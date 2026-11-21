/**
 * The decisive test: a full conversation turn with NO outpost and NO Electron.
 *
 * If this prints PONG, then a machine that has never installed Quick can use
 * this bridge after one browser sign-in — which is the whole point of the
 * login work.
 *
 *   node dist/no-outpost-e2e.js
 */
import { sessionDirect } from './quick/session-direct.js';
import { QuickTransport } from './quick/transport.js';
import { QuickChatSession } from './quick/session.js';

const t0 = Date.now();
const direct = await sessionDirect();
if (!direct.ok || !direct.session) {
  console.error(`session failed at "${direct.step}": ${direct.reason}`);
  process.exit(1);
}

const s = direct.session;
console.log('session source :', s.source);
console.log('ws host        :', s.wsHost);
console.log('ws path        :', s.wsPath);
console.log('tenant         :', s.tenantUrl);
console.log('surface        :', s.surface);
console.log('jwt            :', s.jwt.slice(0, 24) + '...');
console.log('resolved in    :', Date.now() - t0, 'ms');
console.log('');

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

console.log('opening socket...');
await chat.open();
console.log('socket open');
console.log('');

let text = '';
let model = '';
const prompt = process.argv[2] ?? 'Reply with exactly the single word: PONG.';

process.stdout.write('> ' + prompt + '\n\n');

for await (const ev of chat.sendTurn([{ role: 'user', text: prompt }], {
  agentMode: 'smart',
  thinkingEffort: 'high',
  attachments: [],
})) {
  switch (ev.type) {
    case 'text':
      text += ev.delta;
      process.stdout.write(ev.delta);
      break;
    case 'thinking':
      if (process.env.QUICK_ACP_DEBUG === '1') process.stdout.write(`[thinking] ${ev.delta}`);
      break;
    case 'turn_end':
      model = ev.usage?.resolvedModelId ?? model;
      break;
    case 'error':
      console.error(`\nERROR ${ev.code}: ${ev.message}`);
      process.exit(1);
      break;
    default:
      break;
  }
}

console.log('\n');
console.log('assistant:', JSON.stringify(text));
if (model) console.log('model    :', model);
console.log('');
if (text.trim()) {
  console.log('*** NO-OUTPOST END-TO-END SUCCESS ***');
} else {
  console.log('no assistant text arrived');
  process.exitCode = 1;
}
chat.close();
