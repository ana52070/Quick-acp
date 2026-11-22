# quick-acp

一个 **ACP agent**，把 AWS Quick（Quickwork）的 Claude 额度接进任何支持 ACP 的客户端（codeg、T3Code、Zed…），并补上本机 shell 执行能力。

```
codeg / T3Code  ──ACP (JSON-RPC over stdio)──▶  quick-acp  ──Quick bidi (WSS)──▶  Quick 网关
                                                     │
                                                     └── 本机执行 shell / 文件工具
```

**不需要安装 Quick 桌面客户端。** 一次浏览器登录即可。

---

## 它能给你什么

1. **在 codeg 里用 Quick 的 Claude 额度**——Quick 变成 codeg 里的一个 agent，Smart 档位可命中 Opus
2. **补上本机 shell 执行**——Quick 自己不给客户端这个能力
3. **思考流和图片都保留**——`thinking_delta` → `agent_thought_chunk`，图片附件透传
4. **支持多开**——codeg 里开两个对话 = 两条独立 WSS + 两个独立 Quick thread，互不干扰

> **免责声明**：本项目通过逆向分析实现与 Quick 服务的互通，仅用于个人学习与自用。使用它可能违反 Quick 的服务条款，风险自负。请勿用于商业分发。

---

## 验证状态（哪些测过，哪些没有）

| 项目 | 状态 | 依据 |
|---|---|---|
| 编解码 / 工具 / ACP 接线 | ✅ 已测 | `npm run verify`（39 项） |
| 从 Windows 凭据库读登录态 | ✅ **实测** | 读出 refresh_token/client_id/client_secret |
| **WSS 连接握手** | ✅ **实测** | 收到 `session_established` |
| **网关鉴权方式** | ✅ **实测** | query 可行、header 401 |
| **长连接保活** | ✅ **实测** | 发 ping 后 60s 无 `IDLE_TIMEOUT` |
| **`user_message` → 真实回复** | ✅ **实测** | `resolved_model_id: us.anthropic.claude-opus-5-5` |
| **端到端 ACP → Quick → 模型 → ACP** | ✅ **实测** | `npm run e2e` |
| **自己刷新 token** | ✅ **实测** | `oidc.us-east-1.api.aws` + Basic auth → 200 |
| **完全不用 outpost** | ✅ **实测** | `npm run e2e:no-outpost` |
| **无官方客户端的真实登录** | ✅ **实测** | `npm run e2e:fresh`：浏览器登录 → 直连 → 模型回复 |
| **`inject` 工具循环** | ✅ **实测** | `npm run test:tools`：模型发工具调用 → 本地执行 → 最终答案 |
| **多轮连续对话** | ✅ **实测** | 连续 3 轮全部正确（曾是真 bug） |
| **思考转发** | ✅ **实测** | `thinking_delta` → `agent_thought_chunk`（曾完全失效） |
| **图片附件** | ✅ **实测** | 发一张 crimson PNG，模型答「红色」 |
| **并发多会话** | ✅ **实测** | 两个 session 同时提问，各自答对，无串话 |
| 原生 MCP 工具通道 | ⚠️ **需桌面端** | 见「MCP 分支」 |

**关键实测：** 全链路已打通，**并且不需要官方桌面客户端**。

```
*** FRESH MACHINE END-TO-END SUCCESS ***
*** browser sign-in -> OIDC refresh -> gateway -> model -> text ***
*** no Quick install, no outpost, no Electron, no keychain entry ***
```



---

## 安装

需要 Node ≥ 22。

```bash
npm install
npm run build
npm run verify     # 38 项检查
```

---

## 登录：两条路，都不用手抄 token

### 路线 A：已经装过 Quick 桌面端并登录过

**什么都不用做。** 直接跑，quick-acp 自己读：

```
LegacyGeneric:target=quickwork-social-<profileId>         ← 元信息（块数、校验）
LegacyGeneric:target=quickwork-social-<profileId>_chunk_0 ← 含 refresh_token 的 JSON
LegacyGeneric:target=quickwork-social-<profileId>_chunk_1
```

读完自己刷新 token，然后直连网关。**不需要 outpost，不需要 instance token，不需要 Electron。**

### 路线 B：从没装过官方客户端

```bash
node dist/login-cli.js --start-url https://ssoins-xxxxx.awsapps.com/start
```

`--start-url` 是你的 **AWS access portal 地址**。从哪来：

1. 打开 `https://quicksight.aws.amazon.com`（或任意 AWS 控制台）登录
2. 浏览器会落到你的 access portal，地址栏形如 `https://ssoins-1a2b3c4d5e6f.awsapps.com/start`
3. 把整个地址复制过来

然后浏览器会打开 AWS 登录页，登录完写 `~/.quick-acp/login.json`（0600 权限）。之后直接跑，不用再登录。

