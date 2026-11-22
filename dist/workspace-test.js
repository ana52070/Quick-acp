/**
 * Two sessions on two different folders must be jailed to their own.
 *
 * The bug this locks down: the tool policy was built ONCE in the constructor
 * from process.cwd(), and `session/new`'s `cwd` was only stored for display. So
 * every conversation's tools ran against the agent's own working directory
 * instead of the folder the user picked — which mostly looked fine by accident
 * (both were the same folder during development) and would leak across
 * conversations as soon as two folders were open.
 *
 * Runs the real agent, opens two sessions with different cwds, asks each to run
 * `pwd`/`cd` via shell_run, and checks each reply names ITS OWN folder.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const here = dirname(fileURLToPath(import.meta.url));
const agentPath = join(here, 'main.js');
// Two throwaway folders with distinguishable names.
const base = await mkdtemp(join(tmpdir(), 'quick-acp-cwd-'));
const dirA = join(base, 'project-alpha');
const dirB = join(base, 'project-bravo');
await mkdir(dirA, { recursive: true });
await mkdir(dirB, { recursive: true });
const child = spawn(process.execPath, [agentPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Deliberately start the agent somewhere ELSE, so a fallback to process.cwd()
    // cannot accidentally pass this test.
    cwd: tmpdir(),
    env: { ...process.env, QUICK_ACP_ALLOW_SHELL: '1' },
});
child.stderr.on('data', () => { });
let buf = '';
const pending = new Map();
const chunks = new Map();
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
            const sid = typeof p['sessionId'] === 'string' ? p['sessionId'] : '';
            if (u['sessionUpdate'] === 'agent_message_chunk' && typeof content['text'] === 'string') {
                chunks.set(sid, (chunks.get(sid) ?? '') + content['text']);
            }
        }
    }
});
function send(method, params) {
    const id = Math.floor(Math.random() * 1e9);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((res, rej) => {
        pending.set(id, res);
        setTimeout(() => rej(new Error(`timeout: ${method}`)), 240_000);
    });
}
await send('initialize', { protocolVersion: 1, clientCapabilities: {} });
const a = String((await send('session/new', { cwd: dirA, mcpServers: [] })).result?.['sessionId'] ?? '');
const b = String((await send('session/new', { cwd: dirB, mcpServers: [] })).result?.['sessionId'] ?? '');
console.log('session A cwd:', dirA);
console.log('session B cwd:', dirB);
console.log('');
const ask = 'Run the shell command `cd` (on Windows: `cd`) and reply with ONLY the resulting path.';
await send('session/prompt', { sessionId: a, prompt: [{ type: 'text', text: ask }] });
await send('session/prompt', { sessionId: b, prompt: [{ type: 'text', text: ask }] });
await new Promise((r) => setTimeout(r, 600));
const textA = (chunks.get(a) ?? '').trim();
const textB = (chunks.get(b) ?? '').trim();
console.log('A replied:', JSON.stringify(textA.slice(0, 200)));
console.log('B replied:', JSON.stringify(textB.slice(0, 200)));
console.log('');
let failures = 0;
const check = (name, ok) => {
    if (ok)
        console.log(`  ok   ${name}`);
    else {
        failures++;
        console.log(`  FAIL ${name}`);
    }
};
check('session A saw its own folder', textA.includes('project-alpha'));
check('session A did NOT see session B folder', !textA.includes('project-bravo'));
check('session B saw its own folder', textB.includes('project-bravo'));
check('session B did NOT see session A folder', !textB.includes('project-alpha'));
child.kill();
console.log('');
if (failures === 0)
    console.log('per-session workspace works');
else {
    console.log(`${failures} check(s) FAILED`);
    process.exitCode = 1;
}
//# sourceMappingURL=workspace-test.js.map