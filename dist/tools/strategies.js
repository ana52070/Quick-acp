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
/**
 * Which strategy to use.
 *
 * Only one exists on this branch. QUICK_ACP_TOOL_MODE is still read so a config
 * copied from the `mcp-native` branch does not fail loudly; the value is ignored.
 */
export function resolveToolMode() {
    const raw = (process.env.QUICK_ACP_TOOL_MODE ?? '').toLowerCase();
    if (raw === 'mcp') {
        console.error('[quick-acp] QUICK_ACP_TOOL_MODE=mcp ignored: native MCP lives on the ' +
            '"mcp-native" branch (it needs the Quick desktop app). Using inject.');
    }
    return 'inject';
}
// ---------------------------------------------------------------------------
// Strategy: inject
// ---------------------------------------------------------------------------
/** Marker the model is asked to emit. Chosen to be unlikely in prose. */
export const CALL_OPEN = '```quick-tool-call';
export const CALL_CLOSE = '```';
/**
 * 只展示文件目标；命令、查询和提问正文不进入额度提示。
 */
export function extractSafeToolTarget(_name, args) {
    if (!args || typeof args !== 'object')
        return undefined;
    for (const key of ['path', 'file', 'target_file', 'filePath']) {
        const target = args[key];
        if (typeof target === 'string' && target) {
            return target.replace(/[\r\n]/g, ' ').slice(0, 240);
        }
    }
    return undefined;
}
/**
 * 格式化中文工具预算用尽通知，详细列出调用进展、最后执行工具及下一待执行工具。
 */
export function formatBudgetExhaustedNotice(progress) {
    const { totalCalls, maxToolRounds, lastExecutedTool, nextPendingTool } = progress;
    const lastToolDesc = lastExecutedTool
        ? `${lastExecutedTool.name}${(() => {
            const target = extractSafeToolTarget(lastExecutedTool.name, lastExecutedTool.args);
            return target ? ` (${target})` : '';
        })()} [${lastExecutedTool.ok ? '成功' : '失败'}]`
        : '无';
    const nextToolDesc = nextPendingTool
        ? `${nextPendingTool.name}${(() => {
            const target = extractSafeToolTarget(nextPendingTool.name, nextPendingTool.args);
            return target ? ` (${target})` : '';
        })()} [待执行/已拦截]`
        : '无';
    return (`【工具调用额度已用尽】\n` +
        `当前轮次已达到工具调用上限（已执行 ${totalCalls}/${maxToolRounds} 次调用），任务尚未全部完成：\n` +
        `- 最后实际执行工具: ${lastToolDesc}\n` +
        `- 下一待执行工具: ${nextToolDesc}\n` +
        `已安全停止以防止死循环。如需继续执行剩余任务，请提高环境变量 QUICK_ACP_MAX_TOOL_ROUNDS 的数值或进一步细化分拆任务。`);
}
/**
 * Build the prompt that teaches the model the tool contract.
 *
 * Kept separate from the user's text so the caller can see exactly what extra
 * tokens are being spent, and so the contract can be cached upstream.
 */