### 这条登录链是怎么打通的

Quick 自己的客户端就是个**标准 OAuth 授权码 + PKCE 公共客户端**。证据是它存在凭据库里的 `client_secret` —— 那东西其实是个明文 JWT，解开就是：

```json
{"clientType":"PUBLIC",
 "enabledGrants":{
   "AUTH_CODE":{"redirectUris":["http://127.0.0.1:18080"]},
   "REFRESH_TOKEN":{...}},
 "scopes":[{"fullScope":"quicksight:read_write"}]}
```

所以就照标准流程走：

| 步骤 | 端点 | 实测结果 |
|---|---|---|
| 动态注册客户端 | `POST oidc.us-east-1.api.aws/client/register` | ✅ 200，返回 `clientId` + `clientSecret` |
| 授权（PKCE S256） | `GET /authorize` | ✅ 302 → AWS 登录页，带 `identitystore_id` |
| 浏览器回调 | `http://127.0.0.1:18080?code=...` | ✅ 拿到 code |
| 换 token | `POST /token`（**表单字段**） | ✅ 200，拿到 access + refresh |
| 刷新 token | `POST /token`（**Basic auth**） | ✅ 200 |

**两处必须记牢，弄反就 400：**

| 操作 | `client_secret` 放哪 |
|---|---|
| `authorization_code` 换 token | **表单字段**（和 `client_id` 一起放 body）|
| `refresh_token` 刷新 | **HTTP Basic**（`client_id:client_secret` 放 header）|

放反了两边都是 400，而且报错只说 "Invalid request"，什么都不告诉你。这个坑我在开发时踩了两次。

### 更正：之前报告里说"自己刷新 token 不行"是错的

那份报告的结论基于这两次失败：

| 端点 | 结果 |
|---|---|
| `identitycenter.amazonaws.com/<instance>/token` | 403 |
| `oidc.<region>.amazonaws.com/token`（表单） | 400 |
| `oidc.<region>.amazonaws.com/token`（JSON） | 401 invalid_client |
| `<instance>.<region>.portal.amazonaws.com/token` | 404 |

**原因是查询的域名全是旧的。** 正确的是 `oidc.<region>.api.aws`。而且 `client_secret` 要放 Basic auth 而不是 body。

换成正确域名 + Basic auth，一次就 200。所以 outpost 不是必需的——它现在只是 B 计划。

### 环境变量

**全部可选。** 正常使用一个都不用设 —— 工作目录来自 ACP 客户端（你在客户端里选的那个文件夹）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `QUICK_ACP_ALLOW_SHELL` | 开 | 设 `0` 关闭命令执行 |
| `QUICK_ACP_WORKSPACE` | 客户端传来的 cwd | **一般不用设**。仅在客户端不传 `cwd` 时作为兜底 |
| `QUICK_ACP_MAX_TOOL_ROUNDS` | `12` | 单轮最多几次工具调用 |
| `QUICK_ACP_DEBUG` | `0` | 详细日志到 stderr |
| `QUICK_ACP_FRAMING` | `json-base64` | 帧格式。**默认就是对的**，别乱改：`cbor` 会让服务端静默丢消息 |
| `QUICK_ACP_START_URL` | unset | 登录用的 portal 地址，等价于 `--start-url` |
| `QUICK_ACP_TENANT_URL` | 自动发现 | 网关 host。登录后自动从 `profiles.json` / outpost 找回 |

### 自检

```bash
node dist/doctor.js                    # 看凭据状态
node dist/no-outpost-e2e.js            # 不用 outpost 跑一轮真实对话
```

---

## 接入 codeg / T3Code

### codeg（自定义智能体）

「添加自定义智能体」里，分发信息填 **npx**：

```json
{
  "npx": {
    "package": "quick-acp@latest",
    "args": []
  }
}
```

**环境变量不用填。** 工作目录来自你在 codeg 里选的项目文件夹。

### 其他 ACP 客户端

通过 stdio 启动，命令是 `npx quick-acp`（或本地 `node dist/main.js`）：

```json
{
  "quick": {
    "command": "npx",
    "args": ["-y", "quick-acp@latest"]
  }
}
```

**不需要 `QUICK_ACP_INSTANCE_TOKEN`。** 登录态来自凭据库或 `~/.quick-acp/login.json`，走直连路径。

**诊断信息只走 stderr。** stdout 是 JSON-RPC 通道，一行 `console.log` 就会把协议搞坏。

---

## 模式映射（这就是"选模型"）

Quick 不让人直接选模型，只有档位。ACP 的 mode 直接映射过去：

| codeg 里选 | 实际发给 Quick | 效果 |
|---|---|---|
| **Fast** | `agent_mode: fast` | 最快，不思考 |
| **Balanced** | `agent_mode: balanced` | 平衡 |
| **Smart** | `agent_mode: smart` | 最高质量 + 深度思考，**最容易命中 Opus** |

