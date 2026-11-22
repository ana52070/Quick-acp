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

import type {
  Agent,
  AgentSideConnection,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionModeRequest,
  SessionNotification,
} from '@zed-industries/agent-client-protocol';
import { RequestError } from '@zed-industries/agent-client-protocol';
import type { SetSessionModelRequest } from '@zed-industries/agent-client-protocol';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { resolveSession, type QuickSession } from '../quick/auth.js';
import { QuickTransport } from '../quick/transport.js';
import {
  QuickChatSession,
  type AgentMode,
  type ThinkingEffort,
  type TurnAttachment,
} from '../quick/session.js';
import { defaultPolicy, toolDefs, ToolExecutor, type ToolDef } from '../tools/registry.js';
import { resolveToolMode, runWithInjectedTools, type ToolMode } from '../tools/strategies.js';

/** ACP protocol revision this agent implements. */
const PROTOCOL_VERSION = 1;

/**
 * Removes the tool-call contract from the user-visible text stream.
 *
 * WHY THIS EXISTS
 * ---------------
 * The inject strategy asks the model to answer a tool need with a fenced block:
 *
 *   ```quick-tool-call
 *   {"name": "shell_run", "arguments": {"command": "cd"}}
 *   ```
 *
 * That block is an instruction to US, not something to show. But text arrives as
 * deltas, so the first fragments of it were already streamed to the client before
 * the parser had seen the whole thing — the user got a wall of JSON followed by
 * the real answer, and the client rendered it as chat prose because it genuinely
 * was chat prose by then.
 *
 * So the delta stream is filtered rather than the final string: hold back just
 * enough characters to know whether a block is starting (the marker is short),
 * and once inside one, drop everything until it closes.
 */
class ToolCallFilter {
  /** Everything received but not yet emitted or discarded. */
  private held = '';
  /** True once a tool-call block has started and not yet closed. */
  private inside = false;

  constructor(private readonly emit: (delta: string) => Promise<void>) {}

  async push(delta: string): Promise<void> {
    this.held += delta;

    for (;;) {
      if (this.inside) {
        const close = this.held.indexOf(TOOL_CALL_CLOSE);
        if (close < 0) return; // still inside; wait for more
        this.held = this.held.slice(close + TOOL_CALL_CLOSE.length);
        this.inside = false;
        continue;
      }

      const open = this.held.indexOf(TOOL_CALL_OPEN);
      if (open < 0) {
        // No marker yet. Emit everything except a tail that could still become
        // the start of one, so a marker split across deltas is still caught.
        const keep = Math.min(this.held.length, TOOL_CALL_OPEN.length - 1);
        const cut = this.held.length - keep;
        if (cut <= 0) return;
        const safe = this.held.slice(0, cut);
        this.held = this.held.slice(cut);
        if (safe) await this.emit(safe);
        return;
      }

      const before = this.held.slice(0, open);
      if (before) await this.emit(before);
      this.held = this.held.slice(open + TOOL_CALL_OPEN.length);
      this.inside = true;
    }
  }

  /** Emit whatever is left once the turn is over. */
  async flush(): Promise<void> {
    const rest = this.inside ? '' : this.held;
    this.held = '';
    this.inside = false;
    if (rest) await this.emit(rest);
  }
}

const TOOL_CALL_OPEN = '```quick-tool-call';
const TOOL_CALL_CLOSE = '```';

/**
 * Per-session tool environment.
 *
 * The workspace is NOT a global: two conversations can be open on two different
 * folders, and each must be jailed to its own. Everything the tools need is
 * derived from the `cwd` the client sends with `session/new`.
 */
interface SessionTools {
  workspaceRoot: string;
  policy: ReturnType<typeof defaultPolicy>;
  tools: ToolDef[];
  executor: ToolExecutor;
}

interface SessionState {
  id: string;
  chat: QuickChatSession;
  transport: QuickTransport;
  agentMode: AgentMode;
  thinkingEffort: ThinkingEffort;
  cancelled: boolean;
  /** Workspace this session's tools resolve against — from `session/new`. */
  cwd: string;
  /** Tools bound to this session's cwd. */
  sessionTools: SessionTools;
}

function buildSessionTools(workspaceRoot: string): SessionTools {
  const policy = defaultPolicy(workspaceRoot);
  return {
    workspaceRoot,
    policy,
    tools: toolDefs(policy),
    executor: new ToolExecutor(policy),
  };
}

export class QuickAcpAgent implements Agent {
  private sessions = new Map<string, SessionState>();
  private sessionSeq = 0;
  private quickSession: QuickSession | null = null;
  private readonly toolMode: ToolMode;
  private readonly fallbackWorkspace: string;
  private conn: AgentSideConnection | null = null;

