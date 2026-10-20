# 设计：镜像撞墙停批 + 等待期可取消

状态：**已定稿，待实现**（architect 步骤的设计叉子记录；未起并行设计组，理由见下）

## 用法草图（调用方看到的形状）

```ts
// mirror.ts 内部
const slot = await waitForDownloadSlot(currentBookId) // 1s 一个时间片
if (slot.kind === 'blocked') {
  outcome = { status: 'failed', code: slot.code, message: slot.message }
  halt = true // 本轮批量到此为止
}
```

```ts
// index.ts 接线
waitIdle: async (sliceMs) => { try { await waitForIdle(sliceMs); return true } catch { return false } },
blockedReason: (bookId) => {
  const blocked = getPausedForHuman(bookId)
  return blocked === null ? null : { code: blocked.failCode, message: blocked.message }
},
```

## 问题

1. 撞墙（付费墙 / 登录墙 / 拦截）时 `download.pauseForHuman` 会一直占着单任务锁等人工处理，镜像的 `waitIdle(30 分钟)` 干等，批量里每本撞墙的书都要再等 30 分钟。
2. `waitForIdle` 是整段等待，`cancelMirror` 在等待锁期间只置了 `cancelled` 标记，最长要等 30 分钟才被看见。

## 三个候选

| 方案 | 形状 | 代价 | 问题 |
|---|---|---|---|
| A. 1 秒时间片 + 读下载层暂停原因 | `waitIdle(sliceMs): Promise<boolean>` 由镜像自己循环；新增只读 `blockedReason(bookId)` | 改 3 个源文件 + 测试；不加 IPC、不加类型字段 | 每次等待多几次 1s 定时器，量级可忽略 |
| B. 给 `waitForIdle` 传 AbortSignal | 下载层改造，镜像传 signal | 下载层是被多处复用的核心 | 只解决取消，不解决撞墙干等；改动面更大 |
| C. 新增 `status: 'blocked'` 与 `mirror.blocked` 事件 | 领域状态更诚实，界面可给「处理站点墙」按钮 | 动 `shared/types.ts`、契约、preload 类型、界面 | 本任务不需要新交互就能解决两个 bug，属超范围 |

决定：**A**。判据是「用最小表面积同时消掉两个干等」，且不动共享类型与 preload 白名单。反转条件：如果后续要给「遇到墙」单独的界面动作（打开撞墙章 / 单本重试），再升级到 C。

## 类型草图

```ts
export interface MirrorDeps {
  // 原 waitIdle(): Promise<void>
  waitIdle(sliceMs: number): Promise<boolean>
  blockedReason?(bookId: string): { code?: FailCode; message?: string } | null
}

export type MirrorWaitResult =
  | { kind: 'idle' }
  | { kind: 'cancelled' }
  | { kind: 'blocked'; code?: FailCode; message: string }
  | { kind: 'timeout' }

export const MIRROR_WAIT_SLICE_MS = 1_000
export const MIRROR_WAIT_LIMIT_MS = 30 * 60_000
```

## 语义

- 循环顺序：先看 `cancelled`，再看 `blockedReason`，再等一个时间片；总上限仍是 30 分钟。
- 撞墙：该本记 `failed`（带 `code` / `message`），**立即停批**，`status: 'error'`，`message` 写清撞在哪个站点墙、处理后点「继续上次」。
- 取消：等待中最多 1 秒后被看见；正在下的那本仍走 `cancelBook`。
- 超时：保持原行为，该本记 `failed`，继续下一本。
- 不新增共享类型字段；`MirrorProgress.message` 的既有语义（结束态原因）不变。
