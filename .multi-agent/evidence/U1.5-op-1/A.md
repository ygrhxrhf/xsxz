# A 下载结束（取消）后，顶栏回到默认收起，不再常驻「已下 / 取消」

- commit：`2944406d0e9b166db884835c1b552fdeb72b0eb3`
- 窗口：「小说浏览器」X11 `0x5400004`，视口 1280×771
- 截图：`A-after-finish.png`（取消后）；（前一张 running 证据 `_t08-clean-running.png`）
- 状态：`A-after-finish-clean-state.json`
- 干净路径说明：这条路径里用户在 running 期间**一次都没点正文中区**（上一轮 B 里点过中区，属于「用户明确要展开」，另见文末附注）。

## 步骤
1. 书库 → 《样例站点·示例书一》「更多操作」→「重试失败章」，下载真的跑起来（侧栏立刻出现「已下 127 / 200 章 取消」）。
2. 点该书封面打开，进阅读页。**不点正文**，第一眼：`.reader-toolbar` 无 `reader-tools-hidden`、h56、opacity 1、visible，文字含 `已下 169 / 200 章` 与 `取消`。
3. 真实点 `[data-reader-dl="cancel"]`（(1093,28)，`elementFromPoint` 命中 `BUTTON.tool-button`，text `取消`）。

## 取消后读数（逐字）

| 项 | 取消前 | 取消后 | 再等 3s |
|---|---|---|---|
| class | `reader-toolbar` | `reader-toolbar reader-tools-hidden` | `reader-toolbar reader-tools-hidden` |
| aria-hidden | false | **true** | true |
| 高度 | 56 | **0** | 0 |
| opacity | 1 | **0** | 0 |
| visibility | visible | **hidden** | hidden |
| transform | none | `matrix(1, 0, 0, 1, 0, -8)` | 同 |
| 顶栏文字 | …已下 169 / 200 章 取消… | （空字符串） | （空字符串） |
| `[data-reader-dl="progress"]` | 已下 169 / 200 章 | **null** | null |
| `[data-reader-dl="cancel"]` | 取消 | **null** | null |

## 下载确实停了
- 侧栏下载提示：取消前「样例站点·示例书一 / 已下 169 / 200 章 / 取消」→ 取消后 `null`（整块消失）。
- 本地样例站访问日志：最后一次 `GET /book1/c173.html`，之后不再新增请求。
- 书库卡片：取消前「下载中 / 正在下载新章节… / 有取消下载按钮」→ 取消后「**部分** / 28 章下载失败 / 无取消下载按钮」。

## 结论素材
取消生效，顶栏回到默认收起（与下载前基线 `_stage0.json` 的读数完全一致），不再常驻「已下 / 取消」。

## 附注（如实记录，不作判定）
上一轮 B 里用户手动点正文中区把工具展开（intent 变成「用户要展示」），随后在同一状态里点取消，顶栏保持展开（`A-after-finish-state.json`：取消后 class 仍为 `reader-toolbar`、h56、progress/cancel 已为 `null`）。也就是说：结束时会收起的前提是用户没手动表过态；用户手动展开过时保留用户选择。两条都在这里，判定交给判断者。
