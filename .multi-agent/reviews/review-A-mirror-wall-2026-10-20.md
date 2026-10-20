# 对抗审查 A：镜像撞墙停批 + 等待期可取消

- 审查对象：`git diff`（工作区未提交）。任务描述写 5 个文件，实际审到 6 个（多出 `src/main/download.test.ts`）；审查过程中又冒出第 7 个 `scripts/mirror-e2e.mjs`（见下条快照说明）。
- 设计：`.multi-agent/evidence/mirror-wall-design-2026-10-20.md`
- 背景：`.multi-agent/reports/how-mirror-2026-10-20.md`
- 方式：只读静态审查。未改任何文件（本报告除外）、未 commit、**未运行测试**（避免在工作区留下缓存/构建产物），因此"测试是否通过"不在本报告证据范围内；所有结论都是读代码追调用链得出。
- 快照（行号基准）：审查期间**工作区被另一个写者并发改动**——`mirror.ts` 从 `597858f` 变成 `8d9328e`（在 `run()` 收尾多加一行 `const reason = …` 剥尾标点），`scripts/mirror-e2e.mjs` 也多出一段撞墙 E2E（不在本任务给的 5 个文件里）。本报告的行号一律以这些 blob 为准：`mirror.ts=8d9328ee` / `download.ts=9dbe6ce5` / `index.ts=108ab341` / `mirror.test.ts=18aaf753` / `download.test.ts=099ab234` / `docs/ipc-contract.md=3913cae1` / `scripts/mirror-e2e.mjs=7c21072e`。若工作区继续变动，按符号名检索。
- 作者意图（不质疑，只挑执行）：撞站点墙时该本记 `failed` 并立即停批（`status: 'error'`）；等锁期间 `cancelMirror` ≤1 秒被看见，且取消后不再多下一本；共享类型 / IPC / preload / 界面不动。

结论：**0 critical / 8 warning / 5 nit**。意图的两条主路径（1 秒片内看到撞墙、1 秒片内看到取消）在代码里是成立的；问题集中在**检测的覆盖面**、**"取消后不再多下一本"的检查点位置**、**30 分钟预算按调用而非按任务计**、以及**停批文案与下载层提示互相打架**。

---

## Findings

### 1. [warning] "开下之前再确认一次取消"的检查点放错位置：取消落在书目页加载期间，镜像仍会开下一本

**Location**: `src/main/mirror.ts:376-390`

**Finding**: 新增的复检写在 `if (cancelled) break`（377），而它要守的 await 在 **389 的 `loadWithRetry(item.url)`**——中间还夹着 382 的第二次 `lookupExisting`。也就是说"检查 → 真正 `startBook`"之间隔着一整次目录页加载（`loadURL` + 水合等待，最长 2 次尝试 + 400ms 退避），是这条路径上**最长的窗口**，而它没有被任何 `cancelled` 复检覆盖。

**Evidence**: 调用链 `cancelMirror()`（`mirror.ts:173-177`）在 `currentBookId === undefined` 时只置 `cancelled = true`，不碰下载层；此刻镜像正停在 `mirror.ts:389 await loadWithRetry(...)` 里，而 `loadWithRetry`（280-294）只在**加载失败之后**才看 `cancelled`，在途的 `loadPageHtml` 不会被打断 → 加载成功返回 → 390 `d.startBook(html, url)` → `startDownloadFromPage`（`download.ts:910-924`）→ `beginDownloadFromBootstrap` 建书 + `active.set`（`download.ts:1101-1153`）→ 回到镜像 392 置 `currentBookId` → 396 `waitForDownloadSlot(currentBookId)` 第一次迭代就返回 `cancelled` → 462 `break`，`finally`（453-461）把刚起的这本 `cancelBook` 掉。净效果：**用户已点取消，书库里仍多出一本"下载中→partial"的空书**（`downloadChapters` 的 `finally` 会 `refreshBookStatus(bookId,'partial')`，`download.ts:1167-1176`），镜像的 `results` 里却没有它。这正好是本次改动声称要挡住的那一类竞态，只是窗口在加载而不是等锁。
注：意图原文把保证限定在"等待下载锁期间"，这一条不构成对该保证的直接违反；但 376 行注释把意图写成了"开下之前再确认一次"，执行与注释不符。

