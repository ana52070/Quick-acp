# Quick-acp 打包、CI 与发布指南

本指南为开发者与项目维护者提供关于项目本地开发、离线测试、打包校验、持续集成 (CI) 以及版本发布的标准执行规范与边界说明。

---

## 一、版本与环境现状声明

### 1. 当前版本
- **维护版本**：`quick-acp@0.1.8`，包含工具额度耗尽状态规范（TOOL-BUDGET-001）、认证错误码规范化与连接保活修复。
- **运行时一致性**：核心运行时文件与本地验证基准保持哈希一致。

### 2. 发布前验证证据与界定（重要界限）
- **历史验证**：0.1.7发布前同代码构建完成会话818单轮验收；正式0.1.7会话820及授权补回读记录保留在相应版本文档。
- **0.1.8发布前验证**：全套测试与真实网关存活探针通过；同代码热同步构建在Codeg会话824正确截断超额任务、在会话825正常完成并自主回读。正式发布包重装后的复验另行记录，详见0.1.8更新说明。

### 3. 历史产物与指纹凭据说明
- 历史归档 `.dispatch/release-complete/quick-acp-0.1.5.tgz` 及其 SHA1/Integrity 指纹保留作为 0.1.5 历史发布证据；0.1.7 发布归档及记录亦完整保留作为历史对照，切勿批量替换或将其与 0.1.8 产物混淆。

---

## 二、源码开发与测试执行

### 1. 开发环境要求
- **Node.js**：必须满足 `Node.js >= 22`。
- **包管理器**：推荐使用 npm。

### 2. 依赖安装
在项目根目录下通过 package-lock.json 严格安装依赖：
```bash
npm ci
```

### 3. 静态类型检查
执行 TypeScript 静态类型检查（不生成构建产物）：
```bash
npm run typecheck
```
*底层命令为 `tsc -p tsconfig.json --noEmit`，零文件副作用。*

### 4. 本地离线测试套件
本项目设计了完善的纯离线测试套件，**无需 AWS Quick 账号凭据、无需外部网络、亦无需 Python 环境**：

```bash
# 执行完整离线测试流程（包含构建、协议探测、冒烟测试、19项回归、9项路由、10步集成及5项根因专项）
npm test
```

若只需要避免重建 `dist/`，可分别运行以下脚本。测试仍会创建和清理临时文件，并启动本地测试服务：
```bash
# 1. 协议握手探测
node dist/probe.js

# 2. stdio 协议冒烟
node dist/acp-smoke.js

# 3. 串联19项原回归和9项路由专项
node scripts/regression.mjs

# 4. 单独调试9项路由与超时专项
node scripts/test-device-routing.mjs

# 5. 10 步端到端离线 ACP stdio 集成测试（基于 Mock Upstream Gateway）
node scripts/acp-offline-integration.mjs

# 6. 5 项心跳保活与错误码根因专项测试
node scripts/test-auth-rootcause-fixes.mjs
```

### 5. 在线端到端验收测试（可选）
若需验证与真实 AWS Quick 网关的端到端交互闭环（读取贪吃蛇源码、写验收文档，并运行17项测试与pygame绘制循环）：
```bash
# 1. 确保已登录 Quick（生成本地凭据 ~/.quick-acp/login.json）
npm run login -- --start-url https://<你的SSO入口>.awsapps.com/start

# 2. 安装 Python (>=3.10) 依赖
python -m pip install -r examples/snake/requirements.txt

# 3. 运行在线端到端验收
npm run test:live
```

---

## 三、打包清单规范与预检 (npm pack)

### 1. 打包预检命令
在发布或核验前，必须运行打包预检：
```bash
npm pack --dry-run
# 或输出详细 JSON 清单：
npm pack --dry-run --json
```

