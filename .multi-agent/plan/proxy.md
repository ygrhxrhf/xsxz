# 计划：应用内代理（浏览 / 下载共用出口）

> 状态：**已实现并验证**。收工判据见 `.multi-agent/HANDOFF.md`。

## 背景

用户不想为了两个站常开系统代理。整机代理会把所有软件（系统更新、其它应用）都绕出去，
而实际需求只是「让这个小说浏览器走那条线」。项目里此前**没有任何代理相关代码**，
`novelSession()` 只设了 UA。

## 目标

1. 设置里能选「直连 / 跟随系统 / 手动指定（http、https、socks4、socks5）」。
2. 代理只作用于浏览与下载共用的 `persist:novel` 分区，一处设置两处生效。
3. 保存后立即生效，不需要重启。
4. 支持代理认证（用户名密码，密码加密保存），不回传明文。
5. 能一键测试连通性，且测试走真会话。

## 步骤

- [x] 1. 现状确认：`novelSession()` 是唯一会话入口、`settings.ts` 的存取模式、preload 白名单
      - 验：`grep -n "novelSession()" src/main/index.ts` → 4 处调用点
- [x] 2. 新增纯逻辑模块 `src/main/proxy.ts`（规范化 / 规则生成 / 应用 / 判定）
      - 验：`npx vitest run src/main/proxy.test.ts` → 29/29
- [x] 3. 类型与持久化：`ProxyPrefs`、`Settings.proxy`、`SettingsUpdate.proxy/proxyPassword`
      - 验：`npx vitest run src/main/settings.test.ts` → 45/45（含 6 条代理用例）
- [x] 4. 接入会话：启动时应用、`settings.set` 后重新应用、`app` 级 `login` 事件回答代理认证
      - 验：`npm run typecheck` → 0
- [x] 5. IPC：`proxy.test` 走真会话加载目标，只判有没有 HTTP 响应
      - 验：`npx vitest run src/preload/ipcContract.test.ts` → 5/5
- [x] 6. 设置界面「网络代理」区块
      - 验：`npx vitest run src/renderer/pages/Settings.ui.test.ts` → 7/7
- [x] 7. 契约文档：字段表、生效语义、`proxy.test`、SOCKS5 远端 DNS 说明
      - 验：`grep -n "代理（内置浏览 / 下载）" docs/ipc-contract.md`
- [x] 8. 真实链路验证：本地起转发型 HTTP 代理，确认 Electron 真的走它
      - 验：探针结果 `resolvedTarget: PROXY 127.0.0.1:38084`、`resolvedLocal: DIRECT`、
        `connects: ["example.com:443"]`、`title: "Example Domain"`、切回 direct 后 `DIRECT`
- [x] 9. 本机端口自动探测（`proxy.scan`）：用户装了客户端却不知道本地端口开在哪
      - 验：`npx vitest run src/main/proxyScan.test.ts` → 10/10
      - 验：真实探针（起监听 10808/7890 → 扫到 → 关闭 → 消失）
- [x] 10. 收工自检
      - 验：`npm run typecheck` → 0；`npm run build` → 0；
        全量 `npx vitest run src --exclude '.delta/' --exclude '.qoder/'` → 138 文件 / 1359 用例全绿

## 不做（显式出范围）

- 不做 PAC 脚本编辑、不做代理链 / 分流规则引擎。
- 不做「只对某个域名走代理」的规则表：`bypass` 已经是 Chromium 原生语义，够用。
- 不改系统代理设置（`netsh winhttp` / 注册表）：那是用户机器的事，本应用只改自己会话。
- 不给下载单独一套代理：浏览与下载必须同出口，否则「浏览能开、下载下不了」更难排查。

## 关键设计决定

- **默认 `off` 而不是 `system`**：缺省直连。默认跟随系统会让没配代理的用户莫名多一层，
  也让「我明明没开代理」变成假话。
- **`off` 用 `direct://` 而不是空 rules**：空 rules 在 Chromium 里等于跟随系统。
  要表达「连系统代理都不走」必须显式 `direct://`。
- **应用后必须 `closeAllConnections()`**：`setProxy` 只影响之后的新连接，
  不断旧连接会出现「改了设置但还要开系统代理才生效」。
- **SOCKS5 是远端 DNS**：本地 DNS 已被污染的站必须用这条，只改 IP 没用。
- **`proxy.test` 用真会话**：裸 fetch 走 Node 的栈，验不出「这个会话能不能通」。
- **`passwordConfigured` 只读**：让渲染层提交的布尔值落盘，等于允许伪造「已配密码」。

## 已知边界

- 需要真人点击的验证页，代理层面无能为力（那是站点策略，不是网络）。
- 代理本身不可达时，应用不会崩，只是访问不了需要代理的站；`测试连通` 会给出原因。
- HTTP 代理只覆盖 http/https 流量；本应用不涉及其它协议。
