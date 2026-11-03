# 计划：Cloudflare 挑战在 Electron 45 上的收尾

> 状态：**已完成并实测通过**（2026-11-03）。前置：`electron-45-upgrade` 已合并。

## 背景

挑战页战役的旧结论建立在 Electron 43 / Chromium 150 + **网络不通**之上，
当时把所有失败都归因于「Chromium 版本指纹」。Electron 45 合并后需要重测，
尤其是「网络通了之后挑战还挡不挡」。

## 目标

让 uaa001 / alicesw 两个站在「订阅代理 + 内置内核」下能自动进入正文。

## 步骤

- [x] 1. 确认合并状态：Electron 45.2.1 / Chromium 156 已就位
      - 验：`git log` 含 `ca6d844 chore(deps): Electron 45.2.1（Chromium 156）`
- [x] 2. 复测旧结论：Electron 45 + 代理下，隐藏视图能否过挑战
      - 验：**能过**，三种载体（可见窗口 / 可见视图 / 隐藏视图）各拿 47 链接 + `cf_clearance`
      - 验：但**全新分区**首访会卡住（60s 无 cookie）→ 说明还有别的变量
- [x] 3. 变量排查：先排除 UA 版本号（curl 三档 UA 全 403，不是它）
      - 验：`curl -A "Chrome/156|150|120"` → 全部 403，说明 UA 字符串不是决定因素
- [x] 4. 定位真因：会话 UA 是否被覆盖
      - 验：原生 UA → cleared=true / 47 links；覆盖 `Chrome/156.0.0.0` → cleared=false / 0 links
- [x] 5. 修正 `userAgent.ts`：默认不覆盖会话 UA
      - 验：`npx vitest run src/main/userAgent.test.ts` → 6/6
- [x] 6. 修正 `index.ts` 的 `novelSession()`：条件设置 UA
      - 验：`npm run typecheck` → 0
- [x] 7. 端到端复验（全新分区 + 隐藏视图 + 代理，与产品同路径）
      - 验：uaa001 26.0s 拿到 cookie / 54 链接；alicesw 13.8s / 259 链接
- [x] 8. 契约与收尾
      - 验：`npm run build` → 0；代理+UA 相关 6 个套件 103/103

## 根因

`browseUserAgent()` 把 UA 覆盖成了纯 Chrome 串，抹掉了 `Electron/45.2.1`
与完整补丁版本号 `156.0.8078.75`。UA 说「我是纯 Chrome 156.0.0.0」，
但 `navigator` 指纹暴露真实版本 —— **这种不一致被 Cloudflare 判为伪装**，
比如实暴露 Electron 更严。

## 不做

- 不伪造 `cf_clearance`、不解 Turnstile 载荷：只做「等真实浏览器跑完 + 重载」。
- 不引入 puppeteer/stealth 插件那一套指纹篡改：实测如实暴露反而最稳，
  篡改会引入新的不一致。

## 已知边界

- 全量测试里 6 个用例（`aiReadingFollow` / `aiEvidenceIndex` / `readingStats`）
  在并行高负载下会 TLE 超时，**单独跑全过**，与本次改动无关，属已知 flaky。
- 需要真人点选的挑战（interactive challenge）仍需人工，自动重试只覆盖自动放行的情况。
- 长时限稳定性未测。