export function buildToolPrompt(tools, workspaceRoot) {
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
        'CRITICAL EXECUTION ROUTING & ENVIRONMENT CONSTRAINTS:',
        '1. EXCLUSIVE LOCAL CHANNEL: The tools declared below under "AVAILABLE TOOLS" via ```quick-tool-call blocks (such as file_read, file_write, file_list, file_search, shell_run, etc.) are your SOLE AND EXCLUSIVE channel for reading/writing files, inspecting directories, and executing commands in the workspace.',
        '2. NO ACCESS VIA CLOUD/DEVICE TOOLS: Any server-side, upstream, or cloud native device tools (including run_python_on_device, device_terminal, or any cloud/device interpreters) CANNOT access the user\'s local machine or workspace files. They run in a remote, isolated cloud container with no local files.',
        '3. STRICTLY FORBIDDEN: NEVER invoke cloud native device tools (such as run_python_on_device). NEVER assume or state you are operating on a remote device (e.g. "chuiyu设备" or similar). All workspace files exist ONLY on the local machine at the workspace root.',
        '4. MANDATORY PROTOCOL: When you need to read, write, list files or run shell commands, ALWAYS emit a ```quick-tool-call block specifying one of the AVAILABLE TOOLS below. NEVER use any other tool-call format.',
        '',
        'AVAILABLE TOOLS',
        '',
        spec,
        '',
        'HOW TO CALL A TOOL',
        '',
        'When you need a tool, reply with a fenced block containing a JSON tool call:',
        '',
        CALL_OPEN,
        '{"name": "<tool name>", "arguments": { ... }}',
        CALL_CLOSE,
        '',
        'Rules:',
        '- The block must contain only valid JSON.',
        '- If file content contains markdown code blocks (e.g. ```bash), ensure all quotes and newlines in JSON strings are properly escaped as valid JSON.',
        '- You may emit multiple tool calls either in separate ```quick-tool-call blocks or as a JSON array: [{"name": "..."}, ...].',
        '- After the block(s), stop. The caller runs the tool(s) and sends you the result(s).',
        '- To finish without a tool, just answer normally with no tool-call block.',
    ].join('\n');
}
/**
 * Find the boundary of a balanced JSON object `{ ... }` or array `[ ... ]`
 * starting at or after `startIndex`.
 * Properly respects string literal quotes and escape sequences `\"`, `\\`.
 */
export function extractBalancedJson(text, startIndex = 0) {
    let firstBrace = -1;
    let openChar = '';
    let closeChar = '';
    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') {
            firstBrace = i;
            openChar = '{';
            closeChar = '}';
            break;
        }
        if (ch === '[') {
            firstBrace = i;
            openChar = '[';
            closeChar = ']';
            break;
        }
    }
    if (firstBrace === -1)
        return null;
    let depth = 0;
    let inString = false;
    let isEscaped = false;
    for (let i = firstBrace; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (isEscaped) {
                isEscaped = false;
            }
            else if (ch === '\\') {
                isEscaped = true;
            }
            else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === openChar) {
            depth++;
        }
        else if (ch === closeChar) {
            depth--;
            if (depth === 0) {
                return {
                    json: text.slice(firstBrace, i + 1),
                    startIndex: firstBrace,
                    endIndex: i + 1,
                };
            }
        }
    }
    return null;
}
/**
 * Robust JSON parse that handles common minor LLM syntax anomalies
 * such as literal unescaped newlines in multi-line strings or trailing commas,
 * while strictly preserving commas and brackets inside string literals.
 */
export function robustJsonParse(jsonStr) {
    try {
        return JSON.parse(jsonStr);
    }
    catch {
        // 1. Sanitize unescaped control characters inside string literals,
        // and strip trailing commas ONLY outside string literals.
        let sanitized = '';
        let inString = false;
        let isEscaped = false;
        for (let i = 0; i < jsonStr.length; i++) {
            const ch = jsonStr[i];
            if (inString) {
                if (isEscaped) {
                    isEscaped = false;
                    sanitized += ch;
                }
                else if (ch === '\\') {
                    isEscaped = true;
                    sanitized += ch;
                }
                else if (ch === '"') {
                    inString = false;
                    sanitized += ch;
                }
                else if (ch === '\n') {
                    sanitized += '\\n';
                }
                else if (ch === '\r') {
                    sanitized += '\\r';
                }
                else if (ch === '\t') {
                    sanitized += '\\t';
                }
                else {
                    sanitized += ch;
                }
                continue;
            }
            if (ch === '"') {
                inString = true;
                sanitized += ch;
                continue;
            }
            // Outside string literals: look ahead for trailing comma before } or ]
            if (ch === ',') {
                let j = i + 1;
                while (j < jsonStr.length && /\s/.test(jsonStr[j])) {
                    j++;
                }
                if (j < jsonStr.length && (jsonStr[j] === '}' || jsonStr[j] === ']')) {
                    // Trailing comma outside string literal: omit it!
                    continue;
                }
            }
            sanitized += ch;
        }
        return JSON.parse(sanitized);
    }
}
/**
 * Normalize an arbitrary parsed JSON structure into ParsedToolCall[].
 * Supports single call, array of calls, or wrapped shapes { tool_calls: [...] }.
 * Also supports alias keys (e.g. tool/action/parameters/params).
 */
