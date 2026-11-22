#!/usr/bin/env node
/**
 * ACP handshake smoke test.
 *
 * Launches the built agent over stdio and drives the ACP methods a client calls
 * before it ever reaches a prompt turn. This proves the adaptor is wire-correct
 * WITHOUT a Quick account, because none of these methods touch the gateway.
 *
 * What it does NOT prove: that `newSession`/`prompt` reach the gateway. Those
 * need a live Quick session and are the documented next step.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const agentPath = join(here, 'main.js');
let nextId = 1;
const pending = new Map();
function send(child, method, params) {
    const id = nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    child.stdin?.write(`${JSON.stringify(msg)}\n`);
    return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => {
            if (!pending.has(id))
                return;
            pending.delete(id);
            reject(new Error(`timeout waiting for ${method}`));
        }, 10_000);
    });
}
async function main() {
    console.log('ACP handshake smoke test');
    console.log('');
    const child = spawn(process.execPath, [agentPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, QUICK_ACP_WORKSPACE: process.cwd() },
    });
    let buffer = '';
    child.stdout?.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                console.error('  (non-JSON line on stdout:', line.slice(0, 120), ')');
                continue;
            }
            if (typeof msg.id === 'number' && pending.has(msg.id)) {
                const resolve = pending.get(msg.id);
                pending.delete(msg.id);
                resolve(msg);
            }
        }
    });
    let stderr = '';
    child.stderr?.on('data', (c) => {
        stderr += c.toString('utf8');
    });
    let failures = 0;
    const check = async (name, fn) => {
        try {
            await fn();
            console.log(`  ok   ${name}`);
        }
        catch (e) {
            failures++;
            console.log(`  FAIL ${name}`);
            console.log(`       ${e instanceof Error ? e.message : String(e)}`);
        }
    };
    await check('initialize negotiates protocol version and capabilities', async () => {
        const resp = await send(child, 'initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        });
        if (resp.error)
            throw new Error(`error: ${JSON.stringify(resp.error)}`);
        const result = resp.result;
        if (!result)
            throw new Error('no result');
        if (typeof result['protocolVersion'] !== 'number')
            throw new Error('protocolVersion missing');
        const caps = result['agentCapabilities'];
        if (!caps)
            throw new Error('agentCapabilities missing');
        if (typeof caps['loadSession'] !== 'boolean') {
            throw new Error('loadSession should be boolean');
        }
    });
    await check('session/set_model is refused with a real reason, not a fake success', async () => {
        const resp = await send(child, 'session/set_model', {
            sessionId: 'nope',
            modelId: 'claude-opus-5.5',
        });
        if (!resp.error)
            throw new Error('expected an error, got success');
        const msg = String(resp.error.message ?? '');
        if (!/model selection/i.test(msg)) {
            throw new Error(`unexpected refusal reason: ${msg}`);
        }
        // Must be OUR refusal, not the SDK's generic "Method not found".
        if (/method not found/i.test(msg)) {
            throw new Error('handler was not routed: SDK reported Method not found');
        }
    });
    await check('session/set_mode validates the mode id', async () => {
        const resp = await send(child, 'session/set_mode', {
            sessionId: 'nope',
            modeId: 'smart',
        });
        // Unknown session must be refused before mode validation.
        if (!resp.error)
            throw new Error('expected an error for an unknown session');
        if (/method not found/i.test(String(resp.error.message))) {
            throw new Error('handler was not routed');
        }
    });
    await check('unknown method returns method-not-found, not a hang', async () => {
        const resp = await send(child, 'no/such/method', {});
        if (!resp.error)
            throw new Error('expected an error');
    });
    await check('prompt on an unknown session is refused cleanly', async () => {
        const resp = await send(child, 'session/prompt', {
            sessionId: 'does-not-exist',
            prompt: [{ type: 'text', text: 'hi' }],
        });
        if (!resp.error)
            throw new Error('expected an error');
    });
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    console.log('');
    if (failures === 0) {
        console.log('ACP adaptor is wire-correct for the pre-session methods.');
        console.log('Next: provide a Quick session and run a real prompt.');
    }
    else {
        console.log(`${failures} check(s) FAILED`);
        process.exitCode = 1;
    }
    if (stderr.trim()) {
        console.log('');
        console.log('agent stderr (first lines):');
        console.log(stderr
            .trim()
            .split('\n')
            .slice(0, 6)
            .map((l) => `  ${l}`)
            .join('\n'));
    }
}
void main();
//# sourceMappingURL=acp-smoke.js.map