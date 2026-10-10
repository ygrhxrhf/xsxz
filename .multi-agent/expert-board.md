# Expert Board

> 记录实现、测试和只读专家任务；交付切片状态只在 dev-plan.md 维护。

- 模式：campaign
- 战役 ID：weread-shell-20260322

| ID | 坐标 | 状态 | 负责人 | 结果 |
|---|---|---|---|---|
| W1.1-impl-1 | W1.1 | cancelled | subagent_implement | 无改动无提交 |
| W1.1-impl-2 | W1.1 | reported | subagent_implement | commit 9e186de，自测 settings 28 PASS |
| W1.1-diag-1 | W1.1 | cancelled | subagent_local | 实现已落地，诊断作废 |
| W1.1-test-build | W1.1 | cancelled | subagent_test | 未留下报告 |
| W1.1-test-contract | W1.1 | superseded | subagent_test | PASS 但打在 9e186de，不是最终 f2feacc |
| W1.1-test-build-2 | W1.1 | cancelled | subagent_test | 无报告 |
| W1.1-test-contract-2 | W1.1 | accepted | subagent_test | PASS @ f2feacc，28 tests，退出码 0 |
| W1.1-test-build-3 | W1.1 | superseded | subagent_test | SKIP：safe-delete，非代码失败 |
| W1.1-test-build-final | W1.1 | accepted | subagent_test | PASS npm run build 退出码 0，目标 9e186de；f2feacc 仅测试差异 |
| W1.2-impl-1 | W1.2 | cancelled | subagent_implement | 无提交，仅临时 vite 配置 |
| W1.2-impl-2 | W1.2 | cancelled | subagent_implement | 无提交无产品 diff |
| W1.2-diag-1 | W1.2 | cancelled | subagent_local | 未返回；协调者自行读壳层 |
| W1.2-impl-3 | W1.2 | cancelled | subagent_implement | 无提交无产品 diff |
| W1.2-diag-1 | W1.2 | reported | subagent_local | 方案可做；代表页只改 Reader.vue |
| W1.2-diag-2 | W1.2 | cancelled | subagent_local | 被 diag-1 覆盖 |
| W1.2-impl-4 | W1.2 | reported | subagent_implement | 未提交；顶栏半截，缺书脊和底栏 |
| W1.2-impl-4b | W1.2 | cancelled | subagent_implement | 未提交改动被 checkout 清掉 |
| W1.2-impl-5 | W1.2 | cancelled | subagent_implement | 未提交，改动曾丢失 |
| W1.2-impl-6 | W1.2 | reported | subagent_implement | 工作区完成线框但未提交 |
| W1.2-commit | W1.2 | accepted | 协调者 | 仅提交 Reader.vue e360377 |
| W1.2-test-contract | W1.2 | superseded | subagent_test | 工作区不干净时 SKIP |
| W1.2-commit-2 | W1.2 | accepted | 实现 | ee8529b 标签对齐；86db254 书脊与取消函数 |
| W1.2-contract-direct | W1.2 | accepted | 协调者降级代跑 | 53 PASS，退出码 0，HEAD 86db254 |
