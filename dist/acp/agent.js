/**
 * ACP agent implementation backed by the Quick gateway.
 *
 * This is the adaptor T3Code / codeg / any ACP client talks to. It speaks
 * standard ACP over stdio and forwards turns to the Quick session.
 *
 * Mapping notes (each one is a real semantic loss, stated rather than hidden):
 *
 *   - ACP `prompt` gives the full `content` of ONE new user turn, not history.
 *     That matches Quick's thread model exactly: each prompt is an increment.
 *   - ACP `newSession` maps to a fresh Quick thread.
 *   - ACP `setSessionMode` maps to Quick `agent_mode`; the mode list is
 *     Quick's ('fast'/'balanced'/'smart'), not a generic ask/code/architect set.
 *   - ACP `setSessionModel` is refused: Quick does not let a caller pick the
 *     model. Reporting a successful model switch would be a lie.
 *   - Tool calls are executed by this process and reported through
 *     `session/update` so the client renders them like any other agent's.
 */
import { RequestError } from '@zed-industries/agent-client-protocol';
import { resolveSession } from '../quick/auth.js';
import { QuickTransport } from '../quick/transport.js';
import { QuickChatSession, } from '../quick/session.js';
import { defaultPolicy, toolDefs, ToolExecutor } from '../tools/registry.js';
import { resolveToolMode, runWithInjectedTools } from '../tools/strategies.js';
/** ACP protocol revision this agent implements. */
const PROTOCOL_VERSION = 1;
export class QuickAcpAgent {
    sessions = new Map();
    sessionSeq = 0;
    quickSession = null;
    toolMode;
    tools;
    executor;
    workspaceRoot;
    policy;
    conn = null;
    constructor(opts = {}) {
        this.workspaceRoot = opts.workspaceRoot ?? process.cwd();
        const policy = defaultPolicy(this.workspaceRoot);
        this.toolMode = resolveToolMode();
        this.tools = toolDefs(policy);
        this.executor = new ToolExecutor(policy);
        this.policy = policy;
    }
    /** Called by main once the connection exists, so we can emit updates. */
    attach(conn) {
        this.conn = conn;
    }
    // -------------------------------------------------------------------------
    // ACP: lifecycle
    // -------------------------------------------------------------------------
    async initialize(_params) {
        return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: {
                // We stream incremental text, so loadSession stays false: replaying a
                // full history is not something the Quick thread model supports.
                loadSession: false,
                promptCapabilities: {
                    image: true,
                    audio: false,
                    embeddedContext: true,
                },
            },
            authMethods: [],
        };
    }
    async newSession(params) {
        const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : this.workspaceRoot;
        // Each ACP session gets its OWN gateway socket and its own Quick thread, so
        // two conversations in the client map to two independent Quick threads.
        // Turns within one session are serialized by the gateway's thread model;
        // sessions run independently of each other.
        const quick = await this.quick();
        const transport = new QuickTransport(quick, {
            onTokenRefreshNeeded: async () => {
                try {
                    const fresh = await resolveSession();
                    this.quickSession = fresh;
                    return fresh.jwt;
                }
                catch {
                    return null;
                }
            },
        });
        const chat = new QuickChatSession({
            transport,
            actorArn: quick.actorArn,
            agentMode: 'smart',
            thinkingEffort: 'high',
        });
        await chat.open();
        // The session id must be unique ACROSS PROCESS LIFETIMES, not just within
        // this one.
        //
        // It used to be `quick-${++this.sessionSeq}`, which restarts at 1 on every
        // agent start. codeg remembers which conversation a session is bound to, so
        // the second conversation to ever use the agent was told:
        //
        //   conflict: agent session quick-1 is already bound to conversation 770;
        //   refusing to move it onto conversation 771
        //
        // and could never send a message. The Quick thread id is a UUID that this
        // session owns for its whole life, so reusing it gives an id that is unique
        // for real (and correlates with the thread in any server-side logs).
        const id = chat.ensureThread();
        this.sessions.set(id, {
            id,
            chat,
            transport,
            agentMode: 'smart',
            thinkingEffort: 'high',
            cancelled: false,
            cwd,
        });
        return {
            sessionId: id,
            modes: {
                currentModeId: 'smart',
                availableModes: [
                    {
                        id: 'fast',
                        name: 'Fast',
                        description: 'Quickest responses, no extended thinking. Maps to Quick mode "fast".',
                    },
                    {
                        id: 'balanced',
                        name: 'Balanced',
                        description: 'Balances quality and speed. Maps to Quick mode "balanced".',
                    },
                    {
                        id: 'smart',
                        name: 'Smart',
                        description: 'Highest quality with extended thinking. Maps to Quick mode "smart", which is ' +
                            'the tier that routes to the strongest available model.',
                    },
                ],
            },
        };
    }
    async setSessionMode(params) {
        const session = this.requireSession(params.sessionId);
        const mode = String(params.modeId ?? '');
        if (mode !== 'fast' && mode !== 'balanced' && mode !== 'smart') {
            throw RequestError.invalidParams({ modeId: mode });
        }
        session.agentMode = mode;
        // Fast has no thinking control in Quick; the others keep the current effort.
        if (mode === 'fast')
            session.thinkingEffort = 'off';
    }
    /**
     * Quick does not let a caller choose the model, so this is refused rather
     * than silently accepted. The resolved model is reported per turn instead.
     */
    async setSessionModel(params) {
        throw new RequestError(-32601, 'Quick does not expose model selection. The gateway routes the model ' +
            'server-side; per-turn usage reports `resolved_model_id`.', { requestedModelId: params.modelId });
    }
    async authenticate() {
        // No ACP-level auth: the Quick session comes from the desktop app.
    }
    // -------------------------------------------------------------------------
    // ACP: prompt turn
    // -------------------------------------------------------------------------
    async prompt(params) {
        const session = this.requireSession(params.sessionId);
        session.cancelled = false;
        const { text: userText, attachments } = extractContent(params.prompt);
        if (!userText.trim() && attachments.length === 0) {
            return { stopReason: 'end_turn' };
        }
        try {
            const result = await this.runTurn(session, userText, attachments);
            if (result.cancelled) {
                return { stopReason: 'cancelled' };
            }
            return { stopReason: 'end_turn' };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            // Surface protocol-level failures as a refusal the client can render,
            // with the reason intact instead of a generic internal error.
            throw new RequestError(-32000, message, { sessionId: params.sessionId });
        }
    }
    async cancel(params) {
        const session = this.sessions.get(params.sessionId);
        if (!session)
            return;
        session.cancelled = true;
        session.chat.cancel();
    }
    async extMethod(method) {
        throw new RequestError(-32601, `unsupported extension method: ${method}`);
    }
    async extNotification() {
        // Ignored by design.
    }
    // -------------------------------------------------------------------------
    // turn execution
    // -------------------------------------------------------------------------
    async runTurn(session, userText, attachments) {
        // Tools are advertised in the prompt and driven by this loop. One extra
        // gateway turn per tool call is the price of needing nothing but the
        // gateway; the native MCP alternative lives on the `mcp-native` branch.
        const result = await runWithInjectedTools({
            userText,
            tools: this.tools,
            workspaceRoot: this.workspaceRoot,
            executor: this.executor,
            maxToolRounds: Number.parseInt(process.env.QUICK_ACP_MAX_TOOL_ROUNDS ?? '12', 10) || 12,
            turn: (text) => this.oneGatewayTurn(session, text, []),
            onAssistantText: () => {
                /* streamed to the client already */
            },
            onToolCall: (call, result) => {
                void this.emitToolUpdate(session, call.name, call.arguments, result.content, result.ok);
            },
        });
        return { cancelled: result.cancelled, text: result.finalText };
    }
    /** One gateway turn: send text, stream deltas as ACP updates, return full text. */
    async oneGatewayTurn(session, text, attachments) {
        let full = '';
        const stream = session.chat.sendTurn([{ role: 'user', text }], {
            agentMode: session.agentMode,
            thinkingEffort: session.thinkingEffort,
            attachments,
        });
        for await (const ev of stream) {
            if (session.cancelled) {
                session.chat.cancel();
                return { text: full, cancelled: true };
            }
            switch (ev.type) {
                case 'text':
                    full += ev.delta;
                    await this.emitText(session.id, ev.delta);
                    break;
                case 'thinking':
                    // ACP has agent_thought_chunk for exactly this; forward it so the
                    // client can render reasoning like it does for any other agent.
                    await this.emitThought(session.id, ev.delta);
                    break;
                case 'tool_start':
                    await this.emitToolUpdate(session, ev.toolName, ev.args, undefined, true, ev.toolId);
                    break;
                case 'tool_end':
                    break;
                case 'turn_end':
                    break;
                case 'error':
                    throw new Error(`${ev.code}: ${ev.message}`);
                default:
                    break;
            }
        }
        return { text: full, cancelled: session.cancelled };
    }
    // -------------------------------------------------------------------------
    // ACP notifications
    // -------------------------------------------------------------------------
    async emitText(sessionId, delta) {
        if (!this.conn || !delta)
            return;
        const notification = {
            sessionId,
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: delta },
            },
        };
        try {
            await this.conn.sessionUpdate(notification);
        }
        catch {
            /* client went away */
        }
    }
    /**
     * Forward reasoning to the client.
     *
     * ACP distinguishes agent_thought_chunk from agent_message_chunk precisely so
     * a client can render thinking separately instead of mistaking it for the
     * answer. Quick emits thinking_delta, so it maps straight across.
     */
    async emitThought(sessionId, delta) {
        if (!this.conn || !delta)
            return;
        const notification = {
            sessionId,
            update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: delta },
            },
        };
        try {
            await this.conn.sessionUpdate(notification);
        }
        catch {
            /* client went away */
        }
    }
    async emitToolUpdate(session, toolName, args, resultText, ok, toolCallId) {
        if (!this.conn)
            return;
        const id = toolCallId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const notification = {
            sessionId: session.id,
            update: {
                sessionUpdate: 'tool_call',
                toolCallId: id,
                title: toolName,
                kind: 'other',
                status: resultText === undefined ? 'in_progress' : ok ? 'completed' : 'failed',
                rawInput: args,
                ...(resultText === undefined
                    ? {}
                    : { content: [{ type: 'content', content: { type: 'text', text: resultText } }] }),
            },
        };
        try {
            await this.conn.sessionUpdate(notification);
        }
        catch {
            /* client went away */
        }
    }
    // -------------------------------------------------------------------------
    requireSession(id) {
        const s = this.sessions.get(id);
        if (!s)
            throw RequestError.invalidParams({ sessionId: id });
        return s;
    }
    async quick() {
        if (this.quickSession)
            return this.quickSession;
        this.quickSession = await resolveSession();
        return this.quickSession;
    }
}
/** Flatten ACP prompt content blocks into text + attachments. */
function extractContent(blocks) {
    const parts = [];
    const attachments = [];
    if (!Array.isArray(blocks))
        return { text: '', attachments };
    for (const block of blocks) {
        if (!block || typeof block !== 'object')
            continue;
        const b = block;
        const type = b['type'];
        if (type === 'text' && typeof b['text'] === 'string') {
            parts.push(b['text']);
            continue;
        }
        if (type === 'resource' && typeof b['resource'] === 'object') {
            const r = b['resource'];
            if (typeof r['text'] === 'string')
                parts.push(r['text']);
            continue;
        }
        // ACP image blocks carry base64 in `data` with `mimeType`; that maps
        // straight onto Quick's attachment shape.
        if (type === 'image' && typeof b['data'] === 'string') {
            const mimeType = typeof b['mimeType'] === 'string' ? b['mimeType'] : 'image/png';
            const ext = mimeType.split('/')[1] ?? 'png';
            const data = b['data'];
            attachments.push({
                type: 'image',
                name: `image_${attachments.length + 1}.${ext}`,
                size: Math.floor((data.length * 3) / 4), // base64 -> bytes, approximate
                mimeType,
                data,
            });
            continue;
        }
    }
    return { text: parts.join('\n\n'), attachments };
}
//# sourceMappingURL=agent.js.map