**Suggestion**: 在 389 之后、390 之前再插一次 `if (cancelled) break`（`break` 会走不到 `outcome` 记录，符合"取消的那本不写结果"）。或在 `loadWithRetry` 成功后统一做一次 `cancelled` 闸门。

---

### 2. [warning] 停批的 `status: 'error'` 要等"取消 + 再等锁"清理完才发布，那把尺子又是 30 分钟

**Location**: `src/main/mirror.ts:453-461`、`mirror.ts:466-484`

**Finding**: 撞墙分支（400-408）只设了 `halt`；真正 `job.status = 'error'` 与 `publish` 在循环末尾（476-484）。而中间 `finally`（453-461）先 `cancelBook(stuck)` 再 `await waitForDownloadSlot()`——这是一个**新开的 30 分钟预算**（207），且返回值被丢弃（`cancelled` / `timeout` 都当没发生）。"立即停批"因此不是由循环结构保证的，而是由"取消能否立刻打穿下载层"这一外部性质保证的。

**Evidence**: 正常路径下确实很快：`cancelDownload(bookId)`（`download.ts:1561-1569`）→ `notifyLoadCancelled()` → `waitWhilePausedForHuman` 的 `onCancel`（`download.ts:458-462`）reject → `downloadPass` 返回（1229-1234）→ `active.delete`（1175）→ `waitForIdle` 返回，量级几十毫秒。但只要这一路没有在 1 个时间片里结算（例如撞墙暂停与取消之间下载层刚好切到下一次 `loadURL`、或 `refreshBookStatus` 的落盘被拖慢），镜像就会在 **`publish` 之前**空转，最长 `MIRROR_WAIT_LIMIT_MS`；期间界面仍是 `running`、抽屉仍显示"正在下载：《X》"，用户看不到"撞墙停批"的任何迹象。另外 `finally` 里这个 `waitForDownloadSlot()` 的 `cancelled` 返回值被忽略：如果用户在清理窗口里点取消，紧接着 466-471 仍会把 `outcome`（例如超时 failed）写进结果并计数，与"取消的那本不记结果"不一致。

**Suggestion**: 停批先定态再清理——把 `job.status = 'error'` + `publish` 移到设 `halt` 之后立刻执行（或先 `await publish(job)` 再进清理）；清理用的等待换成一个短常量（如 5–10s）而不是复用 `MIRROR_WAIT_LIMIT_MS`；`finally` 里检查返回值，`cancelled` 时丢弃 `outcome` 并 `stop`。

---

### 3. [warning] 撞墙检测只认"正在下的那一本"，别人（用户手点）的下载撞墙时仍然 30 分钟 × 每本 空等，而契约文档已删掉这条已知边界

**Location**: `src/main/mirror.ts:366`、`mirror.ts:179-209`（尤其 185 的 `bookId !== undefined`）、`docs/ipc-contract.md:204`

**Finding**: `blockedReason` 必须带 `bookId`，而等锁前那一次 `waitForDownloadSlot()`（366）**没有 bookId**，因此永远不会看撞墙标志。于是"用户先手点了一本、那本撞墙暂停"这个场景下，镜像的等锁循环只能在 30 分钟后 timeout → 该本记 `failed`（"等待其它下载任务结束超时"）→ 下一本再等 30 分钟… 一批 10 本就是 5 小时、10 条 failed。这正是本次要消掉的"空等下载锁"，只是从"自己的书"换成了"别人的书"。

