#!/usr/bin/env node
/**
 * quick-acp entry point.
 *
 * Speaks ACP over stdin/stdout. Everything diagnostic goes to stderr, because
 * stdout is the protocol channel and a stray console.log corrupts the stream.
 *
 * NOTE ON STARTUP: this used to start Quick's outpost here, because refreshing
 * the token "had to" go through it. That turned out to be wrong — the token
 * refreshes fine against oidc.<region>.api.aws with the client secret as Basic
 * auth, and the gateway host is just `tenant_url` without its scheme. So there
 * is nothing to start: the first turn resolves a session from the stored login
 * or ~/.quick-acp/login.json and dials directly. Less to go wrong, and it works
 * on a machine that has never had the desktop app installed.
 */

import { AgentSideConnection, ndJsonStream } from '@zed-industries/agent-client-protocol';
import type { AnyMessage } from '@zed-industries/agent-client-protocol';
import { QuickAcpAgent } from './acp/agent.js';

const STANDARD_AGENT_METHODS = new Set([
  'authenticate',
  'initialize',
  'session/cancel',
  'session/load',
  'session/new',
  'session/prompt',
  'session/set_mode',
  'session/set_model',
]);

async function main(): Promise<void> {
  const workspaceRoot = process.env.QUICK_ACP_WORKSPACE ?? process.cwd();

  if (process.env.QUICK_ACP_PRINT_INFO === '1') {
    console.error('[quick-acp] workspace root:', workspaceRoot);
    console.error('[quick-acp] tools: prompt-injected (one extra turn per tool call)');
    console.error('[quick-acp] shell enabled:', process.env.QUICK_ACP_ALLOW_SHELL !== '0');
  }

  const agent = new QuickAcpAgent({ workspaceRoot });

  // ndJsonStream wants a WritableStream<Uint8Array> for output and a
  // ReadableStream<Uint8Array> for input. We build them from Node's stdio so
  // the process works whether launched by an ACP client or interactively.
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    },
  });

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on('data', (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
      });
      process.stdin.on('end', () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      process.stdin.on('error', (err) => {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      });
    },
  });

  const rawStream = ndJsonStream(output, input);

  // Translate non-standard extension requests (e.g. session/list, session/fork, session/resume)
  // to leading underscore so AgentSideConnection routes them to agent.extMethod.
  const adaptedReadable = rawStream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(msg: AnyMessage, controller) {
        if (msg && typeof msg === 'object' && 'method' in msg && typeof (msg as any).method === 'string') {
          const method = (msg as any).method as string;
          if (!STANDARD_AGENT_METHODS.has(method) && !method.startsWith('_')) {
            msg = { ...msg, method: `_${method}` } as AnyMessage;
          }
        }
        controller.enqueue(msg);
      },
    }),
  );

  const stream = {
    writable: rawStream.writable,
    readable: adaptedReadable,
  };

  // The connection hands us the Agent handler; we keep the connection so we can
  // push session/update notifications during a turn.
  new AgentSideConnection((conn) => {
    agent.attach(conn);
    return agent;
  }, stream);

  // Keep the process alive on stdin; the SDK drives everything else.
  await new Promise<void>((resolve) => {
    process.stdin.on('close', () => resolve());
    process.on('SIGTERM', () => resolve());
    process.on('SIGINT', () => resolve());
  });
  await agent.closeAll();
}

main().catch((e) => {
  console.error('[quick-acp] fatal:', e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
