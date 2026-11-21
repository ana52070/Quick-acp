#!/usr/bin/env node
/**
 * Credential and session diagnostic.
 *
 * Answers, without revealing any secret:
 *   - which Quick profile is active
 *   - whether the stored login is readable from the OS credential store
 *   - whether an OIDC refresh actually produces a JWT
 *   - what the gateway host would be
 *
 * Run: node dist/doctor.js  (add --refresh to actually mint a token)
 */

import {
  describeCredentialState,
  resolveSession,
  startOutpost,
  DEFAULT_WS_PATH,
} from './quick/auth.js';

async function main(): Promise<void> {
  const doRefresh = process.argv.includes('--refresh');
  const doJson = process.argv.includes('--json');
  const doStart = process.argv.includes('--start-outpost');

  if (doStart) {
    console.log('[outpost] starting the app\'s own outpost so it refreshes the login…');
    const r = await startOutpost();
    if (!r.started) {
      console.error(`[outpost] FAILED: ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[outpost] up. instance token: ${r.instanceToken ? 'acquired' : 'not available'}`);
    if (r.reason) console.log(`[outpost] ${r.reason}`);
  }

  const state = await describeCredentialState();

  if (doJson) {
    console.log(JSON.stringify(state, null, 2));
  } else {
    console.log('quick-acp doctor');
    console.log('');
    console.log('  platform        ', state['platform']);
    console.log('  quickwork home  ', state['quickworkHome']);
    console.log('  active profile  ', state['activeProfile'] ?? '(none)');
    console.log('  outpost port    ', state['outpostPort']);
    console.log('  outpost running ', state['outpostUp'] ? 'yes' : 'no');
    console.log('  agent binary    ', state['agentBinary'] ?? '(not found)');
    console.log('  instance token  ', state['hasInstanceTokenEnv'] ? 'set' : 'not set');

    const sl = state['storedLogin'] as Record<string, unknown>;
    console.log('');
    console.log('  stored login    ', sl['ok'] ? 'READABLE' : 'NOT READABLE');
    if (sl['ok']) {
      console.log('    source        ', sl['source']);
      console.log('    refresh token ', sl['hasRefreshToken'] ? 'present' : 'MISSING');
      console.log('    client id     ', sl['hasClientId'] ? 'present' : 'MISSING');
      console.log('    client secret ', sl['hasClientSecret'] ? 'present' : 'MISSING');
      console.log('    tenant        ', sl['tenant'] ?? '(none)');
      console.log(
        '    access token  ',
        sl['accessTokenExpired'] ? `EXPIRED at ${sl['accessTokenExpiry']}` : 'valid',
      );
    } else {
      console.log('    reason        ', sl['reason']);
    }
  }

  if (!doRefresh) {
    console.log('');
    console.log('Options:');
    console.log('  --start-outpost  start the app\'s outpost so it refreshes the token');
    console.log('  --refresh        resolve a full session (needs a running outpost)');
    return;
  }

  console.log('');
  console.log('[session] resolving full session…');
  try {
    const s = await resolveSession({ force: true });
    console.log('[session] SUCCESS');
    console.log('  source        ', s.source);
    console.log('  ws host       ', s.wsHost);
    console.log('  ws path       ', s.wsPath || DEFAULT_WS_PATH);
    console.log('  tenant        ', s.tenantUrl);
    console.log('  surface       ', s.surface);
    console.log('  outpost id    ', s.outpostId || '(empty — server will decide)');
    console.log('  actor arn     ', s.actorArn || '(none)');
    console.log(
      '  expires       ',
      s.expiresAt ? new Date(s.expiresAt).toISOString() : '(unknown)',
    );
  } catch (e) {
    console.error(`[session] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

void main();
