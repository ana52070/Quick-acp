/**
 * Tool registry and local execution.
 *
 * SCOPE DECISION (matches the referenced guide):
 * Quick already ships file read/write/list/search and apply_patch on the
 * desktop surface — `desktop_windows.yaml` is `default_available: true`, so
 * those tools are on by default. Re-implementing them here would only create a
 * second, worse copy.
 *
 * What Quick does NOT give us is local shell execution: `device_shell` sits
 * behind three gates (code_mode_enabled, outpost capability `deviceShell`,
 * sandbox.available), and the guide's whole point is that people bolt on an
 * external MCP server to get a shell. So:
 *
 *   - shell_run       NEW  — the actual gap this bridge fills
 *   - file_read       NEW  — kept for turn-efficiency: one call instead of
 *                            asking Quick to route it through its own loop
 *   - file_write      NEW
 *   - file_list       NEW
 *   - file_search     NEW
 *
 * Every tool runs on the user's own machine with the user's own privileges. The
 * only hard block is a deny-list of destructive commands (see below); there is
 * no folder jail, because a shell that can `cd` anywhere makes one meaningless.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join, sep } from 'node:path';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for arguments (as ACP/MCP both consume JSON Schema). */
  inputSchema: Record<string, unknown>;
}

export interface ToolPolicy {
  /** Every path argument must resolve inside this directory. */
  workspaceRoot: string;
  /** Enable shell_run. Off unless explicitly turned on. */
  allowShell: boolean;
  /** Shell commands matching any of these are refused outright. */
  shellDenyPatterns: RegExp[];
  /** Hard ceiling on one shell command. */
  shellTimeoutMs: number;
  /** Max bytes returned from any single tool call. */
  maxOutputBytes: number;
  /** Max bytes a file_write may create. */
  maxWriteBytes: number;
}

export const DEFAULT_SHELL_DENY_PATTERNS: RegExp[] = [
  // Destructive filesystem operations that are almost never what a coding
  // agent meant, and are unrecoverable when wrong.
  /\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/,
  /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]*\s+)*~\//,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+.*\bof=\/dev\//,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  // Privilege escalation: the bridge never needs it, and it would let a model
  // escape the workspace jail entirely.
  /\bsudo\b/,
  /\b(chmod|chown)\s+[ugoa+=-]*\s*\+?[rwxXst]*\s*\/(\s|$)/,
  // Piping a download straight into an interpreter. Real supply-chain hazard.
  /\b(curl|wget)\b[^|]*\|\s*(ba|z|k|da)?sh\b/,
];

/**
 * Default policy for a workspace.
 *
 * SHELL IS ON BY DEFAULT — this is a deliberate change.
 *
 * It started off requiring QUICK_ACP_ALLOW_SHELL=1, on the reasoning that an
 * unconfined shell is an RCE primitive. But that only holds if the user could
 * turn it on, and most ACP clients give a custom agent no field for env vars.
 * So the flag could not be set, shell_run was never advertised, and the model
 * told the user "I have no tool to run commands" — indistinguishable from a
 * broken bridge, and that is exactly what happened in practice.
 *
 * There is NO workspace jail either. See `resolveInside` for why: shell_run can
 * reach anywhere the user can, so jailing the file tools while leaving the shell
 * open buys nothing but broken requests. The deny-list stays, because it blocks
 * destruction the user would not want regardless of folder.
 *
 * `QUICK_ACP_ALLOW_SHELL=0` disables execution outright for anyone who wants it.
 */
