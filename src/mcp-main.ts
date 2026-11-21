#!/usr/bin/env node
/**
 * Standalone MCP server entry point.
 *
 * Quick spawns this process (via `POST /local/mcp/add` with
 * `command: node`, `args: [thisFile]`). It must therefore:
 *   - speak newline-delimited JSON-RPC 2.0 on stdin/stdout,
 *   - write nothing else to stdout,
 *   - die quietly when stdin closes.
 *
 * Diagnostics go to stderr.
 */

import { runMcpServer } from './tools/mcp-server.js';
import { defaultPolicy, toolDefs, ToolExecutor } from './tools/registry.js';

async function main(): Promise<void> {
  const workspaceRoot = process.env.QUICK_ACP_WORKSPACE ?? process.cwd();
  const policy = defaultPolicy(workspaceRoot);
  const tools = toolDefs(policy);
  const executor = new ToolExecutor(policy);

  if (process.env.QUICK_ACP_DEBUG === '1') {
    console.error('[quick-acp-mcp] starting MCP server');
    console.error('[quick-acp-mcp] workspace:', policy.workspaceRoot);
    console.error('[quick-acp-mcp] shell enabled:', policy.allowShell);
    console.error('[quick-acp-mcp] tools:', tools.map((t) => t.name).join(', '));
  }

  await runMcpServer({
    tools,
    executor,
    name: 'quick-acp-tools',
    version: '0.1.0',
  });
}

main().catch((e) => {
  console.error('[quick-acp-mcp] fatal:', e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
