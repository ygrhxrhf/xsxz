# 代码审查报告 B（契约 / 数据一致性 / IPC 安全）

- 审查范围：`git diff origin/master..HEAD`（本地 master，8 个提交；审查中新增第 9 个提交 ff527ed「预取下一本书目页」，一并覆盖）
- 方式：只读审查，逐文件 read/grep 核对，未修改任何产品文件
- 重点：契约一致性、IPC 白名单与输入校验、索引 v1→v2 迁移、与既有下载链路的互斥

## BLOCKER

### B1. mirror 与 download 的「单任务锁」只有单向检查，镜像运行期间用户可并发触发下载/检查更新，双方共用同一个隐藏视图互相踩导航（可能把错误页面写进章节正文）

- 位置：
  - `src/main/index.ts:1248`（`mirror.start` 检查 `isDownloadBusy()`，仅单向）
  - `src/main/download.ts:299-301`（`isDownloadBusy()` 只统计 download 自己的 `active`/`runningJobs`/`checkAllRunning`，不含镜像状态）
  - `src/main/mirror.ts:36`、`src/main/index.ts:528-539`（镜像 `loadHtml` 最终走 `loadPageHtml`）
  - `src/main/download.ts:758-765`（`loadPageHtml` → `getHiddenView()`，与章节下载同一隐藏 webContents）
  - `src/main/download.ts:966`（`previewDownload` 只查 `isDownloadBusy()`）、`1612-1615`（`checkUpdate` 只查 `active.size`）、`1684-1696`（`checkAll` 同）、`1751-1755`（`retryFailed` 同）、`1808`（`redownloadChapter` 同）
  - `src/renderer/pages/Browse.vue:1505`（「下载本书」按钮只受 `downloading` 控制，镜像运行中不禁用）、`1514`（镜像按钮只看 `mirrorRunning`）
- 为什么不符 / 会坏：`docs/ipc-contract.md:193` 明确承诺「每本仍走下载一节同一条通道……因此与 `download.*` 共用单任务锁」。实际互斥只在 `mirror.start` 入口做了一次性检查；镜像任务运行期间的「发现阶段」与每本开始前的「书目页加载阶段」（`mirror.ts:263`、`mirror.ts:324` 的 `loadWithRetry`）`active.size === 0`，`isDownloadBusy()` 返回 false。此时用户在浏览页点「下载本书」、或在书库点「检查更新 / 全部检查更新 / 重试失败章」都会被放行，并与镜像并发调用 `loadPageHtml` → 同一个 `getHiddenView()` 的 `webContents.loadURL`。两次并发导航互踩：`waitForNavigationSettle`（`download.ts:619-692`）的 `did-finish-load` 可能由对方的导航触发，随后 `loadAndGetHtml` 读到的是**对方页面的 HTML**。后果包括：下载层把列表页/书目页当成章节页提取正文并 `writeChapterFile` 落盘（书库数据污染，且 `extractBody` 启发式可能判定成功而不报错）；镜像层把章节页当列表页解析；`download.checkAll` 在镜像期间同样只看 `active.size`。
- 触发条件：镜像任务运行中（发现阶段、或任一本书的书目页加载窗口内），用户在浏览页点「下载本书」完成确认，或在书库页点「检查更新 / 全部检查更新 / 重试失败章」。
- 修复方向：把「镜像运行中」纳入互斥判定——例如镜像任务期间置一个 mirrorBusy 标志并让 `download.preview/confirm/checkUpdate/checkAll/retryFailed/redownloadChapter` 与备份闸门（`src/main/index.ts:1111/1126/1141` 同一处 `isDownloadBusy()` 判定）一并检查，同时反向在镜像每本开始前复查 `isDownloadBusy()`；UI 侧镜像运行中禁用「下载本书」。

## MAJOR

### M1. `mirror-state.json` 全部用非原子 `writeFile` 写入，而这个文件的唯一用途就是崩溃后恢复，截断即丢续跑计划

