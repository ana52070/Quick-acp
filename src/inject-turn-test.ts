#!/usr/bin/env node
/**
 * Multi-turn and tool-loop regression test.
 *
 * TWO BUGS THIS LOCKS DOWN (both were live, both were invisible to the
 * single-turn e2e):
 *
 * 1. Back-to-back turns returned an EMPTY second reply. The stream closed on
 *    `turn_usage`, which arrives before the server has actually finished, so the
 *    next `user_message` landed mid-close and was answered with
 *    `message_complete {text:"", initiator:"user"}` — an echo, not a reply.
 *    Fixed by closing on `message_complete` instead.
 *
 * 2. The `inject` tool contract was never exercised end to end, so a protocol
 *    mismatch in the tool loop would have shipped unnoticed.
 *
 * Requires a Quick login (uses ~/.quick-acp/login.json or the keychain).
 *
 *   node dist/inject-turn-test.js
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { sessionDirect } from './quick/session-direct.js';
import { QuickTransport } from './quick/transport.js';
import { QuickChatSession } from './quick/session.js';
import { defaultPolicy, toolDefs, ToolExecutor } from './tools/registry.js';
import { buildToolPrompt, parseToolCall, formatToolResult } from './tools/strategies.js';

const workspace = process.env.QUICK_ACP_WORKSPACE ?? process.cwd();

const direct = await sessionDirect();
if (!direct.ok || !direct.session) {
  console.error(`session failed at "${direct.step}": ${direct.reason}`);
  process.exit(1);
}

const transport = new QuickTransport(direct.session, {
  onTokenRefreshNeeded: async () => {
    const again = await sessionDirect({ preferAccessToken: false });
    return again.ok && again.session ? again.session.jwt : null;
  },
});
const chat = new QuickChatSession({
  transport,
  actorArn: direct.session.actorArn,
  agentMode: 'smart',
  thinkingEffort: 'high',
});
await chat.open();

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

async function turn(text: string): Promise<string> {
  let out = '';
  for await (const ev of chat.sendTurn([{ role: 'user', text }], {
    agentMode: 'smart',
    thinkingEffort: 'high',
    attachments: [],
  })) {
    if (ev.type === 'text') out += ev.delta;
    else if (ev.type === 'error') throw new Error(`${ev.code}: ${ev.message}`);
  }
  return out;
}

console.log('quick-acp multi-turn test');
console.log('');

// 1. Three turns back-to-back, no artificial delay. This is the regression:
//    previously #2 came back empty and #3 answered #2.
console.log('  back-to-back turns:');
const words = ['ALPHA', 'BRAVO', 'CHARLIE'];
const got: string[] = [];
for (const w of words) {
  got.push(await turn(`Reply with exactly the single word: ${w}`));
}
for (let i = 0; i < words.length; i++) {
  const text = got[i]!.trim();
  check(
    `turn ${i + 1} answered with ${words[i]}`,
    text.toUpperCase().includes(words[i]!),
    `got ${JSON.stringify(text.slice(0, 60))}`,
  );
}

// 2. The inject tool loop: model must emit the contract, we execute, it answers.
const policy = { ...defaultPolicy(workspace), allowShell: true };
const tools = toolDefs(policy);
const executor = new ToolExecutor(policy);
const preamble = buildToolPrompt(tools, workspace);

console.log('');
console.log('  inject tool loop:');
const task =
  'Use the file_list tool on the workspace root (path "."). Then tell me how many entries it returned.';
let pending = `${preamble}\n\n---\n\n${task}`;
let sawToolCall = false;
let executed = false;
let finalText = '';

for (let round = 0; round < 4; round++) {
  const reply = await turn(pending);
  const call = parseToolCall(reply);
  if (!call) {
    finalText = reply;
    break;
  }
  sawToolCall = true;
  const result = await executor.execute(call.name, call.arguments);
  executed = result.ok;
  pending = formatToolResult(call, result);
}

check('model emitted a tool call', sawToolCall);
check('tool executed locally', executed);
check('model produced a final answer after the tool', finalText.trim().length > 0);

console.log('');
if (failures === 0) {
  console.log('all multi-turn checks passed');
} else {
  console.log(`${failures} check(s) FAILED`);
  process.exitCode = 1;
}
chat.close();