function normalizeToolCalls(parsed) {
    if (!parsed || typeof parsed !== 'object')
        return [];
    if (Array.isArray(parsed)) {
        const list = [];
        for (const item of parsed) {
            list.push(...normalizeToolCalls(item));
        }
        return list;
    }
    const obj = parsed;
    if (Array.isArray(obj['tool_calls'])) {
        return normalizeToolCalls(obj['tool_calls']);
    }
    if (Array.isArray(obj['tools'])) {
        return normalizeToolCalls(obj['tools']);
    }
    if (Array.isArray(obj['calls'])) {
        return normalizeToolCalls(obj['calls']);
    }
    const name = typeof obj['name'] === 'string'
        ? obj['name']
        : typeof obj['tool'] === 'string'
            ? obj['tool']
            : typeof obj['action'] === 'string'
                ? obj['action']
                : '';
    if (!name)
        return [];
    const rawArgs = obj['arguments'] ?? obj['parameters'] ?? obj['params'] ?? obj['args'] ?? {};
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? rawArgs
        : {};
    return [{ name, arguments: args }];
}
/**
 * Extract all tool calls from a model reply.
 * Handles:
 * - ```quick-tool-call (3 or 4+ backticks)
 * - File content containing markdown backticks without premature truncation
 * - Multi-tool blocks and JSON arrays of tool calls
 * - Sequential scanning so nested tool call markers inside string arguments are skipped
 * - ```json fallback blocks
 * - Direct JSON fallback
 */
export function parseToolCalls(text) {
    const calls = [];
    // 1. Primary: match fenced block with quick-tool-call marker (3 or more backticks)
    const OPEN_REGEX = /`{3,}(?:quick-tool-call|quick_tool_call|tool-call|tool_call)\b/gi;
    let match;
    while ((match = OPEN_REGEX.exec(text)) !== null) {
        const fenceStart = match.index + match[0].length;
        const extracted = extractBalancedJson(text, fenceStart);
        if (extracted) {
            try {
                const parsed = robustJsonParse(extracted.json);
                const found = normalizeToolCalls(parsed);
                if (found.length > 0) {
                    calls.push(...found);
                    // Advance past this entire block (including closing fence if present)
                    // so markers nested inside string arguments are never matched
                    const afterJson = text.slice(extracted.endIndex);
                    const closeMatch = afterJson.match(/^\s*`{3,}/);
                    OPEN_REGEX.lastIndex = extracted.endIndex + (closeMatch ? closeMatch[0].length : 0);
                    continue;
                }
            }
            catch {
                // ignore malformed block
            }
        }
        if (OPEN_REGEX.lastIndex <= match.index) {
            OPEN_REGEX.lastIndex = match.index + match[0].length;
        }
    }
    if (calls.length > 0)
        return calls;
    // 2. Secondary: match ```json blocks with tool calls
    const JSON_BLOCK_REGEX = /`{3,}json\b/gi;
    while ((match = JSON_BLOCK_REGEX.exec(text)) !== null) {
        const start = match.index + match[0].length;
        const extracted = extractBalancedJson(text, start);
        if (extracted) {
            try {
                const parsed = robustJsonParse(extracted.json);
                const found = normalizeToolCalls(parsed);
                if (found.length > 0) {
                    calls.push(...found);
                    const afterJson = text.slice(extracted.endIndex);
                    const closeMatch = afterJson.match(/^\s*`{3,}/);
                    JSON_BLOCK_REGEX.lastIndex = extracted.endIndex + (closeMatch ? closeMatch[0].length : 0);
                    continue;
                }
            }
            catch {
                // ignore
            }
        }
        if (JSON_BLOCK_REGEX.lastIndex <= match.index) {
            JSON_BLOCK_REGEX.lastIndex = match.index + match[0].length;
        }
    }
    if (calls.length > 0)
        return calls;
    // 3. Fallback: try raw JSON if it references known tool signatures
    let searchIdx = 0;
    while (searchIdx < text.length) {
        const sub = text.slice(searchIdx);
        const relIdx = sub.search(/\{[\s\S]*?"(?:name|tool|action)"\s*:\s*"(?:file_|shell_)[^"]+"/);
        if (relIdx < 0)
            break;
        const rawIdx = searchIdx + relIdx;
        const extracted = extractBalancedJson(text, rawIdx);
        if (extracted) {
            try {
                const parsed = robustJsonParse(extracted.json);
                const found = normalizeToolCalls(parsed);
                if (found.length > 0) {
                    calls.push(...found);
                    searchIdx = extracted.endIndex;
                    continue;
                }
            }
            catch {
                // ignore
            }
            searchIdx = extracted.endIndex;
        }
        else {
            searchIdx = rawIdx + 1;
        }
    }
    return calls;
}
/**
 * Extract a single tool call from a model reply.
 * Returns null when the reply is a normal answer, so the caller can treat it as
 * the final assistant text.
 */
