/**
 * Quick-acp 客户端文件系统委托模块。
 *
 * 当 ACP 客户端声明支持 `fs.readTextFile` 能力时，优先通过 RPC 读取编辑器中未保存的内存缓冲区内容。
 * 具备有界超时 (5000ms) 与 AbortSignal 机制；超时或失败时平滑回退至本地磁盘读取。
 */
import { readFile } from 'node:fs/promises';
export class ClientFsDelegate {
    enabled = false;
    setClientCapabilities(caps) {
        this.enabled = caps?.fs?.readTextFile === true;
    }
    get isEnabled() {
        return this.enabled;
    }
    /**
     * 读取指定文件内容，优先尝试客户端未保存缓冲区，带 5 秒超时保护。
     */
    async readTextFile(conn, sessionId, filePath, signal, timeoutMs = 5000) {
        if (this.enabled && conn && typeof conn.readTextFile === 'function') {
            try {
                const readPromise = conn.readTextFile({ sessionId, path: filePath });
                const timeoutPromise = new Promise((_, reject) => {
                    const t = setTimeout(() => reject(new Error('客户端缓冲区读取超时')), timeoutMs);
                    signal?.addEventListener('abort', () => {
                        clearTimeout(t);
                        reject(new Error('操作已取消'));
                    }, { once: true });
                });
                const res = await Promise.race([readPromise, timeoutPromise]);
                if (typeof res?.content === 'string') {
                    return { content: res.content, source: 'client_buffer' };
                }
            }
            catch {
                // 客户端超时或不支持时，平滑降级至本地磁盘文件
            }
        }
        // 磁盘平滑回退读取
        const diskContent = await readFile(filePath, 'utf8');
        return { content: diskContent, source: 'disk' };
    }
}
//# sourceMappingURL=fs-delegate.js.map