/**
 * Quick-acp 本地会话持久化模块。
 *
 * 将会话元数据、对话历史、工具调用记录及思考过程持久化至本地磁盘：
 * 默认路径：~/.quick-acp/sessions/<sessionId>.json
 * 可通过 QUICK_ACP_SESSIONS_DIR 环境变量自定义。
 *
 * 支持能力：
 *   - session/list: 发现工作区或本地创建的历史会话
 *   - session/load: 恢复历史上下文并续接 Quick 线程
 *   - session/resume: 语义化继续已有历史对话
 *   - session/fork: 基于父会话历史分叉出新会话与新线程
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface PersistedToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: string;
  ok?: boolean;
}

export interface PersistedTurn {
  role: 'user' | 'assistant';
  text: string;
  thought?: string;
  toolCalls?: PersistedToolCall[];
  timestamp: number;
}

export interface PersistedSession {
  sessionId: string;
  threadId: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agentMode: string;
  turns: PersistedTurn[];
}

export interface SessionSummaryInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

/** 校验会话 ID 合法性，防止路径遍历或非法文件名 */
export function isValidSessionId(sessionId: string): boolean {
  if (typeof sessionId !== 'string') return false;
  return /^[a-zA-Z0-9_-]{1,128}$/.test(sessionId);
}

/** 获取会话存储根目录 */
export function getSessionsDir(): string {
  if (process.env.QUICK_ACP_SESSIONS_DIR) {
    return process.env.QUICK_ACP_SESSIONS_DIR;
  }
  return join(homedir(), '.quick-acp', 'sessions');
}

/** 确保会话存储目录存在，设置安全权限 (0700) */
export async function ensureSessionsDir(): Promise<string> {
  const dir = getSessionsDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/** 获取会话文件绝对路径 */
function sessionFilePath(dir: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`非法会话 ID: ${sessionId}，仅允许包含字母、数字、下划线及连字符 (1-128 字符)`);
  }
  return join(dir, `${sessionId}.json`);
}

/** 单会话写入并发互斥锁，避免同进程并发写入同一会话产生争用 */
const fileLocks = new Map<string, Promise<void>>();

/**
 * 原子安全保存会话至本地文件。
 * 使用临时文件写入 + 0600 权限 + 原子重命名 (rename)，保证抗崩溃与无并发损坏。
 */
export async function saveSession(record: PersistedSession): Promise<void> {
  if (!isValidSessionId(record.sessionId)) {
    throw new Error(`无法保存会话: 非法会话 ID ${record.sessionId}`);
  }

  const dir = await ensureSessionsDir();
  const file = sessionFilePath(dir, record.sessionId);
  record.updatedAt = Date.now();

  // 获取该会话的顺序锁
  while (fileLocks.has(record.sessionId)) {
    try {
      await fileLocks.get(record.sessionId);
    } catch {
      break;
    }
  }

  let releaseLock: () => void = () => {};
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  fileLocks.set(record.sessionId, lockPromise);

  const tmpFile = join(dir, `.${record.sessionId}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`);

  try {
    const payload = JSON.stringify(record, null, 2);
    // 写入临时文件，权限设为 0600 (仅所有者可读写)
    await writeFile(tmpFile, payload, { encoding: 'utf8', mode: 0o600 });
    try {
      await chmod(tmpFile, 0o600);
    } catch {
      // 忽略 Windows 上非严格 chmod 错误
    }

    // 原子重命名替换目标文件（Windows 上若遇暂时冲突进行微重试）
    let replaced = false;
    for (let i = 0; i < 5; i++) {
      try {
        await rename(tmpFile, file);
        replaced = true;
        break;
      } catch (e: any) {
        if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EEXIST' || e.code === 'EBUSY')) {
          await new Promise((r) => setTimeout(r, 20 * (i + 1)));
          continue;
        }
        throw e;
      }
    }
    if (!replaced) {
      await rename(tmpFile, file);
    }
  } catch (err) {
    try {
      if (existsSync(tmpFile)) {
        await unlink(tmpFile);
      }
    } catch {
      // 忽略清理临时文件异常
    }
    throw new Error(`保存会话文件失败 (${record.sessionId}): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    fileLocks.delete(record.sessionId);
    releaseLock();
  }
}

/**
 * 读取本地持久化会话记录。
 * 若文件不存在或损坏，返回 null，不抛出异常。
 */
export async function readSession(sessionId: string): Promise<PersistedSession | null> {
  if (!isValidSessionId(sessionId)) {
    return null;
  }
  const dir = await ensureSessionsDir();
  const file = sessionFilePath(dir, sessionId);
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as PersistedSession;
    if (parsed && typeof parsed === 'object' && parsed.sessionId === sessionId) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 遍历列出已保存的会话概要，按更新时间倒序排列。
 * 可选传入工作区 cwd 进行过滤。
 */
export async function listPersistedSessions(cwdFilter?: string | null): Promise<SessionSummaryInfo[]> {
  const dir = await ensureSessionsDir();
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const results: PersistedSession[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    try {
      const raw = await readFile(join(dir, f), 'utf8');
      const item = JSON.parse(raw) as PersistedSession;
      if (item && item.sessionId && item.cwd) {
        if (!cwdFilter || normalizePath(item.cwd) === normalizePath(cwdFilter)) {
          results.push(item);
        }
      }
    } catch {
      // 忽略损坏的会话文件
    }
  }

  // 按 updatedAt / createdAt 倒序排序
  results.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

  return results.map((r) => ({
    sessionId: r.sessionId,
    cwd: r.cwd,
    title: r.title || `会话 ${r.sessionId.slice(0, 8)}`,
    updatedAt: new Date(r.updatedAt || r.createdAt).toISOString(),
  }));
}

/**
 * 从父会话分叉一个新会话。
 * 新会话继承父会话的历史 turns，但生成独立的 Quick upstream threadId，支持新线程语义。
 */
export async function forkPersistedSession(
  parentSessionId: string,
  newSessionId: string,
  newCwd?: string,
): Promise<PersistedSession | null> {
  if (!isValidSessionId(parentSessionId) || !isValidSessionId(newSessionId)) {
    return null;
  }
  const parent = await readSession(parentSessionId);
  if (!parent) return null;

  const now = Date.now();
  const forked: PersistedSession = {
    sessionId: newSessionId,
    threadId: randomUUID(), // 分叉必须拥有全新的上游 Quick 线程 ID
    cwd: newCwd || parent.cwd,
    title: `分叉自 ${parent.title || parentSessionId.slice(0, 8)}`,
    createdAt: now,
    updatedAt: now,
    agentMode: parent.agentMode,
    turns: JSON.parse(JSON.stringify(parent.turns)),
  };

  await saveSession(forked);
  return forked;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}
