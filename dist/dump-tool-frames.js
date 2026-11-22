/**
 * Dump the EXACT ACP notifications our agent emits for a tool call.
 *
 * "Enrichment failed for 'file_write'" comes from codeg, not from us, so the
 * question is what it was given. This captures the raw session/update JSON as a
 * client would receive it, byte for byte, with no filtering.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const here = dirname(fileURLToPath(import.meta.url));
const agentPath = join(here, 'main.js');
const work = await mkdtemp(join(tmpdir(), 'quick-acp-dump-'));
const child = spawn(process.execPath, [agentPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: work,
    env: { ...process.env, QUICK_ACP_ALLOW_SHELL: '1' },
});
child.stderr.on('data', () => { });
let buf = '';
const waiters = new Map();
const updates = [];
child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line)
            continue;
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (typeof msg.id === 'number' && waiters.has(msg.id)) {
            const fn = waiters.get(msg.id);
            waiters.delete(msg.id);
            fn(msg);
        }
        else if (msg.method === 'session/update') {
            updates.push(msg.params);
        }
    }
});
function send(method, params) {
    const id = Math.floor(Math.random() * 1e9);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((res, rej) => {
        waiters.set(id, res);
        setTimeout(() => rej(new Error(`timeout: ${method}`)), 240_000);
    });
}
await send('initialize', { protocolVersion: 1, clientCapabilities: {} });
const sid = String((await send('session/new', { cwd: work, mcpServers: [] })).result?.['sessionId'] ?? '');
await send('session/prompt', {
    sessionId: sid,
    prompt: [{ type: 'text', text: 'Create a file named hello.txt containing exactly: hi' }],
});
// Print only the tool-related updates, fully expanded.
const toolUpdates = updates.filter((u) => {
    const rec = u;
    const up = (rec['update'] ?? {});
    const k = String(up['sessionUpdate'] ?? '');
    return k.startsWith('tool_call');
});
console.log('tool-related session/update frames:', toolUpdates.length);
console.log('');
for (const u of toolUpdates) {
    console.log(JSON.stringify(u, null, 2));
    console.log('---');
}
child.kill();
//# sourceMappingURL=dump-tool-frames.js.map