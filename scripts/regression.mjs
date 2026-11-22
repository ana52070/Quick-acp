import assert from 'node:assert/strict';
import { QuickAcpAgent, ToolCallFilter } from '../dist/acp/agent.js';
import { parseToolCall, parseToolCalls, robustJsonParse, runWithInjectedTools } from '../dist/tools/strategies.js';
import { defaultPolicy, toolDefs, ToolExecutor } from '../dist/tools/registry.js';

console.log('=== Quick-acp 全套回归测试 ===\n');

// 1. 原有回归测试：首轮图片附件转发
{
  const agent = new QuickAcpAgent();
  const attachments = [{ name: 'sample.png', mimeType: 'image/png', data: 'test' }];
  let received;
  agent.oneGatewayTurn = async (_session, _text, images) => {
    received = images;
    return { text: '完成', cancelled: false };
  };
  await agent.runTurn(
    { sessionTools: { tools: [], workspaceRoot: process.cwd(), executor: {} } },
    '识别图片',
    attachments,
  );
  assert.deepEqual(received, attachments, '首轮网关请求必须保留图片附件');
  console.log('✓ 1. 图片附件转发回归通过');
}

// 2. 核心故障回归：file_write 中包含 Markdown 三反引号代码块
{
  const fence = String.fromCharCode(96).repeat(3);
  const text =
    fence +
    'quick-tool-call\n' +
    JSON.stringify({
      name: 'file_write',
      arguments: {
        path: 'README.md',
        content: '# 贪吃蛇游戏\n' + fence + 'bash\npython snake.py\n' + fence + '\n享受游戏！',
      },
    }) +
    '\n' +
    fence;

  const parsed = parseToolCall(text);
  assert(parsed, '含三反引号的 file_write 工具调用必须被成功解析');
  assert.equal(parsed.name, 'file_write');
  assert.equal(parsed.arguments.path, 'README.md');
  assert(
    typeof parsed.arguments.content === 'string' &&
      parsed.arguments.content.includes(fence + 'bash\npython snake.py\n' + fence),
    '保留完整的三反引号内容',
  );
  console.log('✓ 2. 文件内容含 Markdown 代码块解析回归通过');
}

// 3. 语法容错回归：4个反引号外层包裹
{
  const fence4 = String.fromCharCode(96).repeat(4);
  const text4 =
    fence4 +
    'quick-tool-call\n' +
    JSON.stringify({
      name: 'file_write',
      arguments: { path: 'test.py', content: 'print("hello")' },
    }) +
    '\n' +
    fence4;

  const parsed4 = parseToolCall(text4);
  assert(parsed4, '4反引号代码块必须能正常解析');
  assert.equal(parsed4.name, 'file_write');
  console.log('✓ 3. 4反引号代码块容错回归通过');
}

// 4. 多工具格式回归：支持数组及多块
{
  const fence = String.fromCharCode(96).repeat(3);
  // 4.1 JSON 数组多工具
  const textArray =
    fence +
    'quick-tool-call\n' +
    JSON.stringify([
      { name: 'file_read', arguments: { path: 'a.txt' } },
      { name: 'file_write', arguments: { path: 'b.txt', content: 'hello' } },
    ]) +
    '\n' +
    fence;
  const callsArray = parseToolCalls(textArray);
  assert.equal(callsArray.length, 2, '支持解析 JSON 数组中的多个工具调用');
  assert.equal(callsArray[0].name, 'file_read');
  assert.equal(callsArray[1].name, 'file_write');

  // 4.2 多个 quick-tool-call 块
  const textMultiBlocks =
    fence +
    'quick-tool-call\n{"name":"file_read","arguments":{"path":"a.txt"}}\n' +
    fence +
    '\n' +
    fence +
    'quick-tool-call\n{"name":"file_write","arguments":{"path":"b.txt","content":"hi"}}\n' +
    fence;
  const callsMulti = parseToolCalls(textMultiBlocks);
  assert.equal(callsMulti.length, 2, '支持解析多个独立的 quick-tool-call 代码块');
  console.log('✓ 4. 模型多工具格式（数组与多块）回归通过');
}

// 5. 流式过滤回归：防止工具 JSON 在流式过程中泄露到用户正文
{
  const fence = String.fromCharCode(96).repeat(3);
  const text =
    fence +
    'quick-tool-call\n' +
    JSON.stringify({
      name: 'file_write',
      arguments: {
        path: 'README.md',
        content: '说明\n' + fence + 'bash\npython snake.py\n' + fence,
      },
    }) +
    '\n' +
    fence;

  const emitted = [];
  const filter = new ToolCallFilter(async (chunk) => {
    emitted.push(chunk);
  });

  // 模拟流式分块输入，在嵌套代码块处切断
  const splitPoint = text.indexOf('bash');
  await filter.push(text.slice(0, splitPoint));
  await filter.push(text.slice(splitPoint));
  await filter.flush();

  const leaked = emitted.join('');
  assert.equal(leaked, '', `工具块绝不能泄露任何 JSON 片段到正文，实际泄露: ${JSON.stringify(leaked)}`);
  console.log('✓ 5. 流式输出过滤（防 JSON 泄露）回归通过');
}

