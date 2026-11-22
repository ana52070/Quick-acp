/**
 * Concurrency: two ACP sessions at once, each with its own gateway socket,
 * driven through the real agent over stdio.
 *
 * This is the "two conversations in codeg at the same time" case. Each session
 * must answer its OWN prompt — the failure mode to catch is crossed replies or
 * one session starving the other.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const agentPath = join(here, 'main.js');
const child = spawn(process.execPath, [agentPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, QUICK_ACP_WORKSPACE: process.cwd(), QUICK_ACP_ALLOW_SHELL: '1' },
});
child.stderr.on('data', () => { });
let nextId = 1;
const pending = new Map();
const chunks = new Map(); // sessionId -> text
let buf = '';
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
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
            const fn = pending.get(msg.id);
            pending.delete(msg.id);
            fn(msg);
        }
        else if (msg.method === 'session/update') {
            const p = (msg.params ?? {});
            const u = (p['update'] ?? {});
            const content = (u['content'] ?? {});
            const sessionId = typeof p['sessionId'] === 'string' ? p['sessionId'] : '';
            if (u['sessionUpdate'] === 'agent_message_chunk' && typeof content['text'] === 'string') {
                chunks.set(sessionId, (chunks.get(sessionId) ?? '') + content['text']);
            }
        }
    }
});
function send(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((res, rej) => {
        pending.set(id, res);
        setTimeout(() => {
            if (pending.delete(id))
                rej(new Error(`timeout: ${method}`));
        }, 300_000);
    });
}
await send('initialize', { protocolVersion: 1, clientCapabilities: {} });
const aRes = await send('session/new', { cwd: process.cwd(), mcpServers: [] });
const bRes = await send('session/new', { cwd: process.cwd(), mcpServers: [] });
const a = String(aRes.result?.['sessionId'] ?? '');
const b = String(bRes.result?.['sessionId'] ?? '');
console.log('session A:', a);
console.log('session B:', b);
console.log('');
console.log('prompting both concurrently...');
const t0 = Date.now();
const [ra, rb] = await Promise.all([
    send('session/prompt', { sessionId: a, prompt: [{ type: 'text', text: 'Reply with exactly: SESSIONA' }] }),
    send('session/prompt', { sessionId: b, prompt: [{ type: 'text', text: 'Reply with exactly: SESSIONB' }] }),
]);
const ms = Date.now() - t0;
await new Promise((r) => setTimeout(r, 800));
const textA = (chunks.get(a) ?? '').trim();
const textB = (chunks.get(b) ?? '').trim();
console.log('');
console.log('elapsed      :', ms, 'ms');
console.log('A stopReason :', ra.result?.['stopReason']);
console.log('B stopReason :', rb.result?.['stopReason']);
console.log('A text       :', JSON.stringify(textA));
console.log('B text       :', JSON.stringify(textB));
console.log('');
const okA = textA.toUpperCase().includes('SESSIONA');
const okB = textB.toUpperCase().includes('SESSIONB');
const crossed = textA.toUpperCase().includes('SESSIONB') || textB.toUpperCase().includes('SESSIONA');
if (okA && okB && !crossed) {
    console.log('*** CONCURRENT SESSIONS WORK — no crossed replies ***');
}
else {
    console.log('FAILED  A_ok=' + okA + ' B_ok=' + okB + ' crossed=' + crossed);
    process.exitCode = 1;
}
child.kill();
//# sourceMappingURL=concurrent-test.js.map