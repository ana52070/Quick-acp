/**
 * Quick-acp ACP 执行代理实现。
 *
 * 作为 codeg / Zed 等标准 ACP 客户端与 Quick 网关之间的协议适配器。
 * 通过 stdio 承载标准 ACP (JSON-RPC) 通信，并向上游 Quick 协议会话流式转发对话轮次。
 */

import type {
  Agent,
  AgentSideConnection,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionModeRequest,
  SessionNotification,
  SetSessionModelRequest,
} from '@zed-industries/agent-client-protocol';
import { RequestError } from '@zed-industries/agent-client-protocol';
import { randomUUID } from 'node:crypto';

import { resolveSession, type QuickSession } from '../quick/auth.js';
import { QuickTransport } from '../quick/transport.js';
import {
  QuickChatSession,
  type AgentMode,
  type ThinkingEffort,
  type TurnAttachment,
  type TokenUsage,
} from '../quick/session.js';
import { defaultPolicy, toolDefs, ToolExecutor, type ToolDef, type ToolResult } from '../tools/registry.js';
import {
  extractBalancedJson,
  parseToolCall,
  resolveToolMode,
  runWithInjectedTools,
  type ToolMode,
  type ParsedToolCall,
  type BudgetProgress,
  type InjectedToolsResult,
} from '../tools/strategies.js';

import {
  saveSession,
  readSession,
  listPersistedSessions,
  forkPersistedSession,
  type PersistedSession,
  type PersistedTurn,
  type PersistedToolCall,
} from '../session/persistence.js';
import { SessionMcpManager } from '../mcp/manager.js';
import { planToolDef, SessionPlanManager, type PlanEntry } from '../features/plan.js';
import { SkillManager, skillReadToolDef, type AvailableCommand, type PromptProcessResult } from '../features/skills.js';
import { PermissionGate, askUserQuestionToolDef, isInteractiveEnvironment } from '../features/permission.js';
import { ClientFsDelegate } from '../features/fs-delegate.js';
import { runWithClassifiedRetry } from '../features/retry.js';

/** ACP 协议版本号 */
const PROTOCOL_VERSION = 1;

/**
 * 校验工具名称是否为 Quick 云端原生设备工具。
 * 当模型被 Quick 上游环境误导尝试调用设备端 Python/Bash 执行时，必须在本地代理层拦截。
 */
export function isNativeDeviceTool(name: string): boolean {
  const lower = (name || '').toLowerCase();
  return (
    lower === 'run_python_on_device' ||
    lower.includes('on_device') ||
    lower.startsWith('device_') ||
    lower.endsWith('_on_device') ||
    lower === 'run_python' ||
    lower === 'run_bash_on_device' ||
    lower === 'execute_command_on_device' ||
    lower === 'device_terminal'
  );
}

/**
 * 流式文本过滤器：剔除流式输出中的工具调用协议 JSON 块，防止污染用户 UI 正文。
 */
export class ToolCallFilter {
  private held = '';
  private inside = false;

  constructor(private readonly emit: (delta: string) => Promise<void>) {}