// 6. 前后伴随文字与流式保留
{
  const fence = String.fromCharCode(96).repeat(3);
  const preText = '正在为您创建贪吃蛇说明文档：\n';
  const postText = '\n已提交创建。';
  const fullText =
    preText +
    fence +
    'quick-tool-call\n' +
    JSON.stringify({
      name: 'file_write',
      arguments: { path: 'README.md', content: 'test' },
    }) +
    '\n' +
    fence +
    postText;

  const emitted = [];
  const filter = new ToolCallFilter(async (chunk) => {
    emitted.push(chunk);
  });
  await filter.push(fullText);
  await filter.flush();

  const userOutput = emitted.join('');
  assert(userOutput.includes('正在为您创建贪吃蛇说明文档：'), '必须保留工具调用前的正文');
  assert(userOutput.includes('已提交创建。'), '必须保留工具调用后的正文');
  assert(!userOutput.includes('quick-tool-call'), '不得包含工具标记');
  assert(!userOutput.includes('file_write'), '不得包含工具名称或 JSON');
  console.log('✓ 6. 工具伴随文字正文正常保留回归通过');
}

// 7. 工具参数别名与鲁棒性回归 (file -> path, text -> content, cmd -> command)
{
  const policy = defaultPolicy(process.cwd());
  const executor = new ToolExecutor(policy);

  // fileRead 接收 file 别名
  const readRes = await executor.execute('file_read', { file: 'package.json', limit: 2 });
  assert(readRes.ok, `file_read 别名参数失败: ${readRes.content}`);
  assert(readRes.content.includes('"name": "quick-acp"'));

  // shellRun 接收 cmd 别名
  const shellRes = await executor.execute('shell_run', { cmd: 'node -v' });
  assert(shellRes.ok, `shell_run 别名参数失败: ${shellRes.content}`);
  assert(shellRes.content.includes('v2'));

  console.log('✓ 7. 工具参数别名（file/cmd/text）回归通过');
}

// 8. 取消与超时机制回归
{
  const policy = defaultPolicy(process.cwd());
  const executor = new ToolExecutor(policy);
  const ac = new AbortController();

  // 8.1 立即取消
  ac.abort();
  const cancelRes = await executor.execute('shell_run', { command: 'node -e "setTimeout(()=>{}, 1000)"' }, ac.signal);
  assert(!cancelRes.ok, '取消后必须返回 ok=false');
  assert.equal(cancelRes.error, 'cancelled');

  console.log('✓ 8. 工具执行中止/取消机制回归通过');
}

// 9. 鲁棒 JSON 解析：尾随逗号过滤绝不损坏字符串内部逗号
{
  // 9.1 对象尾随逗号 + 字符串内含逗号与花括号
  const testJsonObj = '{\n  "path": "test.py",\n  "content": "d = { x: 1, }",\n}';
  const parsedObj = robustJsonParse(testJsonObj);
  assert.equal(parsedObj.content, 'd = { x: 1, }', '对象尾随逗号清理不得损坏字符串内部逗号');

  // 9.2 数组尾随逗号 + 字符串内含逗号与方括号
  const testJsonArr = '{\n  "items": ["a, ]", "b, ]",],\n}';
  const parsedArr = robustJsonParse(testJsonArr);
  assert.equal(parsedArr.items[0], 'a, ]', '数组尾随逗号清理不得损坏字符串内部逗号');
  assert.equal(parsedArr.items.length, 2, '必须正确解析数组项');

  console.log('✓ 9. robustJsonParse 字符串内部逗号保护回归通过');
}

// 10. 工具嵌套防御：parseToolCalls 绝不执行 file_write.content 等参数内部的嵌套工具示例
{
  const fence = String.fromCharCode(96).repeat(3);
  const nestedPayload =
    fence +
    'quick-tool-call\n' +
    JSON.stringify({
      name: 'file_write',
      arguments: {
        path: 'docs/tool-example.md',
        content:
          '如何使用工具：\n' +
          fence +
          'quick-tool-call\n' +
          JSON.stringify({ name: 'shell_run', arguments: { command: 'rm -rf /' } }) +
          '\n' +
          fence,
      },
    }) +
    '\n' +
    fence;

  const calls = parseToolCalls(nestedPayload);
  assert.equal(calls.length, 1, '只能提取外层合法工具调用，绝不能把嵌套示例解析为执行动作');
  assert.equal(calls[0].name, 'file_write');
  assert.equal(calls[0].arguments.path, 'docs/tool-example.md');
  assert(calls[0].arguments.content.includes('rm -rf /'), '内容中必须保留嵌套示例字符串');

  console.log('✓ 10. parseToolCalls 防嵌套工具示例误执行回归通过');
}

// 11. 执行中取消及任意分片边界回归
{
  const executor = new ToolExecutor(defaultPolicy(process.cwd()));
  const controller = new AbortController();
  const running = executor.execute('shell_run', { command: 'node -e "setTimeout(()=>{}, 30000)"' }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 150);
  const result = await running;
  clearTimeout(timer);
  assert.equal(result.error, 'cancelled');
  const fence = String.fromCharCode(96).repeat(3);
  const input =
    fence +
    'quick-tool-call\n' +
    JSON.stringify({ name: 'file_write', arguments: { path: 't.md', content: fence + 'bash\nhi\n' + fence } }) +
    '\n' +
    fence +
    '\n完成';
  for (let split = 1; split < input.length; split++) {
    let output = '';
    const filter = new ToolCallFilter(async (c) => {
      output += c;
    });
    await filter.push(input.slice(0, split));
    await filter.push(input.slice(split));
    await filter.flush();
    assert.equal(output, '\n完成', '流式分片位置=' + split);
  }
  console.log('✓ 11. 执行中取消及任意分片边界回归通过');
}

// 运行 12-19 项进阶能力扩展回归
await import('./test-capabilities.mjs');

// 运行网关原生设备工具拦截、有界取消、无伪成功、安全修正恢复与有界超时控制回归
await import('./test-device-routing.mjs');

console.log('\n=== 全部 19 项原能力及新增网关设备路由与超时控制测试全部通过 ===');
