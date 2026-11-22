/**
 * Quick-acp 分类网络错误自动重试与安全边界守卫模块。
 *
 * 核心机制：
 *   1. 仅针对临时性网络抖动 (ECONNRESET, ETIMEDOUT, 429, 502 等) 进行指数退避重试
 *   2. 取消优先：收到 AbortSignal 时立即中止退避并抛出，杜绝无效等待
 *   3. 副作用守卫：
 *      - 若当前轮次已执行具副作用的工具 (file_write, shell_run, 或任意 MCP 外部工具)，禁止重放
 *      - 若模型已经向客户端流式输出了部分正文 (hasOutputEmitted)，禁止从头重试，防止客户端 UI 出现重复正文
 *   4. 中文诊断说明流式透传给用户，保持过程透明
 */
export const DEFAULT_RETRY_POLICY = {
    maxRetries: 3,
    initialDelayMs: 500,
    maxDelayMs: 4000,
};
const RETRYABLE_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'ECONNREFUSED',
    'UND_ERR_SOCKET',
]);
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
export function isRetryableError(error) {
    if (!error)
        return false;
    if (error instanceof Error) {
        if (error.name === 'AbortError' || error.message.includes('abort') || error.message.includes('cancel')) {
            return false; // 用户主动取消，不重试
        }
        const code = error.code;
        if (code && RETRYABLE_CODES.has(code))
            return true;
        const msg = error.message.toLowerCase();
        if (msg.includes('socket hang up') ||
            msg.includes('econnreset') ||
            msg.includes('etimedout') ||
            msg.includes('network error') ||
            msg.includes('connection closed') ||
            msg.includes('rate limit') ||
            msg.includes('timeout')) {
            return true;
        }
        const status = error.status || error.statusCode;
        if (status && RETRYABLE_HTTP_STATUS.has(Number(status)))
            return true;
    }
    return false;
}
export async function runWithClassifiedRetry(action, opts = {}) {
    // 1. 若已触发不可逆副作用（文件写、本地命令或 MCP 工具），严格禁止重放
    if (opts.hasSideEffects) {
        return action();
    }
    const maxRetries = opts.policy?.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries;
    const initialDelay = opts.policy?.initialDelayMs ?? DEFAULT_RETRY_POLICY.initialDelayMs;
    const maxDelay = opts.policy?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs;
    let attempt = 0;
    while (true) {
        if (opts.abortSignal?.aborted) {
            throw new Error('Cancelled');
        }
        try {
            return await action();
        }
        catch (e) {
            attempt++;
            // 2. 若在此次执行中已经向客户端输出了部分正文，禁止重放，避免生成重复正文
            if (opts.hasOutputEmitted?.()) {
                throw e;
            }
            // 3. 超过最大重试次数、非可重试错误或已被调用方取消
            if (attempt > maxRetries || !isRetryableError(e) || opts.abortSignal?.aborted) {
                throw e;
            }
            const delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
            const notice = `（网络连接抖动或暂时限流，${(delay / 1000).toFixed(1)} 秒后进行第 ${attempt}/${maxRetries} 次重试）`;
            opts.onNotice?.(notice);
            await sleep(delay, opts.abortSignal);
        }
    }
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            return reject(new Error('Cancelled'));
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(new Error('Cancelled'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
//# sourceMappingURL=retry.js.map