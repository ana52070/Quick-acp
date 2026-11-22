/**
 * Regression: session ids must not collide across agent restarts.
 *
 * The bug this locks down: ids were `quick-1`, `quick-2`, … from a counter that
 * reset to 1 on every process start. codeg binds a session id to a conversation
 * and refuses to rebind it, so the second conversation ever opened got
 * "agent session quick-1 is already bound to conversation 770" and could never
 * send a message.
 *
 * Runs the REAL agent twice (two separate processes, like two app restarts) and
 * asserts the ids differ.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const agentPath = join(here, 'main.js');
/** Start an agent, create one session, return its id, and stop the agent. */
async function oneRun(label) {
    const child = spawn(process.execPath, [agentPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, QUICK_ACP_WORKSPACE: process.cwd() },
    });
    child.stderr.on('data', () => { });
    let buf = '';
    const waiters = new Map();
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
        }
    });
    const send = (id, method, params) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        return new Promise((res, rej) => {
            waiters.set(id, res);
            setTimeout(() => rej(new Error(`timeout: ${method}`)), 120_000);
        });
    };
    await send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
    const ns = await send(2, 'session/new', { cwd: process.cwd(), mcpServers: [] });
    if (ns.error)
        throw new Error(`${label}: session/new failed: ${ns.error.message}`);
    const id = String(ns.result?.['sessionId'] ?? '');
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    return id;
}
let failures = 0;
const check = (name, ok, detail = '') => {
    if (ok)
        console.log(`  ok   ${name}`);
    else {
        failures++;
        console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
};
console.log('quick-acp session id uniqueness');
console.log('');
const ids = [];
for (const label of ['run 1', 'run 2', 'run 3']) {
    const id = await oneRun(label);
    ids.push(id);
    console.log(`  ${label}: ${id}`);
}
console.log('');
check('every session got an id', ids.every((i) => i.length > 0));
check('ids are unique across separate agent processes', new Set(ids).size === ids.length, `got ${JSON.stringify(ids)}`);
// The old scheme produced quick-1 / quick-1 / quick-1 here.
check('ids are not the old process-local counter form', !ids.every((i) => /^quick-\d+$/.test(i)) || new Set(ids).size === ids.length);
check('ids look like Quick thread ids (UUID)', ids.every((i) => /^[0-9a-f-]{36}$/i.test(i)));
console.log('');
if (failures === 0)
    console.log('all session-id checks passed');
else {
    console.log(`${failures} check(s) FAILED`);
    process.exitCode = 1;
}
//# sourceMappingURL=session-id-test.js.map