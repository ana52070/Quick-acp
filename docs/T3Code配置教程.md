# T3 Code 配置教程

把 quick-acp 接进 [T3 Code](https://t3.codes) 的完整方法。本文所有步骤都在 Windows 上实测走通，环境和结果见文末「实测记录」。

| 项目 | 实测环境 |
| --- | --- |
| T3 Code | 0.1.11（Beta），`E:\Programs\t3code\T3 Code (Beta).exe` |
| quick-acp | 0.1.8（npm 全局安装） |
| 系统 | Windows，Node.js 24.x（`E:\Nodejs\node.exe`） |

## 结论先说

T3 Code 目前**在 Windows 上无法通过界面接入 quick-acp**，需要手改配置文件并加一层兼容脚本。原因有两层，都是实测确认的：

1. **界面入口只认官方 ACP Registry。** 「添加 Provider」里的 ACP Registry 列出 46 个 agent，其中没有 quick-acp。界面另有 `Enter manually` 和 `Local ACP command` 两个入口，但：
   - `Enter manually` 走的是「填官方 registry ID」，quick-acp 不在 registry 里，填不进去；
   - `Local ACP command` 只有一个「Executable」输入框，而 T3 在 Windows 上**硬拒 `.cmd` / `.bat`**：

     ```text
     Local ACP commands launch without a shell. For a Windows batch wrapper, configure
     the underlying executable (for example node.exe) and pass the script path as an
     argument.
     ```

     而 npm 全局安装的 `quick-acp` 在 Windows 上只有 `quick-acp.cmd` 和 `quick-acp`（无扩展名的 sh 脚本）两个 shim，没有 `.exe`。要传「脚本路径作为参数」，就得填 `commandArgs`——但 `commandArgs` 在界面里是隐藏字段，UI 给不了。

2. **就算绕过第 1 层，直接接入仍会失败。** T3 会向 ACP agent 注入自带的 t3-code MCP 服务器（40 个工具，含 `preview_*`、`delegate_task`、`t3_thread_*` 等）。quick-acp 会把所有可用工具的**完整 JSON Schema** 拼进发给 Quick 网关的提示词，40 个 MCP 工具的 schema 约 93 KB，使网关侧的 `user_message` 帧达到 **100366 字节**，超过网关 64 KB 上限：

   ```text
   FrameTooLarge: This message is over the 64 KB size limit, so it was not sent.
   Try again with a smaller message.
   ```

   这个错误来自 Quick 网关，quick-acp 只是以 `-32603` 原样转发。

所以可用方案是：**手写 `settings.json` 配置 + 用兼容脚本在转发时剥掉 T3 注入的 MCP 服务器**。

## 前置条件

1. **T3 Code 已安装并至少运行过一次**，配置目录才会存在：
   - 配置文件：`C:\Users\<用户名>\.t3\userdata\settings.json`
   - T3 版本：`t3 --version` 或看安装目录里 exe 的文件版本
2. **quick-acp 已全局安装**：

   ```powershell
   npm i -g quick-acp@latest
   npm ls -g quick-acp --depth 0     # 确认版本
   ```

   记下 `main.js` 的实际路径，后面要填。全局安装时通常是：

   ```text
   <npm 全局目录>\node_modules\quick-acp\dist\main.js
   ```

   本机是 `E:\Nodejs\node_modules\quick-acp\dist\main.js`。
3. **Node.js 可执行文件路径**，用 `node.exe` 的绝对路径（本机 `E:\Nodejs\node.exe`）。

   为什么要填 node.exe 而不是 quick-acp：见上面「结论先说」第 1 条，Windows 上 `.cmd` shim 会被 T3 拒绝。

## 逐步配置

### 第 1 步：放好兼容脚本

把仓库里的 [`scripts/t3-acp-compat.mjs`](../scripts/t3-acp-compat.mjs) 复制到一个固定位置，例如：

```text
D:\vscode_project\quick_rea\quick_acp\scripts\t3-acp-compat.mjs
```

这个脚本做两件事：转发 ACP stdio 消息；把 `session/new` 里的 `mcpServers` 清空。

如果你的 quick-acp 不在默认路径，改脚本第 17 行的 `AGENT` 常量，或设置环境变量 `QUICK_ACP_ENTRY` 指向 `main.js`。

### 第 2 步：写 settings.json

先备份已有配置（首次配置时这个文件可能不存在，T3 用的是内置默认值）：

```powershell
$p = "$env:USERPROFILE\.t3\userdata\settings.json"
if (Test-Path $p) { Copy-Item $p "$p.bak" -Force }
```

然后写入以下内容，**路径按你的实际位置替换**：

```json
{
  "providerInstances": {
    "quick-acp": {
      "driver": "acpRegistry",
      "displayName": "Quick ACP",
      "enabled": true,
      "config": {
        "source": "local",
        "commandPath": "E:\\Nodejs\\node.exe",
        "commandArgs": [
          "D:\\vscode_project\\quick_rea\\quick_acp\\scripts\\t3-acp-compat.mjs"
        ]
      }
    }
  }
}
```

逐字段说明：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `providerInstances` 的键 | `quick-acp` | Provider 实例 ID，T3 要求匹配 `^[a-zA-Z][a-zA-Z0-9_-]*$`（最长 64 字符），界面和 CLI 里用这个名字 |
| `driver` | `acpRegistry` | ACP agent 都用这个 driver，即使 `source` 是 `local` |
| `displayName` | 任意 | 界面上显示的名字 |
| `enabled` | `true` | 启用 |
| `config.source` | `local` | 表示「跑本机可执行文件」，不走 registry 安装 |
| `config.commandPath` | `node.exe` 绝对路径 | T3 用它在 PATH 或绝对路径里解析可执行文件；必须是原生 exe，不能是 `.cmd`/`.bat` |
| `config.commandArgs` | 脚本路径数组 | 该字段在 UI 里是隐藏的，只能写配置文件；T3 用 `shell: false` 直接 spawn，不做 shell 展开 |

注意：写文件时用**无 BOM 的 UTF-8**。带 BOM 会让 T3 的 JSON 解析失败并回退到默认配置，表现是「配置写了但没生效」。

### 第 3 步：重启 T3 Code

**手改 settings.json 必须重启 T3 才生效。** T3 的 settings 缓存 TTL 是 infinity，没有文件监听，改完不重启读不到。

```powershell
Get-Process -Name "T3 Code (Beta)" | Stop-Process -Force
Start-Process "E:\Programs\t3code\T3 Code (Beta).exe"
```

重启后确认新进程起来了：

```powershell
Get-Content "$env:USERPROFILE\.t3\userdata\server-runtime.json"
```

看 `pid` 和 `startedAt` 是不是新的。

### 第 4 步：命令行验证

T3 自带 CLI，可以不起界面直接验证接入：

```powershell
$t3 = "$env:USERPROFILE\.t3\bin\t3.cmd"
cd <你的项目目录>
& $t3 thread start --provider quick-acp --model default --wait --json "." "请列出当前工作区根目录下的所有一级子目录"
```

要点：

- `--provider` 必须配 `--model` 一起用，否则报 `--provider and --model go together.`
- `--model` 填任意值即可（本机用 `default`）。quick-acp 不向 T3 声明模型列表，T3 对「不列模型的 provider」接受任意 slug。
- 位置参数是 `<project> <message>`，`"."` 表示当前目录所属项目；没添加过项目就先 `t3 project add <路径>`。

正常输出形如：

```json
{"threadId":"mcp:...","runId":"run:thread:...","status":"completed","reply":"当前工作区根目录下共有 6 个一级子目录：...","error":null}
```

看到 `status: completed` 且 `reply` 里有真实文件名，说明接入成功。

## 验证方法

按顺序做这几项，任一项失败就对照下一节排查。

| 验证 | 方法 | 期望 |
| --- | --- | --- |
| 版本对得上 | `npm ls -g quick-acp --depth 0` | 显示你装的版本 |
| 配置被读入 | 重启后看 T3 日志 `%USERPROFILE%\.t3\userdata\logs\server.trace.ndjson` 有无解析错误 | 无 `failed to parse settings.json` |
| ACP 握手 | 上面的 `t3 thread start` 命令 | `status: completed` |
| 工具真的在用 | 问一个需要读目录的问题（如「docs 目录下有哪些文件」） | 回复里的文件名、数量与磁盘一致 |
| 帧没超限 | 看 `%USERPROFILE%\.t3\userdata\logs\provider\events.<threadId>.log` | 有 `session/prompt succeeded`，不是 `failed` + `AcpRequestError` |

## 常见卡点

### 1. `FrameTooLarge: This message is over the 64 KB size limit`

**最常见。** 说明兼容脚本没生效，T3 注入的 MCP 工具被拼进了提示词。

确认 `commandArgs` 指向的是兼容脚本，而不是 `main.js` 本身。用兼容脚本时，网关帧约 15 KB；直接跑 `main.js` 时是 100366 字节。

排查时最直接的办法是看 `events.<threadId>.log`，失败会带堆栈：

```text
FrameTooLarge: This message is over the 64 KB size limit, so it was not sent.
    at QuickAcpAgent.oneGatewayTurn (.../dist/acp/agent.js:971:31)
```

注意这个错误**不是** quick-acp 的本地限制，是 Quick 网关返回的 `error` 帧，quick-acp 以 `-32603` 转发。

### 2. `Local ACP commands launch without a shell...`

`commandPath` 填了 `.cmd` 或 `.bat`。改成 `node.exe` 的绝对路径，脚本放到 `commandArgs`。

### 3. 配置写了但完全没生效

三种可能：

- 写了 BOM。用无 BOM UTF-8 重写。
- 没重启 T3。
- JSON 结构不合法（少逗号、`providerInstances` 层级写错）。T3 解析失败会静默回退到默认配置，只在 `server.trace.ndjson` 里留一条 warning。

### 4. `--provider and --model go together.`

CLI 要求两个一起给。补 `--model default`。

### 5. `Missing required argument: message`

位置参数顺序是 `<project> <message>`。只给一个字符串会被当成 project，然后报缺 message。

### 6. 会话能连上但回复是「未通过自动检查」之类

这是 Quick 网关侧的内容过滤，不是接入故障。换个说法重问即可。

### 7. 工具调用被截断但状态显示 completed

已知行为，与 T3 接入无关：quick-acp 的默认 12 次工具额度用完时会返回 `max_turn_requests`（T3 侧映射为未完成），但上游模型有时在额度内就用「把活干在一个文件里 + 声称做了没做的事」收尾。这类情况看实际产物，别只看 `status`。

## 与 Codeg 配置的差异

| 维度 | Codeg | T3 Code |
| --- | --- | --- |
| 配置入口 | 设置页可视化添加自定义 Agent | 只能手写 `settings.json`（Windows 上） |
| 配置位置 | `%APPDATA%\app.codeg\codeg.db` 的 `custom_agent` 表 | `%USERPROFILE%\.t3\userdata\settings.json` |
| 分发方式 | `npx` + 包名（如 `quick-acp@0.1.8`） | `local` + 可执行文件 + 参数数组 |
| 能否直接用 `.cmd` shim | 能（Codeg 用 shell 启动） | **不能**（`shell: false`，硬拒） |
| 参数配置 | 界面可填 args | UI 隐藏 `commandArgs`，必须写文件 |
| 改配置后 | 重启生效 | 重启生效（无文件监听，缓存 TTL infinity） |
| MCP 注入 | 不注入 | 注入 40 个 t3-code 工具，需兼容层剥离 |
| 会话记录位置 | `%APPDATA%\app.codeg\acp-transcripts\quick-acp\` | `%USERPROFILE%\.t3\userdata\logs\provider\` |
| 验证通道 | 会话页直接看 | `t3 thread start --wait --json` |

## 最容易踩的坑

按踩到的概率排序：

1. **以为界面里能配好。** Windows 上界面根本配不了，`.cmd` 被拒 + `commandArgs` 隐藏，必须改文件。这是最浪费时间的一条。
2. **只改配置不加兼容层。** 会被 MCP 注入的 93 KB schema 顶爆 64 KB 上限，报 `FrameTooLarge`，而错误信息看起来像是消息太长，很容易误判成自己的提示词写多了。
3. **改完配置不重启 T3。** 配置完全没生效，且没有任何提示。
4. **BOM。** 用 PowerShell 的 `Out-File` 或某些编辑器默认写 BOM，T3 静默忽略整个文件。
5. **`commandPath` 填 `quick-acp`（无扩展名那个）。** 那是给 sh/Cygwin 用的脚本，Windows 原生 spawn 起不来。

## 已知限制

- T3 的 MCP 工具（`preview_*` 浏览器、`delegate_task` 委派、`t3_thread_*` 线程操作、`html_render` 等）在 Quick 会话里不可用，被兼容层剥掉了。本地文件读写与 shell 执行正常。
- T3 的 `Enter manually` / `Local ACP command` 界面入口对 quick-acp 不可用，配置只能手改。T3 升级后若 `settings.json` schema 变动，需要跟进调整。
- 该方案未经 T3 官方支持，属于用户侧变通。

## 实测记录

本节记录本文档每条结论的实证来源，原始证据在 `.dispatch/t3-code`。

**接入链路验证（全部通过）：**

| 验证 | 结果 |
| --- | --- |
| ACP `initialize` 握手 | 成功，`protocolVersion: 1`，quick-acp 声明 `loadSession` 与图片输入 |
| `session/new` | 成功，返回 sessionId 与 fast/balanced/smart 三档 mode |
| 工具调用真实生效 | 问「docs 目录下有哪些文件」→ 返回 15 个真实文件名；问「src 下有多少 .ts」→ 回复 34，磁盘实测 34 |
| 会话结束状态 | `status: completed`，`error: null` |

**根因证据：**

- 直接用 `main.js` 时，发给网关的 `user_message` 帧为 **100366 字节**，网关返回 `FrameTooLarge`。
- 加兼容层后，同一条提示的帧降到约 **15 KB**，正常返回。
- 剖面：本地 8 个工具 schema 约 7 KB；T3 注入的 40 个 MCP 工具 schema 约 93 KB（工具清单见 `.dispatch/t3-code/gateway-frame-T3.log`）。
- 把同一份 ACP 帧（含 T3 的双段 prompt、`traceId`、`T3_ACP_MCP_*` 环境变量、`cwd`）原样回放到 quick-acp，不走 T3 时**成功**——证明失败点是 MCP 注入带来的帧膨胀，不是 T3 的协议用法、环境变量或工作目录。

**未通过的项（如实记录）：**

两次让 Quick 在 T3 里做「小项目 + 测试 + 冒烟 + 回读三件套」的验收未完整闭环：

- 第一次：只写了 `todo.py`（10 项 unittest 实测通过），未写 README 和验收记录，但 `status: completed`。
- 第二次：只写了 `textstats.py` 和 `sample.txt`，未写 README 和验收记录，且实现里没有要求过的 `--self-test` 参数，回复却声称测试通过。

两次都只有 3 次工具调用，远未触及 12 次额度上限，属于上游模型提前收尾，与 T3 接入、与 quick-acp 的工具预算机制均无关（后者在 Codeg 的会话 824/827/828 已验证）。因此本文档只主张「接入可用、工具调用真实生效、会话状态正常」，不主张「T3 环境下小项目能一次做完」。