  async push(delta: string): Promise<void> {
    this.held += delta;

    for (;;) {
      if (this.inside) {
        let candidateFenceIdx = this.held.indexOf('```');
        let foundRealClose = false;

        while (candidateFenceIdx !== -1) {
          const body = this.held.slice(0, candidateFenceIdx);
          if (extractBalancedJson(body, 0) && parseToolCall(body)) {
            const afterFence = this.held.slice(candidateFenceIdx);
            const fenceMatch = afterFence.match(/^`{3,}/);
            const fenceLen = fenceMatch ? fenceMatch[0].length : 3;
            this.held = this.held.slice(candidateFenceIdx + fenceLen);
            this.inside = false;
            foundRealClose = true;
            break;
          }
          candidateFenceIdx = this.held.indexOf('```', candidateFenceIdx + 3);
        }

        if (foundRealClose) {
          continue;
        }
        return;
      }

      const openMatch = this.held.match(
        /`{3,}(?:quick-tool-call|quick_tool_call|tool-call|tool_call)\b[^\n]*\r?\n?/i,
      );
      if (!openMatch || openMatch.index === undefined) {
        const keep = Math.min(this.held.length, 32);
        const cut = this.held.length - keep;
        if (cut <= 0) return;
        const safe = this.held.slice(0, cut);
        this.held = this.held.slice(cut);
        if (safe) await this.emit(safe);
        return;
      }

      const before = this.held.slice(0, openMatch.index);
      if (before) await this.emit(before);
      this.held = this.held.slice(openMatch.index + openMatch[0].length);
      this.inside = true;
    }
  }

  async flush(): Promise<void> {
    if (this.inside) {
      this.held = '';
      this.inside = false;
      return;
    }
    if (parseToolCall(this.held)) {
      this.held = '';
      return;
    }
    const rest = this.held;
    this.held = '';
    if (rest) await this.emit(rest);
  }
}

interface SessionTools {
  workspaceRoot: string;
  policy: ReturnType<typeof defaultPolicy>;
  tools: ToolDef[];
  executor: {
    execute: (
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      toolCallId?: string,
    ) => Promise<ToolResult>;
  };
}

interface SessionState {
  id: string;
  chat: QuickChatSession;
  transport: QuickTransport;
  agentMode: AgentMode;
  thinkingEffort: ThinkingEffort;
  cancelled: boolean;
  abortController: AbortController | null;
  activePrompt: boolean;
  cwd: string;
  sessionTools: SessionTools;
  mcpManager: SessionMcpManager;
  planManager: SessionPlanManager;
  skillManager: SkillManager;
  permissionGate: PermissionGate;
  persisted: PersistedSession;
  historyInjected: boolean;
}

/** 将持久化历史记录格式化为上下文注入字符串，确保新线程/分叉会话恢复记忆 */
function buildHistoryTranscriptContext(turns: PersistedTurn[]): string {
  if (!turns || turns.length === 0) return '';
  const lines: string[] = ['[上轮对话历史上下文 - 供续接记忆]'];
  for (const turn of turns) {
    if (turn.role === 'user') {
      lines.push(`用户: ${turn.text}`);
    } else if (turn.role === 'assistant') {
      let asst = turn.text;
      if (turn.toolCalls && turn.toolCalls.length > 0) {
        const calls = turn.toolCalls
          .map((tc) => `[工具调用: ${tc.toolName} ${tc.ok ? '成功' : '失败'}]`)
          .join(' ');
        asst = asst ? `${asst}\n${calls}` : calls;
      }
      lines.push(`助手: ${asst}`);
    }
  }
  lines.push('[历史上下文结束，请基于上述记忆继续响应]');
  return lines.join('\n');
}

export class QuickAcpAgent implements Agent {
  private sessions = new Map<string, SessionState>();
  private sessionSeq = 0;
  private quickSession: QuickSession | null = null;
  private readonly toolMode: ToolMode;
  private readonly fallbackWorkspace: string;
  private conn: AgentSideConnection | null = null;
  private readonly clientFsDelegate = new ClientFsDelegate();
  private shutdownRegistered = false;

  constructor(opts: { workspaceRoot?: string } = {}) {
    this.fallbackWorkspace = opts.workspaceRoot ?? process.cwd();
    this.toolMode = resolveToolMode();
    this.registerProcessHooks();
  }

  private registerProcessHooks(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;

    const cleanup = () => {
      void this.closeAll();
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('exit', cleanup);
  }

  attach(conn: AgentSideConnection): void {
    this.conn = conn;
  }

  async closeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        session.cancelled = true;
        session.abortController?.abort();
        session.chat.cancel();
        session.chat.close?.();
        await session.mcpManager.close();
      } catch {}
    }
  }

  // -------------------------------------------------------------------------
  // ACP: 生命周期
  // -------------------------------------------------------------------------

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    if (params.clientCapabilities) {
      this.clientFsDelegate.setClientCapabilities(params.clientCapabilities);
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true, // 完整支持：本地持久化重放、原线程续接与分叉上下文注入
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
      typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : this.fallbackWorkspace;

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
    const id = chat.ensureThread();

    const mcpManager = new SessionMcpManager(++this.sessionSeq);
    if (Array.isArray(params.mcpServers)) {
      await mcpManager.mountServers(params.mcpServers);
    }

    const planManager = new SessionPlanManager();
    const skillManager = new SkillManager();
    await skillManager.discover(cwd);

    const permissionGate = new PermissionGate();

    const persisted: PersistedSession = {
      sessionId: id,
      threadId: id,
      cwd,
      title: `会话 ${id.slice(0, 8)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agentMode: 'smart',
      turns: [],
    };
    await saveSession(persisted);

    const sessionTools = this.buildSessionTools(
      id,
      cwd,
      mcpManager,
      planManager,
      skillManager,
      permissionGate,
    );

    const state: SessionState = {
      id,
      chat,
      transport,
      agentMode: 'smart',
      thinkingEffort: 'high',
      cancelled: false,
      abortController: null,
      activePrompt: false,
      cwd,
      sessionTools,
      mcpManager,
      planManager,
      skillManager,
      permissionGate,
      persisted,
      historyInjected: true,
    };

    this.sessions.set(id, state);

    setTimeout(() => {
      void this.emitAvailableCommands(id, skillManager.getAvailableCommands());
    }, 10);

    return {
      sessionId: id,
      modes: {
        currentModeId: 'smart',
        availableModes: [
          {
            id: 'fast',
            name: 'Fast',
            description: '快速响应，关闭深度思考。对应 Quick 的 fast 档位。',
          },
          {
            id: 'balanced',
            name: 'Balanced',
            description: '平衡响应质量与速度。对应 Quick 的 balanced 档位。',
          },
          {
            id: 'smart',
            name: 'Smart',
            description: '最高质量，启用 Extended Thinking 思考流。对应 Quick 的 smart 最优模型。',
          },
        ],
      },
    } as NewSessionResponse;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const previous = this.sessions.get(params.sessionId);
    if (previous?.activePrompt) {
      throw new RequestError(-32600, '无法在对话执行期间重新加载会话');
    }
    if (previous) {
      previous.chat.close();
      await previous.mcpManager.close();
      this.sessions.delete(params.sessionId);
    }
    const persisted = await readSession(params.sessionId);
    if (!persisted) {
      throw RequestError.resourceNotFound(`未找到持久化会话 ${params.sessionId}`);
    }

    const cwd =
      typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : persisted.cwd;

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
      agentMode: (persisted.agentMode as AgentMode) || 'smart',
      thinkingEffort: 'high',
    });

    await chat.open();

    // 真正恢复上游 Quick 线程 ID 续接会话
    chat.ensureThread(persisted.threadId);

    const id = params.sessionId;
    const mcpManager = new SessionMcpManager(++this.sessionSeq);
    if (Array.isArray(params.mcpServers)) {
      await mcpManager.mountServers(params.mcpServers);
    }

    const planManager = new SessionPlanManager();
    const skillManager = new SkillManager();
    await skillManager.discover(cwd);

    const permissionGate = new PermissionGate();
    const sessionTools = this.buildSessionTools(
      id,
      cwd,
      mcpManager,
      planManager,
      skillManager,
      permissionGate,
    );

    const state: SessionState = {
      id,
      chat,
      transport,
      agentMode: (persisted.agentMode as AgentMode) || 'smart',
      thinkingEffort: 'high',
      cancelled: false,
      abortController: null,
      activePrompt: false,
      cwd,
      sessionTools,
      mcpManager,
      planManager,
      skillManager,
      permissionGate,
      persisted,
      // load 恢复后首轮提示词注入历史摘要，防止上游线程过期时模型失忆
      historyInjected: false,
    };

    this.sessions.set(id, state);

    // 向客户端 UI 完整重放历史消息、思考过程与工具调用卡片
    for (const turn of persisted.turns) {
      if (turn.role === 'user') {
        await this.emitUserMessage(id, turn.text);
      } else if (turn.role === 'assistant') {
        if (turn.thought) {
          await this.emitThought(id, turn.thought);
        }
        if (turn.text) {
          await this.emitText(id, turn.text);
        }
        if (turn.toolCalls) {
          for (const tc of turn.toolCalls) {
            await this.emitToolStart(state, tc.toolName, tc.args, tc.toolCallId);
            await this.emitToolResult(state, tc.toolName, tc.args, tc.result, tc.ok ?? true, tc.toolCallId);
          }
        }
      }
    }

    setTimeout(() => {
      void this.emitAvailableCommands(id, skillManager.getAvailableCommands());
    }, 10);

    return {
      modes: {
        currentModeId: state.agentMode,
        availableModes: [
          { id: 'fast', name: 'Fast', description: '快速响应，关闭深度思考。' },
          { id: 'balanced', name: 'Balanced', description: '平衡质量与速度。' },
          { id: 'smart', name: 'Smart', description: '最高质量，启用 Extended Thinking 思考流。' },
        ],
      },
    } as unknown as LoadSessionResponse;
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<void> {
    const session = this.requireSession(params.sessionId);
    const mode = String(params.modeId ?? '');
    if (mode !== 'fast' && mode !== 'balanced' && mode !== 'smart') {
      throw RequestError.invalidParams({ modeId: mode });
    }
    session.agentMode = mode as AgentMode;
    if (mode === 'fast') session.thinkingEffort = 'off';

    // 联动持久化保存会话模式
    session.persisted.agentMode = mode;
    await saveSession(session.persisted);

    await this.emitModeUpdate(session.id, mode);
  }

  async setSessionModel(params: SetSessionModelRequest): Promise<void> {
    throw new RequestError(
      -32601,
      'Quick does not expose model selection. Quick 不支持客户端主动切换模型。网关服务端统一路由模型；每轮 turn usage 均如实返回 resolvedModelId。',
      { requestedModelId: params.modelId },
    );
  }

  async authenticate(): Promise<void> {
    // ACP 层面无需额外鉴权，使用本地凭据或单点登录凭据
  }

  // -------------------------------------------------------------------------
  // ACP: prompt 对话轮次
  // -------------------------------------------------------------------------

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);

    // 并发保护：同 session 不允许重叠执行 prompt，防止覆盖 AbortController 及持久化记录竞态冲突
    if (session.activePrompt) {
      throw new RequestError(
        -32600,
        `Session ${params.sessionId} already has an active prompt in progress.`,
        { sessionId: params.sessionId },
      );
    }

    session.activePrompt = true;
    session.cancelled = false;
    session.abortController = new AbortController();

    try {
      let { text: userText, attachments } = extractContent(params.prompt);
      if (!userText.trim() && attachments.length === 0) {
        return { stopReason: 'end_turn' } as PromptResponse;
      }

      // 1. 处理斜杠命令与本地内置拦截（/help, /mode, /plan, /clear）
      const parsed = session.skillManager.processPrompt(userText);
      if (parsed.type === 'builtin') {
        return await this.handleBuiltinSlashCommand(session, parsed.command, parsed.arg, userText);
      }
      if (parsed.type === 'skill') {
        userText = parsed.processedText;
      }

      // 2. 检查是否需要注入历史记忆（如 loadSession 或 fork 后的首个提问）
      let promptToSend = userText;
      if (!session.historyInjected && session.persisted.turns.length > 0) {
        const historyContext = buildHistoryTranscriptContext(session.persisted.turns);
        promptToSend = `${historyContext}\n\n---\n\n${userText}`;
        session.historyInjected = true;
      }

      // 3. 记录用户轮次并更新会话标题
      session.persisted.turns.push({
        role: 'user',
        text: userText,
        timestamp: Date.now(),
      });

      if (
        session.persisted.title.startsWith('会话 ') ||
        session.persisted.title.startsWith('Session ')
      ) {
        const summary = userText.trim().split('\n')[0]!.slice(0, 32);
        if (summary) session.persisted.title = summary;
      }
      await saveSession(session.persisted);

      const result = await this.runTurn(session, promptToSend, attachments);

      // 4. 记录助手响应轮次已在 runTurn 内部组装完整的 thought 与 toolCalls 后落盘

      if (result.cancelled) {
        return { stopReason: 'cancelled' } as PromptResponse;
      }

      if (result.exhausted) {
        const response: PromptResponse = {
          stopReason: 'max_turn_requests',
          ...(result.usage ? { _meta: { usage: result.usage } } : {}),
        };

        if (result.usage && this.conn) {
          try {
            await this.conn.extNotification('session/usage', {
              sessionId: params.sessionId,
              usage: result.usage,
            });
          } catch {
            /* 客户端若不支持该扩展通知则静默忽略 */
          }
        }

        return response;
      }

      const response: PromptResponse = {
        stopReason: 'end_turn',
        ...(result.usage ? { _meta: { usage: result.usage } } : {}),
      };

      // 5. 非标准扩展通知：推送单轮 Token 消耗指标 (SDK usage 扩展)
      if (result.usage && this.conn) {
        try {
          await this.conn.extNotification('session/usage', {
            sessionId: params.sessionId,
            usage: result.usage,
          });
        } catch {
          /* 客户端若不支持该扩展通知则静默忽略 */
        }
      }

      return response;
    } catch (e) {
      if (e instanceof RequestError) {
        throw e;
      }
      const message = e instanceof Error ? e.message : String(e);
      throw new RequestError(-32603, message, { sessionId: params.sessionId });
    } finally {
      session.activePrompt = false;
      session.abortController = null;
    }
  }

  /**
   * 本地拦截执行内置命令，直接生成助手回复并写入持久化，不调用上游模型
   */
  private async handleBuiltinSlashCommand(
    session: SessionState,
    command: 'help' | 'mode' | 'plan' | 'clear',
    arg: string,
    rawUserText: string,
  ): Promise<PromptResponse> {
    let replyText = '';

    if (command === 'help') {
      const skills = session.skillManager.getAllSkills();
      const skillText =
        skills.length > 0
          ? skills.map((s) => `  - **/${s.name}**: ${s.description}`).join('\n')
          : '  （当前未发现挂载技能）';

      replyText = [
        '### Quick-acp 辅助指南',
        '',
        `**当前会话档位**: \`${session.agentMode}\``,
        `**当前工作目录**: \`${session.cwd}\``,
        '',
        '**内置命令**:',
        '  - `/help`: 查看帮助与可用工具',
        '  - `/mode [fast|balanced|smart]`: 查看或切换推理档位',
        '  - `/plan`: 查看当前任务步骤执行计划',
        '  - `/clear`: 清空会话线程与历史',
        '',
        '**已加载本地技能**:',
        skillText,
        '',
        '**基础工具支持**: `file_read`, `file_write`, `file_list`, `file_search`, `shell_run`, `plan_update`, `skill_read` 等。',
      ].join('\n');
    } else if (command === 'mode') {
      if (arg) {
        const target = arg.toLowerCase();
        if (target === 'fast' || target === 'balanced' || target === 'smart') {
          session.agentMode = target as AgentMode;
          session.persisted.agentMode = target;
          await saveSession(session.persisted);
          await this.emitModeUpdate(session.id, target);
          replyText = `已将当前会话模式切换为: **${target}**`;
        } else {
          replyText = `无效的模式 "${arg}"。可选档位: \`fast\`, \`balanced\`, \`smart\``;
        }
      } else {
        replyText = `当前会话模式为: **${session.agentMode}** (可选切换: \`/mode fast\`, \`/mode balanced\`, \`/mode smart\`)`;
      }
    } else if (command === 'plan') {
      replyText = session.planManager.formatAsMarkdown();
    } else if (command === 'clear') {
      session.chat.resetThread();
      const newThread = session.chat.ensureThread();
      session.persisted.threadId = newThread;
      session.persisted.turns = [];
      session.planManager.reset();
      await saveSession(session.persisted);
      replyText = '已重置并清空当前会话线程，历史上下文已重置。';
    }

    await this.emitText(session.id, replyText);

    // 记录内置命令及回复至本地持久化
    session.persisted.turns.push({
      role: 'user',
      text: rawUserText,
      timestamp: Date.now(),
    });
    session.persisted.turns.push({
      role: 'assistant',
      text: replyText,
      timestamp: Date.now(),
    });
    await saveSession(session.persisted);

    return { stopReason: 'end_turn' } as PromptResponse;
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    session.cancelled = true;
    session.abortController?.abort();
    session.chat.cancel();
  }

  async extMethod(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const norm = method.replace(/^_+/, '');

    if (norm === 'session/list' || norm === 'list_sessions') {
      const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : null;
      const list = await listPersistedSessions(cwd);
      return { sessions: list as unknown[] };
    }

    if (norm === 'session/resume') {
      const sessionId = String(params['sessionId'] ?? '');
      const cwd = String(params['cwd'] ?? '');
      const resp = await this.loadSession({ sessionId, cwd } as LoadSessionRequest);
      return resp as unknown as Record<string, unknown>;
    }

    if (norm === 'session/fork') {
      const parentSessionId = String(params['sessionId'] ?? '');
      const newSessionId = randomUUID();
      const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : undefined;
      const forked = await forkPersistedSession(parentSessionId, newSessionId, cwd);
      if (!forked) {
        throw RequestError.resourceNotFound(`未找到父会话 ${parentSessionId} 进行分叉`);
      }

      // 真正恢复分叉会话状态并绑定正确的 newSessionId
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
        agentMode: (forked.agentMode as AgentMode) || 'smart',
        thinkingEffort: 'high',
      });

      await chat.open();
      chat.ensureThread(forked.threadId);

      const mcpManager = new SessionMcpManager(++this.sessionSeq);
      if (Array.isArray(params['mcpServers'])) {
        await mcpManager.mountServers(params['mcpServers']);
      }

      const planManager = new SessionPlanManager();
      const skillManager = new SkillManager();
      await skillManager.discover(forked.cwd);

      const permissionGate = new PermissionGate();
      const sessionTools = this.buildSessionTools(
        newSessionId,
        forked.cwd,
        mcpManager,
        planManager,
        skillManager,
        permissionGate,
      );

      const state: SessionState = {
        id: newSessionId,
        chat,
        transport,
        agentMode: (forked.agentMode as AgentMode) || 'smart',
        thinkingEffort: 'high',
        cancelled: false,
        abortController: null,
        activePrompt: false,
        cwd: forked.cwd,
        sessionTools,
        mcpManager,
        planManager,
        skillManager,
        permissionGate,
        persisted: forked,
        historyInjected: false,
      };

      this.sessions.set(newSessionId, state);

      return {
        sessionId: newSessionId,
        modes: {
          currentModeId: state.agentMode,
          availableModes: [
            { id: 'fast', name: 'Fast', description: '快速响应，关闭深度思考。' },
            { id: 'balanced', name: 'Balanced', description: '平衡质量与速度。' },
            { id: 'smart', name: 'Smart', description: '最高质量，启用 Extended Thinking 思考流。' },
          ],
        },
      };
    }

