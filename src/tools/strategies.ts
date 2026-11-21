/**
 * Two tool-invocation strategies, selected at runtime.
 *
 * The Quick gateway gives a caller no tool channel: the model's tools belong to
 * Quick's own agent loop. Two mechanisms can bridge that, and — after testing
 * both against the live outpost — only one of them actually works without the
 * desktop app installed.
 *
 *   "inject"  (DEFAULT — works everywhere)
 *     Advertise the tools in the prompt as a JSON contract, parse a fenced block
 *     out of the reply, execute locally, feed the result back as the next user
 *     turn. Costs one extra turn per tool call and depends on the model
 *     complying, but needs nothing but the gateway: no outpost, no instance
 *     token, no Electron shell, no desktop app.
 *
 *   "mcp"     (opt-in — requires the desktop app)
 *     Run an MCP server locally and register it into Quick over the outpost's
 *     `/local/mcp/add`, so Quick's model calls these tools natively. Zero extra
 *     turns and no format compliance problem — strictly better WHEN IT WORKS.
 *
 * WHY MCP IS NOT THE DEFAULT
 * --------------------------
 * Enabling a local MCP server is gated twice, and both gates live in the
 * desktop app:
 *
 *   1. `/local/mcp/toggle` needs {nonce, signature, timestamp, jti,
 *      hashVersion, outpostId}. The signature is Ed25519, produced by Electron's
 *      MAIN process after a native OS confirmation dialog. The private key is
 *      generated per boot, held in main-process memory, and never exposed;
 *      `mcpAttestationGuard.js` explicitly refuses to relay the upload route to
 *      the renderer ("only a renderer forge").
 *
 *   2. `/local/mcp/add|toggle|remove|reload` currently return HTTP 503
 *      `permissions_pending` — "Local MCP creation and modification is
 *      temporarily unavailable while your organization's permissions are
 *      loading." This is a GLOBAL write gate (a brand-new non-existent id gets
 *      the same answer), it does not clear on retry, and `GET /local/mcp/list`
 *      stays 200 because reads are not gated. In practice the permission has to
 *      be pulled by a signed-in desktop app.
 *
 * So "mcp" is opt-in: it is worth turning on for users who run the desktop app,
 * and pointless for everyone else. Setting QUICK_ACP_TOOL_MODE=mcp on a machine
 * without it produces a clear diagnostic instead of a silent capability gap.
 */

import type { ToolDef, ToolExecutor, ToolResult } from './registry.js';

export type ToolMode = 'mcp' | 'inject';

/**
 * Which strategy to use.
 *
 * Default is "inject" because it is the only one that works on a clean machine.
 * QUICK_ACP_TOOL_MODE=mcp opts into the native path once the user has the
 * desktop app running and has enabled the server in its UI.
 */
export function resolveToolMode(): ToolMode {
  const raw = (process.env.QUICK_ACP_TOOL_MODE ?? 'inject').toLowerCase();
  return raw === 'mcp' ? 'mcp' : 'inject';
}

// ---------------------------------------------------------------------------
// Strategy: inject
// ---------------------------------------------------------------------------

/** Marker the model is asked to emit. Chosen to be unlikely in prose. */
const CALL_OPEN = '```quick-tool-call';
const CALL_CLOSE = '```';

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Build the prompt that teaches the model the tool contract.
 *
 * Kept separate from the user's text so the caller can see exactly what extra
 * tokens are being spent, and so the contract can be cached upstream.
 */
export function buildToolPrompt(tools: ToolDef[], workspaceRoot: string): string {
  const spec = tools
    .map((t) => {
      return [
        `### ${t.name}`,
        t.description,
        'Arguments (JSON Schema):',
        '```json',
        JSON.stringify(t.inputSchema, null, 2),
        '```',
      ].join('\n');
    })
    .join('\n\n');

  return [
    'You are operating with access to local tools through the caller.',
    `The workspace root is: ${workspaceRoot}`,
    '',
    'AVAILABLE TOOLS',
    '',
    spec,
    '',
    'HOW TO CALL A TOOL',
    '',
    'When you need a tool, reply with exactly one fenced block and nothing else:',
    '',
    CALL_OPEN,
    '{"name": "<tool name>", "arguments": { ... }}',
    CALL_CLOSE,
    '',
    'Rules:',
    '- Emit at most one tool call per reply.',
    '- The block must contain only valid JSON.',
    '- Do not wrap the JSON in extra prose inside the block.',
    '- After the block, stop. The caller runs the tool and sends you the result.',
    '- To finish without a tool, just answer normally with no such block.',
  ].join('\n');
}

