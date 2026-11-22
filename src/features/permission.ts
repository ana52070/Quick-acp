/**
 * Quick-acp 工具执行权限审批与用户交互提问模块。
 *
 * 核心机制：
 *   1. 权限模式策略隔离：
 *      - 'auto': 自动放行本地与 MCP 工具执行
 *      - 'ask': 对高危/副作用操作 (shell_run, file_write, 及 MCP 工具) 必须向 ACP 客户端发起 `session/request_permission` 审批
 *      - fail-closed: ask 模式下若无客户端连接 (conn == null)，严格拒绝执行，杜绝无头环境意外放行
 *   2. 交互式用户提问 (ask_user_question):
 *      - 仅在有交互式客户端连接且非无头 (headless) 环境下向模型暴露该工具
 *      - 审批与提问必须携带清晰的 question 标题以便客户端 UI 展示
 *      - 包含有界超时 (默认 60s) 与 AbortSignal 级联取消，杜绝永久挂起；超时严格判定为失败，不得假定用户选择
 */

import type { AgentSideConnection } from '@zed-industries/agent-client-protocol';
import type { ToolDef } from '../tools/registry.js';

export type PermissionMode = 'auto' | 'ask';

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

/** 判断当前环境是否具备与用户交互提问的能力 */
export function isInteractiveEnvironment(conn: AgentSideConnection | null): boolean {
  if (process.env.QUICK_ACP_HEADLESS === '1') return false;
  return conn !== null;
}

/** 用户交互提问工具定义 */
export function askUserQuestionToolDef(): ToolDef {
  return {
    name: 'ask_user_question',
    description:
      '向用户提出结构化选择题以获取澄清说明或决策授权。仅在需要用户明确选择时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '向用户展示的问题标题或说明文本' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '供用户单选的选择肢列表（至少 1 项）',
        },
      },
      required: ['question', 'options'],
    },
  };
}

export class PermissionGate {
  private mode: PermissionMode;

  constructor(defaultMode?: PermissionMode) {
    const envMode = process.env.QUICK_ACP_PERMISSION_MODE?.toLowerCase();
    this.mode = defaultMode ?? (envMode === 'ask' ? 'ask' : 'auto');
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  get isAskMode(): boolean {
    return this.mode === 'ask';
  }

  /**
   * 检查指定工具是否获准执行。
   * - 'auto' 模式：全量工具默认放行
   * - 'ask' 模式：
   *    * 若无客户端连接 (conn == null)，fail-closed 拒绝
   *    * 针对敏感工具（shell_run, file_write 以及所有 mcp__ 前缀工具）拉起审批弹窗
   *    * 具备有界超时与 AbortSignal 取消机制
   */
  async checkPermission(opts: {
    conn: AgentSideConnection | null;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    title?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<PermissionCheckResult> {
    if (this.mode !== 'ask') {
      return { allowed: true };
    }

    // ask 模式下若无客户端连接，fail-closed 严格拒绝，防止无头环境产生静默破坏
    if (!opts.conn) {
      return {
        allowed: false,
        reason: '当前权限策略为 ask，但未连接交互式客户端，安全拒绝执行敏感操作 (fail-closed)',
      };
    }

    // 判定是否为带副作用的敏感工具：shell_run, file_write 以及所有 MCP 外部工具
    const isSensitive =
      opts.toolName === 'shell_run' ||
      opts.toolName === 'file_write' ||
      opts.toolName.startsWith('mcp__');

    if (!isSensitive) {
      return { allowed: true };
    }

    if (opts.signal?.aborted) {
      return { allowed: false, reason: '操作已被调用者取消' };
    }

    const timeout = opts.timeoutMs ?? 60_000;

    return new Promise<PermissionCheckResult>((resolve) => {
      let settled = false;
      const settle = (res: PermissionCheckResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(res);
      };

      const timer = setTimeout(() => {
        settle({ allowed: false, reason: `权限请求等待超时 (${timeout}ms)` });
      }, timeout);

      const onAbort = (): void => {
        settle({ allowed: false, reason: '操作已被调用者取消' });
      };

      opts.signal?.addEventListener('abort', onAbort, { once: true });

      const toolTitle = opts.title || `执行工具: ${opts.toolName}`;

      opts.conn!
        .requestPermission({
          sessionId: opts.sessionId,
          toolCall: {
            toolCallId: opts.toolCallId,
            title: toolTitle,
          },
          options: [
            { optionId: 'allow-once', name: '允许执行', kind: 'allow_once' },
            { optionId: 'reject-once', name: '拒绝执行', kind: 'reject_once' },
          ],
        } as any)
        .then((resp) => {
          const outcome = resp?.outcome;
          if (outcome && typeof outcome === 'object') {
            if ('outcome' in outcome && (outcome as any).outcome === 'cancelled') {
              settle({ allowed: false, reason: '用户取消了操作' });
              return;
            }
            if ('optionId' in outcome && (outcome as any).optionId === 'allow-once') {
              settle({ allowed: true });
              return;
            }
          }
          settle({ allowed: false, reason: '用户拒绝了工具执行授权' });
        })
        .catch((e) => {
          settle({
            allowed: false,
            reason: `权限请求异常: ${e instanceof Error ? e.message : String(e)}`,
          });
        });
    });
  }

  /**
   * 实现 `ask_user_question` 交互提问。
   * 必须在标题中呈现问题文本，带超时防挂起，不得将超时伪造成有效回答。
   */
  async askUser(
    conn: AgentSideConnection | null,
    sessionId: string,
    toolCallId: string,
    question: string,
    options: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ content: string; ok: boolean }> {
    if (!conn) {
      return {
        content: '当前环境无交互式 ACP 客户端支持提问，拒绝执行',
        ok: false,
      };
    }

    if (!Array.isArray(options) || options.length === 0) {
      return { content: '提问必须包含至少一个有效选择肢', ok: false };
    }

    if (signal?.aborted) {
      return { content: '提问操作已被取消', ok: false };
    }

    const timeout = timeoutMs ?? 60_000;

    return new Promise<{ content: string; ok: boolean }>((resolve) => {
      let settled = false;
      const settle = (res: { content: string; ok: boolean }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(res);
      };

      const timer = setTimeout(() => {
        settle({ content: `用户提问等待超时 (${timeout}ms) 未收到回应`, ok: false });
      }, timeout);

      const onAbort = (): void => {
        settle({ content: '用户提问操作已被取消', ok: false });
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      const permOptions = options.map((opt, idx) => ({
        optionId: `opt_${idx}`,
        name: String(opt),
        kind: 'allow_once' as const,
      }));

      conn
        .requestPermission({
          sessionId,
          toolCall: {
            toolCallId,
            title: `提问: ${question}`,
          },
          options: permOptions,
        } as any)
        .then((resp) => {
          const outcome = resp?.outcome as any;
          if (outcome?.outcome === 'cancelled') {
            settle({ content: '用户取消了该提问', ok: false });
            return;
          }

          const selectedId = outcome?.optionId;
          const idx = permOptions.findIndex((o) => o.optionId === selectedId);
          if (idx !== -1 && options[idx]) {
            settle({ content: `用户选择了: "${options[idx]}"`, ok: true });
            return;
          }

          settle({ content: '用户拒绝选择或未选择有效选项', ok: false });
        })
        .catch((e) => {
          settle({
            content: `客户端提问交互失败: ${e instanceof Error ? e.message : String(e)}`,
            ok: false,
          });
        });
    });
  }
}