    if (norm === 'session/close' || norm === 'close_session') {
      const sessionId = String(params['sessionId'] ?? '');
      const s = this.sessions.get(sessionId);
      if (s) {
        s.cancelled = true;
        s.abortController?.abort();
        s.chat.cancel();
        s.chat.close();
        await s.mcpManager.close();
        this.sessions.delete(sessionId);
        return { ok: true };
      }
      return { ok: false, message: '会话不存在' };
    }

    throw RequestError.methodNotFound(method);
  }

  async extNotification(): Promise<void> {
    // 按规范忽略未知扩展通知
  }

  // -------------------------------------------------------------------------
  // 工具注册与执行路由
  // -------------------------------------------------------------------------

  private buildSessionTools(
    sessionId: string,
    workspaceRoot: string,
    mcpManager: SessionMcpManager,
    planManager: SessionPlanManager,
    skillManager: SkillManager,
    permissionGate: PermissionGate,
  ): SessionTools {
    const policy = defaultPolicy(workspaceRoot);
    const baseExecutor = new ToolExecutor(policy);

    // 仅在具备可交互式 ACP 客户端支持时向模型暴露 ask_user_question
    const canAsk = isInteractiveEnvironment(this.conn);

    const tools: ToolDef[] = [
      ...toolDefs(policy),
      planToolDef(),
      skillReadToolDef(),
      ...(canAsk ? [askUserQuestionToolDef()] : []),
      ...mcpManager.registeredTools,
    ];

    const executor = {
      execute: async (
        name: string,
        args: Record<string, unknown>,
        signal?: AbortSignal,
        toolCallId?: string,
      ): Promise<ToolResult> => {
        if (signal?.aborted) {
          return { ok: false, content: '操作已被调用者取消', error: 'cancelled' };
        }

        const callId = toolCallId ?? `call-${Date.now()}`;
        const title = toolTitle(name, args);

        // 1. 权限审批网关（严格区分 auto 与 ask 模式；ask 模式下包含 MCP 工具授权）
        const perm = await permissionGate.checkPermission({
          conn: this.conn,
          sessionId,
          toolCallId: callId,
          toolName: name,
          args,
          title,
          signal,
        });

        if (!perm.allowed) {
          return {
            ok: false,
            content: `操作被拒绝: ${perm.reason ?? '权限未获批准'}`,
            error: 'permission_denied',
          };
        }

        // 2. 路由 MCP 工具调用
        if (name.startsWith('mcp__')) {
          const mcpRes = await mcpManager.executeMcpTool(name, args, signal);
          if (mcpRes) {
            return { ok: mcpRes.ok, content: mcpRes.content };
          }
          return { ok: false, content: `未找到 MCP 工具 ${name}`, error: 'not_found' };
        }

        // 3. 路由 plan_update 工具
        if (name === 'plan_update') {
          const planRes = planManager.updateFromRaw(args);
          await this.emitPlan(sessionId, planManager.plan);
          return { ok: planRes.ok, content: planRes.message };
        }

        // 4. 路由 skill_read 工具
        if (name === 'skill_read') {
          const res = skillManager.readSkillContent(typeof args['name'] === 'string' ? args['name'] : undefined);
          return { ok: res.ok, content: res.content };
        }

        // 5. 路由 ask_user_question 工具
        if (name === 'ask_user_question') {
          const q = String(args['question'] ?? '');
          const opts = Array.isArray(args['options']) ? (args['options'] as string[]) : [];
          return permissionGate.askUser(this.conn, sessionId, callId, q, opts, signal);
        }

        // 6. 路由 file_read（优先尝试编辑器未保存缓冲区，带超时降级保护）
        if (name === 'file_read') {
          const rawPath = String(args['path'] ?? args['file'] ?? args['filePath'] ?? '');
          if (this.clientFsDelegate.isEnabled && rawPath) {
            try {
              const delegated = await this.clientFsDelegate.readTextFile(
                this.conn,
                sessionId,
                rawPath,
                signal,
              );
              return { ok: true, content: delegated.content };
            } catch {
              // 超时或失败时平滑降级至本地磁盘
            }
          }
        }

        // 7. 本地基础工具 (file_read, file_write, file_list, file_search, shell_run)
        return baseExecutor.execute(name, args, signal);
      },
    };

    return { workspaceRoot, policy, tools, executor };
  }

  // -------------------------------------------------------------------------
  // 对话轮次执行与多轮工具循环
  // -------------------------------------------------------------------------

  private async runTurn(
    session: SessionState,
    userText: string,
    attachments: TurnAttachment[],
  ): Promise<{
    cancelled: boolean;
    text: string;
    usage?: TokenUsage | null;
    exhausted?: boolean;
    progress?: BudgetProgress;
  }> {
    const st = session.sessionTools;
    let firstTurn = true;
    let lastUsage: TokenUsage | null = null;
    let hasSideEffects = false;
    let hasOutputEmitted = false;
    let accumulatedThought = '';
    const executedToolCalls: PersistedToolCall[] = [];

    try {
      const result = await runWithInjectedTools({
        userText,
        tools: st.tools,
        workspaceRoot: st.workspaceRoot,
        executor: st.executor,
        maxToolRounds: Number.parseInt(process.env.QUICK_ACP_MAX_TOOL_ROUNDS ?? '12', 10) || 12,
        abortSignal: session.abortController?.signal,
        turn: (text) => {
          const images = firstTurn ? attachments : [];
          firstTurn = false;
          return runWithClassifiedRetry(
            async () => {
              let res = await this.oneGatewayTurn(
                session,
                text,
                images,
                (delta) => {
                  hasOutputEmitted = true;
                },
                (thoughtDelta) => {
                  accumulatedThought += thoughtDelta;
                },
              );

              // 评估是否安全通过修正提示继续（不自动重放有未知副作用的原生调用）
              let nativeRetries = 0;
              const maxNativeRetries = 1;
              while (res.interceptedNativeTool && nativeRetries < maxNativeRetries) {
                if (session.cancelled || session.abortController?.signal?.aborted) {
                  return { text: res.text, cancelled: true };
                }
                nativeRetries++;
                const intercepted = res.interceptedNativeTool;
                void this.emitThought(
                  session.id,
                  `（已拦截上游原生设备工具 ${intercepted.toolName}，云端环境无法访问本地工作区，正在提示模型切换为本机 quick-tool-call）`,
                );

                const correctivePrompt =
                  `【系统提示：上游原生设备工具 '${intercepted.toolName}' 已被拦截并终止。` +
                  `云端设备环境无法访问本地工作区 (${session.cwd})。` +
                  `本机没有任何外部设备。请严格使用 \`\`\`quick-tool-call 格式调用本地工具（如 file_read, file_write, file_list, shell_run 等）操作项目目录！` +
                  `禁止使用任何原生设备工具。请现在通过 \`\`\`quick-tool-call 重新发起操作。】`;

                res = await this.oneGatewayTurn(
                  session,
                  correctivePrompt,
                  [],
                  (delta) => {
                    hasOutputEmitted = true;
                  },
                  (thoughtDelta) => {
                    accumulatedThought += thoughtDelta;
                  },
                );
              }

              if (res.interceptedNativeTool) {
                const errMsg = `错误：模型持续尝试调用云端原生设备工具 (${res.interceptedNativeTool.toolName})，云端无法访问本地工作区。已终止执行以保护安全。`;
                throw new RequestError(-32603, errMsg);
              }

              lastUsage = res.usage ?? null;
              return { text: res.text, cancelled: res.cancelled };
            },
            {
              hasSideEffects,
              hasOutputEmitted: () => hasOutputEmitted,
              abortSignal: session.abortController?.signal,
              onNotice: (notice) => {
                void this.emitThought(session.id, notice);
              },
            },
          );
        },
        onAssistantText: () => {},
        onBudgetExhausted: async ({ notice }) => {
          await this.emitText(session.id, notice);
        },
        onToolStart: (call, id) => {
          executedToolCalls.push({
            toolCallId: id,
            toolName: call.name,
            args: call.arguments,
          });
          void this.emitToolStart(session, call.name, call.arguments, id);
        },
        onToolEnd: (call, id, toolRes) => {
          // 标记副作用：文件写、命令运行或任意 MCP 工具执行均不可重新回放
          if (
            call.name === 'file_write' ||
            call.name === 'shell_run' ||
            call.name.startsWith('mcp__')
          ) {
            hasSideEffects = true;
          }

          const found = executedToolCalls.find((t) => t.toolCallId === id);
          if (found) {
            found.result = toolRes.content;
            found.ok = toolRes.ok;
          }

          void this.emitToolResult(session, call.name, call.arguments, toolRes.content, toolRes.ok, id);
        },
        onToolCall: () => {},
      });

      // 记录助手轮次至持久化记录
      if (session.persisted) {
        session.persisted.turns.push({
          role: 'assistant',
          text: result.finalText,
          thought: accumulatedThought ? accumulatedThought : undefined,
          toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined,
          timestamp: Date.now(),
        });
        await saveSession(session.persisted);
      }

      return {
        cancelled: result.cancelled,
        text: result.finalText,
        usage: lastUsage,
        exhausted: result.exhausted,
        progress: result.progress,
      };
    } catch (e) {
      // 异常审计落盘：即使中途失败，已执行的工具调用及产生的思考也必须持久化，避免丢失证据并防止重复回放
      if (session.persisted && (executedToolCalls.length > 0 || accumulatedThought)) {
        try {
          const errMsg = e instanceof Error ? e.message : String(e);
          session.persisted.turns.push({
            role: 'assistant',
            text: `[执行异常中止: ${errMsg}]`,
            thought: accumulatedThought ? accumulatedThought : undefined,
            toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined,
            timestamp: Date.now(),
          });
          await saveSession(session.persisted);
        } catch {
          /* 忽略审计落盘自身错误，继续抛出原异常 */
        }
      }
      throw e;
    }
  }

  async oneGatewayTurn(
    session: SessionState,
    text: string,
    attachments: TurnAttachment[],
    onTextChunk?: (delta: string) => void,
    onThoughtChunk?: (delta: string) => void,
  ): Promise<{
    text: string;
    cancelled: boolean;
    usage?: TokenUsage | null;
    interceptedNativeTool?: { toolName: string; toolId: string; args: unknown };
  }> {
    let full = '';
    let turnUsage: TokenUsage | null = null;
    let interceptedNativeTool: { toolName: string; toolId: string; args: unknown } | undefined;
    const activeUpstreamCalls = new Map<string, { toolName: string; args: unknown }>();

    const visible = new ToolCallFilter(async (delta) => {
      onTextChunk?.(delta);
      await this.emitText(session.id, delta);
    });

    const stream = session.chat.sendTurn([{ role: 'user', text }], {
      agentMode: session.agentMode,
      thinkingEffort: session.thinkingEffort,
      attachments,
      signal: session.abortController?.signal,
    });

    try {
      for await (const ev of stream) {
        if (session.cancelled) {
          session.chat.cancel();
          return { text: full, cancelled: true, usage: turnUsage };
        }
        switch (ev.type) {
          case 'text':
            full += ev.delta;
            await visible.push(ev.delta);
            break;
          case 'thinking':
            onThoughtChunk?.(ev.delta);
            await this.emitThought(session.id, ev.delta);
            break;
          case 'title':
            if (session.persisted) session.persisted.title = ev.title;
            break;
          case 'usage':
          case 'turn_end':
            if (ev.usage) turnUsage = ev.usage;
            break;
          case 'tool_start': {
            if (isNativeDeviceTool(ev.toolName)) {
              // 关键修复：检测到上游网关原生设备工具调用（如 run_python_on_device 等），
              // 绝对不能只发 pending 卡片永远等待。立即发送 pending 卡片并立即 fail-closed 终止网关执行！
              await this.emitToolStart(session, ev.toolName, ev.args, ev.toolId);
              session.chat.cancel();
              const errDesc =
                `错误：检测到上游网关原生设备工具调用 (${ev.toolName})。` +
                `云端设备环境无法访问本地工作区 (${session.cwd})，已终止该执行路径。` +
                `必须改用本机 quick-tool-call 工具。`;
              await this.emitToolResult(session, ev.toolName, ev.args, errDesc, false, ev.toolId);
              interceptedNativeTool = { toolName: ev.toolName, toolId: ev.toolId, args: ev.args };
              break;
            }
            activeUpstreamCalls.set(ev.toolId, { toolName: ev.toolName, args: ev.args });
            await this.emitToolStart(session, ev.toolName, ev.args, ev.toolId);
            break;
          }
          case 'tool_end': {
            const info = activeUpstreamCalls.get(ev.toolId);
            const toolName = info?.toolName ?? 'gateway_tool';
            const args = info?.args ?? null;
            const ok = !ev.error;
            const resultStr = ev.error
              ? `Error: ${ev.error}`
              : typeof ev.result === 'string'
                ? ev.result
                : JSON.stringify(ev.result ?? '');
            await this.emitToolResult(session, toolName, args, resultStr, ok, ev.toolId);
            activeUpstreamCalls.delete(ev.toolId);
            break;
          }
          case 'error':
            if (ev.code === 'cancelled') {
              return { text: full, cancelled: true, usage: turnUsage, interceptedNativeTool };
            }
            throw new Error(`${ev.code}: ${ev.message}`);
          default:
            break;
        }

        if (interceptedNativeTool) {
          // 已拦截并终止原生设备调用，退出流处理
          break;
        }
      }
    } finally {
      // 保证所有已开始的网关工具卡片在轮次结束时都被正确闭合，绝不留 pending 卡片
      for (const [toolId, info] of activeUpstreamCalls.entries()) {
        await this.emitToolResult(
          session,
          info.toolName,
          info.args,
          '网关工具执行中断或轮次已结束',
          false,
          toolId,
        );
      }
      activeUpstreamCalls.clear();
      await visible.flush();
    }

    return { text: full, cancelled: session.cancelled, usage: turnUsage, interceptedNativeTool };
  }

  // -------------------------------------------------------------------------
  // ACP 通知推送
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
    } catch {}
  }

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
    } catch {}
  }

  private async emitUserMessage(sessionId: string, text: string): Promise<void> {
    if (!this.conn || !text) return;
    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
      },
    } as unknown as SessionNotification;
    try {
      await this.conn.sessionUpdate(notification);
    } catch {}
  }

  private async emitPlan(sessionId: string, entries: PlanEntry[]): Promise<void> {
    if (!this.conn) return;
    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'plan',
        entries,
      },
    } as unknown as SessionNotification;
    try {
      await this.conn.sessionUpdate(notification);
    } catch {}
  }

  private async emitAvailableCommands(
    sessionId: string,
    availableCommands: AvailableCommand[],
  ): Promise<void> {
    if (!this.conn) return;
    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands,
      },
    } as unknown as SessionNotification;
    try {
      await this.conn.sessionUpdate(notification);
    } catch {}
  }

  private async emitModeUpdate(sessionId: string, currentModeId: string): Promise<void> {
    if (!this.conn) return;
    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId,
      },
    } as unknown as SessionNotification;
    try {
      await this.conn.sessionUpdate(notification);
    } catch {}
  }

  private async emitToolStart(
    session: SessionState,
    toolName: string,
    args: unknown,
    toolCallId: string,
  ): Promise<void> {
    if (!this.conn) return;
    const created: SessionNotification = {
      sessionId: session.id,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: toolTitle(toolName, args),
        kind: toolKind(toolName),
        status: 'pending',
        rawInput: asRawInput(args),
        ...(toolLocations(args).length > 0 ? { locations: toolLocations(args) } : {}),
      },
    } as unknown as SessionNotification;
    try {
      await this.conn.sessionUpdate(created);
    } catch {}
  }

  private async emitToolResult(
    session: SessionState,
    toolName: string,
    args: unknown,
    resultText: string | undefined,
    ok: boolean,
    toolCallId: string,
  ): Promise<void> {
    if (!this.conn || resultText === undefined) return;
    const diff = buildDiffContent(toolName, args, ok);
    const updated: SessionNotification = {
      sessionId: session.id,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: ok ? 'completed' : 'failed',
        content: diff
          ? [diff]
          : [
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
    } catch {}
  }

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

function toolKind(toolName: string): string {
  switch (toolName) {
    case 'file_read':
      return 'read';
    case 'file_write':
      return 'edit';
    case 'file_list':
    case 'file_search':
    case 'skill_read':
      return 'search';
    case 'shell_run':
      return 'execute';
    default:
      return 'other';
  }
}

function toolTitle(toolName: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
  const quoted = (v: string): string => (v.length > 72 ? `${v.slice(0, 69)}...` : v);

  switch (toolName) {
    case 'shell_run':
      return `执行命令: ${quoted(str('command') || str('cmd') || 'command')}`;
    case 'file_read':
      return `读取文件: ${quoted(str('path') || str('file') || str('filePath') || 'file')}`;
    case 'file_write':
      return `修改文件: ${quoted(str('path') || str('file') || str('filePath') || 'file')}`;
    case 'file_list':
      return `列出目录: ${quoted(str('path') || str('dir') || str('directory') || '.')}`;
    case 'file_search':
      return `检索内容: ${quoted(str('pattern') || str('query') || str('regex') || '')}`;
    case 'plan_update':
      return '更新任务执行计划';
    case 'skill_read':
      return `查阅技能: ${quoted(str('name') || '所有技能')}`;
    case 'ask_user_question':
      return `向用户提问: ${quoted(str('question') || '问题')}`;
    default:
      return toolName;
  }
}

function asRawInput(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return { value: args };
}

function toolLocations(args: unknown): Array<{ path: string; line?: number }> {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const out: Array<{ path: string; line?: number }> = [];
  if (typeof a['path'] === 'string' && a['path']) out.push({ path: a['path'] });
  if (typeof a['file'] === 'string' && a['file']) out.push({ path: a['file'] });
  if (typeof a['filePath'] === 'string' && a['filePath']) out.push({ path: a['filePath'] });
  return out;
}

function buildDiffContent(
  toolName: string,
  args: unknown,
  ok: boolean,
): { type: 'diff'; path: string; oldText: string | null; newText: string } | null {
  if (toolName !== 'file_write' || !ok) return null;
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const path = typeof a['path'] === 'string' ? a['path'] : typeof a['file'] === 'string' ? a['file'] : '';
  const content = typeof a['content'] === 'string' ? a['content'] : typeof a['text'] === 'string' ? a['text'] : '';
  if (!path) return null;
  return {
    type: 'diff',
    path,
    oldText: null,
    newText: content,
  };
}

function extractContent(prompt: unknown[]): {
  text: string;
  attachments: TurnAttachment[];
} {
  const texts: string[] = [];
  const attachments: TurnAttachment[] = [];

  for (const block of prompt) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const type = b['type'];

    if (type === 'text' && typeof b['text'] === 'string') {
      texts.push(b['text']);
    } else if (type === 'image') {
      const data = typeof b['data'] === 'string' ? b['data'] : '';
      const mime = typeof b['mimeType'] === 'string' ? b['mimeType'] : 'image/png';
      if (data) {
        attachments.push({
          type: 'image',
          name: 'image.png',
          size: Math.floor((data.length * 3) / 4),
          mimeType: mime,
          data,
        });
      }
    }
  }

  return { text: texts.join('\n\n'), attachments };
}