**Evidence**: `mirror.start` 有 `isDownloadBusy()` 闸门（`index.ts:1268`、`download.ts:303-305`）只挡开跑瞬间；镜像跑起来之后用户在书库点「下载本书」，`active.size === 0` 的空档能起来（`download.ts:1095-1097`）。它撞墙后 `pauseForHuman` 写 `dl.pausedForHuman`（`download.ts:428-440`）并 `await waitWhilePausedForHuman`（443-466，**无超时**），`active` 一直占着锁；而 `getPausedForHuman(bookId)`（`download.ts:299-301`）只按给定 bookId 查，镜像不知道那个 bookId。`docs/ipc-contract.md:204` 把旧的「已知边界（最多等 30 分钟）」整条删掉换成"不再空等下载锁"，现在文档承诺的范围大于实现覆盖的范围。

**Suggestion**: 让"等锁"这一路也能报墙——`blockedReason()` 的 bookId 改为可选，`index.ts` 在无 bookId 时检查"任意 active 的 `pausedForHuman`"（`download.ts` 加 3 行的 `anyPausedForHuman()` 即可）；镜像在预等锁阶段拿到墙就走同一个 `halt`。同时把契约里对"用户手点的下载正在撞墙"的说明补回一句。

---

### 4. [warning] 停批文案把下载层的"请点『我已处理好，继续下载』"原样嵌进来，而那个下载刚被镜像取消——用户会照着一个必然失败的按钮去点

**Location**: `src/main/mirror.ts:479-480`（拼接处，`479` 的 `reason` 只剥尾标点）+ `mirror.ts:400-408`（`halt.message` 来源）vs `src/main/download.ts:170-180`、`download.ts:1601-1611`

**Finding**: `halt.message` 直接复用 `pausedForHuman.message`，内容是 `blockedMessage()` 生成的整句："…已暂停本次下载。请在该页面用自己的账号登录或完成验证，再点「我已处理好，继续下载」。" 镜像再追加"处理后可点「继续上次」"。`479` 只是把句末标点剥掉再补回，两句指令仍然互斥：前者指向书库的「我已处理好，继续下载」，后者指向镜像抽屉的「继续上次」；而 `finally`（458）已经把那个下载 `cancelBook` 掉了，用户真去书库点前者，`resumeUnblock` 只会回「本次下载已取消，请在书库用「重试失败章」继续」（`download.ts:1604`）。

**Evidence**: `download.blocked` 只被 `Library.vue:1063-1066` 消费，书库页会留下"已暂停"的警告与按钮；镜像侧同时把下载取消。两条 UI 提示并存、指向相反动作。用户按书库那条点 → 失败文案 → 再回镜像点「继续上次」才真的能续。多一步无效操作，且第一次点了像是功能坏了。

**Suggestion**: 镜像不要复用整句 `pausedForHuman.message`，只用它的"哪堵墙 + 卡在哪一章"部分（`DownloadBlocked` 里 `failCode` / `chapterTitle` 已经够），末尾统一由镜像层写"已停止本批，处理后可点「继续上次」"；或者 `halt` 文案里明确写"该本下载已取消，请直接点「继续上次」"。

---

### 5. [warning] `waitIdle` 抛错被静默转成"忙"：适配器一旦坏掉，镜像会以 1 秒一片空转满 30 分钟且零诊断，而钉这条行为的旧测试被删了

**Location**: `src/main/mirror.ts:200-207`（`catch { idle = false }`）、`src/main/index.ts:559`

**Finding**: `index.ts:559` 用 `try { await waitForIdle(sliceMs); return true } catch { return false }` 把下载层的异常语义（`download.ts:292-294` 的 `throw new Error('download did not become idle')`）擦成布尔值，镜像侧再 `catch { idle = false }` 擦一遍。结果是"下载层持续报错"与"下载层仍在忙"在镜像里**不可区分**：永远 false → 循环到 `d.now()` 越过 30 分钟 → 该本记一条"等待其它下载任务结束超时"（与真实原因无关）。改动同时删掉了原来钉"`waitIdle` 拒绝不会终止整批"的用例，现在没有任何测试覆盖 throw 分支。

