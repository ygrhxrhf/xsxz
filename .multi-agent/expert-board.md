# Expert Board

> 记录实现、测试和只读专家任务；交付切片状态只在 dev-plan.md 维护。

- 模式：campaign
- 战役 ID：quiet-reading-20261023

| ID | 坐标 | 状态 | 负责人 | 结果 |
|---|---|---|---|---|
| 5489a0dd | U1.1 | returned | implement | 10ea091。范围内。退回：工具显示时左右区不翻屏。不计尝试 |
| 454788b3 | U1.1 | returned-fixed | implement | 1b86a79。左右区在工具显示时仍翻屏。尝试仍 0/3 |
| U1.1-build | U1.1 | verified | test | npm run build 退出码 0。报告 U1.1-build.md。HEAD 1b86a79 |
| U1.1-contract | U1.1 | review-pending | test | npm test 退出码 1，两条失败。撤回过早 accepted-with-debt；待失败证据与诊断门槛齐备 |
| 0e0ab129 | U1.1 | returned | operate | master 1b86a79 真实窗口 PID3302921，OP-1–OP-5 九张 1280×771 截图与读数，33 份证据已归档 |
| 88c5617b | U1.1 | returned | judge | 图像工具不可用，五项均判证据不够，不构成达标 |
| 主 Agent 抽看 | U1.1 | finding | lead | 看图判定 OP-2/3/4/5 达到；OP-1 重入书架点书卡后顶栏与右侧胶囊仍显示，只有 reload 才隐藏。完成定义 1 未达到，退回返工，尝试 1/3 |
| d97129b5 | U0.1 | verified | local | 独立诊断：两条契约失败不满足 TEST_DEBT 门槛；win32 分支混用宿主 join 属实现问题 |
| U0.1 | U0.1 | review-pending | implement | libraryPath 用 win32.join/posix.join；backup 负例改受控 ENOENT 注入。build 0、npm test 0（135 文件 1237 用例）。报告 U0.1-implement.md。提交被门禁拦，暂存区待协调者提交 |
| U1.1-scope | U1.1 | verified | test | 仅 Reader.vue、readerHelpers.ts 与两份阅读测试。工作区干净 |
| U0.1-commit | U0.1 | verified | implement | 白名单四个文件已提交 b372375。npm test 退出码 0（135 文件 1237 用例） |
| 57e98768 | U1.1 | returned-fixed | implement | 重入缺陷修复 677cbe7：根元素 ref + ResizeObserver 判本页重新可见即收起工具，换书也复位。并发写者事件已由主 Agent 逐行核对 diff 澄清 |
| 104c053a | U1.1 | partial | implement | 独立复核 677cbe7 并复跑 build 0、test 0，追加报告 995e69d |
| U1.1-reentry-premerge | U1.1 | verified | test | HEAD 677cbe7，build 0、test 0（135 文件 1240 用例） |
| U1.1-e2e-postmerge | U1.1 | verified | test | master 995e69d，e2e 11/11、退出码 0 |
| U1.1-op-2 | U1.1 | verified | operate | OP-1R 复拍：重入后顶栏与胶囊全隐藏、书脊与正文在 |
| U1.2 | U1.2 | verified | implement | 09f165a，进度按章拖动并落章首。build 0、test 0 |
| U1.2-premerge / U1.2-contract-2 | U1.2 | verified | test | build 0；全量 test 首轮 ENOTEMPTY 竞态、复跑 0（1247 用例） |
| U1.2-e2e-postmerge | U1.2 | verified | test | master 09f165a，e2e 11/11 |
| U1.2-op-1 | U1.2 | verified | operate | OP-6/OP-7 达到，拖动中浮标显章名、失败章保留重试与去浏览页 |
| U1.3 | U1.3 | verified | implement | 35002d1，readerPager.ts 纯函数 + 段落对齐；三例单测 |
| U1.3-premerge | U1.3 | verified | test | build 0、test 0（1257 用例），范围仅四文件 |
| U1.3-op-1 | U1.3 | verified | operate | OP-8 达到；超长段一次前进一屏不跳段；连续滚动无吸附 |
| U1.4 | U1.4 | verified | implement | 33e1401，readerTail.ts R1–R5 渲染层整段净化，原始索引保留 |
| U1.4-premerge | U1.4 | verified | test | build 0、test 0（1270 用例）；无新增写盘路径 |
| U1.4-e2e-postmerge | U1.4 | verified | test | master 33e1401，e2e 11/11 |
| U1.4-op-1 | U1.4 | verified | operate | OP-9/10/11 达到，章节与 settings hash 全程未变 |
| U1.5 | U1.5 | verified | implement | 2944406，下载 running 强制露出并结束回收起 |
| U1.5-premerge | U1.5 | verified | test | build 0、test 0（1279 用例）；preload/shared/main/App.vue 零命中 |
| U1.5-e2e-postmerge | U1.5 | returned | test | e2e 10/11，失败项仅续读提示。两次复现 |
| U1.5-resume-toast | U1.5 | verified | local | 只读诊断：判定为脚本观测窗竞争，非 U1.5 回归 |
| U1.5-toast-probe | U1.5 | verified | test | 实测结论 A：arm 前提示已弹完；提前 arm 两次均 11/11；App.vue diff 为空 |
| U1.5-op-1 | U1.5 | verified | operate | OP-12 达到；取消后顶栏回收起；running 期间可手动收起 |
| U1.6 | U1.6 | verified | implement | 2e7db64，两偏好字段契约补丁 + 字体面板两开关 |
| U1.6-premerge | U1.6 | verified | test | build 0、test 0（1289 用例）；两字段缺省 true；preload 与 docs 零命中 |
| U1.6-op-1 | U1.6 | verified | operate | OP-13/OP-14 达到；settings.json 两字段持久化正确，重启后顶栏仍在 |
| U1.6-final | U1.6 | verified | test | master 2e7db64：build 0、test 0、e2e 11/11、typecheck 0；plan:status 待账本提交后复跑 |

上一战役 weread-shell-20260322 已完成，任务记录不沿用。
