/**
 * Quick-acp 本地技能 (SKILL) 发现与斜杠命令 (Slash Command) 处理器。
 *
 * 功能涵盖：
 *   1. 遍历工作区及用户主目录，发现并解析 SKILL.md 技能包
 *   2. 将内置斜杠命令与已发现技能汇总为 ACP `available_commands_update` 供客户端展示
 *   3. 本地拦截执行内置命令 (/help, /mode, /plan, /clear)，不向模型发送请求，杜绝模型误调用
 *   4. 支持按需技能触发：用户调用 `/<skill>` 时动态组装技能提示词
 *   5. 提供模型可调用的 `skill_read` 工具，赋能模型在推理过程中自主查阅与加载技能规范
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** 内置本地拦截斜杠命令清单 */
export const BUILTIN_COMMANDS = [
    { name: 'help', description: '显示可用工具、模式、技能及命令说明' },
    { name: 'mode', description: '查看或设置当前推理档位 (fast | balanced | smart)', input: { hint: 'fast | balanced | smart' } },
    { name: 'plan', description: '查看当前计划与任务步骤执行状态' },
    { name: 'clear', description: '重置并清空当前会话线程' },
];
/** 提供给模型自主查阅技能库的工具定义 */
export function skillReadToolDef() {
    return {
        name: 'skill_read',
        description: '查阅或读取本地技能库中的操作规范与专业指引文档。可传入具体技能名称加载其指令内容；留空或传入 "list" 可获取可用技能清单。',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: '要查阅的技能名称（如 "codebase-research" 等）；不传或为 "list" 则列出所有已挂载技能',
                },
            },
        },
    };
}
export class SkillManager {
    skills = new Map();
    /** 扫描工作区及系统主目录下的技能定义 */
    async discover(workspaceRoot) {
        this.skills.clear();
        const candidateRoots = [
            join(workspaceRoot, '.gemini', 'skills'),
            join(workspaceRoot, '.agents', 'skills'),
            join(workspaceRoot, 'skills'),
            join(homedir(), '.gemini', 'config', 'skills'),
            join(homedir(), '.gemini', 'antigravity-cli', 'skills'),
            join(homedir(), '.agents', 'skills'),
        ];
        for (const root of candidateRoots) {
            if (!existsSync(root))
                continue;
            try {
                const entries = await readdir(root, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory())
                        continue;
                    const skillFile = join(root, entry.name, 'SKILL.md');
                    if (!existsSync(skillFile))
                        continue;
                    try {
                        const raw = await readFile(skillFile, 'utf8');
                        const { name, description } = parseSkillFrontmatter(entry.name, raw);
                        this.skills.set(name.toLowerCase(), {
                            name,
                            description,
                            path: skillFile,
                            content: raw,
                        });
                    }
                    catch {
                        /* 忽略单文件读取异常 */
                    }
                }
            }
            catch {
                /* 忽略目录读取异常 */
            }
        }
    }
    /** 获取全量命令清单（内置命令 + 动态加载技能） */
    getAvailableCommands() {
        const list = [...BUILTIN_COMMANDS];
        for (const skill of this.skills.values()) {
            list.push({
                name: skill.name,
                description: `技能: ${skill.description}`,
                input: { hint: '补充任务描述（可选）' },
            });
        }
        return list;
    }
    getSkill(name) {
        return this.skills.get(name.toLowerCase());
    }
    getAllSkills() {
        return Array.from(this.skills.values());
    }
    /** 执行模型调用 skill_read 工具 */
    readSkillContent(skillName) {
        const target = skillName?.trim().toLowerCase();
        if (!target || target === 'list') {
            const all = this.getAllSkills();
            if (all.length === 0) {
                return { content: '当前工作区及系统目录未发现已挂载的技能。', ok: true };
            }
            const summary = all.map((s) => `- **${s.name}**: ${s.description}`).join('\n');
            return {
                content: `### 可用技能列表\n${summary}\n\n使用 \`skill_read({ name: "<技能名称>" })\` 读取具体规范。`,
                ok: true,
            };
        }
        const skill = this.getSkill(target);
        if (!skill) {
            return {
                content: `未找到名称为 "${skillName}" 的技能。请先调用 \`skill_read({ name: "list" })\` 确认技能名称。`,
                ok: false,
            };
        }
        return {
            content: `### 技能规范: ${skill.name}\n\n${skill.content}`,
            ok: true,
        };
    }
    /**
     * 解析用户输入文本，判断是否为内置斜杠命令或按需技能触发。
     */
    processPrompt(promptText) {
        const trimmed = promptText.trimStart();
        if (!trimmed.startsWith('/')) {
            return { type: 'normal', text: promptText };
        }
        const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
        if (!match) {
            return { type: 'normal', text: promptText };
        }
        const commandName = match[1].toLowerCase();
        const arg = (match[2] || '').trim();
        // 1. 判断是否为内置本地拦截命令
        if (commandName === 'help' || commandName === 'mode' || commandName === 'plan' || commandName === 'clear') {
            return {
                type: 'builtin',
                command: commandName,
                arg,
            };
        }
        // 2. 判断是否为挂载的自定义技能
        const skill = this.getSkill(commandName);
        if (skill) {
            const injected = [
                `[按需技能调用: ${skill.name}]`,
                '以下是该技能的具体执行指令与规范：',
                '```markdown',
                skill.content,
                '```',
                arg ? `用户补充任务：\n${arg}` : '',
            ]
                .filter(Boolean)
                .join('\n\n');
            return {
                type: 'skill',
                skillName: skill.name,
                processedText: injected,
            };
        }
        // 3. 其余未知斜杠命令作为普通输入
        return { type: 'normal', text: promptText };
    }
}
function parseSkillFrontmatter(folderName, text) {
    let name = folderName;
    let description = '本地扩展技能';
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch && fmMatch[1]) {
        const lines = fmMatch[1].split('\n');
        for (const l of lines) {
            const colon = l.indexOf(':');
            if (colon === -1)
                continue;
            const key = l.slice(0, colon).trim().toLowerCase();
            const val = l.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '');
            if (key === 'name' && val)
                name = val;
            if (key === 'description' && val)
                description = val;
        }
        return { name, description };
    }
    const titleMatch = text.match(/^#\s+(.+)$/m);
    if (titleMatch && titleMatch[1]) {
        description = titleMatch[1].trim();
    }
    return { name, description };
}
//# sourceMappingURL=skills.js.map