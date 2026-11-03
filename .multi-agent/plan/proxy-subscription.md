# 计划：订阅模式（内置代理内核，只需一条订阅链接）

> 状态：**代码已完成并全部测试通过**；内核二进制需用户侧下载（本机 GitHub 限速，见「未验证项」）。

## 背景

用户手里只有一条订阅链接（`https://api2.yunfan.app/s/...`），机器上没有任何代理客户端。
上一轮做的「手动填本地端口」对此无效——没有客户端就没有本地端口。

订阅实测：88 个真实节点，协议为 `hysteria2 30 / tuic 23 / vless 21 / anytls 14`。
前三者是 UDP 系协议，v2rayN 的支持视版本而定；sing-box 对四种都是原生支持，
因此选它作为内置内核。

## 目标

用户只做一件事：粘贴订阅链接 → 点「连接订阅」→ 浏览与下载自动走代理。

## 步骤

- [x] 1. 协议调研：确认订阅里四种协议的 URI 参数集
      - 验：`anytls[sni,insecure] / vless[encryption,flow,fp,mode,pbk,security,servername,sid,sni,spx,type] / hysteria2[sni,insecure] / tuic[alpn,congestion_control,insecure,sni,udp-relay-mode]`
- [x] 2. `src/main/subscription.ts`：订阅正文解码 + 节点 URI 解析 + sing-box 配置生成
      - 验：`npx vitest run src/main/subscription.test.ts` → 27/27
      - 验：用真实订阅跑 → **86 节点**，四协议全中，公告行被正确过滤
- [x] 3. `src/main/proxyKernel.ts`：内核进程管理（挑端口 / 写配置 / 拉起 / 等监听 / 停止）
      - 验：`npx vitest run src/main/proxyKernel.test.ts` → 12/12
- [x] 4. `src/main/proxyRuntime.ts`：生命周期所有者（订阅→内核→会话），含正文缓存
      - 验：`npx vitest run src/main/proxyRuntime.test.ts` → 12/12
- [x] 5. 类型：`ProxyMode` 加 `'subscription'`；`ProxyPrefs` 加订阅字段；新增 `ProxyKernelState` / `ProxySubscriptionState`
      - 验：`npm run typecheck` → 0
- [x] 6. IPC：`proxy.subscribe` / `parseSubscription` / `selectNode` / `kernelState` / `stopKernel`
      - 验：`npx vitest run src/preload/ipcContract.test.ts` → 5/5
- [x] 7. 界面：模式选择加「订阅（内置内核）」；订阅地址输入、连接按钮、内核状态灯、节点下拉
      - 验：`npx vitest run src/renderer/pages/Settings.ui.test.ts` → 7/7
- [x] 8. 退出清理：`before-quit` 里 `stopSubscriptionProxy()`，避免孤儿进程占端口
      - 验：`grep -n "stopSubscriptionProxy" src/main/index.ts`
- [x] 9. 契约文档 + 全量验证
      - 验：`npm run build` → 0；全量 `npx vitest run src --exclude '.delta/' --exclude '.qoder/'` → 142 文件 / 1420 用例全绿
- [x] 10. 真实端到端：本机跑起内核并访问目标站
      - 验：sing-box 1.14.4 下载完成（32891280 字节）；四份配置全部通过 `sing-box check`
      - 验：四协议真机连通，出口 IP 分别为 156.239.241.66 / 104.233.144.164 / 152.175.38.28
      - 验：`alicesw.com` 经代理返回 200，项目 Electron 会话加载到真实内容（标题「爱丽丝书屋」）
      - 验：`uaa001.com` 返回 403 挑战页（网络已通，剩站点策略）
- [x] 11. 修 REALITY 缺 utls 导致 sing-box 拒绝启动
      - 验：修复前 `check` 报 `FATAL uTLS is required by reality client`；修复后 exit=0
      - 验：`npx vitest run src/main/subscription.test.ts` → 29/29
- [x] 12. 修 closeAllConnections 打崩 network service
      - 验：复现矩阵确认「改代理 + 立刻 close」崩 2 次，加 300ms 等待后 0 次
      - 验：真实场景复验：崩溃 0 次，断连后会话仍 HTTP 200
      - 验：`npx vitest run src/main/proxy.test.ts` → 34/34

## 不做（显式出范围）

- 不做订阅自动更新（定时拉取）：一期只按用户点击拉。
- 不做多节点负载均衡 / 自动选最快：单节点，换节点靠重启内核。
- 不做 Clash / sing-box 原生 JSON 订阅的解析：只认 base64 的分享链接列表，
  JSON 订阅会在解析阶段被判为「没有可用节点」。
- 不随安装包分发内核二进制：体积与更新频率都不合适，且第三方分发的内核无法保证可信。

## 关键设计决定

- **内核只认官方 GitHub Release**：代理内核是整条链路的信任根，从第三方镜像拿等于把
  节点凭据交给镜像方。下载慢是用户网络问题，不由我们「优化」。
- **换节点 = 重启内核**：几百毫秒，比维护热重载状态机可靠得多。
- **订阅正文缓存放主进程**：机场订阅接口有频率限制，换节点不该重拉。
- **只监听 127.0.0.1**：不对外暴露端口。
- **用「端口是否开始监听」判启动成功**：sing-box 没有 readiness 信号，
  这是唯一可靠的观测点；失败时把内核最后几行输出带进错误信息，
  否则「点了没反应」最难查。
- **公告行按节点名过滤**：机场会把「剩余流量 / 到期时间」塞成节点，它们有真实地址但没意义。

## 实测结果（2026-11-03，全部已验证）

| 项目 | 结果 |
|---|---|
| sing-box 1.14.4 下载 | 32891280 字节，`with_quic` / `with_utls` 齐全 |
| 四份配置 `sing-box check` | 全部 exit=0 |
| hysteria2 | Google 302，出口 156.239.241.66 |
| tuic | Google 302，出口 156.239.241.66 |
| anytls | Google 302，出口 104.233.144.164 |
| vless (REALITY) | Google 302，出口 152.175.38.28 |
| alicesw.com 经代理 | **200**，项目会话加载到 71716 字节真实内容 |
| uaa001.com 经代理 | 403（Cloudflare 挑战页，网络已通） |

## 过程中发现并修掉的两个真实缺陷

1. **REALITY 缺 utls**：sing-box 强制要求 uTLS，缺这段直接
   `FATAL "uTLS is required by reality client"` 拒绝启动。分享链接常不带 `fp`，
   原代码 `params.fp ? {...} : undefined` 会省略整段。已改为默认 `chrome`。
2. **closeAllConnections 打崩 network service**：代理指向已死进程时，
   「改代理 + 立刻断连」会让 network service 崩溃，会话不可用。已加 300ms 等待。

## 仍未验证

- 长时限运行下的稳定性（只做了单次连通验证）。
- 订阅自动更新、多节点测速未实现。

## 用户侧完成步骤

1. 下载 `sing-box-1.14.4-windows-amd64.zip`（GitHub `SagerNet/sing-box` Releases）。
2. 解压出 `sing-box.exe`，放到 `%APPDATA%\spbf\proxy-kernel\`。
3. 设置 → 网络代理 → 选「订阅（内置内核）」→ 贴订阅链接 → 连接订阅。