export function defaultPolicy(workspaceRoot: string): ToolPolicy {
  return {
    workspaceRoot: resolve(workspaceRoot),
    allowShell: process.env.QUICK_ACP_ALLOW_SHELL !== '0',
    shellDenyPatterns: DEFAULT_SHELL_DENY_PATTERNS,
    shellTimeoutMs: 120_000,
    maxOutputBytes: 400_000,
    maxWriteBytes: 4_000_000,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function toolDefs(policy: ToolPolicy): ToolDef[] {
  const defs: ToolDef[] = [
    {
      name: 'file_read',
      description:
        'Read a UTF-8 text file. Returns the content with a 1-based line offset. ' +
        'Paths are relative to the workspace root.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the workspace root.' },
          offset: { type: 'number', description: '1-based first line to return. Default 1.' },
          limit: { type: 'number', description: 'Maximum lines to return. Default 2000.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'file_write',
      description:
        'Create or fully replace a UTF-8 text file, creating parent directories as needed. ' +
        'This replaces the whole file; it does not append.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the workspace root.' },
          content: { type: 'string', description: 'Full new file content.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'file_list',
      description:
        'List directory entries. Directories are marked with a trailing slash. ' +
        'Skips node_modules and .git by default.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory, relative to the workspace root. Default ".".' },
          recursive: { type: 'boolean', description: 'Walk subdirectories. Default false.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'file_search',
      description:
        'Search file contents with a regular expression and return matching lines ' +
        'as path:line:text. Bounded by maxResults and a size cap per file.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression source.' },
          path: { type: 'string', description: 'Directory to search. Default ".".' },
          glob: { type: 'string', description: 'Only consider files whose path contains this substring.' },
          maxResults: { type: 'number', description: 'Maximum matches. Default 100.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  ];

  if (policy.allowShell) {
    defs.push({
      name: 'shell_run',
      description:
        'Run a shell command in the workspace root and return combined stdout/stderr and the ' +
        'exit code. Runs through the platform shell, so quoting follows that shell. ' +
        'Bounded by a timeout; destructive and privilege-escalating commands are refused.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run.' },
          cwd: { type: 'string', description: 'Working directory, relative to the workspace root. Default ".".' },
          timeoutMs: { type: 'number', description: 'Override the default timeout in milliseconds.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    });
  }

  return defs;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ToolResult {
  ok: boolean;
  /** Content returned to the model. */
  content: string;
  /** Set when ok is false, for diagnostics. */
  error?: string;
}

export class ToolExecutor {
  private readonly root: string;

  constructor(private policy: ToolPolicy) {
    this.root = resolve(policy.workspaceRoot);
  }

  /**
   * Resolve a caller-supplied path.
   *
   * NO JAIL — deliberately. This used to refuse anything outside the workspace
   * root, on the reasoning that an unconfined file tool is dangerous. But
   * `shell_run` is part of the same tool set and can read and write anywhere the
   * user can, so the jail only restricted the *convenient* path while leaving
   * the powerful one wide open. That is a false sense of safety: it stops honest
   * requests ("read the file I just mentioned in another folder") and stops
   * nothing a model could do with one shell command.
   *
   * A relative path is still resolved against the session's workspace, which is
   * what makes "the path I picked in the client" work naturally.
   */
  private resolveInside(input: string): string {
    const raw = typeof input === 'string' && input.length > 0 ? input : '.';
    return isAbsolute(raw) ? resolve(raw) : resolve(this.root, raw);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'file_read':
          return await this.fileRead(args);
        case 'file_write':
          return await this.fileWrite(args);
        case 'file_list':
          return await this.fileList(args);
        case 'file_search':
          return await this.fileSearch(args);
        case 'shell_run':
          return await this.shellRun(args);
        default:
          return { ok: false, content: `unknown tool: ${name}`, error: 'unknown_tool' };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, content: `error: ${message}`, error: message };
    }
  }

  private async fileRead(args: Record<string, unknown>): Promise<ToolResult> {
    const path = this.resolveInside(String(args['path'] ?? ''));
    const offset = positiveInt(args['offset'], 1);
    const limit = positiveInt(args['limit'], 2000);
    const text = await fs.readFile(path, 'utf8');
    const lines = text.split(/\r?\n/);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
    return {
      ok: true,
      content: truncate(numbered, this.policy.maxOutputBytes, 'file_read'),
    };
  }

  private async fileWrite(args: Record<string, unknown>): Promise<ToolResult> {
    const path = this.resolveInside(String(args['path'] ?? ''));
    const content = String(args['content'] ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.policy.maxWriteBytes) {
      return {
        ok: false,
        content: `refused: content is ${bytes} bytes, over the ${this.policy.maxWriteBytes} byte limit`,
        error: 'write_too_large',
      };
    }
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, content, 'utf8');
    return { ok: true, content: `wrote ${bytes} bytes to ${relative(this.root, path)}` };
  }

  private async fileList(args: Record<string, unknown>): Promise<ToolResult> {
    const dir = this.resolveInside(String(args['path'] ?? '.'));
    const recursive = args['recursive'] === true;
    const skip = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);
    const out: string[] = [];

    const walk = async (current: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 12) return;
      const entries = await fs.readdir(current, { withFileTypes: true });
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (skip.has(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          out.push(`${rel}/`);
          if (recursive) await walk(join(current, entry.name), rel, depth + 1);
        } else {
          out.push(rel);
        }
        if (out.length > 5000) return;
      }
    };

    await walk(dir, '', 0);
    return {
      ok: true,
      content: truncate(out.join('\n') || '(empty)', this.policy.maxOutputBytes, 'file_list'),
    };
  }

  private async fileSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const patternSource = String(args['pattern'] ?? '');
    if (!patternSource) return { ok: false, content: 'refused: empty pattern', error: 'bad_pattern' };
    let re: RegExp;
    try {
      re = new RegExp(patternSource, 'i');
    } catch (e) {
      return { ok: false, content: `invalid regular expression: ${String(e)}`, error: 'bad_pattern' };
    }
    const dir = this.resolveInside(String(args['path'] ?? '.'));
    const globFilter = typeof args['glob'] === 'string' ? args['glob'] : '';
    const maxResults = positiveInt(args['maxResults'], 100);
    const skip = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);
    const hits: string[] = [];

    const walk = async (current: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 12 || hits.length >= maxResults) return;
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (hits.length >= maxResults) return;
        if (skip.has(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(join(current, entry.name), rel, depth + 1);
          continue;
        }
        if (globFilter && !rel.includes(globFilter)) continue;
        let stat;
        try {
          stat = await fs.stat(join(current, entry.name));
        } catch {
          continue;
        }
        if (stat.size > 2_000_000) continue; // skip large/binary files
        let text: string;
        try {
          text = await fs.readFile(join(current, entry.name), 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue; // binary
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            hits.push(`${rel}:${i + 1}:${lines[i]}`);
            if (hits.length >= maxResults) return;
          }
        }
      }
    };

    await walk(dir, '', 0);
    return {
      ok: true,
      content: truncate(hits.join('\n') || '(no matches)', this.policy.maxOutputBytes, 'file_search'),
    };
  }

  private async shellRun(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.policy.allowShell) {
      return {
        ok: false,
        content: 'refused: shell execution is disabled (set QUICK_ACP_ALLOW_SHELL=1 to enable)',
        error: 'shell_disabled',
      };
    }
    const command = String(args['command'] ?? '');
    if (!command.trim()) return { ok: false, content: 'refused: empty command', error: 'bad_command' };

    for (const deny of this.policy.shellDenyPatterns) {
      if (deny.test(command)) {
        return {
          ok: false,
          content: `refused: command matches a blocked pattern (${deny.source})`,
          error: 'command_blocked',
        };
      }
    }

    const cwd = this.resolveInside(String(args['cwd'] ?? '.'));
    const timeoutMs = clampTimeout(args['timeoutMs'], this.policy.shellTimeoutMs);
    const isWindows = process.platform === 'win32';

    return await new Promise<ToolResult>((resolvePromise) => {
      const child = spawn(command, {
        cwd,
        shell: isWindows ? true : '/bin/sh',
        windowsHide: true,
        env: { ...process.env },
      });

      let out = Buffer.alloc(0);
      let killedByTimeout = false;
      let killedBySize = false;
      let settled = false;

      const settle = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      };

      const append = (chunk: Buffer): void => {
        out = Buffer.concat([out, chunk]);
        if (out.length > this.policy.maxOutputBytes && !killedBySize) {
          killedBySize = true;
          void killTree(child, child.pid);
        }
      };

      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      // WHAT A TIMEOUT HAS TO DO ON WINDOWS
      // -----------------------------------
      // `shell: true` means the real command runs under cmd.exe, so it is a
      // GRANDCHILD of this process. Killing the child leaves the grandchild
      // alive, still holding the stdout pipe — and `close` fires only when every
      // holder of that pipe is gone. Result: `kill('SIGKILL')` returns true, the
      // process keeps running, and this promise never settles. That is a
      // permanently hung tool call: it is exactly how "python snake.py" (a GUI
      // app that never exits) froze a conversation with no error at all.
      //
      // So kill the whole tree, and keep a hard backstop: if `close` still has
      // not fired shortly after the kill, settle anyway with what we captured.
      const timer = setTimeout(() => {
        killedByTimeout = true;
        void killTree(child, child.pid);
        setTimeout(() => {
          settle({
            ok: false,
            content: `${out.toString('utf8')}\n[timed out after ${timeoutMs}ms and did not exit]`,
            error: 'timeout',
          });
        }, 2_000);
      }, timeoutMs);

      child.on('error', (err) => {
        settle({ ok: false, content: `failed to start: ${err.message}`, error: 'spawn_failed' });
      });

      child.on('close', (code, signal) => {
        let text = out.toString('utf8');
        if (killedBySize) text += `\n[output truncated at ${this.policy.maxOutputBytes} bytes]`;
        if (killedByTimeout) text += `\n[timed out after ${timeoutMs}ms]`;
        const ok = code === 0 && !killedByTimeout;
        settle({
          ok,
          content: text || '(no output)',
          ...(ok ? {} : { error: killedByTimeout ? 'timeout' : `exit_${code ?? signal}` }),
        });
      });
    });
  }
}

/**
 * Kill a process and everything it spawned.
 *
 * On Windows `child.kill()` only signals the shell we launched; a grandchild
 * survives it, keeps the stdout pipe open, and prevents the `close` event from
 * ever firing. `taskkill /T` walks the tree. Elsewhere, killing the process
 * group (`-pid`) takes the children with it.
 */
function killTree(child: ChildProcess, pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve();

  if (process.platform === 'win32') {
    return new Promise<void>((done) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('close', () => done());
      killer.on('error', () => {
        // taskkill missing or refused: fall back to the single-process kill so
        // the caller's backstop timer still settles the call.
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        done();
      });
    });
  }

  try {
    // Negative pid == the process group, so children die too.
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
  return Promise.resolve();
}

// ---------------------------------------------------------------------------

function positiveInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function clampTimeout(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Never let a caller extend past the policy ceiling.
  return Math.min(Math.trunc(n), fallback);
}

function truncate(text: string, maxBytes: number, tool: string): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n[truncated by ${tool} at ${maxBytes} bytes]`;
}