**Evidence**: `waitForIdle` 的超时值是"每次调用给的"（`download.ts:289`），`waitIdle(sliceMs)` 每片必抛一次（忙时），适配器因此把**每一次正常的 1 秒等待**都走一次 `catch`——这套设计里异常是正常控制流，异常与故障天然分不开。`mirror.test.ts` 现在没有一条 `waitIdle: async () => { throw ... }`。

**Suggestion**: 在下载层加一个只为镜像服务的 `waitForIdleSlice(sliceMs): Promise<boolean>`（内部同一套 20ms 轮询，到点 `return false` 而不是 throw），`index.ts:559` 直接引用它，删掉两处 catch；`waitForIdle(15s)` 留给 `download.ts:1731` 那个调用点。再加一条"适配器抛错"的用例钉住预期行为（失败该本还是停批，由作者定，但必须是有意的）。

---

### 6. [warning] 30 分钟预算按"每次调用"重置，一本书最多吃掉 3 次；设计稿写的"总上限仍是 30 分钟"与实现不符

**Location**: `src/main/mirror.ts:21-22`、`mirror.ts:182/207`、`mirror.ts:366`、`mirror.ts:396`、`mirror.ts:459`

**Finding**: `MIRROR_WAIT_LIMIT_MS` 在 `waitForDownloadSlot` 入口 `const started = d.now()`（182），每次调用都是**全新预算**。一本书最多触发三处：预等锁（366，超时 → 记 failed 后**继续下一本**，下一本又从 0 开始）、开下后的等待（396，超时 → failed）、`finally` 清理（459）。单本 90 分钟、整批 N×30 分钟（预等锁这条尤其）都是可达的。设计稿 `mirror-wall-design:61` 的"总上限仍是 30 分钟"只对单次调用成立。

**Evidence**: 三处调用互不共享 `started`；预等锁 timeout 的 outcome（368-374）不设 `halt`，循环继续，而锁还被那本别人的下载占着（见 Finding 3），所以每本必然再等满 30 分钟。`docs/ipc-contract.md:204` 现在只说"不再空等下载锁"，读者不会预期还有 30 分钟级的等待。

**Suggestion**: 把预算提到"每本书一次"或"每次 `run()` 一次"的粒度（例如 `run()` 里持有一个 `deadline`，逐本传进 `waitForDownloadSlot`），并在契约里写清"等锁超时仍是 30 分钟/本（或/任务）"。至少把预等锁 timeout 的重复消耗写成明确的产品决定。

---

### 7. [warning] 新测试钉的是分支结果，不是这次改动的两个时间语义；`cancelledBooks`（唯一能验证"停掉占锁那本"的观察点）从未被断言

**Location**: `src/main/mirror.test.ts:181-197`、`199-217`、`219-245`；`src/main/mirror.test.ts:40` / `71`

