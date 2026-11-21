#!/usr/bin/env node
/**
 * End-to-end test: ACP prompt -> Quick gateway -> model -> ACP chunks.
 *
 * Drives the REAL agent over stdio exactly as an ACP client would, and asserts
 * that assistant text comes back. This is the test that proves the bridge works,
 * not just that its parts do.
 *
 * Requires a Quick login (uses the outpost to refresh). Not part of `verify`.
 *
 *   node dist/e2e.js
 *   node dist/e2e.js "your prompt"
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const agentPath = join(here, 'main.js');
const promptArg = process.argv.slice(2).find((a) => !a.startsWith('--'));

interface Rpc {
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  method?: string;
  params?: Record<string, unknown>;
}

let nextId = 1;
const pending = new Map<number, (r: Rpc) => void>();
const notifications: Rpc[] = [];

function send(child: ChildProcess, method: string, params: unknown): Promise<Rpc> {
  const id = nextId++;
  child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise<Rpc>((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 300_000);
  });
}

function notify(child: ChildProcess, method: string, params: unknown): void {
  child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

async function main(): Promise<void> {
  console.log('quick-acp end-to-end test');
  console.log('');

  const child = spawn(process.execPath, [agentPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      QUICK_ACP_WORKSPACE: process.cwd(),
      QUICK_ACP_ALLOW_SHELL: '1',
      QUICK_ACP_DEBUG: process.env.QUICK_ACP_DEBUG ?? '1',
    },
  });

  child.stderr?.on('data', (c: Buffer) => {
    const text = c.toString('utf8').trimEnd();
    if (text) console.log(`  [agent] ${text}`);
  });

  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        console.log('  (non-JSON stdout:', line.slice(0, 100), ')');
        continue;
      }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const r = pending.get(msg.id)!;
        pending.delete(msg.id);
        r(msg);
      } else if (msg.method) {
        notifications.push(msg);
      }
    }
  });

  let failures = 0;
  const step = async (name: string, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      console.log(`  ok   ${name}`);
      return true;
    } catch (e) {
      failures++;
      console.log(`  FAIL ${name}`);
      console.log(`       ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  // 1. initialize
  const inited = await step('initialize', async () => {
    const r = await send(child, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (!r.result?.['agentCapabilities']) throw new Error('no capabilities');
  });
  if (!inited) {
    child.kill();
    process.exitCode = 1;
    return;
  }

  // 2. newSession — this opens the real gateway socket
  let sessionId = '';
  const created = await step('session/new (opens the gateway)', async () => {
    const r = await send(child, 'session/new', { cwd: process.cwd(), mcpServers: [] });
    if (r.error) throw new Error(`error: ${r.error.message}`);
    const id = r.result?.['sessionId'];
    if (typeof id !== 'string' || !id) throw new Error('no sessionId returned');
    sessionId = id;
  });
  if (!created) {
    child.kill();
    process.exitCode = 1;
    return;
  }

  // 3. prompt — the real turn
  const prompt =
    promptArg ?? 'Reply with exactly the single word: PONG. No tools, no punctuation.';
  let assistantText = '';
  let usage = '';

  console.log('');
  console.log(`  > prompt: ${prompt}`);
  const replied = await step('session/prompt returns assistant text', async () => {
    // Collect notifications concurrently with the request.
    const collector = setInterval(() => {
      for (const n of notifications.splice(0)) {
        const p = n.params as Record<string, unknown> | undefined;
        const update = p?.['update'] as Record<string, unknown> | undefined;
        if (update?.['sessionUpdate'] === 'agent_message_chunk') {
          const content = update['content'] as Record<string, unknown> | undefined;
          if (typeof content?.['text'] === 'string') assistantText += content['text'];
        }
      }
    }, 100);

    try {
      const r = await send(child, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      if (r.error) throw new Error(`error: ${r.error.message}`);
      const stop = r.result?.['stopReason'];
      if (stop === 'cancelled') throw new Error('turn was cancelled');
    } finally {
      clearInterval(collector);
      // Drain any remaining notifications.
      for (const n of notifications.splice(0)) {
        const p = n.params as Record<string, unknown> | undefined;
        const update = p?.['update'] as Record<string, unknown> | undefined;
        if (update?.['sessionUpdate'] === 'agent_message_chunk') {
          const content = update['content'] as Record<string, unknown> | undefined;
          if (typeof content?.['text'] === 'string') assistantText += content['text'];
        }
      }
    }
  });

  console.log('');
  console.log('  assistant text:', assistantText ? JSON.stringify(assistantText) : '(empty)');
  if (usage) console.log('  usage:', usage);

  if (replied && assistantText.trim().length > 0) {
    console.log('');
    console.log('*** END-TO-END SUCCESS ***');
    console.log('*** ACP client -> quick-acp -> Quick gateway -> model -> ACP chunks ***');
  } else if (replied) {
    console.log('');
    console.log('Turn completed but no assistant text arrived.');
    failures++;
    process.exitCode = 1;
  }

  // 4. cancel path must not throw
  await step('session/cancel is accepted', async () => {
    notify(child, 'session/cancel', { sessionId });
  });

  child.kill();
  await new Promise((r) => setTimeout(r, 300));

  console.log('');
  if (failures === 0) console.log('all e2e steps passed');
  else {
    console.log(`${failures} step(s) FAILED`);
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error('fatal:', e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
