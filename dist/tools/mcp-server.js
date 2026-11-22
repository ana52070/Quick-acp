/**
 * MCP server that quick-acp registers into Quick.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first version of this bridge assumed Quick's MCP entry point was closed
 * and fell back to prompt-injection. That was wrong. Quick's outpost exposes a
 * FULL local MCP server manager, reachable without any special capability:
 *
 *    GET  /local/mcp/list
 *    POST /local/mcp/add        { name, command, args[], url, description,
 *                                 startupTimeout, envVars[], headers[],
 *                                 hostOnOutpost }
 *    POST /local/mcp/toggle     { id, enabled }
 *    POST /local/mcp/remove     { id }
 *    POST /local/mcp/reload     { id }
 *    GET  /local/mcp/known-sources
 *
 * Transports: stdio, sse, streamable_http. It also accepts a pasted
 * `{"mcpServers": {...}}` blob, which is what the referenced guide uses.
 *
 * So the right design is: run an MCP server HERE, register it into Quick over
 * `/local/mcp/add`, and let Quick's model call these tools natively. That gives
 * zero extra turns and no reliance on the model formatting JSON by hand.
 *
 * TRANSPORT: stdio over newline-delimited JSON-RPC 2.0.
 * Quick spawns this process, so we must not write anything to stdout except
 * protocol frames.
 */
import { createInterface } from 'node:readline';
const PROTOCOL_VERSION = '2024-11-05';
/**
 * Run the MCP server on stdio. Resolves when stdin closes.
 *
 * Implements the subset Quick needs: initialize, tools/list, tools/call, ping.
 */
export async function runMcpServer(opts) {
    const out = process.stdout;
    const send = (msg) => {
        out.write(`${JSON.stringify(msg)}\n`);
    };
    const reply = (id, result) => {
        send({ jsonrpc: '2.0', id, result });
    };
    const fail = (id, code, message) => {
        send({ jsonrpc: '2.0', id, error: { code, message } });
    };
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let req;
        try {
            req = JSON.parse(trimmed);
        }
        catch {
            // A malformed frame has no id to answer, so drop it rather than guess.
            continue;
        }
        // Notifications carry no id and take no response.
        const isNotification = req.id === undefined || req.id === null;
        try {
            switch (req.method) {
                case 'initialize': {
                    reply(req.id, {
                        protocolVersion: PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: opts.name, version: opts.version },
                    });
                    break;
                }
                case 'notifications/initialized':
                case 'initialized': {
                    // No response for notifications.
                    break;
                }
                case 'tools/list': {
                    reply(req.id, {
                        tools: opts.tools.map((t) => ({
                            name: t.name,
                            description: t.description,
                            inputSchema: t.inputSchema,
                        })),
                    });
                    break;
                }
                case 'tools/call': {
                    const params = req.params ?? {};
                    const name = typeof params['name'] === 'string' ? params['name'] : '';
                    const argsRaw = params['arguments'];
                    const args = argsRaw && typeof argsRaw === 'object'
                        ? argsRaw
                        : {};
                    if (!name) {
                        fail(req.id, -32602, 'tools/call requires a tool name');
                        break;
                    }
                    const result = await opts.executor.execute(name, args);
                    reply(req.id, {
                        content: [{ type: 'text', text: result.content }],
                        isError: !result.ok,
                    });
                    break;
                }
                case 'ping': {
                    reply(req.id, {});
                    break;
                }
                default: {
                    if (isNotification)
                        break;
                    fail(req.id, -32601, `method not found: ${req.method}`);
                    break;
                }
            }
        }
        catch (e) {
            if (isNotification)
                continue;
            fail(req.id, -32603, e instanceof Error ? e.message : String(e));
        }
    }
}
//# sourceMappingURL=mcp-server.js.map