#!/usr/bin/env node
/**
 * 端到端真实在线 ACP 验收脚本 (End-to-End Live ACP Acceptance Test)
 *
 * 通过启动本地 dist/main.js ACP stdio 子进程，接入真实 Quick Claude 在线模型：
 * 1. 发起 initialize 握手并验证协议版本与多模态能力 (image: true)
 * 2. 在真实工作区 (.dispatch/quick-snake-acceptance) 创建 session/new
 * 3. 验证 session/set_model 依规拒绝指定模型 (-32601)
 * 4. 发送真实的 session/prompt 请求，让 Quick Claude 自主完成多轮工具链路调用：
 *    - file_read: 读取 snake.py 和 test_snake.py
 *    - file_write: 在工作区写入含 Markdown 三反引号代码块的 acceptance-result.md
 *    - shell_run: 执行 17 项 unittest 测试并验证通过
 *    - shell_run: 执行 pygame dummy 5 帧无头冒烟测试并验证通过
 *    - file_read: 回读验收结果文件验证完整性
 * 5. 全程监听并断言 ACP stdio 通知流中的工具卡片：
 *    - file_read (read) pending -> completed
 *    - file_write (edit) pending -> completed
 *    - shell_run (execute) pending -> completed
 * 6. 断言 prompt 返回正常 stopReason ('end_turn')，断言磁盘文件真实落盘且未破坏既有修复
 * 7. 生成并保存脱敏后的端到端验收报告 (.dispatch/acceptance-report.json)
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
const SNAKE_WORKSPACE = resolve(ROOT, process.env.QUICK_ACP_TEST_WORKSPACE || 'examples/snake');
const REPORT_PATH = resolve(ROOT, '.dispatch/acceptance-report.json');

console.log('=== 启动 Quick-acp 端到端真实在线 ACP 验收 ===\n');

// 确认贪吃蛇测试目录存在
await fs.mkdir(SNAKE_WORKSPACE, { recursive: true });
await fs.mkdir(resolve(ROOT, '.dispatch'), { recursive: true });

// 启动 dist/main.js ACP stdio 子进程
const child = spawn(process.execPath, [resolve(ROOT, 'dist/main.js')], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    QUICK_ACP_ALLOW_SHELL: '1',
    QUICK_ACP_PRINT_INFO: '0',
    QUICK_ACP_MAX_TOOL_ROUNDS: '15',
    QUICK_ACP_HEADLESS: '1',
  },
});

let msgId = 0;
const pendingRequests = new Map();
const sessionNotifications = [];
let childExited = false;
let exitCode = null;

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;

    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { resolve, reject, timer } = pendingRequests.get(msg.id);
        clearTimeout(timer);
        pendingRequests.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'session/update') {
        sessionNotifications.push(msg.params);
      }
    } catch {
      // 忽略非 JSON 数据行
    }
  }
});

let stderrLogs = '';
child.stderr.on('data', (chunk) => {
  stderrLogs += chunk.toString('utf8');
});

child.on('exit', (code, signal) => {
  childExited = true;
  exitCode = code;
  for (const [id, req] of pendingRequests.entries()) {
    clearTimeout(req.timer);
    req.reject(new Error(`Agent process exited prematurely with code ${code} signal ${signal}`));
  }
  pendingRequests.clear();
});

child.on('error', (err) => {
  for (const [id, req] of pendingRequests.entries()) {
    clearTimeout(req.timer);
    req.reject(err);
  }
  pendingRequests.clear();
});

function sendRequest(method, params, timeoutMs = 45_000) {
  if (childExited) {
    return Promise.reject(new Error(`Cannot send request: child process already exited with code ${exitCode}`));
  }
  const id = ++msgId;
  const req = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(req) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout waiting for response to ${method} after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timer });
  });
}

function sanitize(val) {
  if (typeof val === 'string') {
    return val
      .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[MASKED_JWT]')
      .replace(/(?:aoa|aoo)[A-Za-z0-9+/=]{20,}/g, '[MASKED_TOKEN]')
      .replace(/arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]*:[^\s"']+/g, '[MASKED_ARN]')
      .replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[MASKED_EMAIL]');
  }
  if (Array.isArray(val)) {
    return val.map(sanitize);
  }
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (/jwt|token|secret|password|auth/i.test(k) && typeof v === 'string') {
        out[k] = '[MASKED_SECRET]';
      } else {
        out[k] = sanitize(v);
      }
    }
    return out;
  }
  return val;
}

try {
  // 1. initialize 握手
  console.log('1. 发送 initialize 握手请求...');
  const initRes = await sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      tools: true,
      terminal: true,
    },
  });
  assert.equal(initRes.protocolVersion, 1, '协议版本必须为 1');
  assert(initRes.agentCapabilities?.promptCapabilities?.image === true, '必须支持图片附件能力');
  console.log('   ✓ initialize 握手成功，支持 image 多模态能力');

  // 2. session/new 在 .dispatch/quick-snake-acceptance 工作区创建会话
  console.log(`2. 在贪吃蛇工作区发送 session/new 请求 (${SNAKE_WORKSPACE})...`);
  const newSessionRes = await sendRequest('session/new', {
    cwd: SNAKE_WORKSPACE,
    mcpServers: [],
  });
  const sessionId = newSessionRes.sessionId;
  assert(sessionId, '必须返回唯一的 sessionId');
  assert(newSessionRes.modes?.availableModes?.length >= 3, '必须返回 fast/balanced/smart 模式列表');
  console.log(`   ✓ session/new 成功建立，sessionId: ${sessionId}`);

  // 3. 验证 session/set_model 拒绝
  console.log('3. 验证 session/set_model 依规拒绝行为...');
  let rejected = false;
  try {
    await sendRequest('session/set_model', {
      sessionId,
      modelId: 'claude-3-opus',
    });
  } catch (err) {
    rejected = true;
    assert(err.message.includes('Quick does not expose model selection') || err.message.includes('-32601'));
  }
  assert(rejected, '必须拒绝指定模型');
  console.log('   ✓ session/set_model 依规拒绝并通过');

  // 4. 发送端到端真实 session/prompt 请求，触发模型自主调用工具
  console.log('4. 发送端到端 session/prompt 任务请求，调用在线 Quick Claude 模型...');
  console.log('   (任务要求：自主读取 snake.py/test_snake.py、写入含三反引号的 acceptance-result.md、运行 17 项测试及 5 帧 smoke)...');

  const promptText = [
    '请对当前工作区内的贪吃蛇项目进行自动化技术验收：',
    '1. 使用 file_read 工具读取 snake.py 和 test_snake.py，了解游戏实现与测试规范。',
    '2. 使用 file_write 工具在当前目录创建 acceptance-result.md，总结游戏逻辑设计并包含至少一段 Markdown 三反引号（```）代码块示例。注意：严禁覆盖或修改已有的 snake.py 和 test_snake.py。',
    '3. 使用 shell_run 工具执行单元测试：python -m unittest test_snake.py，验证全部 17 项测试通过。',
    '4. 使用 shell_run 工具执行 pygame dummy 5 帧冒烟测试：python -c "import os; os.environ[\'SDL_VIDEODRIVER\'] = \'dummy\'; import snake; frames = snake.run(5); print(f\'SMOKE_OK: {frames}\')"',
    '5. 使用 file_read 工具读取刚才生成的 acceptance-result.md，确认内容完整写入。',
    '6. 工具全部执行完毕后给出总结。',
  ].join('\n');

  // 给予在线模型足够的时间进行 4-6 轮自主工具调用（最长 180 秒）
  const promptStartTime = Date.now();
  const promptRes = await sendRequest(
    'session/prompt',
    {
      sessionId,
      prompt: [{ type: 'text', text: promptText }],
    },
    Number(process.env.QUICK_ACP_LIVE_TIMEOUT_MS || 300_000),
  );
  const durationMs = Date.now() - promptStartTime;
  console.log(`   ✓ session/prompt 响应成功！耗时: ${(durationMs / 1000).toFixed(1)} 秒`);
  assert.equal(promptRes.stopReason, 'end_turn', `stopReason 必须为 end_turn，实际: ${promptRes.stopReason}`);

  // 5. 断言通知流中的工具卡片完整生命周期
  console.log('5. 验证 ACP stdio 会话通知流中的工具卡片...');
  console.log(`   收到 session/update 通知总数: ${sessionNotifications.length}`);

  const toolCalls = [];
  const toolUpdates = [];
  const assistantChunks = [];

  for (const notif of sessionNotifications) {
    if (notif.sessionId !== sessionId) continue;
    const upd = notif.update;
    if (!upd) continue;

    if (upd.sessionUpdate === 'tool_call') {
      toolCalls.push(upd);
    } else if (upd.sessionUpdate === 'tool_call_update') {
      toolUpdates.push(upd);
    } else if (upd.sessionUpdate === 'agent_message_chunk') {
      if (upd.content?.text) assistantChunks.push(upd.content.text);
    }
  }

  console.log(`   工具调用创建卡片 (tool_call): ${toolCalls.length} 个`);
  console.log(`   工具调用完成卡片 (tool_call_update): ${toolUpdates.length} 个`);

  // 断言各类型工具卡片存在且执行成功
  const readFileCalls = toolCalls.filter((c) => c.kind === 'read' || c.title?.toLowerCase().includes('read'));
  const writeFileCalls = toolCalls.filter((c) => c.kind === 'edit' || c.title?.toLowerCase().includes('write'));
  const shellRunCalls = toolCalls.filter((c) => c.kind === 'execute' || c.title?.toLowerCase().includes('run'));

  assert(readFileCalls.length >= 3, `必须包含至少 1 次 file_read 调用卡片，实际: ${readFileCalls.length}`);
  assert(writeFileCalls.length >= 1, `必须包含至少 1 次 file_write 调用卡片，实际: ${writeFileCalls.length}`);
  assert(shellRunCalls.length >= 1, `必须包含至少 1 次 shell_run 调用卡片，实际: ${shellRunCalls.length}`);

  for (const call of toolCalls) {
    assert.equal(call.status, 'pending');
    assert(toolUpdates.some(u => u.toolCallId === call.toolCallId && u.status === 'completed' && u.rawOutput?.ok === true), '???????????????: ' + call.title);
  }
  const completedUpdates = toolUpdates.filter((u) => u.status === 'completed' && u.rawOutput?.ok === true);
  assert(completedUpdates.length >= 3, `必须包含至少 3 个成功完成的工具卡片，实际: ${completedUpdates.length}`);

  // 检验 shell_run 输出中包含单元测试和冒烟测试通过标记
  let unittestPassed = false;
  let smokePassed = false;
  for (const u of completedUpdates) {
    const out = String(u.rawOutput?.output || '');
    if (out.includes('Ran 17 tests') && out.includes('OK')) {
      unittestPassed = true;
    }
    if (out.includes('SMOKE_OK: 5')) {
      smokePassed = true;
    }
  }

  assert(unittestPassed, 'shell_run 真实执行输出必须包含 17 项单元测试全部通过标记');
  assert(smokePassed, 'shell_run 真实执行输出必须包含 pygame dummy 5帧冒烟测试成功标记');
  console.log('   ✓ file_read、file_write、shell_run 成功卡片均已断言通过');
  console.log('   ✓ 17 项 unittest 与 pygame dummy 5 帧测试均在 shell_run 中执行并通过');

  // 6. 验证磁盘真实产物
  console.log('6. 验证磁盘真实生成文件与既有成果完好性...');
  const resultFilePath = join(SNAKE_WORKSPACE, 'acceptance-result.md');
  const resultExists = await fs.stat(resultFilePath).then(() => true).catch(() => false);
  assert(resultExists, '模型自主调用的 file_write 必须在磁盘真实生成 acceptance-result.md');

  const diskResultContent = await fs.readFile(resultFilePath, 'utf8');
  const writeCall = writeFileCalls.find(c => c.rawInput?.path?.endsWith('acceptance-result.md'));
  assert(writeCall, 'Current session must write the acceptance report');
  assert.equal(diskResultContent, writeCall.rawInput.content, 'Disk contents must match the current write');
  assert(diskResultContent.includes('```'), 'acceptance-result.md 中必须包含 Markdown 三反引号代码块');
  console.log('   ✓ acceptance-result.md 真实落盘且包含三反引号 Markdown 代码块');

  // 验证已有修复未被破坏
  const snakeCode = await fs.readFile(join(SNAKE_WORKSPACE, 'snake.py'), 'utf8');
  assert(snakeCode.includes('self.direction'), 'snake.py 既有修复（self.direction 转向判断）不得被破坏');
  assert(snakeCode.includes('pygame.font.Font'), 'snake.py 既有修复（pygame.font.Font）不得被破坏');
  console.log('   ✓ 既有修复成果完整保留');

  // 7. 保存脱敏验收报告
  console.log('7. 生成并保存脱敏验收报告...');
  const report = {
    testName: 'Quick-acp Live ACP End-to-End Acceptance',
    timestamp: new Date().toISOString(),
    status: 'PASSED',
    durationMs,
    environment: {
      platform: process.platform,
      nodeVersion: process.version,
      workspace: SNAKE_WORKSPACE,
    },
    handshake: {
      protocolVersion: initRes.protocolVersion,
      capabilities: initRes.agentCapabilities,
    },
    session: {
      sessionId: sessionId.slice(0, 8) + '***',
      stopReason: promptRes.stopReason,
    },
    toolExecutionSummary: {
      totalToolCalls: toolCalls.length,
      totalToolUpdates: toolUpdates.length,
      fileReadCount: readFileCalls.length,
      fileWriteCount: writeFileCalls.length,
      shellRunCount: shellRunCalls.length,
      unittestPassed,
      smokePassed,
    },
    diskArtifactsVerified: {
      acceptanceResultMdExists: true,
      hasMarkdownBackticks: true,
      preservedOriginalFixes: true,
    },
    notificationsSample: sanitize(
      sessionNotifications.filter(
        (n) => n.update?.sessionUpdate === 'tool_call' || n.update?.sessionUpdate === 'tool_call_update',
      ),
    ),
  };

  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`   ✓ 脱敏验收报告已成功写入: ${REPORT_PATH}`);

  console.log('\n=== Quick-acp 端到端真实在线 ACP 验收全部顺利通过！ ===');
} catch (error) {
  await fs.writeFile(resolve(ROOT, '.dispatch/acceptance-failure.json'), JSON.stringify(sanitize({
    status: 'FAILED', timestamp: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    notifications: sessionNotifications,
    stderr: stderrLogs,
  }), null, 2), 'utf8');
  throw error;
} finally {
  try {
    child.stdin.end();
    child.kill();
  } catch {
    // 忽略清理异常
  }
}