**Finding**:
1. `199-217` 的撞墙用例里 `blockedReason` **从第一次轮询就返回 Paywall**（`waitIdle` 只在 `started.length === 0` 时为 true），所以"先忙若干片 → 撞墙标志出现 → 下一片就停"这个真正的时序（也就是本改动的核心）从未被跑到；改回"等锁超时再看墙"或"墙只在第一次轮询才看"这类退化都能通过。
2. `181-197` 的用例名写"…**then ends the batch**"，断言却是 `last.status === 'done'`；而且 `maxBooks: 1` 让"超时后继续下一本"（设计要求"超时保持原行为，继续下一本"）完全没有被验证——这条用例实际上只证明了"预等锁超时 → 该本 failed → 不报错"。
3. 没有任何一条断言检查`waitIdle` 收到的参数是 `MIRROR_WAIT_SLICE_MS`（1000）。"最多 1 秒被看见"完全依赖这个值，把它改成 0 或 60_000 测试全绿。
4. `makeDeps` 暴露的 `cancelledBooks` 在全部用例里**一次都没被断言**，也就是说"超时 / 撞墙后先 `cancelBook` 掉占锁的那本再等"（`mirror.ts:453-461`）没有测试；这条恰好是"别让下一本全部撞锁"的关键。
5. 开下后等待的 timeout 分支（409-415，文案"等待下载任务结束超时"）没有用例，只有预等锁那条（文案"等待其它下载任务结束超时"）。
6. 审查期间并发出现的 `scripts/mirror-e2e.mjs:203-220`（不在任务列的 5 个文件里）确实在真 Electron + 真下载层上补上了撞墙停批的行为验证（`error` + 指向墙 + 第四本未入库 + `results` 只有三本），这是单测缺的那条集成证据；但它的时限是 `wallElapsed < 15_000`，仍然没有钉住"1 秒片 / 撞墙后一片内停"，只证明"没空等 30 分钟"。

**Evidence**: `makeDeps` 的 `now: () => 0`（77）在多数用例里是常量，两个时钟用例则每次 `now()` 跳 10 分钟（185-188、204-207）——这让"预算按经过时间算"和"按片数算"两种实现都过，等于没钉住时间语义。`waitIdle: async () => false`（184）忽略参数，所以片长契约无观测点。

**Suggestion**: 撞墙用例改成 `waitIdle` 先返回 2～3 次 `false`（模拟"下载在跑"），之后 `blockedReason` 才开始返回 Paywall，断言在**下一片**内停批且 `started` 只多一本；加 `expect(sliceMs).toBe(1000)`；加一条超时后断言 `cancelledBooks === ['book-101']`；把 181 那条改名（"fails the untouched book on lock timeout and continues"）并给 `maxBooks: 2` 验证第二本真的开跑。

---

### 8. [warning] `blockedReason` 的两处可选字段是假可选，逼出 4 处条件展开 + 1 个不可达兜底

**Location**: `src/main/mirror.ts:42`、`mirror.ts:55-59`、`mirror.ts:192-197`、`mirror.ts:405`、`mirror.ts:408`

**Finding**: deps 写成 `{ code?: FailCode; message?: string } | null`，于是镜像要写 `...(blocked.code === undefined ? {} : { code: blocked.code })`、`message: blocked.message ?? '撞到站点墙，需要人工处理'`，`halt` 再重复一遍。但唯一的实现是 `index.ts:560-563`，来源 `DownloadBlocked`（`types.ts:229-237`）里 `failCode` 与 `message` **都是必填**，所以这四个分支和那句兜底文案在当前代码里全部不可达。

**Evidence**: `getPausedForHuman` 返回 `DownloadBlocked | null`，`pausedForHuman` 由 `pauseForHuman` 一次性写入（`download.ts:429-436`），`failCode: FailCode` / `message: string` 必填；`resumeUnblock` 只会把整个对象清成 `undefined`（`download.ts:1606`），不会产生缺字段的半成品。

**Suggestion**: `blockedReason?(bookId: string): { code: FailCode; message: string } | null`，`MirrorWaitResult` 的 blocked 分支同样收紧为必填，`waitForDownloadSlot` 里那段条件展开退化成三个字面字段，`halt` 与 `outcome` 共享同一个对象（`halt = { title, ...blocked }`）。同时 `MirrorProgress.message` 的既有语义不变。

---

### 9. [nit] `run()` 里的单本流程被这次改动整体再嵌深一层，5 层 if/else + 两段几乎相同的 `lookupExisting` 兜底

**Location**: `src/main/mirror.ts:349-474`（重点 363-464）

