import { QuickAcpAgent } from '../dist/acp/agent.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import {
  saveSession,
  readSession,
  listPersistedSessions,
  forkPersistedSession,
  isValidSessionId,
} from '../dist/session/persistence.js';
import { SessionMcpManager } from '../dist/mcp/manager.js';
import { SessionPlanManager, planToolDef } from '../dist/features/plan.js';
import { SkillManager, skillReadToolDef } from '../dist/features/skills.js';
import {
  PermissionGate,
  askUserQuestionToolDef,
  isInteractiveEnvironment,
} from '../dist/features/permission.js';
import { ClientFsDelegate } from '../dist/features/fs-delegate.js';
import { runWithClassifiedRetry, isRetryableError } from '../dist/features/retry.js';

console.log('\n=== Quick-acp 进阶能力扩展全面回归测试 ===\n');

// 使用临时目录进行会话持久化测试，严禁污染用户目录 ~/.quick-acp/sessions
const tempSessionsDir = await mkdtemp(join(tmpdir(), 'quick-acp-test-sessions-'));
process.env.QUICK_ACP_SESSIONS_DIR = tempSessionsDir;

try {
  // 12. 本地会话持久化与 list / load / resume / fork / 原子写与合法性校验回归
  {
    // 12.1 会话 ID 合法性校验 (防路径穿越)
    assert(isValidSessionId('normal-session_123'), '正常 ID 应当通过校验');
    assert(!isValidSessionId('../evil-traversal'), '包含路径穿越的 ID 必须被拦截');
    assert(!isValidSessionId(''), '空 ID 必须被拦截');
    assert(!isValidSessionId('session/with/slashes'), '包含斜杠的 ID 必须被拦截');

    const testId = 'test-session-' + Date.now();
    const testSession = {
      sessionId: testId,
      threadId: testId,
      cwd: process.cwd(),
      title: '测试持久化会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agentMode: 'smart',
      turns: [
        { role: 'user', text: '你好', timestamp: Date.now() },
        {
          role: 'assistant',
          text: '你好！有什么我可以帮你的吗？',
          thought: '思考过程已记录',
          toolCalls: [
            {
              toolCallId: 'tc-1',
              toolName: 'file_read',
              args: { path: 'test.txt' },
              result: 'file content',
              ok: true,
            },
          ],
          timestamp: Date.now(),
        },
      ],
    };

    // 保存并验证原子写入及读取完整性
    await saveSession(testSession);
    const loaded = await readSession(testId);
    assert(loaded, '能够正确加载已保存的会话');
    assert.equal(loaded.sessionId, testId);
    assert.equal(loaded.turns.length, 2);
    assert.equal(loaded.turns[1].thought, '思考过程已记录', '助手思考过程得到持久化');
    assert.equal(loaded.turns[1].toolCalls?.length, 1, '助手工具调用得到完整持久化');
    assert.equal(loaded.turns[1].toolCalls?.[0].toolName, 'file_read');

    // 非法 ID 保存必须抛出异常
    await assert.rejects(
      async () => {
        await saveSession({ ...testSession, sessionId: '../../bad' });
      },
      /非法会话 ID/,
      '非法 ID 写入应当抛出明确错误',
    );

    const list = await listPersistedSessions(process.cwd());
    assert(list.some((s) => s.sessionId === testId), '会话列表能列出该会话');

    // 分叉测试：验证继承历史并分配新线程
    const forkedId = 'fork-' + testId;
    const forked = await forkPersistedSession(testId, forkedId);
    assert(forked, '能够分叉新会话');
    assert.equal(forked.sessionId, forkedId);
    assert.equal(forked.turns.length, 2, '子会话继承父会话历史');
    assert.notEqual(forked.threadId, testSession.threadId, '子会话必须拥有独立的上游线程');

    console.log('✓ 12. 本地会话持久化 (原子写/0600/ID校验/历史完整性/fork独立线程) 回归通过');
  }

  // 13. 会话 MCP stdio 与 HTTP/SSE 挂载、命名唯一隔离与生命周期管理
  {
    const mcp = new SessionMcpManager(1);

    // 13.1 挂载 stdio MCP 服务（包含初始化前大量 stderr 输出测试，验证不阻塞死锁）
    const mockServerScript = `
      // 初始化前写入 128KB stderr 数据，验证 transport.stderr.resume() 提前生效，绝不死锁
      process.stderr.write('x'.repeat(131072));

      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test-stdio', version: '1.0' } } }));
          } else if (msg.method === 'notifications/initialized') {
            // ACK
          } else if (msg.method === 'tools/list') {
            console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } }));
          } else if (msg.method === 'tools/call') {
            console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: msg.params.arguments.text || 'ok' }] } }));
          }
        } catch {}
      });
    `;

    await mcp.mountServers([
      {
        name: 'echo-server',
        command: process.execPath,
        args: ['-e', mockServerScript],
      },
    ]);

    assert(mcp.registeredTools.length > 0, '成功发现并注册 stdio MCP 工具');
    const stdioToolName = mcp.registeredTools[0].name;
    assert(
      stdioToolName.startsWith('mcp__s1_srv1_echo_server__'),
      '工具名称应用防截断碰撞的唯一前缀: ' + stdioToolName,
    );

    const callRes = await mcp.executeMcpTool(stdioToolName, { text: 'hello-mcp' });
    assert(callRes && callRes.ok && callRes.content === 'hello-mcp', 'stdio MCP 工具调用成功返回');

    // 13.2 测试调用中 AbortSignal 取消
    const ac = new AbortController();
    ac.abort();
    const cancelledCall = await mcp.executeMcpTool(stdioToolName, { text: 'test' }, ac.signal);
    assert(cancelledCall && !cancelledCall.ok, '已取消的调用应立即拒绝');

    // 13.3 测试挂载失败清理与异常捕获
    const failMcp = new SessionMcpManager(2);
    let failCaught = false;
    try {
      await failMcp.mountServers([
        {
          name: 'bad-server',
          command: process.execPath,
          args: ['-e', 'process.exit(1)'],
        },
      ]);
    } catch {
      failCaught = true;
    }
    await failMcp.close();

    // 13.4 挂载基于 HTTP/Streamable HTTP 的 MCP 服务，并测试 close 时 terminateSession (DELETE)
    const mockHttpPort = 8991;
    let sseSessionId = 'mock-mcp-session-1';
    let httpDeleteReceived = false;

    const mockHttpServer = http.createServer((req, res) => {
      if (req.method === 'DELETE') {
        httpDeleteReceived = true;
        res.writeHead(200);
        res.end();
        return;
      }

      let body = '';
      req.on('data', (c) => (body += c.toString('utf8')));
      req.on('end', () => {
        try {
          const msg = JSON.parse(body || '{}');
          if (msg.method === 'initialize') {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Mcp-Session-Id': sseSessionId,
            });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  protocolVersion: '2024-11-05',
                  capabilities: {},
                  serverInfo: { name: 'test-http', version: '1.0' },
                },
              }),
            );
          } else if (msg.method === 'notifications/initialized') {
            res.writeHead(202);
            res.end();
          } else if (msg.method === 'tools/list') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  tools: [{ name: 'http_ping', description: 'ping over http', inputSchema: { type: 'object', properties: {} } }],
                },
              }),
            );
          } else if (msg.method === 'tools/call') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: { content: [{ type: 'text', text: 'pong' }] },
              }),
            );
          } else {
            res.writeHead(404);
            res.end();
          }
        } catch {
          res.writeHead(500);
          res.end();
        }
      });
    });

    await new Promise((resolve) => mockHttpServer.listen(mockHttpPort, '127.0.0.1', resolve));

    try {
      await mcp.mountServers([
        {
          name: 'remote-http',
          type: 'http',
          url: `http://127.0.0.1:${mockHttpPort}/mcp`,
        },
      ]);

      const httpTool = mcp.registeredTools.find((t) => t.name.includes('http_ping'));
      assert(httpTool, 'HTTP MCP 工具成功发现并注册');
      const httpCallRes = await mcp.executeMcpTool(httpTool.name, {});
      assert(httpCallRes && httpCallRes.ok && httpCallRes.content === 'pong', 'HTTP MCP 工具调用成功');
    } finally {
      // 关闭 mcp 会触发 terminateSession 发送 DELETE 请求
      await mcp.close();
      mockHttpServer.close();
    }
    assert(httpDeleteReceived, 'Streamable HTTP MCP 关闭时必须调用 terminateSession 发出 DELETE 请求');

    // 13.5 真实 SDK SSE fixture 挂载与工具调用验证
    const mockSsePort = 8995;
    const sseMcp = new SessionMcpManager(3);
    let sseClientRes = null;

    const mockSseServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockSsePort}`);
      if (req.method === 'GET' && url.pathname === '/sse') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        sseClientRes = res;
        res.write('event: endpoint\ndata: /messages?sessionId=sse-mock-sess\n\n');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        let body = '';
        req.on('data', (c) => (body += c.toString('utf8')));
        req.on('end', () => {
          res.writeHead(202).end();
          try {
            const msg = JSON.parse(body || '{}');
            if (!sseClientRes) return;
            if (msg.method === 'initialize') {
              sseClientRes.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'sse-srv', version: '1.0' } } }) + '\n\n');
            } else if (msg.method === 'notifications/initialized') {
              // 握手完成通知无需回复
            } else if (msg.method === 'tools/list') {
              sseClientRes.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'sse_hello', description: 'sse hello', inputSchema: { type: 'object' } }] } }) + '\n\n');
            } else if (msg.method === 'tools/call') {
              sseClientRes.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong-sse' }] } }) + '\n\n');
            }
          } catch {}
        });
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise((resolve) => mockSseServer.listen(mockSsePort, '127.0.0.1', resolve));
    try {
      await sseMcp.mountServers([
        {
          name: 'remote-sse',
          type: 'sse',
          url: `http://127.0.0.1:${mockSsePort}/sse`,
        },
      ]);
      const sseTool = sseMcp.registeredTools.find((t) => t.name.includes('sse_hello'));
      assert(sseTool, 'SSE MCP 工具成功发现并注册');
      const sseCallRes = await sseMcp.executeMcpTool(sseTool.name, {});
      assert(sseCallRes && sseCallRes.ok && sseCallRes.content === 'pong-sse', 'SSE MCP 工具调用成功');
    } finally {
      await sseMcp.close();
      mockSseServer.close();
    }

    console.log('✓ 13. 会话 MCP stdio(大stderr/异常清理) 与 HTTP(DELETE)/SSE 挂载与清理回归通过');
  }

  // 14. 计划工具与状态流转
  {
    const def = planToolDef();
    assert.equal(def.name, 'plan_update');
    assert(def.inputSchema && def.inputSchema.properties.entries);

    const pm = new SessionPlanManager();
    const updateRes = pm.updateFromRaw({
      entries: [
        { content: '第一步：分析需求', status: 'completed', priority: 'high' },
        { content: '第二步：编写代码', status: 'in_progress', priority: 'medium' },
        { content: '第三步：验收测试', status: 'pending' },
      ],
    });

    assert(updateRes.ok, '更新计划成功');
    assert.equal(pm.plan.length, 3);
    assert.equal(pm.plan[0].status, 'completed');
    assert.equal(pm.plan[1].status, 'in_progress');
    assert.equal(pm.plan[2].priority, 'medium', '默认优先级补齐为 medium');

    const md = pm.formatAsMarkdown();
    assert(md.includes('[x]') && md.includes('[>]') && md.includes('[ ]'), 'Markdown 格式化正确展示状态');

    console.log('✓ 14. 计划工具 (plan_update) 与结构化状态机回归通过');
  }

  // 15. 本地 SKILL 扫描与斜杠命令本地拦截及模型读取工具
  {
    const sm = new SkillManager();
    await sm.discover(process.cwd());

    const commands = sm.getAvailableCommands();
    assert(commands.some((c) => c.name === 'help'), '包含默认 help 命令');
    assert(commands.some((c) => c.name === 'mode'), '包含默认 mode 命令');
    assert(commands.some((c) => c.name === 'plan'), '包含默认 plan 命令');
    assert(commands.some((c) => c.name === 'clear'), '包含默认 clear 命令');

    // 15.1 测试内置命令拦截解析
    const parsedHelp = sm.processPrompt('/help');
    assert.equal(parsedHelp.type, 'builtin');
    assert.equal(parsedHelp.command, 'help');

    const parsedMode = sm.processPrompt('/mode fast');
    assert.equal(parsedMode.type, 'builtin');
    assert.equal(parsedMode.command, 'mode');
    assert.equal(parsedMode.arg, 'fast');

    const parsedPlan = sm.processPrompt('/plan');
    assert.equal(parsedPlan.type, 'builtin');
    assert.equal(parsedPlan.command, 'plan');

    const parsedClear = sm.processPrompt('/clear');
    assert.equal(parsedClear.type, 'builtin');
    assert.equal(parsedClear.command, 'clear');

    // 15.2 测试模型可自主调用的 skill_read 工具
    const skillTool = skillReadToolDef();
    assert.equal(skillTool.name, 'skill_read');
    const readList = sm.readSkillContent('list');
    assert(readList.ok, '模型查阅技能列表成功');

    console.log('✓ 15. 本地 SKILL 读取、内置命令本地拦截与 skill_read 工具回归通过');
  }

  // 16. 工具执行前权限审批、无头环境防护、提问标题与 MCP 工具纳入授权
  {
    // 16.1 auto 模式下放行
    const autoGate = new PermissionGate('auto');
    const autoCheck = await autoGate.checkPermission({
      conn: null,
      sessionId: 's1',
      toolCallId: 't1',
      toolName: 'shell_run',
      args: { cmd: 'dir' },
    });
    assert(autoCheck.allowed, 'auto 模式无条件放行');

    // 16.2 ask 模式下且 conn=null 必须 fail-closed 严格拒绝，防止无头环境产生静默破坏
    const askGate = new PermissionGate('ask');
    const failClosedCheck = await askGate.checkPermission({
      conn: null,
      sessionId: 's1',
      toolCallId: 't1',
      toolName: 'shell_run',
      args: { cmd: 'rm -rf /' },
    });
    assert(!failClosedCheck.allowed, 'ask 模式下无连接必须拒绝 (fail-closed)');
    assert(failClosedCheck.reason?.includes('fail-closed'), '返回明确拒绝原因');

    // 16.3 ask 模式下 MCP 工具同样纳入授权审批
    let mcpPermissionRequested = false;
    let mcpToolTitle = '';
    const mockConnMcp = {
      requestPermission: async (req) => {
        mcpPermissionRequested = true;
        mcpToolTitle = req.toolCall?.title || '';
        return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
      },
    };
    const mcpCheck = await askGate.checkPermission({
      conn: mockConnMcp,
      sessionId: 's1',
      toolCallId: 'mcp-t1',
      toolName: 'mcp__s1_srv1_disk__delete_file',
      args: { path: 'a.txt' },
      title: '删除文件',
    });
    assert(mcpPermissionRequested, 'MCP 工具执行在 ask 模式下必须拉起权限审批');
    assert.equal(mcpToolTitle, '删除文件', '审批请求携带标题');
    assert(mcpCheck.allowed, '用户批准后放行');

    // 16.4 ask_user_question 交互提问带有标题，且拒绝/取消不执行
    let askedTitle = '';
    const mockConnAsk = {
      requestPermission: async (req) => {
        askedTitle = req.toolCall?.title || '';
        return { outcome: { outcome: 'selected', optionId: req.options[0].optionId } };
      },
    };
    const askRes = await askGate.askUser(mockConnAsk, 's1', 'ask-1', '选择目标版本', ['v1', 'v2']);
    assert(askRes.ok && askRes.content.includes('v1'), '用户选择生效');
    assert.equal(askedTitle, '提问: 选择目标版本', '提问标题清晰可见');

    // 取消提问
    const mockConnCancel = {
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    };
    const cancelRes = await askGate.askUser(mockConnCancel, 's1', 'ask-2', '是否继续', ['是', '否']);
    assert(!cancelRes.ok, '用户取消提问返回失败');

    // 16.5 环境交互能力判断
    assert(!isInteractiveEnvironment(null), '无连接时为非交互环境');

    console.log('✓ 16. 工具权限审批 fail-closed、MCP纳入授权与用户提问标题回归通过');
  }

  // 17. 未保存编辑器缓冲区委托读取与超时回退
  {
    const delegate = new ClientFsDelegate();

    // 17.1 客户端支持时优先读缓冲区
    delegate.setClientCapabilities({ fs: { readTextFile: true } });
    const mockConnFs = {
      readTextFile: async ({ path }) => ({ content: '编辑器未保存最新缓冲区内容: ' + path }),
    };
    const bufRes = await delegate.readTextFile(mockConnFs, 's1', 'test.txt');
    assert.equal(bufRes.source, 'client_buffer');
    assert(bufRes.content.includes('未保存'));

    // 17.2 客户端超时或失败平滑回退本地磁盘
    const mockConnSlow = {
      readTextFile: async () => new Promise((r) => setTimeout(r, 100)),
    };
    const diskRes = await delegate.readTextFile(mockConnSlow, 's1', 'package.json', undefined, 20);
    assert.equal(diskRes.source, 'disk');
    assert(diskRes.content.includes('quick-acp'), '超时平滑回退本地磁盘');

    console.log('✓ 17. 未保存缓冲区有界读取与磁盘平滑回退回归通过');
  }

  // 18. 网络错误分类重试、流式输出防止重复正文与副作用守卫
  {
    // 18.1 错误分类
    const econn = new Error('read ECONNRESET');
    econn.code = 'ECONNRESET';
    assert(isRetryableError(econn), 'ECONNRESET 可重试');

    const authErr = new Error('401 Unauthorized');
    assert(!isRetryableError(authErr), '认证错误绝不重试');

    // 18.2 已输出部分流式正文时，严格禁止重放
    let streamedAttempt = 0;
    try {
      await runWithClassifiedRetry(
        async () => {
          streamedAttempt++;
          const netErr = new Error('network reset midway');
          netErr.code = 'ECONNRESET';
          throw netErr;
        },
        {
          hasOutputEmitted: () => true, // 模拟已向客户端推流了正文片段
          policy: { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 50 },
        },
      );
      assert.fail('应当直接抛出');
    } catch (e) {
      assert.equal(streamedAttempt, 1, '已向客户端输出正文后绝不盲目重试，杜绝正文重复');
    }

    // 18.3 产生副作用后禁止重试
    let sideEffectAttempts = 0;
    try {
      await runWithClassifiedRetry(
        async () => {
          sideEffectAttempts++;
          const netErr = new Error('network drop');
          netErr.code = 'ECONNRESET';
          throw netErr;
        },
        { hasSideEffects: true, policy: { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 50 } },
      );
      assert.fail('应当直接抛出');
    } catch (e) {
      assert.equal(sideEffectAttempts, 1, '产生副作用后绝不执行二次重试');
    }

    console.log('✓ 18. 网络错误重试守卫 (流式防重正文/副作用防护) 回归通过');
  }

  // 19. 并发同 session prompt 互斥保护 (-32600) 与 closeAll 清理
  {
    const agent = new QuickAcpAgent({ workspaceRoot: process.cwd() });
    const sessId = 'sess-concurrent-test';
    agent.sessions.set(sessId, {
      id: sessId,
      activePrompt: false,
      cancelled: false,
      abortController: null,
      skillManager: { processPrompt: () => ({ type: 'raw' }) },
      persisted: { sessionId: sessId, threadId: sessId, cwd: process.cwd(), turns: [], title: '测试会话', createdAt: Date.now(), updatedAt: Date.now() },
      historyInjected: true,
      chat: { cancel: () => {} },
      mcpManager: { close: async () => {} },
    });

    // 模拟运行中的首个 turn
    let resolveTurn;
    const turnPromise = new Promise((r) => { resolveTurn = r; });
    agent.runTurn = async () => {
      await turnPromise;
      return { text: 'done', cancelled: false };
    };

    // 触发首个 prompt
    const p1 = agent.prompt({
      sessionId: sessId,
      prompt: [{ type: 'text', text: 'prompt 1' }],
    });

    // 并发触发第二个 prompt
    let rejectedCode = null;
    try {
      await agent.prompt({
        sessionId: sessId,
        prompt: [{ type: 'text', text: 'prompt 2' }],
      });
    } catch (err) {
      rejectedCode = err.code;
    }

    assert.equal(rejectedCode, -32600, '并发同 session prompt 必须以 -32600 拒绝');

    // 释放首个 prompt
    resolveTurn();
    await p1;

    // 验证 closeAll 安全中止
    await agent.closeAll();
    console.log('✓ 19. 并发同 session prompt 互斥保护 (-32600) 与 closeAll 清理回归通过');
  }
} finally {
  // 清理临时测试会话目录
  try {
    await rm(tempSessionsDir, { recursive: true, force: true });
  } catch {}
}

console.log('\n=== 全部 8 项能力扩展全面回归测试通过 ===\n');
