# 主日志

> 专家组追加。顾问只建空日志。

| 时间 | 事件 | 证据 |
|---|---|---|
| 2026-10-23 | 顾问封板 quiet-reading-20261023。样板已确认，无人值守。替换已完成的 weread-shell | objective.md scheme.md sweep.md |
| 2026-10-23 | 专家组对齐账本。objective 改为进行中。HEAD 刷新为 8997870。下一刀 U1.1 | objective.md readiness.md world.md |
| 2026-10-23 | 补完成定义映射后派 U1.1。子代理 5489a0dd | expert-board.md |
| 2026-10-23 | U1.1 ff-only 合入 master 1b86a79。readiness 改 PENDING。E2E 与 OP-1 至 OP-5 未跑 | dev-plan.md readiness.md |
| 2026-10-23 | 补 U0.1 验证修复切片，关闭全量契约的两条既有平台失败。修后 npm test 退出码 0 | test-reports/U0.1-commit.md |
| 2026-10-26 | U1.1 合入后复验：OP-2/3/4/5 达到，OP-1 重入路径未达到，退回返工（尝试 1/3） | evidence/U1.1-op-1/OP-1.md |
| 2026-10-26 | 重入缺陷修复 677cbe7（ResizeObserver 判本页重新可见）。U0.1 与启动参数 1c0dc91 一并 ff-only 到 995e69d；合入后 e2e 11/11、OP-1R 达到 | evidence/U1.1-op-2/OP-1R.md |
| 2026-10-26 | U1.2 按章拖动 09f165a 合入；OP-6/OP-7 达到 | evidence/U1.2-op-1/ |
| 2026-10-29 | U1.3 段落翻屏 35002d1 合入；OP-8 达到，超长段不跳过 | evidence/U1.3-op-1/ |
| 2026-10-29 | U1.4 渲染层净化 33e1401 合入；OP-9/10/11 达到，文件 hash 未变 | evidence/U1.4-op-1/ |
| 2026-10-29 | U1.5 下载露出 2944406 合入；OP-12 达到。e2e 续读提示失败经实测归因为脚本观测窗缺陷，非产品回归 | test-reports/U1.5-toast-probe.md |
| 2026-10-29 | U1.6 两偏好字段 2e7db64 合入；OP-13/14 达到。最终验证 build 0、test 0（1289 用例）、e2e 11/11、typecheck 0 | test-reports/FINAL-verify.md |
