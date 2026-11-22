# child_auth_required 根因与单轮验收

> [!NOTE]
> **0.1.7 发版与复验状态说明**：
> 本文记录的根因定位与单轮验证基于**本机 0.1.6 加运行时补丁（三运行时文件热同步哈希一致）**的历史实测事实。经用户授权，本项认证根因与连接稳定性修复已正式纳入 **0.1.7** 版本发布范畴。本文所列数据作为 0.1.7 同代码基准的发布前验证证据；`quick-acp@0.1.7` 在 npm 正式发布及 Codeg 重装后的最终复验仍待进行（严禁提前声称 npm 已发布或 0.1.7 已装/已复验）。

## 结论

`child_auth_required` 在此次失败中属于错误归类。Quick把普通套接字异常编码为ACP专属认证错误码，Codeg依协议显示为需要登录。独立真实网关探针还复现了约75秒的本地心跳误杀。修复后，**本机Quick 0.1.6加未发布补丁**通过全新Codeg会话的一次普通提示验收。

npm原版0.1.6仍保持原样；本次未发布、未推送、未修改账户设置。当前本机安装目录已加载补丁，保留原文件备份与逐文件哈希。

## 原始证据与因果链

证据根目录：`.dispatch/auth-rootcause/`。

1. **原失败会话814**：`quick-814-transcript.jsonl`保存16项测试通过的真实工具结果，随后任务中断；`codeg-error-evidence.json`带原日志路径、行号和时间，明确原异常为`socket is not open`，Codeg将其归为`auth_required`。
2. **错误码冲突**：`src/acp/agent.ts`原来使用`RequestError(-32000,...)`包装普通异常及路由错误；实际安装的ACP SDK中`RequestError.authRequired()`也使用`-32000`。Codeg的`connection.rs`按照`ErrorCode::AuthRequired`分类，符合协议。修复将这两处普通失败改为`-32603`。
3. **连接误杀复现**：`liveness-evidence.json`记录真实网关成功建连、11次应用层入站、0次控制层pong；72976毫秒仍有入站，77404毫秒本地看门狗却执行`4002/ping_timeout`。旧看门狗只认可控制pong，持续的业务帧不能阻止误杀。
4. **失效状态与证据丢失**：看门狗主动关闭未通知会话层，connected仍可能为true，后续发送触发socket错误；异常路径又跳过助手工具记录落盘。修复增加非正常关闭通知、连接状态复位、监听解绑和异常审计保存。
5. **重连边界复核**：主代理用`probe-reconnect-race.mjs`实际复现旧连接迟到close清理新连接看门狗，断言先失败；增加连接身份检查后，同一探针通过，结果保存在`reconnect-race-result.json`。

历史会话未保存底层WebSocket关闭调试事件，因此不能虚构其精确close事件；真实探针独立复现了与其时长、后续socket错误一致的故障机制。现有凭据成功建连，原始失败日志没有认证拒绝证据。

## 修复验证

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 修复后真实网关存活 | 建连后超过85秒仍打开，12次入站、0次控制pong、漏pong计数0 | `liveness-after-fix.json` |
| 全套测试 | `npm test`退出0：构建、契约/握手、19项回归、9项路由、10步ACP集成、5项根因专项通过 | `main-npm-test.log` |
| 看门狗失联保护 | 实际运行生产定时器，验证业务入站保持存活、无任何响应触发4002、有控制pong但无业务入站触发4003 | `main-rootcause-tests.log`、`scripts/test-auth-rootcause-fixes.mjs` |
| 测试失败可见性 | 故意触发断言失败时进程退出1；已移除会掩盖失败的finally中强制exit(0) | `test-failure-propagation.log` |
| 本地运行时同步 | 仅三个JS及对应map，源文件与安装文件哈希一致，版本仍0.1.6 | `runtime-sync.json`、`runtime-backup/` |

原首次全套测试失败日志保留在`main-npm-test-first.log`：主代理审查时误移除了原有本地Mock网关协议分支，随后对照已安装0.1.6恢复，完整重跑通过。子代理早期测试的外部登录依赖及手动terminate断言均已纠正；最终结论采用主代理实际执行日志。

## 全新Quick单轮验收

证据目录：`.dispatch/codeg016-singleturn-fixed/`。

- Codeg会话：818；适配器会话：`51bfc3ec-b974-4d06-a71f-08de4fabab82`；任务：`84525f50-5418-464c-bbb4-2e40be619fee`。
- 只发送一次普通项目提示，创建Python标准库记账CLI。没有追加纠正、续验或工具通道约束。`codeg-session.json`及`adapter-session.json`确认只有一个用户轮次。
- 总时长102036毫秒，正常完成，超过此前约75秒中断点。`delegation-result.json`和`acp-transcript.jsonl`保留任务结果与原始调用轨迹。
- 11次工具调用全部成功，实际工具仅`file_write`、`file_read`、`shell_run`；未观察到云端设备工具。详见`tool-summary.json`。
- Quick实际执行17项unittest通过；冒烟通过收入5000.00、支出35.50、列表、余额、新进程重载，余额4964.50，账本两条数据正确。
- 最后三次工具调用分别读回README.md、ledger.json、验收记录.md，全部`ok:true`。
- 主代理独立复跑17项测试，退出0，并在独立进程中执行列表和余额查询，退出0。见`main-review-unittest.log`、`main-review.json`。

**单轮验收结论：通过（本机0.1.6加未发布修复）。**

示例README声明Python 3.8以上，但本轮实际运行环境为Python 3.10.18；本轮结论不包含3.8兼容性认证。