export function parseToolCall(text) {
    const calls = parseToolCalls(text);
    return calls.length > 0 ? calls[0] : null;
}
/** Render a tool result as the next user turn. */
export function formatToolResult(call, result) {
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
export async function runWithInjectedTools(opts) {
    const preamble = buildToolPrompt(opts.tools, opts.workspaceRoot);
    let pending = `${preamble}\n\n---\n\n${opts.userText}`;
    let rounds = 0;
    let lastExecutedTool;
    for (;;) {
        if (opts.abortSignal?.aborted) {
            return { finalText: '', cancelled: true, rounds, exhausted: false };
        }
        const reply = await opts.turn(pending);
        if (reply.cancelled || opts.abortSignal?.aborted) {
            return { finalText: reply.text, cancelled: true, rounds, exhausted: false };
        }
        const calls = parseToolCalls(reply.text);
        if (calls.length === 0) {
            // Normal answer: this is the end of the turn.
            opts.onAssistantText(reply.text);
            return { finalText: reply.text, cancelled: false, rounds, exhausted: false };
        }
        const toolResultTexts = [];
        for (const call of calls) {
            // 取消优先：工具执行前若已被 abort 则立即返回 cancelled
            if (opts.abortSignal?.aborted) {
                return { finalText: '', cancelled: true, rounds, exhausted: false };
            }
            if (rounds >= opts.maxToolRounds) {
                const nextPendingTool = {
                    name: call.name,
                    args: call.arguments,
                };
                const progress = {
                    totalCalls: rounds,
                    maxToolRounds: opts.maxToolRounds,
                    lastExecutedTool,
                    nextPendingTool,
                };
                const notice = formatBudgetExhaustedNotice(progress);
                if (opts.onBudgetExhausted) {
                    await opts.onBudgetExhausted({ progress, notice });
                }
                if (opts.abortSignal?.aborted) {
                    return { finalText: '', cancelled: true, rounds, exhausted: false };
                }
                opts.onAssistantText(notice);
                return {
                    finalText: notice,
                    cancelled: false,
                    rounds,
                    exhausted: true,
                    progress,
                };
            }
            rounds++;
            const toolCallId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            opts.onToolStart?.(call, toolCallId);
            const result = await opts.executor.execute(call.name, call.arguments, opts.abortSignal, toolCallId);
            opts.onToolEnd?.(call, toolCallId, result);
            opts.onToolCall(call, result);
            toolResultTexts.push(formatToolResult(call, result));
            lastExecutedTool = {
                name: call.name,
                args: call.arguments,
                ok: result.ok,
                result: result.content,
            };
            if (opts.abortSignal?.aborted) {
                return { finalText: '', cancelled: true, rounds, exhausted: false };
            }
        }
        pending = toolResultTexts.join('\n\n---\n\n');
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
//# sourceMappingURL=strategies.js.map