# 贡献与发布指南

本项目欢迎社区贡献。在提交代码或发布新版本前，请遵循以下开发、测试与发布规范。关于打包清单与 CI 的详细规范，请同时参阅 [打包与CI发布指南](docs/打包与CI发布指南.md)。

---

## 一、环境要求

- **Node.js**：必须使用 **Node.js ≥ 22**。
- **依赖安装**：克隆仓库后，运行 `npm ci` 安装锁定的项目依赖。

---

## 二、本地检查与测试套件

提交 PR 或维护验证前，必须在本地依次执行以下检查：

```bash
# 1. TypeScript 类型静态检查（只读检查，零文件副作用）
npm run typecheck

# 2. 全套离线测试（包含构建、协议探测、冒烟测试、19 项原回归、9 项路由专项、11 步离线 Mock 集成、5 项根因专项与 10 项工具预算专项）
npm test

# 3. 发布包清单与打包预检
npm pack --dry-run
```

> **离线套件说明**：`npm test` 为纯离线运行套件，无需 AWS Quick 账号凭据、无需外部网络连接、亦无需 Python 环境。测试包含：
> - 协议握手探测与 stdio 冒烟 (`probe.js`, `acp-smoke.js`)
> - 19 项原基础与进阶能力全量回归 (`scripts/regression.mjs`)
> - 9 项网关设备路由约束与超时控制专项测试 (`scripts/test-device-routing.mjs`)
> - 11 步端到端离线 ACP stdio 集成测试 (`scripts/acp-offline-integration.mjs`)
> - 5 项认证/连接根因专项 (`scripts/test-auth-rootcause-fixes.mjs`)
> - 8 项工具预算专项 + 2 项边界回归 (`scripts/test-tool-budget.mjs`、`scripts/test-tool-budget-boundaries.mjs`)
>
> 若仅进行只读验证（避免触发 `npm run build` 修改 `dist/` 编译时间戳），可直接运行对应脚本：`node dist/probe.js`、`node dist/acp-smoke.js`、`node scripts/regression.mjs`、`node scripts/test-device-routing.mjs`、`node scripts/acp-offline-integration.mjs`。

### 在线端到端验收测试（可选，需真实凭据）

若需验证与 AWS Quick 真实网关的端到端交互闭环（贪吃蛇自主开发与测试），请先完成 Quick 登录并配置 Python 3.10+ 环境：

```bash
python -m pip install -r examples/snake/requirements.txt
npm run test:live
```

---

## 三、代码与规范准则

1. **协议输出通道隔离**：
   - `stdout` 专用于标准 ACP (JSON-RPC) 通信流，**严禁向 stdout 输出任何非协议的调试文本**。
   - 所有日志记录、诊断输出与错误排查必须写入 `stderr`（或通过 `console.error`）。
2. **凭据安全规范**：
   - 任何提交的代码、测试日志或文档中，**绝对禁止包含登录凭据、刷新令牌（Refresh Token）、客户端密钥或真实鉴权信息**。
   - 本地凭据默认保存在用户目录 `~/.quick-acp/login.json`（权限 0600），不得将其纳入代码仓库。
   - 发布 Token 仅配置于本地环境变量或用户级 `~/.npmrc`，严禁提交到仓库。
3. **回归守卫原则**：
   - 修复 Bug 或新增协议能力时，必须在 `scripts/regression.mjs`、`scripts/test-device-routing.mjs`、`scripts/test-capabilities.mjs` 或 `scripts/acp-offline-integration.mjs` 中补充对应的离线测试用例，确保后续迭代不发生功能回退。

---

## 四、版本发布流程（仅供维护者参考）

以下流程由维护者在决定发版后执行；普通贡献提交不要求发布npm或创建、推送Git标签。

1. **更新版本号**：
   评估变更性质（补丁/特性），同步更新 `package.json` 与 `package-lock.json` 中的 `version` 字段，并新增或更新对应的交付说明文档。README 中的版本号（徽章、`npx` 命令、配置示例）也要一并同步——目前有 9 处 `quick-acp@0.1.x` 引用，漏改会误导用户，用 `grep -n 'quick-acp@0\.1\.' README.md` 逐个核对。
2. **完整本地验证**：
   运行静态类型检查、全套离线回归测试及打包预检：
   ```bash
   npm run typecheck
   npm test
   npm pack --dry-run
   ```
   核对打包文件清单，确保不包含 `.dispatch/`、`node_modules/`、本地测试日志、转录文件或任何敏感凭据。`.dispatch/` 已在 `.gitignore` 中排除，且不在 `package.json` 的 `files` 白名单里。
3. **独立目录安装测试**：
   执行 `npm pack` 生成 `.tgz` 安装包，并在独立的空白临时目录中执行测试安装（`npm install /path/to/quick-acp-x.y.z.tgz`）。
   > **注意**：已发布包为轻量运行时分发包，不含 `src/` 与 `tsconfig.json`，因此在独立安装目录中**不能直接运行 `npm test`**，应在独立安装目录通过 `node node_modules/quick-acp/dist/probe.js` 和 `node node_modules/quick-acp/dist/acp-smoke.js` 验证编译入口与ACP握手。
4. **正式发布与指纹核验**：
   维护者使用个人安全 Token 执行标准发布：
   ```bash
   npm publish --access public
   ```
   发布后核对 npm registry 上的版本与一致性哈希（`dist.shasum`、`dist.integrity`），注意 npm registry 可能存在短暂的异步处理（如 HTTP 202）或 CDN 同步延迟。
5. **可选版本标签 (Tag)**：
   发布确认无误后，维护者可根据需要创建对应的语义化版本标签并选择性推送（如 `git tag vX.Y.Z`）。打 Tag 是维护者发布后的可选辅助动作，不可作为日常开发或 PR 提交的前置要求。

---

## 五、持续集成 (CI)

本项目在 `.github/workflows/ci.yml` 中配置了自动化流水线，覆盖 Windows (`windows-latest`) 与 Ubuntu (`ubuntu-latest`) 环境（Node.js 22.x），用于自动执行依赖安装、类型检查、离线回归与打包校验。

> **当前 CI 支持范围声明**：
> - 公开 CI 目前仅为仓库内工作流配置就绪，**尚未在远端 GitHub Actions 服务器实际触发运行**。
> - **macOS 当前未纳入 CI 矩阵**，亦未进行本地 macOS 实机验证。
> - 不得声称“已通过跨平台完整测试”，实际状态为 Windows 本地实测通过、Ubuntu/Windows CI 仅配置未远端运行、macOS 未测试未配置。