**Finding**: 每本现在是 `if (existing?.complete) … else { slot 分支 … else { try { 第二次查询 … else { load → startBook → if/else if/else 四分支，内层再 try/catch/finally } } catch … finally … } }`，缩进到第 5 层；`mirror.ts:355-360` 与 `380-385` 是同一段"查询书库，读不到就退回原判据"的复制粘贴；`368-374` 与 `409-415` 是两条只差一个词的超时文案（"等待其它下载任务结束 / 等待下载任务结束"）；`halt` 把 `outcome` 的 `code`/`message` 又抄了一遍（405-408）。

**Evidence**: diff 把原有 60 行的下载块整体缩进 +2 并加了两层分支；`mirror.ts` 415 → 498 行，还没到 1k 的硬线，但"每加一个结局就往这一坨里塞一个 else"的方向已经很明显（这次就塞了 3 个结局：blocked/timeout/stop）。

**Suggestion**: 抽 `runOneBook(item, index, pending): Promise<{ outcome: MirrorBookResult | null; blocked?: { code: FailCode; message: string }; cancelled?: boolean }>`，主循环回到 8 行：`const r = await runOneBook(...); if (r.outcome) 计数; if (r.blocked) { halt = r.blocked; break }; if (r.cancelled) break`；`finally` 的"取消占锁 + 等锁"留在 `runOneBook` 内。第二次对账抽 `reconcile(url, fallback)`，两处超时文案按"是否已知自己的书"取同一模板。

---

### 10. [nit] `waitForDownloadSlot` / `MirrorWaitResult` / 两个 `MIRROR_WAIT_*` 常量都是模块外无人消费的公开面

**Location**: `src/main/mirror.ts:21-22`、`mirror.ts:55-59`、`mirror.ts:179`

**Finding**: 四者都 `export`，但 `index.ts` 不 import（只消费 `setMirrorDeps` / `startMirror` / `cancelMirror` / `getMirrorState` / `setMirrorLastState`），`mirror.test.ts` 也不 import。设计稿把它们画成导出是记录用的，落地后没有第二个消费者。

**Evidence**: `src/main/index.ts:47` 的 import 列表里没有这些名字；`mirror.test.ts:2-11` 也没有。

**Suggestion**: 去掉 `export`（需要时再开）；或至少让 `index.ts` 直接引用 `MIRROR_WAIT_SLICE_MS` 当默认片长，避免"1 秒"这个数在两个文件里各写一次。

---

### 11. [nit] 撞墙 / 超时的结果条目丢掉了已知的 `bookId`，与其它分支的结果形状不一致

**Location**: `src/main/mirror.ts:400-408`、`mirror.ts:409-415`

**Finding**: 这两个分支写在 `started.ok && started.bookId` 里面，`started.bookId` 就在手上，却没写进 `MirrorBookResult.bookId`；而 `downloaded` / `skipped` / "下载结束但书未完整"（429-430）都带。抽屉里"最近结果"（`Browse.vue:228`、1965）因此对撞墙这本少一个可定位的 id。

**Evidence**: `MirrorBookResult.bookId?: string`（`types.ts:250`）本就是可选的，补上不动任何契约；界面当前只显示 `message`，所以这是纯一致性/可诊断性收益。

**Suggestion**: 两个分支补 `bookId: started.bookId`，`halt` 里也带上，后续要给"打开这一本"加按钮时不用再改镜像层。

---

### 12. [nit] `waitForDownloadSlot` 在 `deps` 缺失时报"等锁超时"，而 `run()` 早已挡掉这种情况

**Location**: `src/main/mirror.ts:180-181`

**Finding**: `if (!d) return { kind: 'timeout' }`——把"镜像模块未初始化"（`run()` 在 327-328 已经 `return`，`startMirror` 在 212 也挡过）翻译成用户可见的"等待其它下载任务结束超时，可继续重试"。这是不可达分支，且如果哪天可达，给出的是错误原因。

**Evidence**: `deps` 只在 `setMirrorDeps` 里被赋非空值，`resetMirrorForTests` 置空只发生在测试之间；`run()` 首行 `const d = deps; if (!d) return`。

