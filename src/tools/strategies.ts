/**
 * The tool-invocation strategy.
 *
 * The Quick gateway gives a caller no tool channel: the model's tools belong to
 * Quick's own agent loop. Bridging that takes one of two mechanisms, and this
 * branch ships the only one that works without the desktop app installed.
 *
 *   "inject"  (this branch)
 *     Advertise the tools in the prompt as a JSON contract, parse a fenced block
 *     out of the reply, execute locally, feed the result back as the next user
 *     turn. Costs one extra turn per tool call and depends on the model
 *     complying, but needs nothing but the gateway: no outpost, no instance
 *     token, no Electron shell, no desktop app.
 *
 * WHY THERE IS NO `mcp` MODE HERE
 * ------------------------------
 * Running an MCP server locally and registering it into Quick over
 * `/local/mcp/add` gives the model native tool calls: zero extra turns and no
 * format-compliance problem. It is strictly better — when it works — but
 * enabling a local MCP server is gated twice by the desktop app:
 *
 *   1. `/local/mcp/add|toggle|remove|reload` answer HTTP 503
 *      `permissions_pending` until the app has pulled the organisation's
 *      permissions. A global write gate: a brand-new non-existent id gets the
 *      same answer, and it does not clear on retry. Reads (`list`) stay 200.
 *
 *   2. `toggle` additionally needs an Ed25519-signed confirmation
 *      {nonce, signature, timestamp, jti, hashVersion, outpostId} produced by
 *      Electron's main process after a native OS dialog.
 *
 * Both belong to the desktop app, so `mcp` mode would be dead code on a clean
 * machine — the very machine this project targets. It is kept on the
 * `mcp-native` branch, together with notes on what a desktop-free version would
 * need.
 */

import type { ToolDef, ToolExecutor, ToolResult } from './registry.js';

export type ToolMode = 'inject';

/**
 * Which strategy to use.
 *
 * Only one exists on this branch. QUICK_ACP_TOOL_MODE is still read so a config
 * copied from the `mcp-native` branch does not fail loudly; the value is ignored.
 */
export function resolveToolMode(): ToolMode {
  const raw = (process.env.QUICK_ACP_TOOL_MODE ?? '').toLowerCase();
  if (raw === 'mcp') {
    console.error(
      '[quick-acp] QUICK_ACP_TOOL_MODE=mcp ignored: native MCP lives on the ' +
        '"mcp-native" branch (it needs the Quick desktop app). Using inject.',
    );
  }
  return 'inject';
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
//
// Not present on this branch. The MCP server, its registration handshake, and
// the notes on what a desktop-free version would need all live on the
// `mcp-native` branch. Keeping the stub out of the build means `tsc` cannot be
// satisfied by code that cannot run on a clean machine.
