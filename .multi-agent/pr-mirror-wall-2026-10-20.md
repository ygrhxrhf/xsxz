# 镜像撞墙停批，等待下载锁期间可取消

## Why

撞到站点墙时，下载层会无超时地占着单任务锁等人处理，镜像的 `waitIdle(30 分钟)` 只能干等。批量里每本撞墙的书各等 30 分钟。等锁期间点取消也不生效，镜像还会把下一本完整下完才停。

## What changed

- 新增 `waitForDownloadSlot`：1 秒时间片轮询，先读下载层的 `pausedForHuman`，撞墙当片返回；每本书一个 30 分钟预算，等锁超时也停批。
- 新增 `waitForIdleSlice`（布尔返回）与 `getPausedForHuman`（扫描任意在跑下载）；不再用异常当控制流。
- 取消复检挪到目录页加载之后、`startBook` 之前；停批收尾等待固定 5 秒，不再复用 30 分钟预算。
- 单本流程抽成 `runOneBook`，主循环只剩「取结果 → 计数 → 是否停批」。
- 契约同步：撞墙 / 等锁超时停批、结果带 `bookId`、文案不再指向已被取消的下载。

## Scope

- 不含目录页级的整站拦截（登录重定向、403 落到 `startBook` 失败仍按单本 failed 继续）。
- 不新增 `status: 'blocked'`，停批用 `status: 'error'` 加可读 `message`。
- 不推分支、不建 PR（本机无 `gh`）。

## Tradeoffs

用 `error` 而不是新状态，原因是界面与契约都不必扩字段，改动面最小；代价是「出错」与「撞墙停批」共用结束态，靠 `message` 区分。反转条件：要给撞墙单独按钮时再加状态。

## Blast Radius

只动镜像的等待与调度，下载层的锁语义、IPC 形状、共享类型都不变。`mirror.start` 与 `download.*` 的互斥仍是单向检查，这是上一轮 `review-b.md` 的 B1，本次未覆盖。

## Verification

- `npx vitest run src/main/mirror.test.ts` → 21/21。
- `npx vitest run src/main/download.test.ts` → 75/75。
- 干净工作树 `fa194f1`：`npm run build` 0；`node scripts/mirror-e2e.mjs` 19/19，撞墙 5842ms 停批，第 4 本未下载。
- 全量 1233/1234；唯一失败是 `aiReadingFollow` 的 `ENOTEMPTY` 已知 flaky，单跑 14/14 通过。
