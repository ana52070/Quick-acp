/**
 * Quick-acp 会话级 MCP (Model Context Protocol) 管理器。
 *
 * 基于官方 @modelcontextprotocol/sdk 实现标准 stdio、Streamable HTTP 及 SSE 客户端挂载。
 *
 * 核心机制：
 *   1. 工具名称唯一性隔离：采用 `mcp__s<会话序号>_<服务序号>_<服务名>__<工具名>`，避免多服务/截断碰撞
 *   2. 严格的子进程与网络生命周期管理：
 *      - stdio 捕获并清空 stderr，避免缓冲区满导致子进程挂起
 *      - 挂载失败或退出时立即终止进程树，杜绝孤儿进程泄漏
 *      - close() 时基于 taskkill /T (Win) 或负 PID 进程组 (POSIX) 彻底清理整个子进程树
 *   3. 支持执行过程中的 AbortSignal 级联取消与有界超时
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { killTree } from '../tools/registry.js';
export class SessionMcpManager {
    sessionSeq;
    mountedClients = [];
    tools = [];
    isClosed = false;
    constructor(sessionSeq) {
        this.sessionSeq = sessionSeq;
    }
    get registeredTools() {
        return this.tools;
    }
    /**
     * 挂载所有配置的 MCP 服务（顺序挂载）。
     * 任一服务启动失败会记录错误并彻底清理其资源，不影响其他服务运行。
     */
    async mountServers(servers) {
        if (this.isClosed)
            return [];
        let serverIdx = 0;
        for (const raw of servers) {
            if (!raw || typeof raw !== 'object')
                continue;
            const server = raw;
            if (!server.name)
                continue;
            serverIdx++;
            try {
                if ('command' in server && typeof server.command === 'string') {
                    await this.mountStdioServer(server, serverIdx);
                }
                else if ('url' in server && typeof server.url === 'string') {
                    await this.mountHttpServer(server, serverIdx);
                }
            }
            catch (e) {
                console.error(`[quick-acp:mcp] 挂载 MCP 服务 ${server.name} 失败:`, e instanceof Error ? e.message : String(e));
            }
        }
        return this.tools;
    }
    /**
     * 生成无碰撞的唯一服务端前缀标识。
     * 包含会话序列号、服务端序号与经过安全字符替换的服务名，不进行硬截断以杜绝碰撞。
     */
    makeCleanName(name, serverIdx) {
        const safe = name.replace(/[^a-zA-Z0-9]/g, '_');
        return `s${this.sessionSeq}_srv${serverIdx}_${safe}`;
    }
    /**
     * 挂载基于 stdio 的 MCP 子进程服务。
     * 确保 stderr 得到消费，防止子进程阻塞；挂载异常时立即杀进程树。
     */
    async mountStdioServer(server, serverIdx) {
        const clean = this.makeCleanName(server.name, serverIdx);
        const envRecord = { ...process.env };
        if (Array.isArray(server.env)) {
            for (const pair of server.env) {
                if (pair && pair.name)
                    envRecord[pair.name] = pair.value;
            }
        }
        else if (server.env && typeof server.env === 'object') {
            Object.assign(envRecord, server.env);
        }
        const client = new Client({ name: `quick-acp-mcp-${clean}`, version: '0.1.5' }, { capabilities: {} });
        const transport = new StdioClientTransport({
            command: server.command,
            args: server.args ?? [],
            env: envRecord,
            cwd: server.cwd,
            stderr: 'pipe',
        });
        // SDK stdio 构造时已创建 PassThrough 并在 start() pipe。
        // 若服务在 initialize 前输出大量 stderr，若不及时消费 PassThrough 会因缓冲区满反压导致死锁。
        // 必须在 await client.connect 前监听并 resume 公开的 transport.stderr
        if (transport.stderr) {
            transport.stderr.on('data', (chunk) => {
                if (process.env.QUICK_ACP_DEBUG === '1') {
                    process.stderr.write(`[mcp:${server.name}:stderr] ${chunk.toString('utf8')}`);
                }
            });
            transport.stderr.resume();
        }
        let spawnedProcess = null;
        try {
            await client.connect(transport);
            spawnedProcess = transport._process;
            // 再次确保消费子进程底层 stderr 流（双重保障）
            if (spawnedProcess?.stderr) {
                spawnedProcess.stderr.resume();
            }
            // 获取工具列表
            const toolsResult = await client.listTools();
            const rawTools = toolsResult?.tools ?? [];
            for (const rawTool of rawTools) {
                const toolName = `mcp__${clean}__${rawTool.name}`;
                this.tools.push({
                    name: toolName,
                    description: `[MCP: ${server.name}] ${rawTool.description ?? rawTool.name}`,
                    inputSchema: rawTool.inputSchema ?? { type: 'object', properties: {} },
                });
            }
            const mounted = {
                serverName: server.name,
                cleanName: clean,
                client,
                childProcess: spawnedProcess,
                callTool: async (rawName, args, signal) => {
                    if (signal?.aborted) {
                        return { content: '操作已被调用者取消', ok: false };
                    }
                    try {
                        const res = await client.callTool({ name: rawName, arguments: args }, undefined, { signal });
                        const contents = Array.isArray(res?.content) ? res.content : [];
                        const textParts = contents
                            .filter((c) => c.type === 'text' && typeof c.text === 'string')
                            .map((c) => c.text);
                        return {
                            content: textParts.length > 0 ? textParts.join('\n') : JSON.stringify(res),
                            ok: !res?.isError,
                        };
                    }
                    catch (e) {
                        return {
                            content: e instanceof Error ? e.message : String(e),
                            ok: false,
                        };
                    }
                },
                close: async () => {
                    // close 前先杀进程树，防 SDK client.close() 先杀父进程导致孙进程失联
                    const targetPid = transport.pid ?? transport._process?.pid ?? spawnedProcess?.pid;
                    const proc = transport._process ?? spawnedProcess;
                    if (targetPid) {
                        await killTree(proc, targetPid);
                    }
                    try {
                        await client.close();
                    }
                    catch {
                        /* 忽略正常关闭错误 */
                    }
                },
            };
            this.mountedClients.push(mounted);
        }
        catch (err) {
            // 挂载失败从 transport.pid 或 _process 捕获并清理子进程树
            const targetPid = transport.pid ?? transport._process?.pid ?? spawnedProcess?.pid;
            const proc = transport._process ?? spawnedProcess;
            if (targetPid) {
                await killTree(proc, targetPid);
            }
            try {
                await client.close();
            }
            catch { }
            throw err;
        }
    }
    /**
     * 挂载基于 HTTP / SSE 的 MCP 服务。
     * 支持官方 Streamable HTTP 与 SSE 规范。
     */
    async mountHttpServer(server, serverIdx) {
        const clean = this.makeCleanName(server.name, serverIdx);
        const headerRecord = {};
        if (Array.isArray(server.headers)) {
            for (const h of server.headers) {
                if (h && h.name)
                    headerRecord[h.name] = h.value;
            }
        }
        else if (server.headers && typeof server.headers === 'object') {
            Object.assign(headerRecord, server.headers);
        }
        const client = new Client({ name: `quick-acp-mcp-${clean}`, version: '0.1.5' }, { capabilities: {} });
        const url = new URL(server.url);
        const isSse = server.type === 'sse';
        const transport = isSse
            ? new SSEClientTransport(url, {
                eventSourceInit: {
                    // @ts-ignore
                    headers: headerRecord,
                },
                requestInit: {
                    headers: headerRecord,
                },
            })
            : new StreamableHTTPClientTransport(url, {
                requestInit: {
                    headers: headerRecord,
                },
            });
        try {
            await client.connect(transport);
            const toolsResult = await client.listTools();
            const rawTools = toolsResult?.tools ?? [];
            for (const rawTool of rawTools) {
                const toolName = `mcp__${clean}__${rawTool.name}`;
                this.tools.push({
                    name: toolName,
                    description: `[MCP: ${server.name}] ${rawTool.description ?? rawTool.name}`,
                    inputSchema: rawTool.inputSchema ?? { type: 'object', properties: {} },
                });
            }
            const mounted = {
                serverName: server.name,
                cleanName: clean,
                client,
                callTool: async (rawName, args, signal) => {
                    if (signal?.aborted) {
                        return { content: '操作已被调用者取消', ok: false };
                    }
                    try {
                        const res = await client.callTool({ name: rawName, arguments: args }, undefined, { signal });
                        const contents = Array.isArray(res?.content) ? res.content : [];
                        const textParts = contents
                            .filter((c) => c.type === 'text' && typeof c.text === 'string')
                            .map((c) => c.text);
                        return {
                            content: textParts.length > 0 ? textParts.join('\n') : JSON.stringify(res),
                            ok: !res?.isError,
                        };
                    }
                    catch (e) {
                        return {
                            content: e instanceof Error ? e.message : String(e),
                            ok: false,
                        };
                    }
                },
                close: async () => {
                    try {
                        if ('terminateSession' in transport && typeof transport.terminateSession === 'function') {
                            await transport.terminateSession();
                        }
                    }
                    catch {
                        /* 忽略 terminateSession 异常 */
                    }
                    try {
                        await client.close();
                    }
                    catch {
                        /* 忽略 HTTP 关闭错误 */
                    }
                },
            };
            this.mountedClients.push(mounted);
        }
        catch (err) {
            try {
                if ('terminateSession' in transport && typeof transport.terminateSession === 'function') {
                    await transport.terminateSession();
                }
            }
            catch { }
            try {
                await client.close();
            }
            catch { }
            throw err;
        }
    }
    /**
     * 执行指定名称的 MCP 工具，支持 AbortSignal 取消。
     */
    async executeMcpTool(fullName, args, signal) {
        if (!fullName.startsWith('mcp__'))
            return null;
        const parts = fullName.split('__');
        if (parts.length < 3)
            return null;
        const clean = parts[1];
        const rawName = parts.slice(2).join('__');
        const client = this.mountedClients.find((c) => c.cleanName === clean);
        if (!client) {
            return { content: `未找到 MCP 服务前缀为 ${clean} 的客户端`, ok: false };
        }
        const typedArgs = (args && typeof args === 'object' ? args : {});
        return client.callTool(rawName, typedArgs, signal);
    }
    /**
     * 彻底关闭本会话挂载的所有 MCP 客户端与子进程树。
     */
    async close() {
        this.isClosed = true;
        for (const client of this.mountedClients) {
            try {
                await client.close();
            }
            catch {
                /* 忽略单客户端关闭异常 */
            }
        }
        this.mountedClients = [];
        this.tools = [];
    }
}
//# sourceMappingURL=manager.js.map