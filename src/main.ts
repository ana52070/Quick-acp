#!/usr/bin/env node
/**
 * quick-acp entry point.
 *
 * Speaks ACP over stdin/stdout. Everything diagnostic goes to stderr, because
 * stdout is the protocol channel and a stray console.log corrupts the stream.
 */

import { AgentSideConnection, ndJsonStream } from '@zed-industries/agent-client-protocol';
import { QuickAcpAgent } from './acp/agent.js';
import { startOutpost, outpostIsUp } from './quick/auth.js';

async function main(): Promise<void> {
  const workspaceRoot = process.env.QUICK_ACP_WORKSPACE ?? process.cwd();

  if (process.env.QUICK_ACP_PRINT_INFO === '1') {
    console.error('[quick-acp] workspace root:', workspaceRoot);
    console.error('[quick-acp] tool mode:', process.env.QUICK_ACP_TOOL_MODE ?? 'mcp (default)');
    console.error('[quick-acp] shell enabled:', process.env.QUICK_ACP_ALLOW_SHELL === '1');
    console.error('[quick-acp] framing:', process.env.QUICK_ACP_FRAMING ?? 'cbor (default)');
  }

  // Bring up the credential path before serving ACP.
  //
  // Quick's tokens can only be refreshed by its own outpost (the stored client
  // is a Quick-Portal device client that the public OIDC endpoint rejects), so
  // the bridge starts that outpost itself when one is not already running.
  // Without this the user would have to copy an ephemeral in-memory token on
  // every restart.
  if (process.env.QUICK_ACP_NO_AUTOSTART !== '1') {
    const already = await outpostIsUp();
    if (!already) {
      console.error('[quick-acp] no outpost running; starting one so the login can be refreshed');
    }
    const r = await startOutpost();
    if (!r.started) {
      // Not fatal: a client may only be calling initialize (as the smoke test
      // does). Report it and let the first real turn surface the error.
      console.error(`[quick-acp] outpost not available: ${r.reason}`);
    } else if (r.reason) {
      console.error(`[quick-acp] ${r.reason}`);
    }
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

  const stream = ndJsonStream(output, input);

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
}

main().catch((e) => {
  console.error('[quick-acp] fatal:', e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
