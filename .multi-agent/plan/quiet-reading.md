# quiet-reading-20261023 验证计划

切片状态唯一来源：../dev-plan.md。此处只记录最终收工检查，不以 worktree 提交或旧样板代替验收。

- [x] U1.1 默认收起与点按：验 npm run build、npm test、合入后 npm run e2e:reader → 全部退出码 0；OP-1–OP-5 达到（重入缺陷经 677cbe7 修复后由 U1.1-op-2 的 OP-1R 复拍确认）。
- [x] U1.2 按章拖动：验 npm run build、npm test、合入后 npm run e2e:reader → 全部退出码 0；OP-6–OP-7 达到。
- [x] U1.3 段落翻屏：验 npm run build、npm test → 退出码 0；OP-8 达到，超长段不跳过、连续滚动不吸附。
- [x] U1.4 渲染层净化：验 npm run build、npm test、合入后 npm run e2e:reader → 退出码 0；OP-9–OP-11 达到，六文件 hash 全程未变。
- [x] U1.5 下载进度露出：验 npm run build、npm test、合入后 npm run e2e:reader → 本刀自身断言通过；OP-12 达到。续读提示断言的观测窗缺陷已由 U1.5-toast-probe 实测归因，不属产品回归。
- [x] U1.6 偏好兼容：验 npm run build、npm test → 退出码 0；OP-13–OP-14 达到，旧文件缺字段补 true 已锁定。
- [x] 默认分支最终复验：验 git rev-parse HEAD、npm run build、npm test、npm run typecheck、npm run e2e:reader、npm run e2e:mirror → HEAD 1d46396 合并远端后，build 0、test 0（136 文件 1291 用例，连续两次）、typecheck 0、e2e:reader 11/11、e2e:mirror 19/19，证据见 test-reports/FINAL-verify-merged.md 与 U1.6-test-reconfirm.md。
- [x] 收工自检：账本与证据已全部提交；plan:status 仅剩「已授权推送」一项未勾。
- [x] 已授权推送：HEAD 与 origin/master 同为 8c3f9900f20100fe63047853d19d54cfc24e4b58，push 退出码 0（da60097..8c3f990），未 force；证据 test-reports/push-final.md。

## 已有证据

- 全部切片 done，master 依次为 1b86a79 → 995e69d → 09f165a → 35002d1 → 33e1401 → 2944406 → 2e7db64。
- 真实操作验收证据目录：evidence/U1.1-op-1、U1.1-op-2、U1.2-op-1、U1.3-op-1、U1.4-op-1、U1.5-op-1、U1.6-op-1。
- 最终验证：test-reports/FINAL-verify.md（build 0、test 0 共 1289 用例、e2e 11/11、typecheck 0）。