  constructor(opts: { workspaceRoot?: string } = {}) {
    // Only a FALLBACK. The real workspace comes from `session/new`'s `cwd`,
    // which is the folder the user picked in the ACP client — that is the
    // protocol's own mechanism and the only one that should matter.
    this.fallbackWorkspace = opts.workspaceRoot ?? process.cwd();
    this.toolMode = resolveToolMode();
  }

  /** Called by main once the connection exists, so we can emit updates. */
  attach(conn: AgentSideConnection): void {
    this.conn = conn;
  }

  // -------------------------------------------------------------------------
  // ACP: lifecycle
  // -------------------------------------------------------------------------

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
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
    } as InitializeResponse;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    // ACP's own workspace mechanism: the client sends the folder the user
    // picked, and every tool call in this session is jailed to it. Falling back
    // to the process cwd only when a client sends nothing.
    const cwd =
      typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : this.fallbackWorkspace;

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
        } catch {
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
      sessionTools: buildSessionTools(cwd),
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
            description:
              'Highest quality with extended thinking. Maps to Quick mode "smart", which is ' +
              'the tier that routes to the strongest available model.',
          },
        ],
      },
    } as NewSessionResponse;
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<void> {
    const session = this.requireSession(params.sessionId);
    const mode = String(params.modeId ?? '');
    if (mode !== 'fast' && mode !== 'balanced' && mode !== 'smart') {
      throw RequestError.invalidParams({ modeId: mode });
    }
    session.agentMode = mode as AgentMode;
    // Fast has no thinking control in Quick; the others keep the current effort.
    if (mode === 'fast') session.thinkingEffort = 'off';
  }

  /**
   * Quick does not let a caller choose the model, so this is refused rather
   * than silently accepted. The resolved model is reported per turn instead.
   */
  async setSessionModel(params: SetSessionModelRequest): Promise<void> {
    throw new RequestError(
      -32601,
      'Quick does not expose model selection. The gateway routes the model ' +
        'server-side; per-turn usage reports `resolved_model_id`.',
      { requestedModelId: params.modelId },
    );
  }

  async authenticate(): Promise<void> {
    // No ACP-level auth: the Quick session comes from the desktop app.
  }

  // -------------------------------------------------------------------------
  // ACP: prompt turn
  // -------------------------------------------------------------------------

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    session.cancelled = false;

    const { text: userText, attachments } = extractContent(params.prompt);
    if (!userText.trim() && attachments.length === 0) {
      return { stopReason: 'end_turn' } as PromptResponse;
    }

    try {
      const result = await this.runTurn(session, userText, attachments);
      if (result.cancelled) {
        return { stopReason: 'cancelled' } as PromptResponse;
      }
      return { stopReason: 'end_turn' } as PromptResponse;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Surface protocol-level failures as a refusal the client can render,
      // with the reason intact instead of a generic internal error.
      throw new RequestError(-32000, message, { sessionId: params.sessionId });
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    session.cancelled = true;
    session.chat.cancel();
  }

  async extMethod(method: string): Promise<Record<string, unknown>> {
    throw new RequestError(-32601, `unsupported extension method: ${method}`);
  }

  async extNotification(): Promise<void> {
    // Ignored by design.
  }

  // -------------------------------------------------------------------------
  // turn execution
  // -------------------------------------------------------------------------

  private async runTurn(
    session: SessionState,
    userText: string,
    attachments: TurnAttachment[],
  ): Promise<{ cancelled: boolean; text: string }> {
    // Tools are advertised in the prompt and driven by this loop. One extra
    // gateway turn per tool call is the price of needing nothing but the
    // gateway; the native MCP alternative lives on the `mcp-native` branch.
    //
    // The tool set and its jail come from THIS session's cwd, not from a global:
    // two conversations on two folders must not see each other's files.
    const st = session.sessionTools;
    const result = await runWithInjectedTools({
      userText,
      tools: st.tools,
      workspaceRoot: st.workspaceRoot,
      executor: st.executor,
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
  private async oneGatewayTurn(
    session: SessionState,
    text: string,
    attachments: TurnAttachment[],
  ): Promise<{ text: string; cancelled: boolean }> {
    let full = '';
    // Strips the tool-call contract out of what the user sees. See below.
    const visible = new ToolCallFilter((delta) => this.emitText(session.id, delta));
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
          await visible.push(ev.delta);
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

    await visible.flush();
    return { text: full, cancelled: session.cancelled };
  }

  // -------------------------------------------------------------------------
  // ACP notifications
  // -------------------------------------------------------------------------

  private async emitText(sessionId: string, delta: string): Promise<void> {
    if (!this.conn || !delta) return;
    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: delta },
      },
    } as SessionNotification;
    try {
      await this.conn.sessionUpdate(notification);
    } catch {
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
  private async emitThought(sessionId: string, delta: string): Promise<void> {
    if (!this.conn || !delta) return;
    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: delta },
      },
    } as unknown as SessionNotification;
    try {
      await this.conn.sessionUpdate(notification);
    } catch {
      /* client went away */
    }
  }

  /**
   * Announce a tool call to the client, then its outcome.
   *
   * TWO PROTOCOL MISTAKES THIS FIXES (both were visible in codeg as "the tool
   * call JSON is printed as chat text instead of a tool card"):
   *
   * 1. The content block was `{ type: 'content', content: { text } }` — the
   *    inner object must be a real text block, `{ type: 'text', text }`. Without
   *    that discriminator a strict client drops the content as unrenderable.
   *
   * 2. The result was sent as a second `tool_call` with the same id. ACP models
   *    this as `tool_call` (create) then `tool_call_update` (progress/result);
   *    re-sending `tool_call` is undefined and clients ignore it.
   *
   * `kind` also matters: it is how a client decides which icon and affordance to
   * show, and 'other' for everything made every call look identical.
   */
  private async emitToolUpdate(
    session: SessionState,
    toolName: string,
    args: unknown,
    resultText: string | undefined,
    ok: boolean,
    toolCallId?: string,
  ): Promise<void> {
    if (!this.conn) return;
    const id = toolCallId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Creation frame. No content yet: the call has not produced anything.
    const created: SessionNotification = {
      sessionId: session.id,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: toolTitle(toolName, args),
        kind: toolKind(toolName),
        status: 'in_progress',
        rawInput: asRawInput(args),
      },
    } as unknown as SessionNotification;
    try {
      await this.conn.sessionUpdate(created);
    } catch {
      return; // client went away; nothing to update either
    }

    if (resultText === undefined) return;

    // Result frame.
    const updated: SessionNotification = {
      sessionId: session.id,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: ok ? 'completed' : 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: resultText },
          },
        ],
        rawOutput: { output: resultText, ok },
      },
    } as unknown as SessionNotification;
    try {
      await this.conn.sessionUpdate(updated);
    } catch {
      /* client went away */
    }
  }

  // -------------------------------------------------------------------------

  private requireSession(id: string): SessionState {
    const s = this.sessions.get(id);
    if (!s) throw RequestError.invalidParams({ sessionId: id });
    return s;
  }

  private async quick(): Promise<QuickSession> {
    if (this.quickSession) return this.quickSession;
    this.quickSession = await resolveSession();
    return this.quickSession;
  }
}

