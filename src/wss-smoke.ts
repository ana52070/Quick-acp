#!/usr/bin/env node
/**
 * Live gateway test: connect, session_connect, and send one real turn.
 *
 * This is the step that proves the bridge actually works end to end. It needs a
 * valid Quick session (obtained via the outpost), so it is NOT part of
 * `npm run verify`.
 *
 * What it does, in order, printing every frame:
 *   1. resolve a session (starts the outpost if needed)
 *   2. dial the gateway with the five required headers
 *   3. send session_connect and wait for any inbound frame
 *   4. send one user_message and stream whatever comes back
 *   5. report exactly where it stopped if it stops
 *
 * Usage:
 *   node dist/wss-smoke.js                 # full run, default prompt
 *   node dist/wss-smoke.js "your prompt"   # custom prompt
 *   node dist/wss-smoke.js --frames-only   # stop after session_connect
 *   QUICK_ACP_FRAMING=json-base64 node dist/wss-smoke.js
 */

import { resolveSession, startOutpost, outpostIsUp } from './quick/auth.js';
import { QuickTransport, buildHandshake, DEFAULT_WS_PATH, ALT_WS_PATH } from './quick/transport.js';
import { resolveToolMode } from './tools/strategies.js';

const args = process.argv.slice(2);
const framesOnly = args.includes('--frames-only');
const promptArg = args.find((a) => !a.startsWith('--'));

/** How long to wait for the first inbound frame after session_connect. */
const FIRST_FRAME_TIMEOUT_MS = 75_000;
/** How long to wait for the turn to finish. */
const TURN_TIMEOUT_MS = 240_000;

function log(...parts: unknown[]): void {
  console.log(...parts);
}

function now(): string {
  return new Date().toISOString().slice(11, 23);
}

