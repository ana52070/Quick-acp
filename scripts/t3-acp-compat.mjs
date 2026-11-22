// T3 Code 兼容层。
//
// 问题：T3 Code 会把自带的 t3-code MCP 服务器注入 session/new。quick-acp 会把所有
// 可用工具的完整 JSON Schema 拼进发给 Quick 网关的 user_message 提示词里，T3 注入的
// 41 个 MCP 工具连同 schema 约 93 KB，使该帧达到 100366 字节，超过网关 64 KB 上限，
// 网关返回 FrameTooLarge，整个 turn 失败。
//
// 做法：转发时把 session/new 的 mcpServers 清空，提示词就只含 quick-acp 自带的 8 个
// 本地工具（约 7 KB），帧降到 15 KB 左右。
//
// 代价：T3 的 MCP 工具（preview_*、delegate_task、t3_thread_*、html_render 等）在
// Quick 会话里不可用。本地文件读写、shell 执行不受影响。

import { spawn } from 'node:child_process';

// 指向全局安装的 quick-acp 入口。换机器时改这里，或用环境变量覆盖。
const AGENT = process.env.QUICK_ACP_ENTRY ?? 'E:\\Nodejs\\node_modules\\quick-acp\\dist\\main.js';

const child = spawn(process.execPath, [AGENT], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('exit', (code) => process.exit(code ?? 0));
child.stdout.on('data', (chunk) => process.stdout.write(chunk));

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length === 0) continue;

    let out = line;
    try {
      const message = JSON.parse(line);
      if (message.method === 'session/new' && message.params && Array.isArray(message.params.mcpServers)) {
        message.params = { ...message.params, mcpServers: [] };
        out = JSON.stringify(message);
      }
    } catch {
      /* 非 JSON 行原样转发 */
    }
    child.stdin.write(out + '\n');
  }
});
process.stdin.on('end', () => child.stdin.end());
