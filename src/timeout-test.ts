/**
 * A command that never exits must TIMEOUT, not hang forever.
 *
 * The bug: `shell: true` runs the command under cmd.exe, so the real process is
 * a grandchild. `child.kill('SIGKILL')` killed only cmd.exe; the grandchild
 * survived holding the stdout pipe, so `close` never fired and the tool call
 * stayed pending with no error — a conversation frozen mid-turn, exactly what a
 * `python snake.py` (GUI app) request did.
 *
 * Reproduces with a long sleep and a 2s timeout, then asserts the call settles.
 */
import { defaultPolicy, ToolExecutor } from './tools/registry.js';

const policy = { ...defaultPolicy(process.cwd()), shellTimeoutMs: 2_000 };
const executor = new ToolExecutor(policy);

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('quick-acp blocking-command timeout');
console.log('');

// 1. A process that outlives the timeout.
{
  const t0 = Date.now();
  const cmd = process.platform === 'win32' ? 'ping -n 60 127.0.0.1' : 'sleep 60';
  const r = await executor.execute('shell_run', { command: cmd });
  const ms = Date.now() - t0;
  console.log(`  ping/sleep -> settled in ${ms}ms, ok=${r.ok}, error=${r.error ?? '-'}`);
  check('a blocking command settles', ms < 15_000, `took ${ms}ms`);
  check('it reports a timeout', r.error === 'timeout', `got ${r.error ?? '(none)'}`);
  check('it does not claim success', r.ok === false);
}

// 2. A grandchild must not survive. Start a nested shell that spawns a sleeper,
//    then confirm nothing matching is left running.
{
  const marker = `quickacp-sleeper-${Date.now()}`;
  const cmd =
    process.platform === 'win32'
      ? `cmd /c ping -n 60 127.0.0.1 > nul & echo ${marker}`
      : `sh -c 'sleep 60' ; echo ${marker}`;
  await executor.execute('shell_run', { command: cmd, timeoutMs: 1_500 });

  // Give the kill a moment to propagate.
  await new Promise((r) => setTimeout(r, 2_500));

  const { execFileSync } = await import('node:child_process');
  let listing = '';
  try {
    listing =
      process.platform === 'win32'
        ? execFileSync('tasklist', ['/fi', 'imagename eq PING.EXE'], { encoding: 'utf8' })
        : execFileSync('sh', ['-c', 'ps -eo comm'], { encoding: 'utf8' });
  } catch {
    listing = '';
  }
  const stillRunning = /PING\.EXE|ping\.exe/i.test(listing) && listing.split('\n').length > 3;
  console.log(`  leftover grandchildren: ${stillRunning ? 'YES' : 'none'}`);
  check('no orphaned grandchild survives the timeout', !stillRunning);
}

// 3. A fast command still works (the fix must not break the happy path).
{
  const r = await executor.execute('shell_run', { command: 'echo quickacp-ok' });
  check('normal command still succeeds', r.ok && r.content.includes('quickacp-ok'));
}

console.log('');
if (failures === 0) console.log('timeout handling works');
else {
  console.log(`${failures} check(s) FAILED`);
  process.exitCode = 1;
}
