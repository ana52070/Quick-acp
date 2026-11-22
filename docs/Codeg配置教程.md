# Codeg 配置与使用指南

Quick-acp 0.1.8 包含默认本机路由保护、心跳看门狗长任务保活、错误码规范化、连接竞争隔离与工具调用额度耗尽状态规范。在 Codeg 中，**推荐固定版本 `quick-acp@0.1.8` 通过 npx 分发**，安装简便且具备确定性版本保障；若需二次开发或本地协议调试，可选用源码本地方案。

---

## 一、Codeg 代理配置

### 方式一：npx 分发配置（首选推荐）

在 Codeg 的自定义代理设置（**Settings → Agents → Add custom agent**）中填写：

```json
{
  "npx": {
    "package": "quick-acp@0.1.8",
    "args": []
  }
}
```

若 Codeg 界面提供的是 command / args 形式：

```json
{
  "command": "npx",
  "args": ["-y", "quick-acp@0.1.8"],
  "env": {
    "QUICK_ACP_ALLOW_SHELL": "1",
    "QUICK_ACP_PERMISSION_MODE": "auto",
    "QUICK_ACP_MAX_TOOL_ROUNDS": "12"
  }
}
```

> **实测记录**：0.1.8发布前同代码热同步构建已通过两轮验收：会话824超额后明确未完成；会话825在9次本机调用内完成7项自测、冒烟与三文件自主回读。正式发布包重装后的默认提示复验另行记录。

---

### 方式二：本地源码运行配置（次选，本地二次开发）

从源码构建运行时，先在项目根目录执行：

```bash
npm ci
npm run build
```

在 Codeg 的自定义代理配置中指向本地构建产物：

```json
{
  "command": "node",
  "args": ["D:/projects/quick-acp/dist/main.js"],
  "env": {
    "QUICK_ACP_ALLOW_SHELL": "1",
    "QUICK_ACP_PERMISSION_MODE": "auto",
    "QUICK_ACP_MAX_TOOL_ROUNDS": "12"
  }
}
```

> **注意**：
> - 请将上述路径替换为你本机的实际绝对路径，Windows 路径建议使用正斜杠（`/`）。
> - 若 `node` 未在系统 GUI PATH 中，请填写 `node` 可执行文件的完整绝对路径。
> - 项目工作区目录由 ACP 协议握手时的 `session/new.cwd` 传入，无需在此硬编码。

---

## 二、运行环境与登录要求

### 1. Node.js 版本要求
- 必须使用 **Node.js ≥ 22**（可在终端运行 `node -v` 核对）。
- 运行时依赖 Node 原生 ES Module 与现代异步流处理特性。

### 2. Quick 账号登录
Quick-acp 支持两种凭据获取方式：

1. **自动读取官方桌面端凭据（推荐日常使用）**：
   本机若已安装并登录 AWS Quick 官方桌面端，Quick-acp 会自动从系统凭据管理器（Windows Credential Manager / macOS Keychain）读取凭据，无需手动重复登录。
2. **免桌面端浏览器单点登录（CLI 独立登录）**：
   在无官方桌面端的设备上，直接通过 CLI 唤起浏览器完成 SSO 登录：
   ```bash
   # npx 安装方式
   npx -y quick-acp-login --start-url https://<你的SSO入口>.awsapps.com/start

   # 源码环境方式
   node dist/login-cli.js --start-url https://<你的SSO入口>.awsapps.com/start
   ```
   凭据将以 `0600` 权限安全保存在本地用户目录（`~/.quick-acp/login.json`）。

> **安全须知**：`~/.quick-acp/login.json` 包含敏感刷新令牌，**切勿填入 Codeg 分发配置或提交到公开代码仓库**。

### 3. 运行环境自检
登录后可运行自检命令确认凭据有效性与系统可用性：

```bash
# npx 方式
npx -y quick-acp doctor

# 源码环境方式
npm run doctor
```

---

## 三、环境变量配置

| 环境变量 | 默认值 | 作用与说明 |
|---|---|---|
| `QUICK_ACP_ALLOW_SHELL` | `1` | 是否启用本地命令行执行工具 `shell_run`（`1` 开启，`0` 关闭） |
| `QUICK_ACP_PERMISSION_MODE` | `auto` | 权限审批模式：`auto` 自动放行；`ask` 敏感操作弹窗请求用户审批，无连接时 fail-closed 拒执行 |
| `QUICK_ACP_SESSIONS_DIR` | `~/.quick-acp/sessions` | 本地会话持久化与转录记录存储目录 |
| `QUICK_ACP_MAX_TOOL_ROUNDS` | `12` | 单回合对话工具多轮调用的最大上限（包含失败调用）。达到上限且任务未竟时返回 `max_turn_requests` 明确提示未完成，并输出中文进度说明；超大多步骤任务可增大此环境变量覆盖默认值 |
| `QUICK_ACP_HEADLESS` | `0` | 是否为无头运行环境（`1` 时判定为非交互环境，关闭交互提问工具） |
| `QUICK_ACP_TURN_TIMEOUT_MS` | `180000` | 单轮网关等待超时上限（毫秒），取消立即唤醒本地等待 |

