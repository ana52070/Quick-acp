#!/usr/bin/env node
/**
 * 工具调用预算耗尽与协议状态专项测试 (Tool Budget Exhaustion Tests)
 *
 * 覆盖场景：
 * 1. 额度 2 请求 3 -> max_turn_requests 不是 end_turn
 * 2. 客户端收到中文未完成 + 进度提示 (调用数、最后执行工具及状态、下一待执行工具，不泄漏完整文件/敏感参数)
 * 3. 磁盘留工具与截断提示 (session.persisted 记录完整 executedToolCalls 与中文截断 text)
 * 4. 批量中途停止且无多执行/空卡片 (预算 2 批处理 3 工具，恰执行 2 个，第 3 个不发 tool_call 卡片)
 * 5. 恰好预算后正常 final (预算 2 执行 2 个工具后模型正常输出最终回复 -> 允许 end_turn)
 * 6. 额度内 normal 不重复输出 (正常文本流式推流，不因回调重复 emitText)
 * 7. 取消优先 (执行或超额过程中触发 abortSignal -> 必须返回 cancelled)
 * 8. 真实 ACP stdio Mock 端到端验证超额 stopReason (验证外部客户端经 stdio 接收 max_turn_requests 与截断通知)
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { QuickAcpAgent } from '../dist/acp/agent.js';
import { QuickChatSession } from '../dist/quick/session.js';
import { esEncode, esDrain, decodeInbound } from '../dist/quick/codec.js';

console.log('=== 启动 Quick-acp 工具预算专项测试 (Tool Budget Tests) ===\n');

const tempSessionsDir = await mkdtemp(join(tmpdir(), 'quick-acp-test-budget-'));
process.env.QUICK_ACP_SESSIONS_DIR = tempSessionsDir;

let mockWsServer = null;
let stdioChild = null;

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

try {
  // -------------------------------------------------------------------------
  // 测试 1 & 2 & 3: 额度2请求3 -> max_turn_requests、客户端中文提示、磁盘审计完整
  // -------------------------------------------------------------------------
  {
    console.log('测试 1-3: 额度 2 请求 3 -> max_turn_requests、客户端中文通知与磁盘审计...');
    process.env.QUICK_ACP_MAX_TOOL_ROUNDS = '2';

    const clientUpdates = [];
    const mockConn = {
      sessionUpdate: async (notification) => {
        clientUpdates.push(notification);
      },
      extNotification: async () => {},
    };

    const agent = new QuickAcpAgent({ workspaceRoot: tempSessionsDir });
    agent.conn = mockConn;
    agent.quick = async () => ({
      tenantUrl: 'https://test.example.com',
      wsHost: '127.0.0.1:9999',
      jwt: 'mock-token',
      surface: 'test-surface',
      outpostId: 'test-outpost',
      actorArn: 'mock-actor',
    });

    const originalChatOpen = QuickChatSession.prototype.open;
    QuickChatSession.prototype.open = async function () {
      this.connected = true;
    };

    let sessionId;
    try {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'budget-test', version: '1.0' },
      });

      const res = await agent.newSession({
        sessionId: 'test-budget-session-1',
        cwd: tempSessionsDir,
      });
      sessionId = res.sessionId;
    } finally {
      QuickChatSession.prototype.open = originalChatOpen;
    }

    // 模拟 3 轮工具调用：
    // 第 1 轮：请求写 1.txt
    // 第 2 轮：请求写 2.txt
    // 第 3 轮：请求写 3.txt (超出上限 2 轮)
    let gatewayTurnCount = 0;
    agent.oneGatewayTurn = async (session, text, images, onTextChunk) => {
      gatewayTurnCount++;
      if (gatewayTurnCount === 1) {
        return {
          text: '```quick-tool-call\n{"name":"file_write","arguments":{"path":"1.txt","content":"file 1 content"}}\n```',
          cancelled: false,
        };
      } else if (gatewayTurnCount === 2) {
        return {
          text: '```quick-tool-call\n{"name":"file_write","arguments":{"path":"2.txt","content":"file 2 content"}}\n```',
          cancelled: false,
        };
      } else {
        return {
          text: '```quick-tool-call\n{"name":"file_write","arguments":{"path":"3.txt","content":"file 3 content"}}\n```',
          cancelled: false,
        };
      }
    };

    const promptRes = await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '请连续写入三个文件 1.txt 2.txt 3.txt' }],
    });

    // 校验 1: stopReason 必须为 max_turn_requests，绝不是 end_turn
    assert.equal(
      promptRes.stopReason,
      'max_turn_requests',
      '超出工具预算时 stopReason 必须为 max_turn_requests 而非 end_turn',
    );
    console.log('✓ 1. 额度 2 请求 3 时返回 stopReason: max_turn_requests 校验通过');

    // 校验 2: 客户端收到中文未完成 + 进度提示
    const textUpdates = clientUpdates.filter(
      (u) => u.update?.sessionUpdate === 'agent_message_chunk',
    );
    const combinedClientText = textUpdates.map((u) => u.update.content?.text || '').join('');

    assert(
      combinedClientText.includes('【工具调用额度已用尽】') ||
      combinedClientText.includes('工具调用上限') ||
      combinedClientText.includes('额度'),
      '客户端必须收到中文工具额度用尽提示',
    );
    assert(
      combinedClientText.includes('2/2') || combinedClientText.includes('2 次') || combinedClientText.includes('2'),
      '提示中必须包含调用次数进度信息',
    );
    assert(
      combinedClientText.includes('2.txt') && combinedClientText.includes('成功'),
      '提示中必须包含最后实际执行的工具/文件 (2.txt) 及其成功状态',
    );
    assert(
      combinedClientText.includes('3.txt'),
      '提示中必须包含下一待执行工具/文件 (3.txt)',
    );
    assert(
      !combinedClientText.includes('file 1 content') && !combinedClientText.includes('file 3 content'),
      '提示中绝不得输出完整文件内容或敏感参数',
    );
    console.log('✓ 2. 客户端接收中文未完成提示、进度、最后工具及下一待执行工具校验通过');

    // 校验 3: 磁盘持久化留存已执行工具与截断说明
    const sessionFilePath = join(tempSessionsDir, `${sessionId}.json`);
    const sessionFileContent = await readFile(sessionFilePath, 'utf8');
    const persisted = JSON.parse(sessionFileContent);

    const asstTurns = persisted.turns.filter((t) => t.role === 'assistant');
    assert(asstTurns.length >= 1, '磁盘必须持久化落盘助手轮次');
    const lastAsstTurn = asstTurns[asstTurns.length - 1];

    assert(
      lastAsstTurn.text.includes('【工具调用额度已用尽】') || lastAsstTurn.text.includes('工具调用上限'),
      '磁盘持久化文本必须留存中文截断说明',
    );
    assert(
      Array.isArray(lastAsstTurn.toolCalls) && lastAsstTurn.toolCalls.length === 2,
      '磁盘必须记录实际成功执行的 2 个工具调用记录',
    );
    assert.equal(lastAsstTurn.toolCalls[0].args.path, '1.txt');
    assert.equal(lastAsstTurn.toolCalls[1].args.path, '2.txt');
    console.log('✓ 3. 磁盘留存已执行工具列表与截断说明持久化校验通过');
  }

  // -------------------------------------------------------------------------
  // 测试 4: 批量中途停止且无多执行/空卡片
  // -------------------------------------------------------------------------
  {
    console.log('测试 4: 批量中途停止且无多执行/空卡片...');
    process.env.QUICK_ACP_MAX_TOOL_ROUNDS = '2';

    const clientUpdates = [];
    const mockConn = {
      sessionUpdate: async (notification) => {
        clientUpdates.push(notification);
      },
      extNotification: async () => {},
    };

    const agent = new QuickAcpAgent({ workspaceRoot: tempSessionsDir });
    agent.conn = mockConn;
    agent.quick = async () => ({
      tenantUrl: 'https://test.example.com',
      wsHost: '127.0.0.1:9999',
      jwt: 'mock-token',
      surface: 'test-surface',
      outpostId: 'test-outpost',
      actorArn: 'mock-actor',
    });

    const originalChatOpen = QuickChatSession.prototype.open;
    QuickChatSession.prototype.open = async function () {
      this.connected = true;
    };

    let sessionId;
    try {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'budget-batch', version: '1.0' },
      });

      const res = await agent.newSession({
        sessionId: 'test-budget-session-batch',
        cwd: tempSessionsDir,
      });
      sessionId = res.sessionId;
    } finally {
      QuickChatSession.prototype.open = originalChatOpen;
    }

    // 单轮一次性返回 3 个工具调用
    agent.oneGatewayTurn = async () => {
      const batchCalls = [
        { name: 'file_write', arguments: { path: 'batch1.txt', content: 'b1' } },
        { name: 'file_write', arguments: { path: 'batch2.txt', content: 'b2' } },
        { name: 'file_write', arguments: { path: 'batch3.txt', content: 'b3' } },
      ];
      return {
        text: '```quick-tool-call\n' + JSON.stringify(batchCalls) + '\n```',
        cancelled: false,
      };
    };

    const promptRes = await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '批处理写入 3 个文件' }],
    });

    assert.equal(promptRes.stopReason, 'max_turn_requests');

    // 统计开始卡片与完成卡片
    const startCards = clientUpdates.filter((u) => u.update?.sessionUpdate === 'tool_call');
    const endCards = clientUpdates.filter(
      (u) => u.update?.sessionUpdate === 'tool_call_update' && u.update?.status === 'completed',
    );

    assert.equal(startCards.length, 2, '前 2 个工具必须发出开始卡片，第 3 个绝不能预先发卡片');
    assert.equal(endCards.length, 2, '恰好完成 2 个工具');

    // 确认第 3 个工具 batch3.txt 绝无任何卡片
    const batch3Card = clientUpdates.find((u) => (u.update?.sessionUpdate === 'tool_call' || u.update?.sessionUpdate === 'tool_call_update') && JSON.stringify(u).includes('batch3.txt'));
    assert(!batch3Card, '未执行工具 batch3.txt 绝不能发出任何工具卡片');
    console.log('✓ 4. 批量多调用中途停止、无超额执行、无空卡片校验通过');
  }

  // -------------------------------------------------------------------------
  // 测试 5: 恰好预算后正常 final (允许 end_turn)
  // -------------------------------------------------------------------------
  {
    console.log('测试 5: 恰好预算后正常 final 回复允许 end_turn...');
    process.env.QUICK_ACP_MAX_TOOL_ROUNDS = '2';

    const clientUpdates = [];
    const mockConn = {
      sessionUpdate: async (notification) => {
        clientUpdates.push(notification);
      },
      extNotification: async () => {},
    };

    const agent = new QuickAcpAgent({ workspaceRoot: tempSessionsDir });
    agent.conn = mockConn;
    agent.quick = async () => ({
      tenantUrl: 'https://test.example.com',
      wsHost: '127.0.0.1:9999',
      jwt: 'mock-token',
      surface: 'test-surface',
      outpostId: 'test-outpost',
      actorArn: 'mock-actor',
    });

    const originalChatOpen = QuickChatSession.prototype.open;
    QuickChatSession.prototype.open = async function () {
      this.connected = true;
    };

    let sessionId;
    try {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'budget-exact', version: '1.0' },
      });

      const res = await agent.newSession({
        sessionId: 'test-budget-session-exact',
        cwd: tempSessionsDir,
      });
      sessionId = res.sessionId;
    } finally {
      QuickChatSession.prototype.open = originalChatOpen;
    }

    let turnCount = 0;
    agent.oneGatewayTurn = async (session, text, images, onTextChunk) => {
      turnCount++;
      if (turnCount === 1) {
        return {
          text: '```quick-tool-call\n{"name":"file_write","arguments":{"path":"exact1.txt","content":"e1"}}\n```',
          cancelled: false,
        };
      } else if (turnCount === 2) {
        return {
          text: '```quick-tool-call\n{"name":"file_write","arguments":{"path":"exact2.txt","content":"e2"}}\n```',
          cancelled: false,
        };
      } else {
        // 执行完 2 个工具（恰好达到 2 轮上限）后，模型在下一轮给出了正常的最终答案（无工具调用）
        const finalAns = '两个文件均已成功写入，任务全部完成！';
        onTextChunk?.(finalAns);
        return {
          text: finalAns,
          cancelled: false,
        };
      }
    };

    const promptRes = await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '写两个文件并总结' }],
    });

    assert.equal(
      promptRes.stopReason,
      'end_turn',
      '恰好耗尽预算但模型给出了正常最终答案时必须允许 end_turn',
    );
    console.log('✓ 5. 恰好预算后模型给出正常最终回复允许 end_turn 校验通过');
  }

  // -------------------------------------------------------------------------
  // 测试 6: 额度内 normal 不重复输出
  // -------------------------------------------------------------------------
  {
    console.log('测试 6: 额度内 normal 文本流式推送不重复...');
    process.env.QUICK_ACP_MAX_TOOL_ROUNDS = '12';

    const clientUpdates = [];
    const mockConn = {
      sessionUpdate: async (notification) => {
        clientUpdates.push(notification);
      },
      extNotification: async () => {},
    };

    const agent = new QuickAcpAgent({ workspaceRoot: tempSessionsDir });
    agent.conn = mockConn;
    agent.quick = async () => ({
      tenantUrl: 'https://test.example.com',
      wsHost: '127.0.0.1:9999',
      jwt: 'mock-token',
      surface: 'test-surface',
      outpostId: 'test-outpost',
      actorArn: 'mock-actor',
    });

    const originalChatOpen = QuickChatSession.prototype.open;
    QuickChatSession.prototype.open = async function () {
      this.connected = true;
    };

    let sessionId;
    try {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'budget-normal', version: '1.0' },
      });

      const res = await agent.newSession({
        sessionId: 'test-budget-session-normal',
        cwd: tempSessionsDir,
      });
      sessionId = res.sessionId;
    } finally {
      QuickChatSession.prototype.open = originalChatOpen;
    }

    const uniquePhrase = 'UNIQUE_PHRASE_' + Date.now();
    // 模拟真实网关流式推流两段
    agent.oneGatewayTurn = async (session, text, images, onTextChunk) => {
      onTextChunk?.(uniquePhrase + '-part1');
      await agent.emitText(session.id, uniquePhrase + '-part1');
      onTextChunk?.(uniquePhrase + '-part2');
      await agent.emitText(session.id, uniquePhrase + '-part2');
      return {
        text: uniquePhrase + '-part1' + uniquePhrase + '-part2',
        cancelled: false,
      };
    };

    const promptRes = await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '你好' }],
    });
    assert.equal(promptRes.stopReason, 'end_turn');

    const emittedChunks = clientUpdates
      .filter((u) => u.update?.sessionUpdate === 'agent_message_chunk')
      .map((u) => u.update.content?.text || '');

    const totalEmittedText = emittedChunks.join('');
    // 检查 uniquePhrase 出现次数：只应出现 1 次完整内容，不得在结束时再全量 emitText 一次
    const occurrences = totalEmittedText.split(uniquePhrase).length - 1;
    assert.equal(
      occurrences,
      2, // part1 一次, part2 一次，合起来 2 次前缀命中
      '正常回答不得在轮次结束时被 onAssistantText 重复 emitText',
    );
    console.log('✓ 6. 额度内 normal 文本流式推送不重复校验通过');
  }

  // -------------------------------------------------------------------------
  // 测试 7: 取消优先
  // -------------------------------------------------------------------------
  {
    console.log('测试 7: 取消操作优先于预算判断...');
    process.env.QUICK_ACP_MAX_TOOL_ROUNDS = '2';

    const agent = new QuickAcpAgent({ workspaceRoot: tempSessionsDir });
    agent.quick = async () => ({
      tenantUrl: 'https://test.example.com',
      wsHost: '127.0.0.1:9999',
      jwt: 'mock-token',
      surface: 'test-surface',
      outpostId: 'test-outpost',
      actorArn: 'mock-actor',
    });

    const originalChatOpen = QuickChatSession.prototype.open;
    QuickChatSession.prototype.open = async function () {
      this.connected = true;
    };

    let sessionId;
    try {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'budget-cancel', version: '1.0' },
      });

      const res = await agent.newSession({
        sessionId: 'test-budget-session-cancel',
        cwd: tempSessionsDir,
      });
      sessionId = res.sessionId;
    } finally {
      QuickChatSession.prototype.open = originalChatOpen;
    }

    agent.oneGatewayTurn = async (session) => {
      // 模拟在网关返回前或工具执行前用户取消
      session.cancelled = true;
      session.abortController?.abort();
      return {
        text: 'cancelled',
        cancelled: true,
      };
    };

    const promptRes = await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '执行任务' }],
    });

    assert.equal(
      promptRes.stopReason,
      'cancelled',
      '发生取消时 stopReason 必须为 cancelled，取消优先于预算截断',
    );
    console.log('✓ 7. 取消优先校验通过');
  }

  // -------------------------------------------------------------------------
  // 测试 8: 真实 ACP stdio Mock 端到端验证超额 stopReason
  // -------------------------------------------------------------------------
  {
    console.log('测试 8: 真实 ACP stdio Mock 端到端验证超额 stopReason...');
    const MOCK_WS_PORT = 8788;
    mockWsServer = new WebSocketServer({ port: MOCK_WS_PORT });

    mockWsServer.on('connection', (ws) => {
      ws.on('message', (chunk) => {
        let msg = null;
        try {
          const text = chunk.toString('utf8');
          if (text.startsWith('{')) {
            const parsed = JSON.parse(text);
            if (parsed.eventType === 'rawInputEvent' && parsed.payload?.payload) {
              msg = JSON.parse(Buffer.from(parsed.payload.payload, 'base64').toString('utf8'));
            }
          }
        } catch {}
        if (!msg) {
          try {
            const { messages } = esDrain(new Uint8Array(chunk));
            for (const m of messages) {
              const ev = decodeInbound(m);
              if (ev.kind === 'message') {
                msg = JSON.parse(ev.body);
                break;
              }
            }
          } catch {}
        }

        if (!msg) return;

        if (msg.type === 'session_connect') {
          return;
        }

        if (msg.type === 'user_message') {
          // 不论第几次收到，都持续返回新的 file_list 工具调用
          setTimeout(() => {
            ws.send(makeQuickFrame({ type: 'message_start', message_id: 'msg-loop-' + Date.now() }));
            ws.send(
              makeQuickFrame({
                type: 'text_delta',
                payload: {
                  delta: '```quick-tool-call\n{"name":"file_list","arguments":{"path":"."}}\n```',
                },
              }),
            );
            ws.send(makeQuickFrame({ type: 'message_complete', payload: { text: '' } }));
          }, 30);
        }
      });

      ws.send(makeQuickFrame({ type: 'session_established' }));
    });

    stdioChild = spawn(process.execPath, [join(process.cwd(), 'dist/main.js')], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        QUICK_ACP_MOCK_SESSION: '1',
        QUICK_ACP_MOCK_HOST: `127.0.0.1:${MOCK_WS_PORT}`,
        QUICK_ACP_SESSIONS_DIR: tempSessionsDir,
        QUICK_ACP_ALLOW_SHELL: '1',
        QUICK_ACP_PRINT_INFO: '0',
        QUICK_ACP_MAX_TOOL_ROUNDS: '2', // 设为 2，第 3 次调用必触发截断
      },
    });

    let msgId = 0;
    const pending = new Map();
    const stdioNotifications = [];

    let stdoutBuf = '';
    stdioChild.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id !== undefined && pending.has(parsed.id)) {
            const { resolve, reject, timer } = pending.get(parsed.id);
            clearTimeout(timer);
            pending.delete(parsed.id);
            if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            else resolve(parsed.result);
          } else if (parsed.method === 'session/update') {
            stdioNotifications.push(parsed.params);
          }
        } catch {}
      }
    });

    const sendRpc = (method, params = {}) => {
      return new Promise((resolve, reject) => {
        const id = ++msgId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP 请求 ${method} (id=${id}) 等待超时`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        stdioChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    };

    // 握手
    await sendRpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const sessionRes = await sendRpc('session/new', { cwd: process.cwd(), mcpServers: [] });
    const e2eSessionId = sessionRes.sessionId;

    // 发起工具调用触发超额
    const promptRes = await sendRpc('session/prompt', {
      sessionId: e2eSessionId,
      prompt: [{ type: 'text', text: '测试无限工具循环' }],
    });

    assert.equal(
      promptRes.stopReason,
      'max_turn_requests',
      'ACP stdio 端到端超额时 stopReason 必须为 max_turn_requests',
    );

    const asstChunks = stdioNotifications.filter(
      (n) => n.update?.sessionUpdate === 'agent_message_chunk',
    );
    const combinedStdioText = asstChunks.map((n) => n.update.content?.text || '').join('');
    assert(
      combinedStdioText.includes('【工具调用额度已用尽】') ||
      combinedStdioText.includes('工具调用上限') ||
      combinedStdioText.includes('额度'),
      'ACP stdio 客户端必须收到流式推送的中文截断提示',
    );

    console.log('✓ 8. 真实 ACP stdio Mock 端到端验证超额 stopReason 校验通过');
  }

  console.log('\n=== 全部 8 项工具预算与协议状态专项测试顺利通过 ===\n');
} finally {
  if (stdioChild) {
    try {
      stdioChild.stdin.end();
      stdioChild.kill('SIGTERM');
    } catch {}
  }
  if (mockWsServer) {
    try {
      mockWsServer.close();
    } catch {}
  }
  try {
    await rm(tempSessionsDir, { recursive: true, force: true });
  } catch {}
}
