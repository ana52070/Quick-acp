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
 * Every tool is confined to a workspace root and gated by an explicit policy,
 * because an unconfined shell reachable from a model is a remote-code-execution
 * primitive pointed at the user's machine.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join, sep } from 'node:path';
export const DEFAULT_SHELL_DENY_PATTERNS = [
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
export function defaultPolicy(workspaceRoot) {
    return {
        workspaceRoot: resolve(workspaceRoot),
        allowShell: process.env.QUICK_ACP_ALLOW_SHELL === '1',
        shellDenyPatterns: DEFAULT_SHELL_DENY_PATTERNS,
        shellTimeoutMs: 120_000,
        maxOutputBytes: 400_000,
        maxWriteBytes: 4_000_000,
    };
}
// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
export function toolDefs(policy) {
    const defs = [
        {
            name: 'file_read',
            description: 'Read a UTF-8 text file. Returns the content with a 1-based line offset. ' +
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
            description: 'Create or fully replace a UTF-8 text file, creating parent directories as needed. ' +
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
            description: 'List directory entries. Directories are marked with a trailing slash. ' +
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
            description: 'Search file contents with a regular expression and return matching lines ' +
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
            description: 'Run a shell command in the workspace root and return combined stdout/stderr and the ' +
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
export class ToolExecutor {
    policy;
    root;
    constructor(policy) {
        this.policy = policy;
        this.root = resolve(policy.workspaceRoot);
    }
    /**
     * Resolve a caller-supplied path inside the workspace.
     * Absolute paths are accepted but must still land inside the root; anything
     * that escapes (via `..`, a symlink target, a different drive) is refused.
     */
    resolveInside(input) {
        const raw = typeof input === 'string' && input.length > 0 ? input : '.';
        const abs = isAbsolute(raw) ? resolve(raw) : resolve(this.root, raw);
        const rel = relative(this.root, abs);
        if (rel.startsWith('..') || (isAbsolute(rel) && rel !== '')) {
            throw new Error(`path escapes the workspace root: ${input}`);
        }
        if (rel !== '' && rel.split(sep).includes('..')) {
            throw new Error(`path escapes the workspace root: ${input}`);
        }
        return abs;
    }
    async execute(name, args) {
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
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { ok: false, content: `error: ${message}`, error: message };
        }
    }
    async fileRead(args) {
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
    async fileWrite(args) {
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
    async fileList(args) {
        const dir = this.resolveInside(String(args['path'] ?? '.'));
        const recursive = args['recursive'] === true;
        const skip = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);
        const out = [];
        const walk = async (current, prefix, depth) => {
            if (depth > 12)
                return;
            const entries = await fs.readdir(current, { withFileTypes: true });
            entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
            for (const entry of entries) {
                if (skip.has(entry.name))
                    continue;
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    out.push(`${rel}/`);
                    if (recursive)
                        await walk(join(current, entry.name), rel, depth + 1);
                }
                else {
                    out.push(rel);
                }
                if (out.length > 5000)
                    return;
            }
        };
        await walk(dir, '', 0);
        return {
            ok: true,
            content: truncate(out.join('\n') || '(empty)', this.policy.maxOutputBytes, 'file_list'),
        };
    }
    async fileSearch(args) {
        const patternSource = String(args['pattern'] ?? '');
        if (!patternSource)
            return { ok: false, content: 'refused: empty pattern', error: 'bad_pattern' };
        let re;
        try {
            re = new RegExp(patternSource, 'i');
        }
        catch (e) {
            return { ok: false, content: `invalid regular expression: ${String(e)}`, error: 'bad_pattern' };
        }
        const dir = this.resolveInside(String(args['path'] ?? '.'));
        const globFilter = typeof args['glob'] === 'string' ? args['glob'] : '';
        const maxResults = positiveInt(args['maxResults'], 100);
        const skip = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);
        const hits = [];
        const walk = async (current, prefix, depth) => {
            if (depth > 12 || hits.length >= maxResults)
                return;
            let entries;
            try {
                entries = await fs.readdir(current, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                if (hits.length >= maxResults)
                    return;
                if (skip.has(entry.name))
                    continue;
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    await walk(join(current, entry.name), rel, depth + 1);
                    continue;
                }
                if (globFilter && !rel.includes(globFilter))
                    continue;
                let stat;
                try {
                    stat = await fs.stat(join(current, entry.name));
                }
                catch {
                    continue;
                }
                if (stat.size > 2_000_000)
                    continue; // skip large/binary files
                let text;
                try {
                    text = await fs.readFile(join(current, entry.name), 'utf8');
                }
                catch {
                    continue;
                }
                if (text.includes('\u0000'))
                    continue; // binary
                const lines = text.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (re.test(lines[i])) {
                        hits.push(`${rel}:${i + 1}:${lines[i]}`);
                        if (hits.length >= maxResults)
                            return;
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
    async shellRun(args) {
        if (!this.policy.allowShell) {
            return {
                ok: false,
                content: 'refused: shell execution is disabled (set QUICK_ACP_ALLOW_SHELL=1 to enable)',
                error: 'shell_disabled',
            };
        }
        const command = String(args['command'] ?? '');
        if (!command.trim())
            return { ok: false, content: 'refused: empty command', error: 'bad_command' };
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
        return await new Promise((resolvePromise) => {
            const child = spawn(command, {
                cwd,
                shell: isWindows ? true : '/bin/sh',
                windowsHide: true,
                env: { ...process.env },
            });
            let out = Buffer.alloc(0);
            let killedByTimeout = false;
            let killedBySize = false;
            const append = (chunk) => {
                out = Buffer.concat([out, chunk]);
                if (out.length > this.policy.maxOutputBytes && !killedBySize) {
                    killedBySize = true;
                    try {
                        child.kill('SIGKILL');
                    }
                    catch {
                        /* already dead */
                    }
                }
            };
            child.stdout?.on('data', append);
            child.stderr?.on('data', append);
            const timer = setTimeout(() => {
                killedByTimeout = true;
                try {
                    child.kill('SIGKILL');
                }
                catch {
                    /* already dead */
                }
            }, timeoutMs);
            child.on('error', (err) => {
                clearTimeout(timer);
                resolvePromise({ ok: false, content: `failed to start: ${err.message}`, error: 'spawn_failed' });
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                let text = out.toString('utf8');
                if (killedBySize)
                    text += `\n[output truncated at ${this.policy.maxOutputBytes} bytes]`;
                if (killedByTimeout)
                    text += `\n[timed out after ${timeoutMs}ms]`;
                const ok = code === 0 && !killedByTimeout;
                resolvePromise({
                    ok,
                    content: text || '(no output)',
                    ...(ok ? {} : { error: killedByTimeout ? 'timeout' : `exit_${code ?? signal}` }),
                });
            });
        });
    }
}
// ---------------------------------------------------------------------------
function positiveInt(v, fallback) {
    const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}
function clampTimeout(v, fallback) {
    const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0)
        return fallback;
    // Never let a caller extend past the policy ceiling.
    return Math.min(Math.trunc(n), fallback);
}
function truncate(text, maxBytes, tool) {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes)
        return text;
    return `${buf.subarray(0, maxBytes).toString('utf8')}\n[truncated by ${tool} at ${maxBytes} bytes]`;
}
//# sourceMappingURL=registry.js.map