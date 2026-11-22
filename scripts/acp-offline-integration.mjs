#!/usr/bin/env node
/**
 * 离线 ACP stdio 协议端到端集成测试 (Offline ACP stdio Integration Test)
 *
 * 标识：[MOCK UPSTREAM GATEWAY]
 * 说明：通过启动真实的 dist/main.js ACP stdio 子进程，接入本地 Mock Quick WebSocket 网关，
 * 验证端到端 ACP 协议完整性：
 *   1. initialize 协议握手能力协商 (loadSession: true, image: true)
 *   2. session/new 初始化并建立 WebSocket 传输连接
 *   3. 本地内置斜杠命令 (/help, /mode) 拦截执行且不发模型
 *   4. 真实多轮工具调用流转 (file_list: tool_call -> pending -> completed -> tool_call_update)
 *   5. session/load 历史回放与原线程续接
 *   6. session/fork 新会话分叉与历史记忆摘要上下文注入
 *   7. 进程平稳关闭与资源释放
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { esEncode, esDrain, decodeInbound } from '../dist/quick/codec.js';

console.log('=== 启动 Quick-acp 离线 ACP stdio 协议集成测试 (Mock Upstream Gateway) ===\n');

const MOCK_WS_PORT = 8785;
const tempSessionsDir = await mkdtemp(join(tmpdir(), 'quick-acp-offline-int-'));

// 1. 搭建本地 Mock Quick WebSocket 网关
const wss = new WebSocketServer({ port: MOCK_WS_PORT });

let activeGatewayWs = null;
const receivedGatewayMessages = [];
let excessLoopCount = 0;

function makeQuickFrame(obj) {
  const jsonStr = JSON.stringify(obj);
  const innerPayload = Buffer.from(
    JSON.stringify({ payload: Buffer.from(jsonStr).toString('base64') }),
  );
  return esEncode(
    {
      ':event-type': 'rawInputEvent',
      ':content-type': 'application/json',
      ':message-type': 'event',
    },
    innerPayload,
  );
}

wss.on('connection', (ws) => {
  activeGatewayWs = ws;

  ws.on('message', (chunk) => {
    try {
      const text = chunk.toString('utf8');
      if (text.startsWith('{')) {
        const parsed = JSON.parse(text);
        if (parsed.eventType === 'rawInputEvent' && parsed.payload?.payload) {
          const inner = Buffer.from(parsed.payload.payload, 'base64').toString('utf8');
          const msg = JSON.parse(inner);
          receivedGatewayMessages.push(msg);
          handleGatewayInbound(ws, msg);
          return;
        }
      }
    } catch {}

    try {
      const { messages } = esDrain(new Uint8Array(chunk));
      for (const msg of messages) {
        const ev = decodeInbound(msg);
        if (ev.kind === 'message') {
          const parsed = JSON.parse(ev.body);
          receivedGatewayMessages.push(parsed);
          handleGatewayInbound(ws, parsed);
        }
      }
    } catch {}
  });

  // 收到连接握手后，响应 session_established
  ws.send(makeQuickFrame({ type: 'session_established' }));
});

function handleGatewayInbound(ws, msg) {
  if (msg.type === 'session_connect') {
    // 已在连接时返回 session_established
    return;
  }

  if (msg.type === 'user_message') {
    const text = msg.payload?.text || '';

    // 扩展测试分支：测试计划更新 (plan_update)
    if (text.includes('测试计划更新')) {
      setTimeout(() => {
        ws.send(makeQuickFrame({ type: 'message_start', message_id: 'msg-plan-1' }));
        ws.send(
          makeQuickFrame({
            type: 'text_delta',
            payload: {
              delta: '```quick-tool-call\n{"name":"plan_update","arguments":{"entries":[{"content":"步骤1：初始化","status":"completed"},{"content":"步骤2：集成测试","status":"in_progress"}]}}\n```',
            },
          }),
        );
        ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
      }, 50);
    } else if (text.includes('测试未保存缓冲区')) {
      setTimeout(() => {
        ws.send(makeQuickFrame({ type: 'message_start', message_id: 'msg-buf-1' }));
        ws.send(
          makeQuickFrame({
            type: 'text_delta',
            payload: {
              delta: '```quick-tool-call\n{"name":"file_read","arguments":{"path":"unsaved_test.ts"}}\n```',
            },
          }),
        );
        ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
      }, 50);
    } else if (text.includes('测试权限审批拒绝')) {
      setTimeout(() => {
        ws.send(makeQuickFrame({ type: 'message_start', message_id: 'msg-perm-1' }));
        ws.send(
          makeQuickFrame({
            type: 'text_delta',
            payload: {
              delta: '```quick-tool-call\n{"name":"ask_user_question","arguments":{"question":"确认删除测试文件吗？","options":["同意","拒绝"]}}\n```',
            },
          }),
        );
        ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
      }, 50);
    } else if (text.includes('Tool result') && text.includes('plan_update')) {
      setTimeout(() => {
        ws.send(makeQuickFrame({ type: 'message_start', message_id: 'msg-plan-done' }));
        ws.send(makeQuickFrame({ type: 'text_delta', payload: { delta: '已成功更新任务执行计划。' } }));
        ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
      }, 50);
    } else if (text.includes('Tool result') && text.includes('UNSAVED BUFFER')) {
      setTimeout(() => {
        ws.send(makeQuickFrame({ type: 'message_start', message_id: 'msg-buf-done' }));
        ws.send(makeQuickFrame({ type: 'text_delta', payload: { delta: '已成功从编辑器未保存缓冲区读取内容。' } }));
        ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
      }, 50);
    } else if (text.includes('Tool result') && (text.includes('拒绝') || text.includes('refused'))) {
      setTimeout(() => {
        ws.send(makeQuickFrame({ type: 'message_start', message_id: 'msg-perm-done' }));
        ws.send(makeQuickFrame({ type: 'text_delta', payload: { delta: '用户已拒绝执行，无任何副作用产生。' } }));
        ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
      }, 50);
    } else if (text.includes('测试工具超额')) {
      excessLoopCount = 1;
      setTimeout(() => {
        ws.send(makeQuickFrame({ type: 'message_start', message_id: 'msg-excess-1' }));
        ws.send(
          makeQuickFrame({
            type: 'text_delta',
            payload: {
              delta: '```quick-tool-call\n{"name":"file_list","arguments":{"path":"."}}\n```',
            },
          }),
        );
        ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
      }, 10);
    } else if (excessLoopCount > 0 && (text.includes('Tool result') || text.includes('file_list'))) {
      excessLoopCount++;
      setTimeout(() => {
        ws.send(makeQuickFrame({ type: 'message_start', message_id: `msg-excess-${excessLoopCount}` }));
        ws.send(
          makeQuickFrame({
            type: 'text_delta',
            payload: {
              delta: '```quick-tool-call\n{"name":"file_list","arguments":{"path":"."}}\n```',
            },
          }),
        );
        ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
      }, 10);
    } else if (text.includes('测试工具调用')) {
      setTimeout(() => {
        // 第一轮：触发 file_list 工具调用
        ws.send(makeQuickFrame({ type: 'message_start', message_id: 'msg-tool-1' }));
        ws.send(makeQuickFrame({ type: 'thinking_start', payload: { type: 'thinking_start' } }));
        ws.send(makeQuickFrame({ type: 'thinking_delta', payload: { delta: '正在分析目录...' } }));
        ws.send(
          makeQuickFrame({
            type: 'text_delta',
            payload: {
              delta: '```quick-tool-call\n{"name":"file_list","arguments":{"path":"."}}\n```',
            },
          }),
        );
        ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
      }, 50);
    } else if (text.includes('Tool result') || text.includes('file_list')) {
      // 第二轮工具回传：完成对话
      setTimeout(() => {
        ws.send(makeQuickFrame({ type: 'message_start', message_id: 'msg-final-1' }));
        ws.send(
          makeQuickFrame({
            type: 'text_delta',
            payload: { delta: '已成功列出目录并完成工具调用测试。' },
          }),
        );
        ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
      }, 50);
    } else {
      // 普通回复
      setTimeout(() => {
        ws.send(makeQuickFrame({ type: 'message_start', message_id: 'msg-normal-1' }));
        ws.send(
          makeQuickFrame({
            type: 'text_delta',
            payload: { delta: 'Mock回复: ' + text.slice(0, 50) },
          }),
        );
        ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
      }, 50);
    }
  }
}

// 2. 启动 dist/main.js ACP stdio 子进程
const child = spawn(process.execPath, [join(process.cwd(), 'dist/main.js')], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    QUICK_ACP_MOCK_SESSION: '1',
    QUICK_ACP_MOCK_HOST: `127.0.0.1:${MOCK_WS_PORT}`,
    QUICK_ACP_SESSIONS_DIR: tempSessionsDir,
    QUICK_ACP_ALLOW_SHELL: '1',
    QUICK_ACP_PRINT_INFO: '0',
  },
});

let msgId = 0;
const pendingRequests = new Map();
const sessionNotifications = [];

let stdoutBuffer = '';
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString('utf8');
  let newlineIdx;
  while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
    const line = stdoutBuffer.slice(0, newlineIdx).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
    if (!line) continue;

    try {
      const msg = JSON.parse(line);
      if (msg.method && msg.id !== undefined) {
        // Agent 向 Client 发起的反向 RPC 请求
        handleClientInboundRpc(msg);
      } else if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { resolve, reject, timer } = pendingRequests.get(msg.id);
        clearTimeout(timer);
        pendingRequests.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'session/update') {
        sessionNotifications.push(msg.params);
      }
    } catch {
      // 忽略非 JSON 行
    }
  }
});

let stderrLogs = '';
child.stderr.on('data', (chunk) => {
  stderrLogs += chunk.toString('utf8');
});


let simulateRejectPermission = false;
let clientFsReadReceived = false;
let clientPermissionRequested = false;

function handleClientInboundRpc(msg) {
  if (msg.method === 'fs/read_text_file') {
    clientFsReadReceived = true;
    const resp = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: '// [UNSAVED BUFFER CONTENT IN EDITOR]\nconst unsaved = true;',
      },
    };
    child.stdin.write(JSON.stringify(resp) + '\n');
    return;
  }

  if (msg.method === 'session/request_permission') {
    clientPermissionRequested = true;
    const optionId = simulateRejectPermission ? 'reject-once' : 'allow-once';
    const resp = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        outcome: {
          outcome: 'selected',
          optionId,
        },
      },
    };
    child.stdin.write(JSON.stringify(resp) + '\n');
    return;
  }
}

function sendRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`ACP 请求 ${method} (id=${id}) 等待超时 (15000ms)`));
    }, 15000);

    pendingRequests.set(id, { resolve, reject, timer });
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    child.stdin.write(payload);
  });
}

try {
  // 3. 验证 initialize 协议握手
  console.log('1. 发送 initialize 协议握手...');
  const initRes = await sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true } },
  });
  assert.equal(initRes.protocolVersion, 1, 'ACP 协议版本匹配');
  assert.equal(initRes.agentCapabilities?.loadSession, true, '声明支持 loadSession 会话恢复');
  assert.equal(initRes.agentCapabilities?.promptCapabilities?.image, true, '声明支持多模态图片交互');
  console.log('✓ 1. initialize 握手协商成功');

  // 4. 验证 session/new 会话创建与命令清单推送
  console.log('2. 发送 session/new 创建新会话...');
  const newSessionRes = await sendRequest('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
  });
  assert(newSessionRes.sessionId, '成功返回 sessionId');
  assert(newSessionRes.modes?.availableModes?.length >= 3, '包含 fast/balanced/smart 档位');
  const sessionId = newSessionRes.sessionId;
  console.log('✓ 2. session/new 创建成功, sessionId:', sessionId);

  // 等待 available_commands_update 通知
  await new Promise((r) => setTimeout(r, 200));
  const cmdNotice = sessionNotifications.find(
    (n) => n.update?.sessionUpdate === 'available_commands_update',
  );
  assert(cmdNotice, '收到 available_commands_update 通知');
  const commands = cmdNotice.update.availableCommands;
  assert(commands.some((c) => c.name === 'help'), '命令列表包含 help');
  assert(commands.some((c) => c.name === 'mode'), '命令列表包含 mode');
  assert(commands.some((c) => c.name === 'plan'), '命令列表包含 plan');
  assert(commands.some((c) => c.name === 'clear'), '命令列表包含 clear');
  console.log('✓ 3. 客户端斜杠命令目录推送验证通过');

  // 5. 验证内置斜杠命令本地拦截执行（不请求上游模型）
  console.log('4. 验证 /help 与 /mode 命令本地拦截...');
  const gatewayMsgCountBefore = receivedGatewayMessages.filter((m) => m.type === 'user_message').length;

  const helpPromptRes = await sendRequest('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '/help' }],
  });
  assert.equal(helpPromptRes.stopReason, 'end_turn');

  const modePromptRes = await sendRequest('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '/mode fast' }],
  });
  assert.equal(modePromptRes.stopReason, 'end_turn');

  const gatewayMsgCountAfter = receivedGatewayMessages.filter((m) => m.type === 'user_message').length;
  assert.equal(
    gatewayMsgCountBefore,
    gatewayMsgCountAfter,
    '内置斜杠命令必须由本地完全拦截，不得发往上游模型',
  );
  console.log('✓ 4. 内置斜杠命令本地拦截验证通过');

  // 6. 验证端到端多轮工具调用流转
  console.log('5. 发送测试工具调用提示词...');
  sessionNotifications.length = 0; // 清空旧通知

  const toolPromptRes = await sendRequest('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '请测试工具调用' }],
  });
  assert.equal(toolPromptRes.stopReason, 'end_turn', '工具调用轮次正常结束');

  const toolCallCreated = sessionNotifications.find(
    (n) => n.update?.sessionUpdate === 'tool_call',
  );
  assert(toolCallCreated, '收到 tool_call 创建通知');
  assert.equal(toolCallCreated.update.kind, 'search', 'file_list 对应 search 类型卡片');

  const toolCallCompleted = sessionNotifications.find(
    (n) => n.update?.sessionUpdate === 'tool_call_update' && n.update.status === 'completed',
  );
  assert(toolCallCompleted, '收到 tool_call_update 完成通知');

  const asstMessage = sessionNotifications.find(
    (n) =>
      n.update?.sessionUpdate === 'agent_message_chunk' &&
      n.update.content?.text?.includes('已成功列出目录'),
  );
  assert(asstMessage, '助手最终回复文本正常流式推流');
  console.log('✓ 5. 端到端多轮工具调用流转与卡片状态验证通过');

  // 7. 验证 session/load 恢复会话历史重放
  console.log('6. 验证 session/load 历史回放...');
  sessionNotifications.length = 0;

  const loadRes = await sendRequest('session/load', {
    sessionId,
    cwd: process.cwd(),
    mcpServers: [],
  });
  assert(loadRes.modes, 'session/load 正确返回 modes');

  const replayedUser = sessionNotifications.find(
    (n) => n.update?.sessionUpdate === 'user_message_chunk',
  );
  assert(replayedUser, '成功重放用户历史消息');

  const replayedTool = sessionNotifications.find(
    (n) => n.update?.sessionUpdate === 'tool_call',
  );
  assert(replayedTool, '成功重放工具调用卡片');
  console.log('✓ 6. session/load 历史回放与续接验证通过');

  // 8. 验证 session/fork 会话分叉与上下文摘要注入
  console.log('7. 验证 session/fork 分叉与父会话历史注入...');
  const forkRes = await sendRequest('_session/fork', {
    sessionId,
  });
  assert(forkRes.sessionId, '分叉返回新 sessionId');
  assert.notEqual(forkRes.sessionId, sessionId, '分叉会话 ID 必须独立于父会话');
  const forkedSessionId = forkRes.sessionId;

  // 向分叉后的会话发送提问，验证上游 Mock 网关收到的 user_message 包含父历史摘要
  receivedGatewayMessages.length = 0;
  await sendRequest('session/prompt', {
    sessionId: forkedSessionId,
    prompt: [{ type: 'text', text: '在分叉中继续' }],
  });

  const forkUserMsg = receivedGatewayMessages.find((m) => m.type === 'user_message');
  assert(forkUserMsg, '网关收到分叉会话消息');
  assert(
    forkUserMsg.payload?.text?.includes('上轮对话历史上下文'),
    '分叉新会话的首个请求中必须注入父会话的历史记忆摘要',
  );
  console.log('✓ 7. session/fork 新会话独立性与历史摘要记忆注入验证通过');

  // 8. 验证 plan_update 结构化任务计划通知
  console.log('8. 验证 plan_update 结构化通知...');
  sessionNotifications.length = 0;
  const planPromptRes = await sendRequest('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '请测试计划更新' }],
  });
  assert.equal(planPromptRes.stopReason, 'end_turn');

  const planNotice = sessionNotifications.find((n) => n.update?.sessionUpdate === 'plan');
  assert(planNotice, '客户端必须收到 sessionUpdate: "plan" 的结构化通知');
  assert.equal(planNotice.update.entries?.length, 2, '任务计划条目数量正确');
  assert.equal(planNotice.update.entries[0].status, 'completed');
  assert.equal(planNotice.update.entries[1].status, 'in_progress');
  console.log('✓ 8. plan_update 结构化任务计划通知集成验证通过');

  // 9. 验证 client fs/read_text_file 委托读取未保存内存缓冲区
  console.log('9. 验证 client fs/read_text_file 读取未保存缓冲区...');
  clientFsReadReceived = false;
  const bufPromptRes = await sendRequest('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '请测试未保存缓冲区' }],
  });
  assert.equal(bufPromptRes.stopReason, 'end_turn');
  assert(clientFsReadReceived, 'Agent 必须向客户端 stdio 发送 fs/read_text_file 请求');
  console.log('✓ 9. client fs/read_text_file 内存缓冲区委托装配验证通过');

  // 10. 验证 ask 模式/权限审批拒绝后无副作用且会话可续接
  console.log('10. 验证权限审批拒绝后无副作用与会话续接...');
  simulateRejectPermission = true;
  clientPermissionRequested = false;
  sessionNotifications.length = 0;

  const rejectPromptRes = await sendRequest('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '请测试权限审批拒绝' }],
  });
  assert.equal(rejectPromptRes.stopReason, 'end_turn');
  assert(clientPermissionRequested, '敏感操作或提问必须触发 session/request_permission');

  const toolFailedNotice = sessionNotifications.find(
    (n) => n.update?.sessionUpdate === 'tool_call_update' && n.update.status === 'failed',
  );
  assert(toolFailedNotice, '被拒绝的工具调用状态必须更新为 failed');

  // 验证拒绝后无副作用：立即发送下一轮普通提问，会话完全正常运转
  const followUpRes = await sendRequest('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '你好，请继续' }],
  });
  assert.equal(followUpRes.stopReason, 'end_turn');
  console.log('✓ 10. 权限审批拒绝后无副作用且后续会话正常推进验证通过');

  // 11. 验证工具调用超额返回 max_turn_requests 与截断提示
  console.log('11. 验证工具调用超额返回 max_turn_requests 与截断提示...');
  sessionNotifications.length = 0;
  const excessPromptRes = await sendRequest('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '请测试工具超额' }],
  });
  assert.equal(
    excessPromptRes.stopReason,
    'max_turn_requests',
    '工具调用超额时必须返回 max_turn_requests 而不是 end_turn',
  );
  const excessNotice = sessionNotifications.find(
    (n) =>
      n.update?.sessionUpdate === 'agent_message_chunk' &&
      (n.update.content?.text?.includes('【工具调用额度已用尽】') ||
        n.update.content?.text?.includes('工具调用上限') ||
        n.update.content?.text?.includes('额度')),
  );
  assert(excessNotice, '客户端必须收到中文工具额度用尽提示');
  console.log('✓ 11. 工具调用超额返回 max_turn_requests 与截断提示验证通过');

  console.log('\n=== 全部离线 ACP stdio 协议集成测试顺利通过 ===\n');
} finally {
  // 清理子进程与 Mock 服务器
  child.stdin.end();
  child.kill('SIGTERM');
  wss.close();
  try {
    await rm(tempSessionsDir, { recursive: true, force: true });
  } catch {}
}
