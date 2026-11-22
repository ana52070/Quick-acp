import assert from 'node:assert/strict';
import { QuickAcpAgent, isNativeDeviceTool } from '../dist/acp/agent.js';
import { QuickChatSession } from '../dist/quick/session.js';
import { buildToolPrompt } from '../dist/tools/strategies.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

console.log('=== 网关原生设备工具拦截与有界超时离线回归测试 ===\n');

const tempSessionsDir = await mkdtemp(join(tmpdir(), 'quick-acp-test-routing-'));
process.env.QUICK_ACP_SESSIONS_DIR = tempSessionsDir;

try {
  // 1. 验证 isNativeDeviceTool 识别逻辑
  {
    assert(isNativeDeviceTool('run_python_on_device'), 'run_python_on_device 必须被识别为原生设备工具');
    assert(isNativeDeviceTool('device_terminal'), 'device_terminal 必须被识别为原生设备工具');
    assert(isNativeDeviceTool('run_bash_on_device'), 'run_bash_on_device 必须被识别为原生设备工具');
    assert(isNativeDeviceTool('run_python'), 'run_python 必须被识别为原生设备工具');
    assert(isNativeDeviceTool('execute_command_on_device'), 'execute_command_on_device 必须被识别为原生设备工具');
    assert(!isNativeDeviceTool('file_read'), 'file_read 不是设备工具');
    assert(!isNativeDeviceTool('file_write'), 'file_write 不是设备工具');
    assert(!isNativeDeviceTool('shell_run'), 'shell_run 不是设备工具');
    assert(!isNativeDeviceTool('plan_update'), 'plan_update 不是设备工具');
    console.log('✓ 1. isNativeDeviceTool 规则识别通过');
  }

  // 2. 验证 buildToolPrompt 提示词强约束与唯一通道声明
  {
    const prompt = buildToolPrompt(
      [{ name: 'file_read', description: 'Read file', inputSchema: { type: 'object' } }],
      'D:/test_workspace',
    );
    assert(prompt.includes('EXCLUSIVE LOCAL CHANNEL'), '必须声明本地工具为唯一执行通道');
    assert(prompt.includes('NO ACCESS VIA CLOUD/DEVICE TOOLS'), '必须明确云端设备工具不可访问本地工作区');
    assert(prompt.includes('run_python_on_device'), '必须显式点名禁止 run_python_on_device');
    assert(prompt.includes('D:/test_workspace'), '必须包含工作区根目录');
    console.log('✓ 2. buildToolPrompt 唯一通道与云端设备工具禁用提示词约束通过');
  }

  // 3. 验证 oneGatewayTurn 拦截原生设备工具调用：立即终止、标记失败、不留 pending 卡片
  {
    const agent = new QuickAcpAgent({ workspaceRoot: process.cwd() });
    const updates = [];
    agent.conn = {
      sessionUpdate: async (notif) => {
        updates.push(notif.update);
      },
    };

    let cancelCalled = false;
    const mockChat = {
      cancel: () => {
        cancelCalled = true;
      },
      sendTurn: async function* () {
        yield { type: 'text', delta: '我先在chuiyu设备的项目目录里确认参考文件' };
        yield {
          type: 'tool_start',
          toolName: 'run_python_on_device',
          toolId: 'call-dev-123',
          args: { script: 'import os; print(os.listdir())' },
        };
        // 模拟上游设备工具挂起中
      },
    };

    const session = {
      id: 'test-sess-device',
      cwd: process.cwd(),
      chat: mockChat,
      agentMode: 'smart',
      thinkingEffort: 'high',
      cancelled: false,
      abortController: null,
    };

    const res = await agent.oneGatewayTurn(session, '列出项目文件', []);

    assert(cancelCalled, '检测到 run_python_on_device 必须立刻调用 chat.cancel() 中止网关执行');
    assert(res.interceptedNativeTool, '必须返回被拦截的原生设备工具信息');
    assert.equal(res.interceptedNativeTool.toolName, 'run_python_on_device');

    // 验证卡片状态：必须先发 pending，随后立即发 failed，绝不留 pending
    const startCard = updates.find((u) => u.sessionUpdate === 'tool_call' && u.toolCallId === 'call-dev-123');
    assert(startCard, '必须发出 tool_call 卡片');
    assert.equal(startCard.status, 'pending');

    const endCard = updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call-dev-123');
    assert(endCard, '必须发出 tool_call_update 卡片');
    assert.equal(endCard.status, 'failed', '原生设备工具卡片状态必须为 failed，严禁伪成功');
    assert(endCard.rawOutput?.output?.includes('已终止该执行路径'), '卡片错误信息必须明确解释终止原因');

    console.log('✓ 3. oneGatewayTurn 原生设备工具拦截、主动取消网关与明确失败卡片闭合通过');
  }

  // 4. 验证 runTurn 拦截原生设备工具后，安全注入修正提示并由模型切换为 quick-tool-call 本地工具
  {
    const agent = new QuickAcpAgent({ workspaceRoot: process.cwd() });
    const thoughts = [];
    agent.conn = {
      sessionUpdate: async (notif) => {
        if (notif.update?.sessionUpdate === 'agent_thought_chunk') {
          thoughts.push(notif.update.content?.text);
        }
      },
    };

    let turnStep = 0;
    let correctivePromptReceived = '';
    agent.oneGatewayTurn = async (_session, text, _images) => {
      turnStep++;
      if (turnStep === 1) {
        // 第一轮：模型误用了原生设备工具
        return {
          text: '我先在chuiyu设备的项目目录里确认参考文件',
          cancelled: false,
          interceptedNativeTool: {
            toolName: 'run_python_on_device',
            toolId: 'call-dev-456',
            args: { script: 'ls' },
          },
        };
      } else {
        // 第二轮：模型收到修正提示，切换为本地 quick-tool-call
        correctivePromptReceived = text;
        return {
          text: '好的，改用本机工具读取文件：\n```quick-tool-call\n{"name":"file_list","arguments":{"path":"."}}\n```',
          cancelled: false,
        };
      }
    };

    let localToolExecuted = false;
    const mockExecutor = {
      execute: async (name) => {
        if (name === 'file_list') localToolExecuted = true;
        return { ok: true, content: 'package.json\nsrc\n' };
      },
    };

    const session = {
      id: 'test-sess-corrective',
      cwd: process.cwd(),
      chat: { cancel: () => {} },
      sessionTools: {
        tools: [{ name: 'file_list', description: 'list files', inputSchema: { type: 'object' } }],
        workspaceRoot: process.cwd(),
        executor: mockExecutor,
      },
      abortController: new AbortController(),
      cancelled: false,
      persisted: {
        sessionId: 'test-sess-corrective',
        threadId: 'test-sess-corrective',
        cwd: process.cwd(),
        title: '测试修正会话',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        agentMode: 'smart',
        turns: [],
      },
    };

    // 第二轮工具执行完后，模型最终回答
    const originalOneGatewayTurn = agent.oneGatewayTurn;
    let subStep = 0;
    agent.oneGatewayTurn = async (s, text, images) => {
      subStep++;
      if (subStep <= 2) {
        return originalOneGatewayTurn(s, text, images);
      }
      return { text: '已通过本地工具成功列出文件。', cancelled: false };
    };

    const turnRes = await agent.runTurn(session, '请查看目录', []);

    assert.equal(turnStep, 2, '必须在拦截后触发第二轮修正提示');
    assert(correctivePromptReceived.includes('系统提示：上游原生设备工具'), '第二轮必须注入修正提示');
    assert(correctivePromptReceived.includes('run_python_on_device'), '修正提示中必须指明被拦截的工具');
    assert(localToolExecuted, '模型切换后，必须成功在本地执行 file_list 工具');
    assert.equal(turnRes.cancelled, false);
    assert(turnRes.text.includes('已通过本地工具成功列出文件'));
    assert(thoughts.some((t) => t?.includes('已拦截上游原生设备工具')), '必须向客户端推送诊断思考说明');

    console.log('✓ 4. runTurn 安全修正提示恢复与无缝切回本地 quick-tool-call 验证通过');
  }

  // 5. 验证上游普通 tool_result 帧正确闭合 tool_start 卡片，且未返回结果的卡片在 turn 结束时兜底闭合
  {
    const agent = new QuickAcpAgent({ workspaceRoot: process.cwd() });
    const updates = [];
    agent.conn = {
      sessionUpdate: async (notif) => {
        updates.push(notif.update);
      },
    };

    const mockChat = {
      cancel: () => {},
      sendTurn: async function* () {
        // 1. 正常网关工具调用 + tool_result 闭合
        yield {
          type: 'tool_start',
          toolName: 'server_search',
          toolId: 'call-search-1',
          args: { query: 'acp spec' },
        };
        yield {
          type: 'tool_end',
          toolId: 'call-search-1',
          result: 'found 3 results',
        };
        // 2. 异常网关工具调用：仅 tool_start，无 tool_end 就直接结束
        yield {
          type: 'tool_start',
          toolName: 'server_hang_tool',
          toolId: 'call-hang-2',
          args: {},
        };
        yield { type: 'turn_end', usage: null };
      },
    };

    const session = {
      id: 'test-sess-tool-result',
      cwd: process.cwd(),
      chat: mockChat,
      agentMode: 'smart',
      thinkingEffort: 'high',
      cancelled: false,
      abortController: null,
    };

    await agent.oneGatewayTurn(session, '搜索规范', []);

    // 验证 search 工具卡片 completed
    const searchEnd = updates.find(
      (u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call-search-1',
    );
    assert(searchEnd, 'server_search 必须收到 tool_call_update');
    assert.equal(searchEnd.status, 'completed');
    assert.equal(searchEnd.rawOutput?.output, 'found 3 results');

    // 验证未返回结果的 hang_tool 卡片在 finally 中被兜底闭合为 failed，绝不留 pending
    const hangEnd = updates.find(
      (u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'call-hang-2',
    );
    assert(hangEnd, 'server_hang_tool 必须被兜底 tool_call_update 闭合');
    assert.equal(hangEnd.status, 'failed', '未完成工具必须标为 failed');

    console.log('✓ 5. 上游 tool_result 正常闭合与轮次结束未闭合卡片兜底保护通过');
  }

  // 6. 验证 sendTurn 有界超时 (turnTimeoutMs) 机制：超时后自动中止并不挂起
  {
    const mockTransport = {
      surface: 'test',
      outpostId: 'test-outpost',
      send: () => {},
    };
    const session = new QuickChatSession({ transport: mockTransport });
    session.connected = true;

    const start = Date.now();
    let timedOutError = null;

    try {
      const stream = session.sendTurn([{ role: 'user', text: 'hello' }], {
        turnTimeoutMs: 150,
      });
      for await (const ev of stream) {
        if (ev.type === 'error') {
          timedOutError = ev;
        }
      }
    } catch (err) {
      timedOutError = err;
    }

    const elapsed = Date.now() - start;
    assert(elapsed >= 140 && elapsed < 800, `必须在指定超时 (150ms) 附近终止，实际用时 ${elapsed}ms`);
    assert(timedOutError, '超时必须交付错误事件或异常');
    assert.equal(timedOutError.code, 'turn_timeout', '错误代码必须为 turn_timeout');

    console.log('✓ 6. sendTurn turnTimeoutMs 有界超时自动中止通过');
  }

  // 7. 验证 cancel() 立即唤醒 sendTurn 挂起等待，杜绝永久阻塞
  {
    const mockTransport = {
      surface: 'test',
      outpostId: 'test-outpost',
      send: () => {},
    };
    const session = new QuickChatSession({ transport: mockTransport });
    session.connected = true;

    const start = Date.now();
    let cancelError = null;

    setTimeout(() => {
      session.cancel();
    }, 100);

    try {
      const stream = session.sendTurn([{ role: 'user', text: 'hello' }], {
        turnTimeoutMs: 10000,
      });
      for await (const ev of stream) {
        if (ev.type === 'error') {
          cancelError = ev;
        }
      }
    } catch (err) {
      cancelError = err;
    }

    const elapsed = Date.now() - start;
    assert(elapsed >= 90 && elapsed < 600, `cancel 必须在 ~100ms 立即唤醒结束，实际用时 ${elapsed}ms`);
    assert(cancelError, '主动 cancel 必须交付 cancelled 事件');
    assert.equal(cancelError.code, 'cancelled');

    console.log('✓ 7. cancel() 立即唤醒挂起 sendTurn 并释放资源通过');
  }

  {
    const agent = new QuickAcpAgent();
    agent.oneGatewayTurn = async () => ({ text: '', cancelled: false,
      interceptedNativeTool: { toolName: 'run_python_on_device', toolId: 'repeat', args: {} } });
    await assert.rejects(agent.runTurn({id: 'repeat', cwd: process.cwd(),
      sessionTools: {tools: [], workspaceRoot: process.cwd(), executor: {}},
      abortController: new AbortController(), cancelled: false}, '查看文件', []),
      /持续尝试调用云端原生设备工具/);
    console.log('✓ 8. 重复错误设备路由必须返回失败');
  }
  {
    const session = new QuickChatSession({transport: {send: () => {throw new Error('send failed');}}});
    session.connected = true;
    await assert.rejects(async () => {
      for await (const event of session.sendTurn([{role:'user',text:'hello'}], {turnTimeoutMs: 1000})) {}
    }, /send failed/);
    assert.equal(session.activeHandler, null);
    assert.equal(session.activeMessageId, null);
    let sends = 0;
    const aborted = new AbortController(); aborted.abort();
    const cancelled = new QuickChatSession({transport: {send: (message) => {if(message.type==='user_message') sends++;}}});
    cancelled.connected = true;
    for await (const event of cancelled.sendTurn([{role:'user',text:'hello'}], {signal:aborted.signal})) {}
    assert.equal(sends, 0, '预先取消后不能再发送用户任务');
    console.log('✓ 9. 发送失败释放状态，预先取消不发任务');
  }
  console.log('\n=== 全部 9 项网关设备路由与超时控制测试通过 ===\n');
} finally {
  try {
    await rm(tempSessionsDir, { recursive: true, force: true });
  } catch {}
}