### 2. 包含文件清单规则 (`package.json` 中的 `files` 字段)
打入 npm 包的文件严格由 `files` 字段及 npm 默认规则白名单控制：
- `dist/`：编译后的纯 ESM 运行时脚本与 Source Map。
- `README.md` 与 `README.zh-CN.md`：当前保持一致的简体中文说明文档。
- `CONTRIBUTING.md`：贡献与维护规范。
- `LICENSE`：MIT 许可文件。
- `docs/`：包含配置教程、能力对标、更新说明与本发布指南。
- `examples/snake/`：供客户端与测试验证的贪吃蛇示例源码及测试。
- `scripts/` 下的核心测试脚本：
  - `scripts/regression.mjs`
  - `scripts/acp-acceptance.mjs`
  - `scripts/test-capabilities.mjs`
  - `scripts/acp-offline-integration.mjs`
  - `scripts/test-device-routing.mjs`
  - `scripts/test-auth-rootcause-fixes.mjs`

### 3. 排除规则与安全防线
当前 `files` 白名单与示例目录的 `.npmignore` 共同控制打包范围，实际清单已核对不含以下项目；白名单内文件的内容仍须在发布前检查：
- **内部调度与验收目录**：`.dispatch/` 目录及其所有子文件与测试产物。
- **敏感凭据与认证缓存**：用户目录的 `~/.quick-acp/login.json` 与本地认证文件；npm打包规则不会自动扫描并剔除文件正文中的秘密。
- **开发与构建源码**：`src/` 源码目录、`tsconfig.json`。
- **临时与日志文件**：`node_modules/`、`*.log`、`.git/`、`.github/`。

---

## 四、独立目录安装与发布包特性验证

### 1. 独立目录验证方法
在发布新版本前，建议通过独立空目录验证打包产物：
```bash
# 1. 在根目录生成安装包
npm pack

# 2. 进入临时沙箱目录
mkdir ../test-sandbox && cd ../test-sandbox
npm init -y

# 3. 从本地安装打包产物
npm install ../quick_acp/quick-acp-0.1.8.tgz

# 4. 验证 CLI 命令启动
node node_modules/quick-acp/dist/probe.js
node node_modules/quick-acp/dist/acp-smoke.js
```

### 2. 发布包的核心机制差异（无 src/ 约束）
- **发布包中不包含 TS 源码**：发布包面向分发与生产运行，只包含 `dist/` 中的编译产物，不包含 `src/` 与 `tsconfig.json`。
- **不能在发布包安装目录下直接运行 `npm test`**：
  因为 `package.json` 中的 `"test"` 脚本定义包含 `"npm run build"`（即 `tsc -p tsconfig.json`）。在没有 `src/` 和 `tsconfig.json` 的已发布安装环境中，直接运行 `npm test` 会因缺失 TypeScript 配置文件而抛出编译错误。
- **正确验证方式**：直接通过 `dist/` 脚本或 CLI 命令（`node dist/probe.js`、`node node_modules/quick-acp/dist/acp-smoke.js`）进行功能与协议交互验证。

---

## 五、持续集成 (CI) 规范与真实支持范围

### 1. CI 配置文件
项目的持续集成配置文件位于 `.github/workflows/ci.yml`。

### 2. 矩阵配置
```yaml
strategy:
  matrix:
    os: [ ubuntu-latest, windows-latest ]
    node-version: [ 22.x ]
```
CI 流水线包含：代码检出 -> Node 22 环境配置 -> `npm ci` -> `npm run typecheck` -> `npm test` (离线全套测试) -> `npm pack --dry-run`。

### 3. 真实支持范围与客观状态声明
- **远端运行现状**：当前 GitHub Actions 工作流仅为**仓库内配置文件就绪**，尚未在远端 GitHub Actions 服务器实际触发运行。
- **操作系统覆盖范围**：
  - **Windows**：已在本地 Windows 开发机上进行了充分的离线回归与实机端到端验收。
  - **Ubuntu**：已在 CI 脚本中配置矩阵，但尚未在远端 Actions 运行产生日志。
  - **macOS**：**当前不在 CI 矩阵中**，亦未在本地 macOS 环境进行实测。
