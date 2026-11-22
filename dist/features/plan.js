/**
 * Quick-acp 任务计划管理与 ACP plan 会话状态同步模块。
 *
 * 核心功能：
 *   1. 向模型提供 `plan_update` 工具，支持结构化待办列表更新
 *   2. 将计划步骤流转实时映射为 ACP `sessionUpdate: 'plan'` 通知推送至编辑器卡片
 *   3. 提供可供 `/plan` 斜杠命令直接消费的格式化 Markdown 文本渲染器
 */
/** 计划更新工具定义 */
export function planToolDef() {
    return {
        name: 'plan_update',
        description: '更新任务执行计划或待办事项清单。向客户端界面推送结构化的阶段进度指示条。',
        inputSchema: {
            type: 'object',
            properties: {
                entries: {
                    type: 'array',
                    description: '按时间顺序排列的完整任务计划条目数组',
                    items: {
                        type: 'object',
                        properties: {
                            content: { type: 'string', description: '步骤的简要描述' },
                            status: {
                                type: 'string',
                                enum: ['pending', 'in_progress', 'completed'],
                                description: '当前步骤状态 (pending: 待处理, in_progress: 进行中, completed: 已完成)',
                            },
                            priority: {
                                type: 'string',
                                enum: ['low', 'medium', 'high'],
                                description: '优先级 (默认: medium)',
                            },
                        },
                        required: ['content', 'status'],
                    },
                },
            },
            required: ['entries'],
        },
    };
}
export class SessionPlanManager {
    currentPlan = [];
    get plan() {
        return this.currentPlan;
    }
    /** 从模型传入的原始参数中解析并校验计划条目 */
    updateFromRaw(args) {
        if (!args || typeof args !== 'object') {
            return { entries: this.currentPlan, ok: false, message: '无效的计划参数' };
        }
        const a = args;
        const rawEntries = a['entries'] || a['todos'] || a['tasks'];
        if (!Array.isArray(rawEntries)) {
            return { entries: this.currentPlan, ok: false, message: '计划条目必须是数组格式' };
        }
        const sanitized = [];
        for (const item of rawEntries) {
            if (!item || typeof item !== 'object')
                continue;
            const rec = item;
            const content = String(rec['content'] || rec['text'] || rec['title'] || '').trim();
            if (!content)
                continue;
            let status = 'pending';
            const rawStatus = String(rec['status'] || '').toLowerCase();
            if (rawStatus === 'completed' || rawStatus === 'done' || rawStatus === 'finished') {
                status = 'completed';
            }
            else if (rawStatus === 'in_progress' || rawStatus === 'running' || rawStatus === 'active') {
                status = 'in_progress';
            }
            let priority = 'medium';
            const rawPriority = String(rec['priority'] || '').toLowerCase();
            if (rawPriority === 'high' || rawPriority === 'low') {
                priority = rawPriority;
            }
            sanitized.push({ content, status, priority });
        }
        this.currentPlan = sanitized;
        return {
            entries: this.currentPlan,
            ok: true,
            message: `执行计划已更新 (${this.currentPlan.length} 个步骤)`,
        };
    }
    /** 渲染为 Markdown 格式供客户端或 /plan 命令查看 */
    formatAsMarkdown() {
        if (this.currentPlan.length === 0) {
            return '当前会话尚未制定具体执行计划。可由模型调用 `plan_update` 设定。';
        }
        const lines = ['### 当前任务执行计划', ''];
        for (let i = 0; i < this.currentPlan.length; i++) {
            const e = this.currentPlan[i];
            let marker = '[ ]';
            if (e.status === 'completed')
                marker = '[x]';
            else if (e.status === 'in_progress')
                marker = '[>]';
            const pri = e.priority === 'high' ? '🔥 ' : e.priority === 'low' ? '💡 ' : '';
            lines.push(`${i + 1}. ${marker} ${pri}${e.content} (${e.status})`);
        }
        return lines.join('\n');
    }
    reset() {
        this.currentPlan = [];
    }
}
//# sourceMappingURL=plan.js.map