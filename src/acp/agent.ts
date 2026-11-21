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

interface SessionState {
  id: string;
  chat: QuickChatSession;
  transport: QuickTransport;
  agentMode: AgentMode;
  thinkingEffort: ThinkingEffort;
  cancelled: boolean;
  /** Workspace this session's tools resolve against. */
  cwd: string;
}

export class QuickAcpAgent implements Agent {
  private sessions = new Map<string, SessionState>();
  private sessionSeq = 0;
  private quickSession: QuickSession | null = null;
  private readonly toolMode: ToolMode;
  private readonly tools: ToolDef[];
  private readonly executor: ToolExecutor;
  private readonly workspaceRoot: string;
  private readonly policy: ReturnType<typeof defaultPolicy>;
  private conn: AgentSideConnection | null = null;

  constructor(opts: { workspaceRoot?: string } = {}) {
    this.workspaceRoot = opts.workspaceRoot ?? process.cwd();
    const policy = defaultPolicy(this.workspaceRoot);
    this.toolMode = resolveToolMode();
    this.tools = toolDefs(policy);
    this.executor = new ToolExecutor(policy);
    this.policy = policy;
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
    const cwd =
      typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : this.workspaceRoot;

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

    const id = `quick-${++this.sessionSeq}`;
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
  private async oneGatewayTurn(
    session: SessionState,
    text: string,
    attachments: TurnAttachment[],
  ): Promise<{ text: string; cancelled: boolean }> {
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
    const notification: SessionNotification = {
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
    } as unknown as SessionNotification;
    try {
      await this.conn.sessionUpdate(notification);
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

/** Flatten ACP prompt content blocks into text + attachments. */
function extractContent(blocks: unknown): { text: string; attachments: TurnAttachment[] } {
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
