/**
 * Final proof for the "no official client" story, in one command.
 *
 *   1. sign in through the browser (OAuth + PKCE, no desktop app)
 *   2. write ~/.quick-acp/login.json
 *   3. build a session from that file alone (no outpost, no keychain)
 *   4. run a real turn and print the model
 *
 * This is what a brand-new machine does.
 *
 *   node dist/fresh-machine-e2e.js --start-url https://ssoins-xxx.awsapps.com/start
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { login, bridgeLoginPath } from './quick/login.js';
import { sessionDirect } from './quick/session-direct.js';
import { QuickTransport } from './quick/transport.js';
import { QuickChatSession } from './quick/session.js';

const START = process.argv.slice(2).find((a) => a.startsWith('http')) ??
  process.env.QUICK_ACP_START_URL ??
  '';

if (!START) {
  console.error('usage: node dist/fresh-machine-e2e.js --start-url <your AWS access portal URL>');
  console.error('');
  console.error('  Get that URL by signing in at https://quicksight.aws.amazon.com — the browser');
  console.error('  lands on an address like https://ssoins-xxxxxxxxxxxx.awsapps.com/start');
  console.error('  (or set QUICK_ACP_START_URL).');
  process.exit(1);
}

console.log('quick-acp: fresh-machine end-to-end test');
console.log('');
console.log('This simulates a machine with NO Quick install:');
console.log('  - no desktop app login');
console.log('  - no outpost');
console.log('  - only a browser sign-in');
console.log('');

console.log('=== step 1: browser sign-in ===');
const result = await login({
  startUrl: START,
  persist: false,
  onUrl: (u) => {
    console.log('');
    console.log('*** OPEN THIS URL AND SIGN IN ***');
    console.log(u);
    console.log('');
    console.log('waiting for the callback on http://127.0.0.1:18080 ...');
  },
});

if (!result.ok) {
  console.error('');
  console.error('sign-in failed:', result.error);
  process.exit(1);
}
console.log('');
console.log('signed in');
console.log('  client id  :', result.clientId);
console.log('  access tok :', result.accessToken?.slice(0, 24) + '...');
console.log('  refresh tok:', result.refreshToken?.slice(0, 24) + '...');

// Write the bridge login file. tenant_url comes from discovery; if it is empty
// the caller must supply it, so say so instead of writing a half-usable file.
if (!result.tenantUrl) {
  console.error('');
  console.error('signed in, but the gateway host (tenant_url) could not be discovered.');
  console.error('Provide it explicitly:  set QUICK_ACP_TENANT_URL=https://qbs-....plato.ai.aws.dev');
  process.exit(1);
}
console.log('  tenant     :', result.tenantUrl);

const dir = join(homedir(), '.quick-acp');
await mkdir(dir, { recursive: true, mode: 0o700 });
const p = bridgeLoginPath();
await writeFile(
  p,
  JSON.stringify(
    {
      issuer_url: result.issuerUrl,
      tenant_url: result.tenantUrl,
      client_id: result.clientId,
      client_secret: result.clientSecret,
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_at: result.expiresAt,
      signed_in_at: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
  { encoding: 'utf8', mode: 0o600 },
);
console.log('  wrote      :', p);

console.log('');
console.log('=== step 2: build a session from that file only ===');
// Hide the keychain profile so this genuinely tests the no-install path.
const savedHome = process.env.QUICK_ACP_QUICKWORK_HOME;
process.env.QUICK_ACP_QUICKWORK_HOME = join(homedir(), '.quick-acp', 'empty-home');
if (!existsSync(process.env.QUICK_ACP_QUICKWORK_HOME)) {
  await mkdir(process.env.QUICK_ACP_QUICKWORK_HOME, { recursive: true });
}

const direct = await sessionDirect();
if (savedHome === undefined) delete process.env.QUICK_ACP_QUICKWORK_HOME;
else process.env.QUICK_ACP_QUICKWORK_HOME = savedHome;

if (!direct.ok || !direct.session) {
  console.error(`session failed at "${direct.step}": ${direct.reason}`);
  process.exit(1);
}
const s = direct.session;
console.log('  source     :', s.source);
console.log('  ws host    :', s.wsHost);
console.log('  jwt        :', s.jwt.slice(0, 24) + '...');

console.log('');
console.log('=== step 3: real turn ===');
const transport = new QuickTransport(s, {
  onTokenRefreshNeeded: async () => {
    const again = await sessionDirect();
    return again.ok && again.session ? again.session.jwt : null;
  },
});
const chat = new QuickChatSession({
  transport,
  actorArn: s.actorArn,
  agentMode: 'smart',
  thinkingEffort: 'high',
});
await chat.open();
console.log('socket open');
console.log('');

let text = '';
let model = '';
for await (const ev of chat.sendTurn(
  [{ role: 'user', text: 'Reply with exactly the single word: PONG.' }],
  { agentMode: 'smart', thinkingEffort: 'high', attachments: [] },
)) {
  if (ev.type === 'text') {
    text += ev.delta;
    process.stdout.write(ev.delta);
  } else if (ev.type === 'error') {
    console.error(`\nERROR ${ev.code}: ${ev.message}`);
    process.exit(1);
  } else if (ev.type === 'turn_end') {
    model = ev.usage?.resolvedModelId ?? '';
  }
}

console.log('\n');
console.log('assistant  :', JSON.stringify(text));
console.log('model      :', model || '(unreported)');
console.log('');
if (text.trim()) {
  console.log('*** FRESH MACHINE END-TO-END SUCCESS ***');
  console.log('*** browser sign-in -> OIDC refresh -> gateway -> model -> text ***');
  console.log('*** no Quick install, no outpost, no Electron, no keychain entry ***');
} else {
  console.log('no assistant text arrived');
  process.exitCode = 1;
}
chat.close();
