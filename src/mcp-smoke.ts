#!/usr/bin/env node
/**
 * MCP server smoke test.
 *
 * Launches the built MCP server over stdio and drives the JSON-RPC methods
 * Quick calls: initialize, tools/list, tools/call, ping. This proves the
 * registration payload will resolve to a working server WITHOUT a Quick
 * account, because the server is just a normal MCP process.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, 'mcp-main.js');

interface RpcResponse {
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let nextId = 1;
const pending = new Map<number, (r: RpcResponse) => void>();

function send(child: ChildProcess, method: string, params?: unknown): Promise<RpcResponse> {
  const id = nextId++;
  child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise<RpcResponse>((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 10_000);
  });
}

async function main(): Promise<void> {
  console.log('MCP server smoke test');
  console.log('');

  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      QUICK_ACP_WORKSPACE: process.cwd(),
      QUICK_ACP_ALLOW_SHELL: '1',
    },
  });

  let buffer = '';
  child.stdout?.on('data', (c: Buffer) => {
    buffer += c.toString('utf8');
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg: RpcResponse;
      try {
        msg = JSON.parse(line) as RpcResponse;
      } catch {
        console.error('  (non-JSON on stdout:', line.slice(0, 120), ')');
        continue;
      }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const r = pending.get(msg.id)!;
        pending.delete(msg.id);
        r(msg);
      }
    }
  });

  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });

  let failures = 0;
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (e) {
      failures++;
      console.log(`  FAIL ${name}`);
      console.log(`       ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await check('initialize returns protocol version and tools capability', async () => {
    const r = await send(child, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '1' },
    });
    if (r.error) throw new Error(JSON.stringify(r.error));
    const res = r.result;
    if (!res) throw new Error('no result');
    if (typeof res['protocolVersion'] !== 'string') throw new Error('protocolVersion missing');
    const caps = res['capabilities'] as Record<string, unknown> | undefined;
    if (!caps?.['tools']) throw new Error('tools capability missing');
    const info = res['serverInfo'] as Record<string, unknown> | undefined;
    if (info?.['name'] !== 'quick-acp-tools') throw new Error('wrong server name');
  });

  await check('tools/list advertises the file tools and shell_run', async () => {
    const r = await send(child, 'tools/list', {});
    if (r.error) throw new Error(JSON.stringify(r.error));
    const tools = r.result?.['tools'] as Array<{ name: string; inputSchema: unknown }> | undefined;
    if (!Array.isArray(tools)) throw new Error('tools is not an array');
    const names = tools.map((t) => t.name);
    for (const expected of ['file_read', 'file_write', 'file_list', 'file_search', 'shell_run']) {
      if (!names.includes(expected)) throw new Error(`missing tool: ${expected}`);
    }
    for (const t of tools) {
      if (!t.inputSchema) throw new Error(`tool ${t.name} has no inputSchema`);
    }
  });

  await check('tools/call shell_run actually executes a command', async () => {
    const cmd = process.platform === 'win32' ? 'echo quick-acp-ok' : 'echo quick-acp-ok';
    const r = await send(child, 'tools/call', {
      name: 'shell_run',
      arguments: { command: cmd },
    });
    if (r.error) throw new Error(JSON.stringify(r.error));
    const content = r.result?.['content'] as Array<{ type: string; text: string }> | undefined;
    if (!Array.isArray(content) || content.length === 0) throw new Error('no content');
    if (!content[0]!.text.includes('quick-acp-ok')) {
      throw new Error(`unexpected output: ${content[0]!.text}`);
    }
    if (r.result?.['isError'] === true) throw new Error('isError should be false');
  });

  await check('tools/call file_read refuses a path outside the workspace', async () => {
    const r = await send(child, 'tools/call', {
      name: 'file_read',
      arguments: { path: '../../../../etc/passwd' },
    });
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (r.result?.['isError'] !== true) throw new Error('escape should be reported as an error');
    const content = r.result['content'] as Array<{ text: string }>;
    if (!content[0]!.text.includes('escapes the workspace')) {
      throw new Error(`wrong refusal: ${content[0]!.text}`);
    }
  });

  await check('tools/call with a blocked command is refused', async () => {
    const r = await send(child, 'tools/call', {
      name: 'shell_run',
      arguments: { command: 'rm -rf /' },
    });
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (r.result?.['isError'] !== true) throw new Error('blocked command should be an error');
    const content = r.result['content'] as Array<{ text: string }>;
    if (!content[0]!.text.includes('blocked')) {
      throw new Error(`wrong refusal: ${content[0]!.text}`);
    }
  });

  await check('unknown method returns method-not-found', async () => {
    const r = await send(child, 'no/such/method', {});
    if (!r.error) throw new Error('expected an error');
    if (r.error.code !== -32601) throw new Error(`wrong code: ${r.error.code}`);
  });

  await check('ping answers', async () => {
    const r = await send(child, 'ping', {});
    if (r.error) throw new Error(JSON.stringify(r.error));
  });

  child.kill();
  await new Promise((r) => setTimeout(r, 200));

  console.log('');
  if (failures === 0) {
    console.log('MCP server is wire-correct and its tools execute locally.');
  } else {
    console.log(`${failures} check(s) FAILED`);
    process.exitCode = 1;
  }
  if (stderr.trim()) {
    console.log('');
    console.log('server stderr:');
    console.log(stderr.trim().split('\n').slice(0, 6).map((l) => `  ${l}`).join('\n'));
  }
}

void main();
