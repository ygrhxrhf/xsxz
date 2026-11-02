# CF 挑战页在 Electron 45（Chromium 156）下的复测

> 日期：2026-11-02
> 载体：Electron 45.2.1 / Chromium 156.0.8078.75 / Node 24.22.1
> 目标：`https://www.uaa001.com/`（Cloudflare 托管）

## 为什么测

挑战页战役（`053c13c`）的全部实测跑在 **Electron 43 / Chrome 150** 上，结论是：

| 载体（Electron 43） | 结果 |
|---|---|
| 可见 `BrowserWindow` | 曾成功，`cf_clearance` 5–11s 下发，重载后 47 链接 |
| 隐藏 `WebContentsView`（产品下载视图） | **拿不到 cookie**，25s 内一直停在挑战页 |

当时判断是「Chromium 版本 + 隐藏视图指纹差异」，并把 uaa001 归到「人在环」。
升级 Electron 就是为了验证这个判断。

## 怎么测

`cf-probe.mjs` 驱动 `cf-runner.cjs`，三个变体各自独立进程、独立 partition：

- **A 可见 BrowserWindow** —— 模拟用户在内置浏览里过验证。
- **B 下载视图（不挂窗口）** —— 与 `download.ts` 的 `getHiddenView()` 配置一致：
  `sandbox:true` + `setVisible(false)` + 负坐标 bounds + **不** `addChildView`。
- **C 下载视图（挂到隐藏窗口）** —— 只差「是否挂载」，用来区分两个变量。

每个变体：首载 → 每秒轮询 `cf_clearance`（45s 预算）→ 拿到后重载一次 → 取标题/正文长度/链接数。
判定「已放行」：正文 ≥ 1000 字且链接 ≥ 10 个（挑战页两项都接近 0）。

## 结果

| 变体 | `cf_clearance` | 首载正文/链接 | 重载后正文/链接 | 结论 |
|---|---|---|---|---|
| A 可见窗口 | 4316 ms | **116 字 / 2 链接**（挑战页） | **14036 字 / 264 链接** | PASS |
| B 隐藏视图（不挂窗口） | 2338 ms | 14028 字 / 264 链接 | 14028 字 / 264 链接 | PASS |
| C 隐藏视图（挂隐藏窗口） | 2578 ms | 13311 字 / 264 链接 | 13311 字 / 264 链接 | PASS |

非 `-3`（ABORTED，重载导航的正常中断）的 `did-fail-load` 数量：三种载体均为 **0**。

## 结论

1. **Chromium 156 下，产品的隐藏下载视图能拿到 `cf_clearance`** —— Electron 43 时的「拿不到 cookie」在 45 上不复现。
2. **A 变体提供了对照**：同一轮里首载确实是 116 字的挑战页，重载后才是正文。说明站点挑战仍在，只是这次三种载体都过了，判定不是「站已经不设挑战」。
3. 因此 `challengePage.ts` 的自动重试逻辑（等 cookie → 重载一次）在 Chromium 156 上是**有效路径**，不再必然落到「人在环」。
4. B 与 C 结果一致 → 「是否 `addChildView` 挂到窗口」不是决定因素；早先的失败更像是 Electron 43 的指纹问题。

## 边界

- 单站单次采样。Cloudflare 按指纹动态调整难度，不能保证所有站、所有时段都如此。
- 只验证「等真实浏览器跑完 + 重载」，未涉及解析 Turnstile 载荷或伪造 cookie。
- 一次早期跑动里 B 变体出现过一次 `ERR_FAILED (-2)`，随后进程无报告退出；用独立 partition 重跑即正常（`-3` 是重载中断）。判断为 partition 复用下的偶发，未纳入结论。

## 复现

```bash
node .multi-agent/evidence/electron-45-cf-2026-11-02/cf-probe.mjs
# 结果：cf-report-{A,B,C}.json + cf-summary.json + cf-probe.log
```