> **配置项纠正说明**：
> 早期文档中提及的 `QUICK_ACP_MAX_RETRIES` 经源码审计**并未在代码中实现读取**。网络错误重试采用代码内置的 `DEFAULT_RETRY_POLICY`（最多 3 次指数退避，仅在未产生副作用且未流式输出正文时重试）。文档已据实移除该无用环境变量。

---

## 四、核心功能与协议边界

### 1. 会话恢复与分叉 (Load / Fork)
- **本地持久化**：会话状态、轮次与工具卡片均以原子写入方式留存在本地磁盘（`~/.quick-acp/sessions/<sessionId>.json`）。
- **会话恢复 (`session/load`)**：恢复历史上下文，并续接上游原 Quick threadId。首轮自动注入历史摘要，防止上游线程过期时模型失忆。
- **会话级分叉 (`session/fork`)**：基于父会话已有的全部历史 turns 生成新会话，并派生全新独立的上游 Quick 线程。
- **边界说明**：当前分叉为**会话级全量历史派生**，**不支持在对话树任意历史 turn 节点任意回退分叉**。

### 2. 会话级 MCP 挂载 (stdio / HTTP / SSE)
- 客户端在 `session/new` 时传入 `mcpServers`。
- 本地进程直连外部服务，工具自动附加命名空间前缀 `mcp__s<会话序号>_<服务名>__<工具名>`，防止服务间工具名称冲突。
- **生命周期与取消边界**：
  - 用户在单轮生成中点击取消（`session/cancel`），仅中断当前轮次推理与本地工具执行，**绝不关闭 MCP 服务**。
  - MCP 服务保持挂载状态，后续对话轮次仍可正常调用。
  - 只有在会话彻底销毁或关闭（客户端断开、进程退出、重新 load 覆盖旧会话）时，才会清理 stdio 子进程树或发送 HTTP DELETE 请求。

### 3. 斜杠命令与本地 SKILL 扩展
- **内置命令**：`/help`、`/mode`、`/plan`、`/clear` 由代理本地拦截直接返回，不调用上游大模型，不消耗配额。
- **本地技能发现**：启动时检索工作区及用户目录下的 `SKILL.md`（支持 `.gemini/skills/`、`.agents/skills/`、`skills/`），自动注册为斜杠命令；调用时按需提取并注入提示词。
- 提供 `skill_read` 工具供模型自主查阅技能详情。

### 4. 任务执行计划 (Plan Update)
- 模型可通过 `plan_update` 工具动态更新任务步骤状态（`pending` / `in_progress` / `completed`）。
- 状态更新通过标准 ACP `sessionUpdate: 'plan'` 实时同步至客户端 Plan 状态卡片。

### 5. 权限审批与交互式提问
- 当 `QUICK_ACP_PERMISSION_MODE=ask` 时，写文件、执行 Shell 以及所有 MCP 外部工具在执行前会拉起 `session/request_permission` 弹窗；用户拒绝后立即中止执行，无任何副作用。
- **交互提问 (`ask_user_question`)**：模型在面临决策分支时可主动向用户提问。
  - **边界说明**：底层映射为 ACP `session/request_permission` 的选项列表（`kind: 'allow_once'`）。当前 ACP SDK 0.4.5 规范仅支持单选项按钮选择与取消，**不支持多选框或自由文本输入**。

### 6. 工具调用额度与耗尽状态管理 (0.1.8)
- **额度计算原则**：单回合默认额度为 12 次，无论工具执行成功或失败均计入调用次数，防止死循环无限消耗。
- **耗尽状态规范**：模型仍有调用意图但额度耗尽时，返回 `stopReason: 'max_turn_requests'` 而非 `end_turn`，Codeg 等客户端将明确呈现未完成状态，不会被误标为 `completed`。
- **中文未完成提示**：截断时向对话流输出包含已调用数、最后工具及执行状态、下一步待执行操作的结构化中文提示。
- **审计与取消保护**：已执行工具审计卡片完整落盘；用户取消优先中断，不为未执行工具生成卡片；额度内自然收尾返回 `end_turn`，不重复正常答案。