- **准确描述要求**：**不得对外声称“已通过跨平台完整测试”**，必须客观表述为“已完成 Windows 本地实测，Ubuntu/Windows CI 仅配置未远端运行，macOS 未测试未配置”。

---

## 六、维护者发布流程

### 1. 版本号升级
当发版文档准备就绪且验收通过时：
1. 确认变更性质为 Bug 修复与稳定性增强（版本升级为 `0.1.8`）。
2. 使用 `npm version 0.1.8 --no-git-tag-version` 同步更新 `package.json` 与 `package-lock.json`。
3. 确保所有发版文档（CHANGELOG.md、README.md、README.zh-CN.md、docs/0.1.8更新说明.md 等）已全部到位并完成复核。

### 2. 发布前完整自检清单
```bash
# 1. 静态类型无报错
npm run typecheck

# 2. 全套离线回归通过
npm test

# 3. 打包清单预检，核实文件条目与大小
npm pack --dry-run --json
```

### 3. 凭据与认证安全规范
- **Token 配置规范**：发布所用的 npm Token 只能配置在发布者本地操作系统的环境变量中（如 `NPM_TOKEN`）或存放在用户级主目录下的 `~/.npmrc` 文件中。
- **严禁入库**：绝对禁止将任何包含认证 Token、私钥或登录凭据的文件提交到 Git 仓库中。
- **说明文档脱敏**：任何公开发布说明、Commit 信息、Issue 或文档中，严禁出现真实账号名称、SSO 起始 URL 实例或鉴权秘密。

### 4. 正式发布执行
先保存并检查 tarball，再发布同一文件：
```bash
npm pack --pack-destination .dispatch/release-018
npm publish .dispatch/release-018/quick-acp-0.1.8.tgz --access public --ignore-scripts
```

### 5. 发布后 Registry 验证（区分 HTTP 状态与 CLI）
发布命令执行后，必须核验 registry 上的版本与一致性：
- **注意异步延迟**：`npm publish` 成功后，CLI 返回通常提示包已上传成功。但 npm registry 的 HTTP 接口（或后端 CDN 索引）有时存在异步写入（如返回 HTTP 202 正在处理中）或短暂的 CDN 缓存同步延迟。若查询暂未命中，应检查实际响应与包状态，稍后再次核对。不能仅凭 CLI 返回“+ 包名”判定公开可安装，也不要立即重复发布同版本。
- **Registry 版本与指纹核验命令**：
  ```bash
  # 查询线上最新版本
  npm view quick-acp version

  # 查询发布包完整哈希与 dist 信息
  npm view quick-acp@0.1.8 dist.tarball dist.shasum dist.integrity
  ```
- **比对一致性**：确认线上返回的 `shasum` 和 `integrity` 与本地执行 `npm pack` 时生成的指纹完全一致。

### 6. Git 标签 (Tag) 规范
- **发布后可选操作**：在 npm 发布确认成功、且 registry 指纹比对无误后，项目维护者可根据需要为该发布节点创建对应的 Git 语义化标签：
  ```bash
  git tag v0.1.8
  git push origin v0.1.8
  ```
- **明确解耦**：打 Tag 与推送到 GitHub 是维护者在版本正式发布后的可选收尾步骤；日常代码提交与本地审计严格不需要打 Tag。

---

## 七、Codeg 客户端集成与回读

在 Codeg 编辑器中使用 quick-acp 代理时：
1. **固定分发版本**：
   在 Codeg 代理设置中，推荐将启动分发规格固定为明确的语义化版本（如 `quick-acp@0.1.8`），避免因未指定版本导致的客户端缓存或拉取浮动。
2. **安装状态回读验证**：
   在 Codeg 的设置与代理管理界面中，重新加载或安装后，确认状态显示为：
   `“本地：<版本号>。已安装。”`
   并且安装日志中包含 `installed successfully`，确保客户端与底层代理版本严格对齐。
