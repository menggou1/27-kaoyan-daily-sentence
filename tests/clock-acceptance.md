# Edge 丢弃恢复校时验收

## 现象和修复

[Issue #1](https://github.com/menggou1/27-kaoyan-daily-sentence/issues/1) 的对照实验确认，Edge 在丢弃后重建文档时曾为固定的 `/api/now` 返回两条缓存 200，并把陈旧但合法的 `unix_ms` 应用到页面。11 月 17 日现场的前两条响应体没有留存，无法判定它们是否曾命中同一缓存。

Chromium 源码的 `DetermineFrameCacheMode` 在文档完成 `load` 前为 `kBackForward` 和 `kRestore` 返回 `kForceCache`。[上游报告 #490673934](https://issues.chromium.org/issues/490673934) 在关闭标签页后重开和会话恢复时观察到显式 `no-store` 的网络标志被历史恢复策略覆盖。本项目的 Edge 对照中，NetLog 同时记录到恢复请求使用不同于首次进入的 `load_flags`，原版两个 200 读取缓存而且没有发送 HTTP 请求。具体输入和上游归档见 [Chromium 源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/loader/frame_fetch_context.cc) 和 [HTTP 工作组讨论](https://lists.w3.org/Archives/Public/ietf-http-wg/2026JanMar/0125.html)。

重建文档会重新执行启动校时。有请求尚未结束时，`syncPending` 合并后续恢复事件，超时后允许替换。一个快速 200 完成后 `syncPending` 会清空，随后到达的 `pageshow`、`focus` 等事件可以再次发起校时。这解释了同一恢复内请求可能相继出现，日志未将现场的两条请求逐一归因到具体事件。200 只表示 HTTP 状态。安全整数、年份范围、耗时及两种时钟的增量校验能发现格式问题或请求期间的时钟异常，五小时前的合法时间戳仍可能通过这些检查。

校时请求使用 Web Crypto 生成的 128 位文档标识和文档内递增序号，避免同一毫秒或设备回拨时重用 URL。每次请求保留 `no-store`，拒绝重定向到其他缓存键。实测 UTCTime 接受带 `_sync` 的查询，返回不同的 `unix_ms` 和 `Access-Control-Allow-Origin: *`。页面以本次请求的往返耗时近似补偿网络延迟，用 `performance.now()` 推进网络锚点。`Date.now()` 用于未校时时的降级及比较时钟增量。对失败、超时、取消和迟到的旧请求，已有锚点继续走动，新文档首次失联时使用设备时间，下一次成功校时即可恢复。旧版若已采纳错误锚点，之后的失败会将偏差延续到下一次成功校时。

## 新鲜度依据和边界

- UTCTime 的 `Date` 与 `Age` 在实际跨域响应中没有通过 `Access-Control-Expose-Headers` 暴露。即使能读到 `Date`，缓存也可把它和 JSON 一起重放。`Cache-Control: public, max-age=1` 表示缓存策略。`Age` 在存在且可信时可提示缓存年龄，缺失不能证明新鲜。浏览器资源计时也受跨域 `Timing-Allow-Origin` 限制，生产页面因此采用独立请求 URL 来隔离已知的浏览器缓存路径。
- 没有网络锚点时，设备可能偏差数小时。已有锚点时，后台或休眠补时也可能受同一期间的设备前拨影响。把设备时间或历史锚点当成绝对标尺，可能拒绝真实的新样本并让偏差持续。此修复未引入外部时源，也未拒绝合法的向后校正。
- 每个新 URL 本身不能证明上游数据绝对新鲜。如果上游或中间层对从未用过的查询仍返回陈旧但合法的 JSON，页面没有独立证据来识别它。重定向、网络失败、超时、取消或校验失败时使用已有锚点或设备时间。生产接口变更后重新执行真实 UTCTime 验收。

## 测试矩阵

| 场景 | 层级和操作 | 通过条件 |
| --- | --- | --- |
| 首次进入及空缓存 | Playwright 本地 HTTP、真实 Edge `--live` | 冷启动收到 200，格式有效，样本与已知测试时刻或独立测量同时段的 UTCTime 一致，且有实际 HTTP 发送 |
| 同一毫秒和文档重建 | Node VM | 两种时钟都固定时，同文档连续请求与新文档首请求 URL 各异，`no-store` 和取消信号保留 |
| 普通历史响应、五小时前的缓存、重复 200 | Playwright 可控重放；有头 Edge 使用实际 HTTP 缓存 | 原版同一响应编号和时间戳重复出现，服务端新增请求为零。修复版 URL 各异，响应关联到新的服务端编号，未采纳缓存时间 |
| 丢弃及连续恢复三次 | 有头 Edge CDP、`edge://discards` | 控制页确认目标 `discarded`，激活同一标签槽位后 `wasDiscarded` 为真、`timeOrigin` 改变、导航为 `back_forward`，NetLog 记录新 HTTP 发送且无缓存读取 |
| 超时、取消、网络故障、无效 HTTP 和 JSON | Node VM、Playwright、真实 Edge 本地 HTTP | 5 秒后连接关闭或信号中止，旧请求无法覆盖当前时钟。无锚点用设备时间，有锚点继续推进 |
| 失败后恢复 | Playwright、真实 Edge 本地 HTTP | 同一 `timeOrigin`，后续收到有效新样本后由本地时间或「保持中」回到「已网络校时」 |
| 北京时间跨午夜、双倒计时一致 | Node VM、Playwright 模拟跨日 | 北京日期和当天内容更新，考试倒计时及次日零点倒计时与同一 `clockNow()` 计算结果一致 |
| 改系统时间、休眠和定期校时 | Node VM、Playwright 独立推进设备和单调时间 | 稳定的网络锚点在前台不随设备偏移改变，设备时间错误仍可重新校时，正常推进到 10 分钟时发送新请求 |

## 运行和核查

使用 Node.js 24。站点本身无需安装 npm 依赖。首次安装测试工具运行 `npm ci --prefix tests`。Windows 使用已安装的 Edge，PowerShell 中设置 `$env:BROWSER_CHANNEL = 'msedge'`。Linux 在 `tests` 目录运行 `npx playwright install --with-deps --no-shell chromium`，并用 `BROWSER_CHANNEL=chromium` 运行 Playwright 检查。

```text
node tests/clock-ordering.cjs
node tests/ui-check.cjs --clock-only
node tests/ui-check.cjs
node tests/calendar-hover-runner.cjs
node tests/edge-clock-discard.cjs
node tests/edge-clock-discard.cjs --live
```

Playwright 的阻断检查用本地 HTTP 服务控时，并用独立的 `CacheStorage` 固定重放同一个旧响应。这个对照验证客户端在按 URL 重放时的行为。真正丢弃由独立的有头 Edge 脚本执行。它使用临时配置文件、浏览器级 NetLog、`edge://discards` 的 `Urgent Discard` 和浏览器级 CDP 重新激活标签页。点击丢弃前解除对目标页的调试连接，否则 Edge 可能禁止丢弃。测试记录页面实际解析的时间戳、状态、响应编号、请求时间、取消状态和 NetLog 的 HTTP 发送及缓存读取情况。设置 `TEST_ARTIFACTS` 可保存失败截图和诊断文件。丢弃动作不可用、没有重建文档或缺少网络证据时脚本失败，该环境的相应行为仍未获验证。

GitHub Actions 的 `Clock regression (Edge)` 和 `Clock regression (Chromium)` 检查以失败退出阻断工作流，分别在 `windows-latest` 的 `msedge` 通道和 `ubuntu-latest` 的 Chromium 通道运行。目标为 `main` 的 PR、推送至 `main` 以及手动触发会运行。较新的同类运行会取消同一 PR 或分支上尚未完成的旧运行。失败保存 Playwright Trace、可用截图和请求日志。分支是否强制要求这些检查通过，由 GitHub 分支规则控制。

`Real Edge tab discard` 独立于上述回归检查。相关代码推送到 `main` 时运行本地缓存对照，也可手动选择 `local-cache` 或 `live-utctime`。真实接口只在 `live-utctime` 场景使用。无论成功还是失败均上传可用的生命周期和网络证据。若 Runner 的 Edge 无法执行真正丢弃，在独立的本机 Edge 配置中复测。

## 本机 Edge 记录

Windows Edge `157.0.4341.60`，2026-11-20 北京时间 13:07–13:08。本地接口对照使用同一浏览器配置和缓存分区。下列 `unix_ms` 保留原始毫秒值。

| 场景 | 可核查结果 |
| --- | --- |
| 普通过期缓存 | 13:07:53 左右，两条 200 均为响应 #3，`unix_ms=1795151267361`，服务端新增 0 次，NetLog 两次读缓存 |
| 五小时前的缓存 | 13:07:56 左右，两条 200 均为响应 #4，`unix_ms=1795133273979`，服务端新增 0 次，NetLog 两次读缓存，页面慢约五小时 |
| 修复版连续三次丢弃恢复 | 13:08:00–13:08:05，响应 #7–#12 各有不同的 URL 和 `unix_ms`，服务端新增 6 次，NetLog 记录 6 次实际 HTTP 发送和 0 次缓存读取 |
| 恢复首请求超时再重试 | 请求 #13 的连接在 5,014 毫秒后关闭，使用设备时间；响应 #14 到达后原文档恢复网络校时，`timeOrigin=1795151286044.8` |
| 真实 UTCTime | 13:09:54–13:09:59，连续三次真实丢弃恢复共收到 5 条 200，`unix_ms` 从 `1795151394408` 到 `1795151399139`，NetLog 记录 5 次实际发送、0 次缓存读取 |

## 已部署站点验收

要验收已部署站点，在独立 Edge 配置中打开站点和 `edge://discards`，保持浏览器 HTTP 缓存启用。用 `edge://net-export` 在丢弃前开始记录，关闭目标页 DevTools，切到控制页执行 `Urgent Discard`，再从标签栏切回站点。记录新文档的 `document.wasDiscarded`、`performance.timeOrigin`、导航类型和 `_sync` URL。至少重复三轮，逐条核对 NetLog 对 `/api/now` 的 HTTP 发送和缓存读取，比较响应的 `Date` 或 `unix_ms` 与采集时刻及页面显示。如需观察失败，另用本地脚本控制超时。自然跨午夜及修改操作系统时钟仅在专用测试环境验证，避免干扰正在使用的设备。