/**
 * Extract a tool call from a model reply.
 * Returns null when the reply is a normal answer, so the caller can treat it as
 * the final assistant text.
 */
export function parseToolCall(text: string): ParsedToolCall | null {
  const open = text.indexOf(CALL_OPEN);
  if (open < 0) return null;
  const afterOpen = open + CALL_OPEN.length;
  const close = text.indexOf(CALL_CLOSE, afterOpen);
  if (close < 0) return null;
  const body = text.slice(afterOpen, close).trim();
  if (!body) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null; // model emitted malformed JSON; treat as prose
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj['name'] === 'string' ? obj['name'] : '';
  if (!name) return null;
  const args =
    obj['arguments'] && typeof obj['arguments'] === 'object'
      ? (obj['arguments'] as Record<string, unknown>)
      : {};
  return { name, arguments: args };
}

/** Render a tool result as the next user turn. */
export function formatToolResult(call: ParsedToolCall, result: ToolResult): string {
  return [
    `Tool result for ${call.name}:`,
    '',
    '```',
    result.content,
    '```',
    '',
    result.ok
      ? 'Continue. Call another tool if needed, or give your final answer.'
      : 'The tool failed. Adjust your approach or explain the problem.',
  ].join('\n');
}

/**
 * Drive a prompt loop with the inject strategy.
 *
 * The caller supplies a `turn` function that performs ONE gateway turn and
 * returns the full assistant text; this function handles the tool round trips.
 */
export async function runWithInjectedTools(opts: {
  userText: string;
  tools: ToolDef[];
  workspaceRoot: string;
  executor: ToolExecutor;
  maxToolRounds: number;
  turn: (text: string) => Promise<{ text: string; cancelled: boolean }>;
  onAssistantText: (text: string) => void;
  onToolCall: (call: ParsedToolCall, result: ToolResult) => void;
}): Promise<{ finalText: string; cancelled: boolean; rounds: number }> {
  const preamble = buildToolPrompt(opts.tools, opts.workspaceRoot);
  let pending = `${preamble}\n\n---\n\n${opts.userText}`;
  let rounds = 0;

  for (;;) {
    const reply = await opts.turn(pending);
    if (reply.cancelled) {
      return { finalText: reply.text, cancelled: true, rounds };
    }

    const call = parseToolCall(reply.text);
    if (!call) {
      // Normal answer: this is the end of the turn.
      opts.onAssistantText(reply.text);
      return { finalText: reply.text, cancelled: false, rounds };
    }

    if (rounds >= opts.maxToolRounds) {
      const stop =
        `Stopped after ${opts.maxToolRounds} tool rounds without a final answer. ` +
        'Raise QUICK_ACP_MAX_TOOL_ROUNDS or narrow the request.';
      opts.onAssistantText(stop);
      return { finalText: stop, cancelled: false, rounds };
    }

    rounds++;
    const result = await opts.executor.execute(call.name, call.arguments);
    opts.onToolCall(call, result);
    pending = formatToolResult(call, result);
  }
}

// ---------------------------------------------------------------------------
// Strategy: mcp
// ---------------------------------------------------------------------------

/**
 * Point Quick at this bridge's MCP server.
 *
 * The server itself lives in mcp-server.ts and is spawned by Quick; this
 * function only performs the registration handshake and reports precisely
 * which step failed, because a half-done registration is worse than none:
 * an added-but-disabled server looks present in Quick's UI but provides no
 * tools, which is confusing to debug later.
 */
export async function setupMcpStrategy(opts: {
  serverName: string;
  scriptPath: string;
  workspaceRoot: string;
  allowShell: boolean;
  replace?: boolean;
}): Promise<{ ok: boolean; serverId?: string; error?: string; step?: string }> {
  const { registerMcpServer } = await import('./mcp-register.js');
  return registerMcpServer({
    name: opts.serverName,
    scriptPath: opts.scriptPath,
    workspaceRoot: opts.workspaceRoot,
    allowShell: opts.allowShell,
    replace: opts.replace ?? true,
  });
}