**Suggestion**: 删掉这行，让 `d` 直接非空（或在类型上就用 `deps!`），镜像层不再为"没装线"造一个假超时。

---

### 13. [nit] `finally` 里等的锁和刚放掉的锁不是同一个抽象：`cancelBook` 之后紧接着用"无 bookId"的等待，语义靠注释维系

**Location**: `src/main/mirror.ts:453-461`

**Finding**: `d.cancelBook(stuck)` 是"取消某一本"，`await waitForDownloadSlot()` 是"等整个下载层空闲"；两者在函数签名上毫无关联，读者得读 455 行注释才知道这是在等"我刚取消的那本收尾"。而 `waitForDownloadSlot()` 的空 bookId 语义（不看墙、只看空闲）与它上面两次用法（预等锁 / 开下后等）**三种含义共用一个名字**。

**Evidence**: 459 的返回值被完全丢弃（`timeout` / `cancelled` 都当无事发生），说明调用方对这个 wait 的语义也没想清楚要什么。

**Suggestion**: 换成下载层提供的一个明确原语（`waitForBookToSettle(bookId, ms)`），或者至少在这里用 `await d.waitIdle(shortMs)` 并检查返回值；把"撞墙感知的等待"和"纯粹等空闲"命名区分开。

---

## 逐条对照作者的五个追踪点

| 追踪点 | 结论 |
|---|---|
| 1. 撞墙检测时序 | 自己下的那本：`pauseForHuman` 先写标志（`download.ts:429`）再 `await`，镜像每片先查标志（`mirror.ts:185`）→ 下一片必看到，成立。缺：**等锁阶段（366）没有 bookId，看不到别人的墙**（Finding 3）。 |
| 2. 取消 vs 锁刚空出 | 377 的复检位置偏早（Finding 1）；`finally` 之后没有复检 `cancelled`（Finding 2 末段）；`waitForDownloadSlot` 顶部与返回 `cancelled` 时都有检查，等锁窗口内 ≤1 片成立。 |
| 3. 30 分钟预算 | 每次调用一个新预算，单本最多 3 次；预等锁超时还会逐本重来（Finding 6）。 |
| 4. 单本失败 vs 整批停批 | 边界清楚（只有 `waitForDownloadSlot` 的 `blocked` 设 `halt`；`startBook` 返回的 code 仍是单本 failed），但**目录页级别的墙 / 登录重定向**只表现为 `loadWithRetry` 或 `startBook` 失败，仍按单本 failed 一路撞下去——"整站被拦"这类墙落在停批判据之外（Finding 3 的另一面）。 |
| 5. 测试是否测行为 | 大体是行为层（started / results / status），并发补上的 E2E 也覆盖了真机停批；但两个核心时间语义（片长、先忙后墙）仍没被钉住，`cancelledBooks` 无断言（Finding 7）。 |

## 未发现问题的地方（明确记录，避免重复审）

- `getPausedForHuman` 的可见性窗口是对的：`resumeUnblock` 会清 `dl.pausedForHuman`（`download.ts:1606`），所以"用户已恢复后镜像仍判撞墙"这条不成立；`active.delete` 也一并清掉。
- 共享类型 / IPC / preload / 界面确实没被改动：`types.ts` 只被 import，`FailCode`、`MirrorBookResult.code` 都是既有字段；`index.ts` 只看 `configureMirrorRuntime` 一段；`docs/ipc-contract.md` 的措辞与前两条结论基本对得上（除 Finding 3 的覆盖面）。
- `cancelMirror` 在等锁期间不调 `cancelBook` 的新语义没有引入"取消后下载层无人收尾"的问题：等锁期间下载层本来就不归镜像管。
- `halt` 优先于 `cancelled` 的结束态取舍（477-483）可用：用户先看到"撞墙"，再按「继续上次」；`mirrorCanResume`（`Browse.vue:237-244`）在 `failed > 0 || results.length < planned` 时给按钮，停批后两者都成立。
