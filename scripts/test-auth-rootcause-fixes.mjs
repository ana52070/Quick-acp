import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import WebSocket from 'ws';
import { RequestError } from '@zed-industries/agent-client-protocol';
import { QuickAcpAgent } from '../dist/acp/agent.js';
import { QuickChatSession } from '../dist/quick/session.js';
import { QuickTransport } from '../dist/quick/transport.js';

console.log('=== 针对已证实根因的针对性回归测试 (Green Test - 严格离线/生产定时器驱动) ===\n');

const tempSessionsDir = await mkdtemp(join(tmpdir(), 'quick-acp-test-rootcause-'));
process.env.QUICK_ACP_SESSIONS_DIR = tempSessionsDir;

// 纯内存 Fake WebSocket (基于 EventEmitter)，模拟底层传输边界，不启动任何端口、不依赖证书/凭据
class FakeWs extends EventEmitter {
  readyState = WebSocket.OPEN;
  pingCount = 0;
  sentMessages = [];

  ping() {
    this.pingCount++;
  }

  send(data) {
    this.sentMessages.push(data);
  }

  close(code = 1000, reason = '') {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, reason);
  }

  terminate() {
    this.close(1006, 'terminated');
  }
}

// 模拟传输边界：包装 QuickTransport，拦截 connect() 绑定 FakeWs 并执行生产事件监听器
function createMockTransport(sessionAuth, opts = {}) {
  const transport = new QuickTransport(sessionAuth, opts);
  transport.connect = async function () {
    this.closeEmitted = false;
    this.closedByUs = false;
    this.pendingPong = false;
    this.missedPongs = 0;
    const fakeWs = new FakeWs();
    this.ws = fakeWs;
    this.lastInboundAt = Date.now();
    this.startWatchdogs();

    fakeWs.on('close', (code, reason) => {
      this.stopWatchdogs();
      this.emitClose(code, reason?.toString() ?? '');
    });

    fakeWs.on('message', (data) => {
      this.lastInboundAt = Date.now();
      this.sawInbound = true;
      this.pendingPong = false;
      this.missedPongs = 0;
      try {
        this.handleBinary(data instanceof Uint8Array ? data : Buffer.from(data));
      } catch {}
    });

    fakeWs.on('pong', () => {
      this.pendingPong = false;
      this.missedPongs = 0;
    });

    this.emit({ type: 'open' });
  };
  return transport;
}