---

## 五、测试验证

```bash
# 1. 运行 19 项全套核心与进阶能力离线回归（无网络依赖）
npm run test:regression

# 2. 运行离线 ACP stdio 全流程集成测试（含 Mock 网关）
npm run test:integration

# 3. 运行完整离线套件（包含构建、握手探测、冒烟、19项回归、9项路由、10步集成与5项根因专项）
npm test

# 4. 运行真实 Quick 网关端到端贪吃蛇验收（需有效登录凭据与 Python 3.10+ pygame）
python -m pip install -r examples/snake/requirements.txt
npm run test:live
```

---

## 六、常见问题排查

| 现象 | 原因分析 | 处理方案 |
|---|---|---|
| Codeg 安装后仍运行旧版本 | npx 缓存或本地构建未更新 | 确认配置填写为固定版本 `quick-acp@0.1.8`；源码环境重新执行 `npm run build` 并新建会话 |
| 任务复杂时提示工具额度耗尽 | 单轮工具调用达到上限（默认 12 次，包含失败调用） | 此为防止死循环的正常截断保护（返回 `max_turn_requests` 并给出中文进度与下一步建议）。可在环境变量中增加 `"QUICK_ACP_MAX_TOOL_ROUNDS": "20"` 调大额度，或拆分为多步交互 |
| 启动报 `node: command not found` | GUI 进程缺少环境变量 PATH | 在 Codeg 配置的 `command` 中填写 `node` 可执行文件的绝对路径（如 `C:/Program Files/nodejs/node.exe`） |
| Node 版本报错 | 运行环境低于 Node 22 | 升级 Node.js 至 22.0.0 或更高版本 |
| 登录失效或报 401 | 凭据过期或未登录 | 运行 `npm run doctor` 检查；通过 `quick-acp-login` 重新登录 |
| 任务执行超过 70 秒报认证失败 | 旧版本心跳看门狗误杀与错误码误判 | 升级至 `quick-acp@0.1.8`，已内置业务流保活并将普通错误码规范为 -32603 |
| 偶发网络断连 | 上游 WebSocket 连接抖动 | 系统内置针对 ECONNRESET/429/502/503 的指数退避重试（最多 3 次）；若轮次已产生写操作则安全阻断重试以防副作用 |
| 希望关闭 Shell 工具 | 安全考量限制命令执行 | 在配置的 `env` 中添加 `"QUICK_ACP_ALLOW_SHELL": "0"` |
| 敏感操作希望弹窗确认 | 生产环境防误操作 | 在配置的 `env` 中添加 `"QUICK_ACP_PERMISSION_MODE": "ask"` |
| 提问工具无法输入文字 | 协议能力边界 | 当前版本提问工具基于 ACP 权限选项设计，仅支持单选按钮，不支持自由文本表单 |

---

## 七、版本演进与提示词约定

### 1. 0.1.8 工具额度耗尽状态规范
在 0.1.8 版本中，针对多工具复杂长任务，解决了 0.1.7 中额度耗尽仍返回 `end_turn` 导致 Codeg 客户端将未完成任务误标为已完成的问题（TOOL-BUDGET-001）。保留默认 12 次调用额度（失败调用亦计入额度），额度耗尽且任务未竟时返回 `max_turn_requests` 并输出中文未完成提示与当前进度，支持通过 `QUICK_ACP_MAX_TOOL_ROUNDS` 环境变量调整上限。发布前同代码热同步构建已通过会话824的超额未完成验收与会话825的额度内正常完成、自主回读验收；正式包重装后复验另行记录。

### 2. 0.1.7 默认提示即用与长任务保活
在 0.1.7 版本中，已内置了默认本机路由引导、原生设备工具拦截取消机制、业务入站保活（解决 75 秒看门狗本地误杀）以及标准错误码映射（-32603）。用户在 Codeg 中发送普通开发提示词即可直接调用本机文件与 Shell 工具推进任务，无需额外附加“限定 quick-tool-call 本机通道”等规避提示词。

### 3. 0.1.5 / 0.1.6 历史演进背景（供排查参考）
- **0.1.5 历史通道约束**：在 0.1.5 版本中，由于未内置路由引导，偶发可能被上游误分发至云端设备工具导致等待。当时通过在提示词中附加“只使用本机适配器的 quick-tool-call 文本工具通道”作为临时使用约束；
- **0.1.6 超时与拦截配置**：0.1.6 起引入了 `QUICK_ACP_TURN_TIMEOUT_MS`（默认 180000 毫秒）用于单轮等待上限，并增加了设备工具主动取消与失败收尾。