- 位置：`src/main/index.ts:562`（`saveState: writeFile(mirrorStatePath(), …)`）、`src/main/index.ts:577`（启动阶段 running→cancelled 降级写，同样非原子）
- 为什么不符 / 会坏：仓库其余状态文件一律走 `atomicWriteText`（临时文件 + rename，见 `src/main/atomicFile.ts` 与 `library.ts:449` 的 index.json）。`mirror-state.json` 在每次 `publish`（每本书开始、每条结果落定）都重写一次，写入频率高；进程恰在写入中途被杀（这正是该文件要覆盖的崩溃场景）→ JSON 截断 → 启动时 `JSON.parse` 失败走 `catch`（`src/main/index.ts:582`）→ 按「无历史任务」整体丢弃，`plan` 丢失，`docs/disk-schema.md:507` 承诺的「取消或进程中断后能从同一列表页继续」失效。
- 触发条件：镜像运行中进程崩溃/被任务管理器结束，且击杀落在一次 `writeFile` 窗口内（每次进度落盘都是一次机会）。
- 修复方向：`saveState` 与启动降级写改用 `atomicWriteText`。

## MINOR

### m1. 契约承诺 `resume`「没有待办时返回 `{ ok: false }`」，代码未实现该检查

- 位置：`src/main/mirror.ts:176-199`（resume 分支只检查同种子 + `plan` 非空）；`docs/ipc-contract.md:207`
- 为什么不符：对一个已全部处理完（`done` 且 results 覆盖整个 plan、failed=0）的任务直接 IPC 调 `mirror.start({resume:true,…})`，契约说应返回 `{ok:false}`，实际返回 `ok:true` 并重跑整个 plan（靠书库对账全部 skip，结果无害但计数重置）。渲染层按钮有 gate（`Browse.vue:237-244`），所以只能通过直接 IPC 触发。
- 修复方向：resume 分支补「仍有未处理书目或失败书目」检查，否则返回 `{ok:false, message}`。

### m2. `upsertIndexItem` / `removeIndexItem` 不校验旧索引版本，直接把 v1 行连同 `version: 2` 写回

- 位置：`src/main/library.ts:452-461`、`464-472`（无条件 `writeIndex({ version: INDEX_VERSION, books: cached.books… })`）；对照 `rebuildIndex` 的版本门 `library.ts:495`
- 为什么 / 触发条件（待确认）：正常启动顺序下无问题——`src/main/index.ts:2455` 的 `recoverInterruptedStatus()` 在 `registerIpc`/`createWindow` 之前必然触发 `listBooks()` → 版本不符 → 全量重建为 v2，所以 v1 索引活不到第一次 upsert。但若启动时书库目录不可读（`rebuildIndex` 481-483 直接 return [] 不写盘）而后恢复可读，此时第一次 `library.updateMeta`/`setCover`/`deleteBook` 会读到 v1 缓存行并以 `version: 2` 写回；这些行缺 `sourceUrl`，而 mtime 缓存又命中，`rebuildIndex` 会在相当长时间内继续供给缺 `sourceUrl` 的行，镜像的 sourceUrl 兜底比对失效（有 `findExistingBookId` 身份匹配兜底，不会重复建书，仅多做一次身份回退）。
- 修复方向：upsert/remove 读到 `cached.version !== INDEX_VERSION` 时按无缓存处理（触发重建而非直接回写）。

### m3. `before-quit` 没有 `cancelMirror()`，关窗退出时镜像循环可能继续开下一本

- 位置：`src/main/index.ts:2505-2519`（只 `cancelDownload()` / `cancelCheckAll()` / `aiQueue.cancelAll()`）
- 为什么 / 触发条件：退出时 `cancelDownload()` 取消当前书 → 镜像 `waitIdle` 返回 → 镜像自己的 `cancelled` 标志仍为 false → 循环进入下一本书并调用 `startDownloadFromPage`，在关停窗口内写 `book.json`（downloading）。下次启动由 `recoverInterruptedStatus`（`library.ts:1450`）修正，`mirror-state.json` 的遗留 `running` 也按 `index.ts:568-577` 降级为 interrupted，均自愈，但属于无谓的落盘与状态抖动。
- 修复方向：`before-quit` 中补一次 `cancelMirror()`。

### m4. 启动阶段的 running→cancelled 降级写与新任务的状态写存在理论竞态

- 位置：`src/main/index.ts:565-584`
- 为什么 / 触发条件（待确认，窗口极小）：`configureMirrorRuntime` 是 `void` 出去的异步函数；`readFile` 悬挂期间若用户已 `mirror.start` 并落盘了新的 running 状态，随后 577 行仍会把**旧快照的降级结果**写回 `mirror-state.json`，覆盖新任务记录。内存态有 `setMirrorLastState` 的 running 守卫（`mirror.ts:146`）不受影响，仅磁盘快照短暂陈旧。以启动到首次交互的时序看几乎不可达。
- 修复方向：写回前复查 `getMirrorState().running`（或把降级写放进同一守卫）。