想用 Opus 就选 **Smart**。具体用哪个模型由 Quick 服务端决定，会在 `token_usage.resolved_model_id` 里回报。

`session/set_model` 会被明确拒绝——因为 Quick 不支持，假装成功等于骗你。

---

## 工具

### 为什么不重复造文件工具

Quick 自己**已经有**文件读写/搜索/`apply_patch`（`desktop_windows.yaml` 是 `default_available: true`）。**真正缺的是本机 shell。**

所以这里提供的工具：

| 工具 | 理由 |
|---|---|
| `shell_run` | **真空缺**。Quick 的 `device_shell` 卡在 `code_mode_enabled` + `deviceShell` + `sandbox.available` 三重门上 |
| `file_read` / `file_write` / `file_list` / `file_search` | 保留：本机执行比绕 Quick 的 agent 循环省一整轮 |

### 安全边界

- **命令执行默认开启**（`QUICK_ACP_ALLOW_SHELL=0` 可关）
- 拦破坏性命令：`rm -rf /`、`mkfs`、`dd of=/dev/`、`sudo`、`curl | sh` 等
- **没有文件夹禁锢** —— 理由见下
- 输出有大小上限，写入有大小上限，命令有超时

**为什么不做文件夹禁锢**：`shell_run` 本来就能 `cd` 到任何地方、读写任何文件。只给文件工具加目录限制，等于拦住了方便的路径却留着强力的路径，只会让「读一下隔壁文件夹那个文件」这种正常请求失败，换不来任何实际安全。所以要么整体禁 shell，要么就都放开。

相对路径按客户端选的工作目录解析，绝对路径直接用。

### 工作方式

把工具定义写进 prompt，让模型输出带标记的代码块，本地执行后把结果当下一轮用户消息喂回去：

```quick-tool-call
{"name": "shell_run", "arguments": {"command": "dir"}}
```

- ✅ **不需要 outpost、不需要 instance token、不需要桌面端**
- ✅ 全新机器登录完就能用
- ❌ 每次工具调用多一整轮对话
- ❌ 靠模型遵守格式，不是协议保证

实测（`npm run test:tools`）：模型会规范输出这个块，工具本地执行，然后给出最终答案。

### 关于原生 MCP

理论上可以让模型**原生调用**工具（零额外轮次、不依赖模型写 JSON）。这条路实现在 **`mcp-native` 分支**，没有合并进来，原因很实在：启用本地 MCP server 要过两道门，**都在 Quick 桌面端**。

参考：想自己研究的话，`mcp-native` 分支里有完整的逆向记录和待解决的三个环节。

---

## 已知局限

这些是架构决定的，不是 bug：

1. **不能重放历史。** Quick 服务端按 thread 存上下文，客户端只发增量。所以 `loadSession: false`，新会话就是新 thread。
2. **不能指定模型。** 只能选档位。`session/set_model` 明确拒绝。
3. **额度按 `agent_hours` 计。** 不是按 token。长时间输出会快速消耗月度额度。
4. **同一会话内串行。** Quick thread 是一问一答的流。但**多个会话可以并行**——每个 ACP session 一条独立 WSS。
5. **音频不支持。** 图片和文本可以。`promptCapabilities.audio: false`。

---

## 目录结构

```
src/
  quick/
    codec.ts         CBOR + event-stream + Quick 帧（两种模式）
    auth.ts          会话获取（直连 → outpost → 明确报错）
    credstore.ts     Windows 凭据库读取（分块重组）
    login.ts         真实登录：动态注册 + PKCE + 换 token + 刷新
    session-direct.ts 不用 outpost，从登录态直接拼会话
    transport.ts     WSS 拨号、握手、看门狗、token 刷新
    session.ts       thread 模型、增量流、附件
    gateway-contract.ts 实测出来的网关常量（有测试断言）
  tools/
    registry.ts      工具定义与执行
    strategies.ts    prompt 注入式工具循环
  acp/agent.ts       ACP Agent 实现
  main.ts            ACP 入口
  login-cli.ts       登录命令行
  probe.ts           编解码 / 工具 / 工具契约检查
  acp-smoke.ts       5 项 ACP 接线检查
  e2e.ts             端到端（ACP → Quick → 模型 → ACP）
  no-outpost-e2e.ts  端到端（不走 outpost）
  fresh-machine-e2e.ts 端到端（模拟全新机器，纯浏览器登录）
  inject-turn-test.ts  多轮对话 + 工具循环回归（这两个都曾是真 bug）
  concurrent-test.ts   两个会话并发，检查不串话
```

---

## 已知未完成

