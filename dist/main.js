#!/usr/bin/env node
/**
 * quick-acp entry point.
 *
 * Speaks ACP over stdin/stdout. Everything diagnostic goes to stderr, because
 * stdout is the protocol channel and a stray console.log corrupts the stream.
 *
 * NOTE ON STARTUP: this used to start Quick's outpost here, because refreshing
 * the token "had to" go through it. That turned out to be wrong — the token
 * refreshes fine against oidc.<region>.api.aws with the client secret as Basic
 * auth, and the gateway host is just `tenant_url` without its scheme. So there
 * is nothing to start: the first turn resolves a session from the stored login
 * or ~/.quick-acp/login.json and dials directly. Less to go wrong, and it works
 * on a machine that has never had the desktop app installed.
 */
import { AgentSideConnection, ndJsonStream } from '@zed-industries/agent-client-protocol';
import { QuickAcpAgent } from './acp/agent.js';
async function main() {
    const workspaceRoot = process.env.QUICK_ACP_WORKSPACE ?? process.cwd();
    if (process.env.QUICK_ACP_PRINT_INFO === '1') {
        console.error('[quick-acp] workspace root:', workspaceRoot);
        console.error('[quick-acp] tools: prompt-injected (one extra turn per tool call)');
        console.error('[quick-acp] shell enabled:', process.env.QUICK_ACP_ALLOW_SHELL === '1');
    }
    const agent = new QuickAcpAgent({ workspaceRoot });
    // ndJsonStream wants a WritableStream<Uint8Array> for output and a
    // ReadableStream<Uint8Array> for input. We build them from Node's stdio so
    // the process works whether launched by an ACP client or interactively.
    const output = new WritableStream({
        write(chunk) {
            return new Promise((resolve, reject) => {
                process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()));
            });
        },
    });
    const input = new ReadableStream({
        start(controller) {
            process.stdin.on('data', (chunk) => {
                controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
            });
            process.stdin.on('end', () => {
                try {
                    controller.close();
                }
                catch {
                    /* already closed */
                }
            });
            process.stdin.on('error', (err) => {
                try {
                    controller.error(err);
                }
                catch {
                    /* already errored */
                }
            });
        },
    });
    const stream = ndJsonStream(output, input);
    // The connection hands us the Agent handler; we keep the connection so we can
    // push session/update notifications during a turn.
    new AgentSideConnection((conn) => {
        agent.attach(conn);
        return agent;
    }, stream);
    // Keep the process alive on stdin; the SDK drives everything else.
    await new Promise((resolve) => {
        process.stdin.on('close', () => resolve());
        process.on('SIGTERM', () => resolve());
        process.on('SIGINT', () => resolve());
    });
}
main().catch((e) => {
    console.error('[quick-acp] fatal:', e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
});
//# sourceMappingURL=main.js.map