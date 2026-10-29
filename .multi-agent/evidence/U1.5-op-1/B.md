# B running 期间点正文中区仍能手动收起 / 展开工具，不被强制钉死

- commit：`2944406d0e9b166db884835c1b552fdeb72b0eb3`
- 窗口：「小说浏览器」X11 `0x5400004`，视口 1280×771
- 截图：`B-manual-toggle.png`（收起那一刻）；另存 `_b-expanded-again.png`（再次展开）
- 状态：`B-manual-toggle-state.json`
- 下载状态：全程 `running`（书库卡片「下载中」，侧栏「已下 x / 200 章 取消」）

## 点击点
正文中区中心：`.reader-content` rect x324 y24 w684 h723 → 点 (666, 386)。
`elementFromPoint(666,386)` 命中 `P.para`，文字「验收占位段落 001-3：这一段只是样例正文…」，确认点在正文里、在 content 内。

## 四次读数（逐字）

| 时刻 | class | aria-hidden | 高度 | opacity | visibility | 顶栏文字 | 进度 |
|---|---|---|---|---|---|---|---|
| 点击前 | `reader-toolbar` | false | 56 | 1 | visible | 样例站点·示例书一 书架 搜索 标记 朗读 AI 已下 102 / 200 章 取消 设置 浏览 | 已下 102 / 200 章 |
| 点中区第 1 次后 | `reader-toolbar reader-tools-hidden` | **true** | **0** | **0** | **hidden** | （空） | 已下 103 / 200 章（节点仍在，但不可见、不可点） |
| 再等 4.2s（进度继续走） | `reader-toolbar reader-tools-hidden` | true | 0 | 0 | hidden | （空） | 已下 110 / 200 章 |
| 点中区第 2 次后 | `reader-toolbar` | false | 56 | 1 | visible | 样例站点·示例书一 书架 搜索 标记 朗读 AI 已下 111 / 200 章 取消 设置 浏览 | 已下 111 / 200 章 |
| 再等 2s | `reader-toolbar` | false | 56 | 1 | visible | … 已下 116 / 200 章 取消 … | 已下 116 / 200 章 |

- 收起时 `[data-reader-dl="progress"]` / `[data-reader-dl="cancel"]` 的 `hitIsSelf` 均为 `false`（被隐藏、点不到）。
- 收起后跨了 7 章（103→110），顶栏没有被自动逻辑顶回来——用户在 running 期间的收起选择被尊重。
- 再次点击能重新展开，进度与取消回来且可点（`cancel.hitIsSelf=true`）。

## 结论素材
running 期间点正文中区，工具可收起、可再展开，且收起状态能跨多个进度 tick 保持；没有被钉死在常驻展开。