**原生 MCP 工具通道需要 Quick 桌面端。** 不开桌面端也能用（走 `inject`），只是每次工具调用多一轮。

这不是"技术不可能"，而是**当前桥接没有实现独立的权限初始化与确认链**。要让 MCP 完全不依赖桌面端，需要补三样东西：

1. 自己触发组织策略解析（`admin controls`），让 `permissions_pending` 解除
2. 自己实现命令确认的用户交互（替代 Electron 的原生对话框）
3. 走通工具发布到云端的环节

前两步是工程问题，第三步还没找到接口。所以现状是：**MCP 保留为可选增强，`inject` 作为默认。**

顺带记一个容易误判的点：`permissions_pending` 和 `Invalid or missing confirmation nonce` 是**两道独立的门**，通常先撞前者。桌面端日志证明前者确实会自己解除：

```
18:37:29  [OutpostServer] admin controls unresolved after 30.0s; MCP mutations remain pending
18:37:47  [OutpostBoot]   local_mcp_connect gate=resolved gate_wait_ms=0


---

## 实测出的协议真相（和代码里写的不一样）

逆向读到的和网关实际接受的**有三处不一致**，不实测根本发现不了：

### 1. 鉴权必须在 query，不能在 header

| 方式 | 结果 |
|---|---|
| `Authorization: Bearer <jwt>` | **401** |
| `?token=<jwt>` | **OPEN** |

渲染层 `IZe()` 确实往 header 里塞 Bearer，但那是走主进程 IPC 代理的路径。用裸 `ws` 客户端发同样的 header 会被拒。

**这是最容易踩的坑：拿着有效 token 却一直 401。**

### 2. `surfaceType` 是必填 query 参数

没有它，即使 token 正确也是 401。加上 `?surfaceType=QUICK_WORK_DESKTOP_WINDOWS` 才通过。

### 3. 路径是 `/streaming/...` 不是 `/ws/service/...`

| 路径 | 结果 |
|---|---|
| `/streaming/quickwork-chat-bidirectional-stream` | 401（路径对，鉴权错）→ 修好鉴权后 OPEN |
| `/ws/service/SpaceNeedleConversationService/operation/...` | **404** |

### 4. 服务端 95 秒无帧就断

```
{"type":"error","code":"IDLE_TIMEOUT","message":"Client sent no frames for >95 seconds"}
```

必须定时发 `ping`。代码里用 45 秒。

### 5. `connected` 帧不是对话前置条件

它属于 WebRTC 语音路径（`LiveConversationWebRtcClient*`），聊天不等它。没有它不代表有问题。

### 6. **不能用 `turn_usage` 判断一轮结束**（这条坑最隐蔽）

`turn_usage` 比真正的结束早到几百毫秒。如果拿它当结束信号、立刻发下一条消息，服务端还在收尾，会把新消息当成上一轮的回显吞掉：

```json
{"type":"message_complete","payload":{"text":"","initiator":"user"}}
```

实测对照（同一条 socket）：

| 场景 | 结果 |
|---|---|
| 连续发两轮 | 第 2 轮空 |
| 连续发三轮 | 第 2 轮空，**第 3 轮拿到第 2 轮的答案** |
| 两轮之间等 2.5 秒 | 两轮都正常 |

第 3 轮拿到 T2 这说明消息**只是排队，没有丢**。正确做法是等 `message_complete` 才关流，`turn_usage` 只用来报告用量。

这个 bug 影响每一次多轮对话，不只是工具调用，但单轮 e2e 测试完全测不出来。

### 7. 服务端工具事件叫 `tool_result`，不是 `tool_end`

`tool_end` 在这个协议里根本不存在——那是第一版猜的名字，会静默匹配不到任何东西。真实名字见渲染层 `case 'tool_result'`。

这些都写进了 `src/quick/gateway-contract.ts`，并有测试断言。

---

## 跑通它

**不需要复制任何 token。** 直接：

```bash
set QUICK_ACP_ALLOW_SHELL=1
set QUICK_ACP_DEBUG=1
node dist/main.js
```

`main.js` 会自动完成：读凭据 → 刷新 token → 直连网关 → 接 ACP。

看 stderr：

- `[quick-acp:ws] connecting to …` 然后 `open` → 网关通了
- `[quick-acp] MCP server registered and enabled (id …)` → 原生工具通道通了
- `[quick-acp] falling back to prompt-injected tools …` → 没桌面端，工具走 inject
- `[quick-acp] outpost not available: …` → 明确告诉你缺什么

### 只想看它到底能不能跑

```bash
node dist/e2e.js              # 端到端：ACP prompt → Quick → 模型 → ACP chunk
node dist/inject-turn-test.js # 多轮对话 + 工具循环回归
```

看到 `*** END-TO-END SUCCESS ***` 和 `all multi-turn checks passed` 就是全链路通了。

