# 计划：整站镜像（分类页 → 批量入书库）

> 状态：**已实现并验证**，剩「推送 + 开 PR」未做。收工判据见 `.multi-agent/HANDOFF.md`。

## 目标

在浏览页打开分类 / 作者 / 搜索结果页，一次把列表（含同源「下一页」）里的书批量下进书库；已完整入库的按 `sourceUrl` 跳过；取消或进程中断后能接着上次继续。

## 步骤

- [x] 1. 调查：mirror / library index / 下载锁三处现状
      - 验：`docs/ipc-contract.md`「整站镜像」一节与 `src/main/download.ts` 单任务锁一致
- [x] 2. 设计：并发发现 + 跳过已入库 + 可恢复队列的形状
      - 验：契约里写明「列表页串行翻页、书目页用独立预取视图、下载串行」
- [x] 3. 吞吐检查点：阻塞项 / 共享可变状态 / 最小安全拆分
      - 验：单隐藏视图不能并发导航 → 预取拆独立视图 + `serialQueue` 串行
- [x] 4. 实现：发现、sourceUrl 跳过、队列恢复、UI 抽屉
      - 验：`npm run typecheck` → 0
- [x] 5. 真实表面验证
      - 验：`npx vitest run` → 135 文件 / 1236 用例全通过
      - 验：`npm run build` → 0
      - 验：`node scripts/mirror-e2e.mjs` → 19 项全 PASS（含撞墙 6 秒内停批）
- [x] 6. 小单元提交（本地领先 `origin/master` 5 个 commit，功能共 20 个）
      - 验：`git log --oneline origin/master..HEAD`
- [x] 7. 审查：两个模型出报告，收掉真问题
      - 验：`deepseek-flash`（judgment，5 条）、`mimo-v2.6-flash`（scout，审查 B：1 BLOCKER + 1 MAJOR + 6 MINOR）；`gpt-6-luna` 两次运行时错误未产出
      - 已修：预取视图并发读错页（`d9b56f6`）、预取视图不释放、开跑前不复检下载锁（`7b7a5c6` + `f5d49e5`）、双向互斥 + 状态原子写 + 退出取消（`0ee14e6`）、旧索引先重建（`e8c34da`）、续跑只跑没做完的（`ff38d38`）
      - 不修：`seedUrl` 仅前缀校验——评估为不引入新的 SSRF 面（报告 m6）
- [x] 8. 交付物：PR 正文（本机无 gh）
      - 验：`.multi-agent/pr-mirror-2026-10-20.md`、`.multi-agent/pr-mirror-wall-2026-10-20.md`

## 不做（显式出范围）

- 跨域、站内搜索接口、代登录、并发下载、多列表页并发
- 撞墙自动解锁：不做，改为撞墙即停、提示「继续上次」

## 已知边界

- 撞墙（登录 / 付费 / 拦截）时本批 1 秒内停批，不再干等 30 分钟；要处理墙得用户自己来
- 与下载双向互斥：镜像进行中不能下载单本 / 检查更新，反之亦然
- 书目发现是启发式（同源 + 路径特征打分），新站可能漏书

## 断点记录（每次停下前更新）

- 状态：代码已提交（本地领先 `origin/master` 5 个 commit）、未推送
- 下一步第一条命令：`git push gitee master`（GitHub 走 SSH，按需选远端）
- 未验证项：真实站点上的镜像（只验了本地夹具站）