### m5. 文档说「界面据此（interrupted）给继续上次」，界面实际用 plan/results 推导

- 位置：`docs/disk-schema.md:507`、`docs/ipc-contract.md:207` 对 `interrupted` 的表述；实际 `Browse.vue:237-244` 只用 `plan`/`results`/`failed` 判定，`interrupted` 字段（`types.ts:279`）无任何消费方
- 为什么：行为上等价（中断后 results 必不完整 → 按钮会出现），但契约文字描述的机制与实现不一致，后续维护者会误以为该字段有 UI 语义。
- 修复方向：文档改口为「按 plan/results 推导，interrupted 仅作展示信息」，或让 UI 真正消费该字段。

### m6. `seedUrl` 仅做 `^https?:\/\//` 前缀校验（信息性，非新增风险类）

- 位置：`src/main/mirror.ts:171`；`src/main/index.ts:1249`
- 评估：镜像的**发现范围**已按契约收口——列表链接与「下一页」均强制同源（`mirror.ts:72`、`mirror.ts:120`），非 http(s) 拒绝。种子地址本身可指向任意 http(s)（含内网地址），但由于渲染进程是本地可信 UI、且既有 `download.redownloadChapter`（`download.ts:1810`）同样接受渲染进程传入的任意 http(s) URL、浏览页本身即可导航任意地址，本通道没有引入新的 SSRF 攻击面。不建议改，除非未来渲染层引入远程内容。

## 已核实、无问题的点

- **索引 v1→v2 迁移无数据丢失**：`Book.sourceUrl` 在 origin/master 的 `types.ts` 已存在（磁盘 book.json 一直带该字段），v1 索引命中版本门（`library.ts:495`）后全量重建即可补列；备份恢复 `validateStagedLibrary` 同时接受 1 和 2（`backup.ts:141`），与 `docs/disk-schema.md:73` 表述一致。除 m2 的防御性缺口外迁移路径干净。
- **index.json / book.json 写盘原子**：`writeIndex` 走 `atomicWriteText`（`library.ts:449`），书籍读改写有 `withBookLock` 串行化（`library.ts:199`）。
- **preload 白名单完整**：`mirror.start/cancel/state/onProgress` 四个通道与 `docs/ipc-contract.md:197-200` 表格逐一对应（`src/preload/index.ts:196-206`），`onProgress` 复用统一 `on()` 并返回退订函数；渲染层在 `Browse.vue:1455` 注册、1469 行统一退订。
- **IPC 返回形状与契约一致**：`mirror.start` 的 `{ok,jobId}|{ok:false,message}`（`mirror.ts:167/179/180`）、`mirror.cancel` 恒 `{ok:true}`、`mirror.state` 的 `{ok:true,state:{running,last}}` 均与契约表格相符；`maxBooks`/`maxPages` 缺省 10/3、夹紧 1–50/1–10（`mirror.ts:17-20`、`127-134`）与契约文字一致，非数值输入回退默认值。
- **事件 payload 无敏感路径泄漏**：`MirrorProgress` 只含 seedUrl、书目 URL/标题、计数与中文 message，不含磁盘路径；`mirror-state.json` 的路径本身不外发。
- **跳过已入库逻辑以书库为唯一真值**：`lookupExisting`（`index.ts:545-560`）先用下载层 bookId 变体匹配、再退回 sourceUrl 规范化比对，镜像日志不做「已下过」快照，与 `docs/ipc-contract.md:205` 一致；取消当前书不写结果（`mirror.ts:333-334`）符合契约 206 行。
- **续跑中断降级**：启动把遗留 `running` 降级为 `cancelled`+`interrupted`（`index.ts:568-577`），与 disk-schema 507 行一致（写盘原子性问题见 M1，降级逻辑本身正确）。
- **等待超时语义**：`waitIdle` 30 分钟超时后只记 `failed` 并停掉卡住的下载（`mirror.ts:364-371`），符合契约「单本失败（含等待超时）只记 failed，不终止整批」。
- **e2e 脚本的 `--no-sandbox` 仅存在于 `scripts/mirror-e2e.mjs` 测试启动参数**，未进入产品代码。

## 遗留待确认

- m2 / m4 的触发窗口均为防御性缺口，标注「待确认」，建议按上述方向补守卫但不阻塞合入。
- 审查中 master 新增了 ff527ed 提交（预取视图）；预取用独立 view 且失败仅回退正常加载，未引入与 B1 不同的新问题。