/**
 * Map our tool names onto ACP's ToolKind.
 *
 * The client renders per kind (a read shows a file, an execute shows a
 * terminal). Reporting 'other' for everything is why every call looked the same.
 */
function toolKind(toolName: string): string {
  switch (toolName) {
    case 'file_read':
      return 'read';
    case 'file_write':
      return 'edit';
    case 'file_list':
    case 'file_search':
      return 'search';
    case 'shell_run':
      return 'execute';
    default:
      return 'other';
  }
}

/** A one-line human summary. The client shows this as the card's heading. */
function toolTitle(toolName: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
  const quoted = (v: string): string => (v.length > 72 ? `${v.slice(0, 69)}...` : v);

  switch (toolName) {
    case 'shell_run':
      return `Run ${quoted(str('command') || 'command')}`;
    case 'file_read':
      return `Read ${quoted(str('path') || 'file')}`;
    case 'file_write':
      return `Write ${quoted(str('path') || 'file')}`;
    case 'file_list':
      return `List ${quoted(str('path') || '.')}`;
    case 'file_search':
      return `Search ${quoted(str('pattern') || '')}`;
    default:
      return toolName;
  }
}

/** ACP wants rawInput as an object; a stray string would be dropped. */
function asRawInput(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return { value: args };
}

/** Flatten ACP prompt content blocks into text + attachments. */function extractContent(blocks: unknown): { text: string; attachments: TurnAttachment[] } {
  const parts: string[] = [];
  const attachments: TurnAttachment[] = [];
  if (!Array.isArray(blocks)) return { text: '', attachments };

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const type = b['type'];

    if (type === 'text' && typeof b['text'] === 'string') {
      parts.push(b['text']);
      continue;
    }

    if (type === 'resource' && typeof b['resource'] === 'object') {
      const r = b['resource'] as Record<string, unknown>;
      if (typeof r['text'] === 'string') parts.push(r['text']);
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
