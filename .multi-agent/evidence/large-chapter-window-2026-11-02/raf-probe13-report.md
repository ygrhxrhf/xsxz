# 大章迁窗修复 e02995a 手动回归证据（raf-probe13）

- 日期：2026-11-02
- 基线：`e02995a`（fix(reader): 大章迁窗落进占位间隙时按目标段真实几何补偿）
- 环境：Windows 真 Electron 窗口 + CDP 驱动（复用 probe-window 骨架，非 mock）
- 结果：**9 项通过 / 0 项失败**

## 回归范围

修复只动 `recenterWindowTo`（占位估算 / 窗口定位），以下四个功能路径必须零回归：

| # | 功能路径 | 探针断言 | 结果 |
|---|---|---|---|
| 1 | 压暗遮罩 | 背景面板含「屏幕压暗」滑块；`dim=50` 时遮罩 `opacity=0.5`、`pointer-events:none`、`aria-hidden=true` | PASS |
| 2 | 睡眠模式（定时停止 UI） | 朗读面板有「定时停止」select 且可切到 10 分钟 | PASS |
| 3 | 目录抽屉 | 抽屉可打开、可关闭（`.n-drawer` 卸载） | PASS |
| 4 | 屏幕翻页 | 可切到屏幕翻页模式；空格 keydown 后 scrollTop 前移（delta=139 @ clientH=690） | PASS |
| 5 | 大章窗口有界 | 翻页后 `.para[data-p]` 节点 240 个（240/2600 段），迁窗补偿未破坏 | PASS |

## 探针修正过程（两次吞键根因）

初始 7/8，翻页 delta=0。诊断注入确认：空格 keydown 已到达 `window` 监听器（`reachedWindow=true`），`before=2 after=2`，但 scrollTop 不动。

1. **根因一（面板）**：切完屏幕翻页模式后字体面板仍开着，`activeBottomPanel !== null` → `anyDrawerOpen()` 为 true → `resolveReaderKey` 对空格返回 null（仅 Escape 放行）。修正：翻页前先收起字体面板，断言 `.bottom-panel` 卸载。
2. **根因二（抽屉未关，真正拦路）**：目录抽屉关闭按钮选择器 `.n-drawer-header__close` 落空，`showDrawer` 仍为 true → `anyDrawerOpen()` 恒真。诊断证据：`anyDrawer: true`。修正：关闭按钮失败则再点底部「目录」按钮 toggle（真实用户路径），并断言 `.n-drawer === null`。
3. **smooth 滚动异步**：`pageByScreen` 用 `behavior:'smooth'`，固定 sleep 600ms 不足；改为轮询等 `scrollTop` 前移（≤2.5s）。

## 证据

- 探针：`raf-probe13.mjs`（本目录）
- 最终输出：

```
PASS  背景面板打开且含屏幕压暗滑块  — hasDim=true slider=true
PASS  压暗遮罩元素渲染（dim=50）且 pointer-events:none + aria-hidden  — opacity=0.5 pe=none
PASS  朗读面板有「定时停止」下拉
PASS  「定时停止」可切到 10 分钟  — value=10
PASS  目录抽屉打开
PASS  目录抽屉已关闭
PASS  可切换到屏幕翻页模式  — clicked
诊断翻页: {"reachedWindow":true,"before":2,"after":2,"screenActive":null,"bottomPanelPresent":false,"anyDrawer":false,"activeBottomPanelText":null,"scrollH":171808,"clientH":690,"paraCount":240}
PASS  翻页后 scrollTop 前移  — delta=139 clientH=690
PASS  翻页后大章窗口节点有界  — nodes=240 min=0 max=239

结果：9 项通过，0 项失败
```

## 结论

e02995a 修复对睡眠模式、压暗遮罩、目录抽屉、翻页四条路径零回归；翻页后大章窗口 240 段连续、有界。手动回归完成。