try {
  // -------------------------------------------------------------------------
  // 1. ACP 错误码非 auth 校验 (-32000 专用于 authRequired)
  // -------------------------------------------------------------------------
  {
    console.log('测试 1: 验证普通异常与路由错误不再返回 -32000 (authRequired)...');
    const agent = new QuickAcpAgent({ workspaceRoot: process.cwd() });

    // 局部 stub agent.quick 与 QuickChatSession.open，确保离线运行不读凭据不联网
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
        clientInfo: { name: 'test', version: '1.0' },
      });

      const res = await agent.newSession({
        sessionId: 'test-err-code-session',
        cwd: process.cwd(),
      });
      sessionId = res.sessionId;
    } finally {
      QuickChatSession.prototype.open = originalChatOpen;
    }

    // 1a. 模拟普通异常（如 socket is not open / 网络失败）
    const state = agent['sessions'].get(sessionId);
    assert(state, 'Session state 必须存在');
    state.chat.sendTurn = async function* () {
      throw new Error('socket is not open');
    };

    let caughtError = null;
    try {
      await agent.prompt({
        sessionId,
        prompt: [{ type: 'text', text: 'Hello' }],
      });
    } catch (e) {
      caughtError = e;
    }

    assert(caughtError instanceof RequestError, '抛出的错误必须是 RequestError');
    assert.notEqual(
      caughtError.code,
      -32000,
      '普通错误（如 socket is not open）绝对不能使用 -32000 (authRequired)，否则 Codeg 将其误报为登录失败！',
    );
    assert.equal(
      caughtError.code,
      -32603,
      '普通错误必须映射为 JSON-RPC Internal Error (-32603)',
    );

    // 1b. 模拟持续调用云端原生设备工具触发的路由错误
    state.chat.sendTurn = async function* () {
      yield {
        type: 'tool_start',
        toolName: 'run_python_on_device',
        toolId: 'tool-dev-1',
        args: { code: 'print(1)' },
      };
      yield { type: 'turn_end' };
    };

    let caughtRoutingError = null;
    try {
      await agent.prompt({
        sessionId,
        prompt: [{ type: 'text', text: 'Run device tool' }],
      });
    } catch (e) {
      caughtRoutingError = e;
    }

    assert(caughtRoutingError instanceof RequestError, '路由拦截终止必须抛出 RequestError');
    assert.notEqual(
      caughtRoutingError.code,
      -32000,
      '原生设备工具拦截错误不能使用 -32000 (authRequired)！',
    );
    assert.equal(
      caughtRoutingError.code,
      -32603,
      '原生设备工具拦截错误应使用非认证错误码 (-32603)',
    );

    console.log('✓ 1. ACP 错误码非 auth 校验通过 (离线隔离)');
  }

  // -------------------------------------------------------------------------
  // 2. 异常审计落盘校验 (runTurn 异常丢失已完成工具持久化)
  // -------------------------------------------------------------------------
  {
    console.log('测试 2: 验证 runTurn 异常路径中已执行工具与助手轮次正常持久化落盘...');
    const agent = new QuickAcpAgent({ workspaceRoot: process.cwd() });

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
        clientInfo: { name: 'test', version: '1.0' },
      });

      const res = await agent.newSession({
        sessionId: 'test-audit-persist-session',
        cwd: process.cwd(),
      });
      sessionId = res.sessionId;
    } finally {
      QuickChatSession.prototype.open = originalChatOpen;
    }

    const state = agent['sessions'].get(sessionId);
    assert(state, 'Session state 必须存在');

    // 模拟场景：
    // 第1轮：模型调用本地文件读取工具 quick-tool-call
    // 第2轮：工具执行完毕并返回结果给模型后，网络发生中断（socket is not open）
    let round = 0;
    state.chat.sendTurn = async function* () {
      round++;
      if (round === 1) {
        yield {
          type: 'text',
          delta: '```quick-tool-call\n{"name":"file_read","arguments":{"path":"package.json"}}\n```',
        };
        yield { type: 'turn_end' };
      } else {
        throw new Error('socket is not open');
      }
    };

    let caughtAuditErr = null;
    try {
      await agent.prompt({
        sessionId,
        prompt: [{ type: 'text', text: '读取 package.json' }],
      });
    } catch (e) {
      caughtAuditErr = e;
    }

    assert(caughtAuditErr, '应当捕获后续断网异常');

    // 检查 session.persisted 中的 turns
    const persistedTurns = state.persisted.turns;
    const assistantTurns = persistedTurns.filter((t) => t.role === 'assistant');
    assert(
      assistantTurns.length > 0,
      '异常发生后，必须记录助手轮次，不可丢失！',
    );

    const lastAssistantTurn = assistantTurns[assistantTurns.length - 1];
    assert(
      lastAssistantTurn.toolCalls && lastAssistantTurn.toolCalls.length > 0,
      '异常发生前已完成执行的工具调用必须被持久化落盘！',
    );
    assert.equal(
      lastAssistantTurn.toolCalls[0].toolName,
      'file_read',
      '已执行的工具调用名应为 file_read',
    );
    assert(
      lastAssistantTurn.toolCalls[0].result,
      '已执行的工具调用必须保留其执行结果，以便后续审计并避免重放',
    );

    // 检查磁盘上的持久化文件内容
    const diskContent = await readFile(join(tempSessionsDir, `${sessionId}.json`), 'utf8');
    const parsed = JSON.parse(diskContent);
    const diskAssistantTurns = parsed.turns.filter((t) => t.role === 'assistant');
    assert(
      diskAssistantTurns.length > 0 && diskAssistantTurns[0].toolCalls?.length > 0,
      '磁盘文件中必须保存已完成工具的审计记录！',
    );

    console.log('✓ 2. 异常审计落盘校验通过 (离线隔离)');
  }

  // -------------------------------------------------------------------------
  // 3. QuickChatSession close 状态重置与安全重连校验
  // -------------------------------------------------------------------------
  {
    console.log('测试 3: 验证 QuickChatSession 在 close/error 后 connected 状态重置与安全重连...');

    const mockSessionAuth = {
      tenantUrl: 'https://test.example.com',
      wsHost: '127.0.0.1:9999',
      jwt: 'mock-token',
      surface: 'test-surface',
      outpostId: 'test-outpost',
    };

    const transport = createMockTransport(mockSessionAuth);
    const session = new QuickChatSession({
      transport,
      actorArn: 'mock-actor',
    });

    // 首次 open
    await session.open();
    assert.equal(session['connected'], true, 'open 后 session.connected 应为 true');
    assert.equal(transport.isOpen, true, 'transport.isOpen 应为 true');

    // 3a. 服务端断开连接
    assert(transport.ws, '底层 ws 连接必须存在');
    transport.ws.close(1001, 'server shutdown');

    assert.equal(
      session['connected'],
      false,
      '底层 close 触发后，session.connected 必须更新为 false，不能残留为 true！',
    );
    assert.equal(transport.isOpen, false, '断开后 transport.isOpen 应为 false');

    // 3b. 再次调用 open() 能够安全重新建连
    await session.open();
    assert.equal(session['connected'], true, '重新 open() 后 session.connected 应为 true');
    assert.equal(transport.isOpen, true, '重新 open() 后 transport.isOpen 应为 true');

    // 3c. 验证 watchdog terminate 不能屏蔽 close 事件通知
    let closeReceived = false;
    let closeEvent = null;
    transport.on((ev) => {
      if (ev.type === 'close') {
        closeReceived = true;
        closeEvent = ev;
      }
    });

    // 模拟 watchdog 调用 terminate(4002, 'ping_timeout')
    transport.terminate(4002, 'ping_timeout');
    assert.equal(
      closeReceived,
      true,
      'watchdog 或本地 terminate(4002, ping_timeout) 必须发出 close 通知，不能被屏蔽！',
    );
    assert.equal(closeEvent.code, 4002, '关闭码应为 4002');
    assert.equal(closeEvent.reason, 'ping_timeout', '原因应为 ping_timeout');
    assert.equal(session['connected'], false, 'terminate 后 connected 必须为 false');

    console.log('✓ 3. close 状态重置与安全重连校验通过 (Mock传输边界)');
  }

  // -------------------------------------------------------------------------
  // 4. 有入站无控制 pong 持续存活校验 (实际运行 startWatchdogs 生产定时器)
  // -------------------------------------------------------------------------
  {
    console.log('测试 4: 验证有入站数据无控制 pong 经过多个 25s 周期不死，不被 4002 ping_timeout 误杀...');

    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    try {
      const mockSessionAuth = {
        tenantUrl: 'https://test.example.com',
        wsHost: '127.0.0.1:9999',
        jwt: 'mock-token',
        surface: 'test-surface',
        outpostId: 'test-outpost',
      };

      const transport = new QuickTransport(mockSessionAuth);
      let closeEvent = null;
      transport.on((ev) => {
        if (ev.type === 'close') closeEvent = ev;
      });

      const fakeWs = new FakeWs();
      // 模拟真实网关特性：不对 ping 回复 pong
      fakeWs.ping = function () {
        this.pingCount++;
        // 绝不回复 pong！
      };

      transport.ws = fakeWs;
      transport.lastInboundAt = Date.now();
      fakeWs.on('message', (data) => {
        transport.lastInboundAt = Date.now();
        transport.sawInbound = true;
      });

      // 实际启动生产看门狗定时器 (WS_PING_INTERVAL_MS = 25_000, WS_IDLE_CHECK_INTERVAL_MS = 15_000)
      transport.startWatchdogs();

      // 验证经过 4 个完整周期（共 100 秒 simulated time）：
      // 在每个 25 秒周期的前段收到应用层入站数据，且网关从不回复 pong
      for (let cycle = 1; cycle <= 4; cycle++) {
        mock.timers.tick(20_000); // 推进 20 秒
        // 模拟收到网关下发的业务帧/应用层入站消息
        fakeWs.emit('message', Buffer.from('gateway-application-data'));
        mock.timers.tick(5_000); // 推进 5 秒，到达 25 秒周期节点，实际触发生产 pingTimer 回调

        assert.equal(
          transport['missedPongs'],
          0,
          `第 ${cycle} 周期：因有应用层入站，生产 pingTimer 必须将 missedPongs 复位为 0`,
        );
        assert.equal(
          transport['pendingPong'],
          true,
          `第 ${cycle} 周期：pingTimer 执行后发出新的 ping，标记 pendingPong = true`,
        );
        assert.equal(transport.isOpen, true, `第 ${cycle} 周期：连接必须保持存活`);
      }

      assert.equal(closeEvent, null, '有入站消息时绝不能触发 close 事件');
      assert.equal(transport.isOpen, true, '经过 100s 模拟时间多周期后连接仍然健康存活');

      transport.stopWatchdogs();
    } finally {
      mock.timers.reset();
    }

    console.log('✓ 4. 有入站无控制 pong 持续存活校验通过 (生产定时器真实驱动)');
  }

  // -------------------------------------------------------------------------
  // 5. 真正失联超阈值由生产定时器实际终止 (覆盖无 pong 无入站与有 pong 假活)
  // -------------------------------------------------------------------------
  {
    console.log('测试 5: 验证真正失联按实际 watchdog 定时器终止 (覆盖无 pong 无入站与有 pong 假活)...');

    // 5a. 真实失联：无 pong 且无入站，连续 2 次错过 pong 被生产 pingTimer 实际终止 (4002)
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    try {
      const mockSessionAuth = {
        tenantUrl: 'https://test.example.com',
        wsHost: '127.0.0.1:9999',
        jwt: 'mock-token',
        surface: 'test-surface',
        outpostId: 'test-outpost',
      };

      const transport = new QuickTransport(mockSessionAuth);
      let closeEvent = null;
      transport.on((ev) => {
        if (ev.type === 'close') closeEvent = ev;
      });

      const fakeWs = new FakeWs();
      // 绝不回复 pong，也无任何入站消息
      fakeWs.ping = function () {
        this.pingCount++;
      };

      transport.ws = fakeWs;
      transport.lastInboundAt = Date.now();
      transport.startWatchdogs();

      // Tick 1 (25s): 第一次 pingTimer 执行，pendingPong 原为 false，无 recentInbound，设 pendingPong = true 并发出 ping
      mock.timers.tick(25_000);
      assert.equal(transport.isOpen, true, '第 1 个 25s 周期发送 ping，连接未断');
      assert.equal(transport['pendingPong'], true, 'pendingPong 设为 true');
      assert.equal(transport['missedPongs'], 0, 'missedPongs 此时仍为 0');

      // Tick 2 (50s): 第二次 pingTimer 执行，pendingPong 为 true 且未收到 pong/入站，missedPongs++ => 1
      mock.timers.tick(25_000);
      assert.equal(transport.isOpen, true, '第 2 个 25s 周期 (50s)，missedPongs 为 1，未达阈值 2');
      assert.equal(transport['missedPongs'], 1, 'missedPongs 递增为 1');

      // Tick 3 (75s): 第三次 pingTimer 执行，missedPongs++ => 2 >= WS_PING_MAX_MISSED (2)，触发生产 terminate(4002, 'ping_timeout')
      mock.timers.tick(25_000);
      assert.equal(transport.isOpen, false, '真正失联达到 2 次错过阈值后，生产 pingTimer 必须终止连接');
      assert(closeEvent, '必须发出 close 事件通知');
      assert.equal(closeEvent.code, 4002, '关闭码必须为 4002 (ping_timeout)');
      assert.equal(closeEvent.reason, 'ping_timeout', '原因应为 ping_timeout');

      transport.stopWatchdogs();
    } finally {
      mock.timers.reset();
    }

    // 5b. 覆盖有控制 pong 但无应用层入站：被生产 idleTimer 终止 (4003 inbound_idle)
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    try {
      const mockSessionAuth = {
        tenantUrl: 'https://test.example.com',
        wsHost: '127.0.0.1:9999',
        jwt: 'mock-token',
        surface: 'test-surface',
        outpostId: 'test-outpost',
      };

      const transport = new QuickTransport(mockSessionAuth);
      let idleCloseEvent = null;
      transport.on((ev) => {
        if (ev.type === 'close') idleCloseEvent = ev;
      });

      const fakeWs = new FakeWs();
      // 模拟虽然对 ping 回复了 pong（网络层 alive），但应用层/服务端运行时已挂死不发任何消息
      fakeWs.ping = function () {
        this.pingCount++;
        // 回复 pong，清除 pendingPong 与 missedPongs
        transport.pendingPong = false;
        transport.missedPongs = 0;
      };

      transport.ws = fakeWs;
      transport.lastInboundAt = Date.now();
      transport.sawInbound = true; // 模拟进入 steady 状态，阈值为 60s (WS_INBOUND_IDLE_MS)
      transport.startWatchdogs();

      // 在 30s 时，pingTimer 和 idleTimer 均已运行，但 idleMs = 30s < 60s，不应超时
      mock.timers.tick(30_000);
      assert.equal(transport.isOpen, true, '在 30s 时尚未达到 60s idle 阈值，连接保持');
      assert.equal(idleCloseEvent, null, '未达阈值不触发 close');

      // 推进到 60s，生产 idleTimer (每 15s 检测一次) 检测到 idleMs >= 60_000，触发生产 terminate(4003, 'inbound_idle')
      mock.timers.tick(30_000);
      assert.equal(
        transport.isOpen,
        false,
        '虽然持续有控制 pong，但超过 60s 无应用层入站必须被生产 idleTimer 终止！',
      );
      assert(idleCloseEvent, '必须发出 idle 超时 close 事件');
      assert.equal(idleCloseEvent.code, 4003, '关闭码必须为 4003 (inbound_idle)');
      assert.equal(idleCloseEvent.reason, 'inbound_idle', '原因应为 inbound_idle');

      transport.stopWatchdogs();
    } finally {
      mock.timers.reset();
    }

    console.log('✓ 5. 真正失联超阈值由生产定时器实际终止校验通过 (生产定时器真实驱动，覆盖无 pong 与有 pong 假活)');
  }

  console.log('\n=== 5 项根因回归测试通过 ===');
} finally {
  await rm(tempSessionsDir, { recursive: true, force: true });
}