async function main(): Promise<void> {
  const framing = (process.env.QUICK_ACP_FRAMING === 'json-base64' ? 'json-base64' : 'cbor') as
    | 'cbor'
    | 'json-base64';

  log('quick-acp gateway test');
  log('  framing :', framing);
  log('  toolmode:', resolveToolMode());
  log('');

  // --- 1. session ---------------------------------------------------------
  if (!(await outpostIsUp())) {
    log('[1/5] no outpost; starting one…');
    const r = await startOutpost();
    if (!r.started) {
      log('      FAILED to start outpost:', r.reason);
      process.exitCode = 1;
      return;
    }
  }

  let session;
  try {
    session = await resolveSession({ force: true });
  } catch (e) {
    log('      FAILED to resolve session:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }
  log('[1/5] session ok');
  log('      source  :', session.source);
  log('      wsHost  :', session.wsHost);
  log('      wsPath  :', session.wsPath || `(default) ${DEFAULT_WS_PATH}`);
  log('      surface :', session.surface);
  log('      outpost :', session.outpostId || '(empty)');
  log(
    '      jwt     :',
    session.jwt.length > 24
      ? `${session.jwt.slice(0, 10)}…${session.jwt.slice(-6)} (${session.jwt.length} chars)`
      : `(short: ${session.jwt.length} chars)`,
  );
  log('');

  // --- 2. dial ------------------------------------------------------------
  const transport = new QuickTransport(session, { framing });
  const frames: string[] = [];
  let firstFrameAt = 0;

  transport.on((ev) => {
    if (ev.type === 'open') {
      log('[2/5] socket open');
      firstFrameAt = Date.now();
    } else if (ev.type === 'message') {
      frames.push(ev.body);
      let pretty = ev.body;
      try {
        pretty = JSON.stringify(JSON.parse(ev.body));
      } catch {
        /* keep raw */
      }
      log(`      << ${now()} ${pretty.slice(0, 400)}`);
    } else if (ev.type === 'error') {
      log(`      !! ${now()} ${ev.body}`);
    } else if (ev.type === 'close') {
      log(`      socket closed: ${ev.code} ${ev.reason}`);
    }
  });

  try {
    await transport.connect();
  } catch (e) {
    log('[2/5] DIAL FAILED:', e instanceof Error ? e.message : String(e));
    log('');
    log('This is the failure that matters. Things to try, in order:');
    log('  1. QUICK_ACP_FRAMING=json-base64  (the two code paths disagree)');
    log('  2. a different ws path: set QUICK_ACP_WS_PATH=' + ALT_WS_PATH);
    log('  3. token may be opaque, not a JWT: check `node dist/doctor.js --refresh`');
    process.exitCode = 1;
    return;
  }

  // --- 3. session_connect -------------------------------------------------
  log('[3/5] sending session_connect');
  const handshake = buildHandshake(session, { framing });
  log('      headers:', Object.keys(handshake.headers).join(', '));
  transport.send({
    type: 'session_connect',
    payload: {
      actor_id: session.actorArn ?? '',
      external_agent_sign_in: 1,
      recents_promotion: 1,
    },
  });

  // Wait for the server to say anything at all. Silence here means the socket
  // is up but the session was not accepted, which is a distinct failure.
  const sawFrame = await waitFor(() => frames.length > 0, FIRST_FRAME_TIMEOUT_MS);
  if (!sawFrame) {
    log('');
    log('[3/5] NO INBOUND FRAME within', `${FIRST_FRAME_TIMEOUT_MS}ms.`);
    log('      The socket opened and session_connect was sent, but the server');
    log('      never replied. That means the server did not accept the session —');
    log('      most likely the token (opaque vs JWT) or the outpost id.');
    transport.terminate(1000, 'debug_done');
    process.exitCode = 1;
    return;
  }
  log(`[3/5] server replied (${frames.length} frame(s) so far)`);

  if (framesOnly) {
    log('');
    log('--frames-only: stopping here.');
    transport.terminate(1000, 'debug_done');
    return;
  }

  // --- 4. one real turn ---------------------------------------------------
  const text =
    promptArg ??
    'Reply with exactly the word: READY. Do not use any tools and do not explain.';
  const messageId = crypto.randomUUID();
  const threadId = crypto.randomUUID();

  log('');
  log('[4/5] sending user_message');
  log('      text      :', text.slice(0, 120));
  log('      thread_id :', threadId);
  transport.send({
    type: 'user_message',
    payload: {
      thread_id: threadId,
      text,
      message_id: messageId,
      agent_mode: 'smart',
      thinking_effort: 'high',
      user_timezone: 'UTC',
      user_locale: 'en-US',
    },
  });

  // --- 5. collect ---------------------------------------------------------
  const startedAt = Date.now();
  let assistantText = '';
  const sawReply = await waitFor(() => {
    for (const f of frames) {
      if (!f.includes('text_delta') && !f.includes('token_usage') && !f.includes('message_start')) {
        continue;
      }
      try {
        const m = JSON.parse(f) as Record<string, unknown>;
        const payload =
          m['payload'] && typeof m['payload'] === 'object'
            ? (m['payload'] as Record<string, unknown>)
            : {};
        if (m['type'] === 'text_delta' && typeof payload['delta'] === 'string') {
          assistantText += payload['delta'];
        }
        if (m['type'] === 'token_usage' || m['type'] === 'turn_end') return true;
      } catch {
        /* not a frame we parse */
      }
    }
    return false;
  }, TURN_TIMEOUT_MS);

  log('');
  log('[5/5] result');
  log('      frames     :', frames.length);
  log('      elapsed    :', `${Date.now() - startedAt}ms`);
  log('      reply text :', assistantText ? JSON.stringify(assistantText.slice(0, 300)) : '(none)');

  if (sawReply && assistantText) {
    log('');
    log('*** SUCCESS: the gateway answered with model output. ***');
    log('*** The bridge works end to end.                    ***');
  } else if (sawReply) {
    log('');
    log('Turn completed but no assistant text was captured.');
    log('That means the protocol works but the frame shapes differ from what');
    log('session.ts expects. The raw frames above show the real shape.');
    process.exitCode = 1;
  } else {
    log('');
    log('No turn completion within', `${TURN_TIMEOUT_MS}ms.`);
    log('Frames received:', frames.length);
    process.exitCode = 1;
  }

  transport.terminate(1000, 'done');
}

/** Poll a predicate until it is true or the timeout elapses. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return pred();
}

void main().catch((e) => {
  console.error('fatal:', e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
