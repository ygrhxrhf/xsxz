# 交付切片

> 这是交付工作的唯一状态表。专家任务只记在 expert-board.md。专家组可以拆小切片，不能删完成定义，也不能加方案外的产品。

| 坐标 | 里程碑 | 行为事实 | 目标文件 | 验收标准 | 验证 | 状态 | 尝试 | 阶段 | 完成定义 |
|---|---|---|---|---|---|---|---|---|---|
| U0.1 | 验证修复 | 修复阻挡全量契约的既有平台语义与测试夹具：目标 win32 使用 win32.join；备份 ENOENT 用可控错误注入验证，不依赖真实 Q 盘 | src/main/libraryPath.ts, src/main/libraryPath.test.ts, src/main/backup.test.ts | 保留 Windows 家目录与缺失目录提示断言，npm run build 和 npm test 退出码 0。不改备份产品逻辑、不改真实书库 | build,contract | done | 0/3 | 独立 | 1–6 的验证前置 |
| U1.1 | A | 完成定义 1 与 2：有书时顶栏和右侧胶囊默认不可见，书脊仍在；点正文中区显隐工具，点左右翻屏；无书空态不变 | src/renderer/pages/Reader.vue, src/renderer/pages/readerHelpers.ts | OP-1 至 OP-5。验证 npm run build；npm test；npm run e2e:reader | build,contract,e2e | done | 1/3 | 独立 | 1 2 |
| U1.2 | A | 完成定义 3：底部进度按章拖动，松手打开该章章首；失败章停住；空列表正文显示「无法打开这一章」 | src/renderer/pages/Reader.vue, src/renderer/pages/readerHelpers.ts | OP-6 OP-7。验证 npm run build；npm test；npm run e2e:reader | build,contract,e2e | done | 0/3 | 独立 | 3 |
| U1.3 | A | 完成定义 4：点「屏幕翻页」后翻屏对齐段落；超长段前进不超过一屏；「连续滚动」不吸附 | src/renderer/pages/readerPager.ts, src/renderer/pages/Reader.vue | OP-8；单测三例。验证 npm run build；npm test | build,contract | done | 0/3 | 独立 | 4 |
| U1.4 | A | 完成定义 5：渲染层按 R1–R5 不显示整段尾巴；「本章显示原文」只对当前章、不写盘 | src/renderer/pages/readerTail.ts, src/renderer/pages/Reader.vue | OP-9 OP-10 OP-11。验证 npm run build；npm test；npm run e2e:reader | build,contract,e2e | done | 0/3 | 独立 | 5 |
| U1.5 | A | 完成定义 6：仅下载 running 时不点正文也能看见「已下」和「取消」；结束或取消后可再收起 | src/renderer/pages/Reader.vue | OP-12。验证 npm run build；npm test；npm run e2e:reader | build,contract,e2e | done | 0/3 | 独立 | 6 |
| U1.6 | A | 完成定义 5：ReaderPrefs 增加 hideReaderChrome 与 hideSiteTail，缺省 true；字体面板可关净化、可让工具一直显示 | src/shared/types.ts, src/main/settings.ts, src/renderer/pages/Reader.vue | OP-13 OP-14。验证 npm run build；npm test | build,contract | done | 0/3 | 契约补丁 | 5 |

状态：planned / ready / running / verified / integrated / done / blocked / skipped。下一刀取 `planned`。`verified` 只表示合入前抽查通过。`integrated` 只表示已合入待验，合入后 E2E 和画面复核通过才是 `done`。
尝试使用 0/3、1/3、2/3、3/3。第三次失败后先诊断，不能原样再派。`TEST_DEBT` 是附注，不是状态，也不能代替通过。

## 依赖与合入后证据

| 坐标 | 前置依赖 | 合入前证据 | 合入后证据 | 路径 | 附注/owner/关闭条件 |
|---|---|---|---|---|---|
| U0.1 | 无 | .multi-agent/test-reports/U0.1-implement.md 与 U0.1-commit.md：build 0，npm test 0（135 文件 1237 用例）。目标 commit b372375 | 已 ff-only 合入 995e69d。合入后 U1.1-e2e-postmerge.md 中 build 0 | 主路径 | 无界面；仅关闭全量契约的已复现平台失败，禁止削弱断言 |
| U1.1 | 无 | U1.1-build.md 退出码 0；U1.1-launcher-premerge.md 在 1c0dc91 上 build 0；U1.1-reentry-premerge.md 在 677cbe7 上 build 0、npm test 0（135 文件 1240 用例）；U1.1-scope.md 仅阅读页文件。目标 commit 995e69d | 已 ff-only 到 master 995e69d。U1.1-e2e-postmerge.md：build 退出码 0，e2e:reader 11/11 退出码 0。画面：U1.1-op-1 的 OP-2/3/4/5 达到；重入缺陷经 677cbe7 修复后 U1.1-op-2 的 OP-1R 达到（before 顶栏在、after 重入后顶栏与胶囊全隐藏、书脊与正文在） | 主路径 | 阅读页。不可 skipped |
| U1.2 | U1.1 | U1.2-premerge.md：build 0；U1.2-contract-2.md：npm test 0（135 文件 1247 用例）。范围仅 Reader.vue、readerHelpers.ts 与两份阅读测试。目标 commit 09f165a | 已 ff-only 到 master 09f165a。U1.2-e2e-postmerge.md：build 0、e2e:reader 11/11 退出码 0。画面 U1.2-op-1：OP-6 拖动中浮标「第 2 章」且松手后落第二章首段；OP-7 落失败章仍见失败说明与「重试失败章」「去浏览页」 | 主路径 | 不可 skipped |
| U1.3 | 无 | U1.3-premerge.md：HEAD 35002d1，build 0、npm test 0（135 文件 1257 用例），范围仅 readerPager.ts 与阅读页两份测试及 Reader.vue | 已 ff-only 到 master 35002d1。画面 U1.3-op-1：OP-8 翻页前第 10 段被屏底切断，翻页后 scrollTop 809 与该段 absTop 对齐、首句整行可见；超长第 14 段一次前进 723px 不超一屏不跳段；连续滚动 8 次每次 120px 单调无吸附 | 主路径 | 无 e2e 列，画面即主证据。不可 skipped |
| U1.4 | U1.1 | U1.4-premerge.md：HEAD 33e1401，build 0、npm test 0（135 文件 1270 用例），范围仅 readerTail.ts 与阅读页文件，无新增章节/annotations/tts/frontier 写入 | 已 ff-only 到 master 33e1401。U1.4-e2e-postmerge.md：build 0、e2e 11/11 退出码 0。画面 U1.4-op-1：OP-9 整段尾巴不可见（段落序号跳号）；OP-10「请收藏这封信」完整可见；OP-11 点本章显示原文后尾巴整段可见，换章后第二章尾巴再次不可见且开关回关，六文件 hash 全程未变 | 主路径 | 新建 readerTail.ts。不可 skipped |
| U1.5 | U1.1 | U1.5-premerge.md：HEAD 2944406，build 0、npm test 0（135 文件 1279 用例），范围仅 Reader.vue、readerHelpers.ts 与两份阅读测试，src/preload、src/shared、src/main、App.vue 零命中 | 已 ff-only 到 master 2944406。U1.5-e2e-postmerge.md：build 0，e2e:reader 首次 10/11，失败项仅续读提示。U1.5-toast-probe.md 实测确认：App.vue 启动即自动进 reader 并已完成唯一一次 loadBook 弹提示，脚本在点书卡后才装观察器故抓不到；提前安装后两次均 11/11，且 33e1401..2944406 的 App.vue diff 为空，与本刀无关。OP-12 画面待跑 | 主路径 | 不可 skipped。e2e 续读提示断言的观测窗缺陷记附注：命令 npm run e2e:reader 退出码 1 报告路径 .multi-agent/test-reports/U1.5-e2e-postmerge.md 与 U1.5-toast-probe.md owner：测试脚本 关闭条件：观察器提前到取得 CDP target 后安装并在仓库内脚本落地后该断言稳定通过 |
| U1.6 | U1.1 U1.4 | U1.6-premerge.md：HEAD 2e7db64，build 0、npm test 0（136 文件 1289 用例）；范围仅 7 个预期文件；DEFAULT_READER_PREFS 两字段均 true；preload 与两份 docs 零命中 | 已 ff-only 到 master 2e7db64。画面 U1.6-op-1：OP-13 关净化后回书库再开同书，整段站点尾巴可见且 settings.json reader.hideSiteTail=false；OP-14 开工具一直显示后杀进程重启同一 userData，再开书顶栏仍 visible 高度 56、hideReaderChrome=false | 主路径 | types.ts 与 settings.ts 只经协调者补丁，本刀已按该路径执行。不可 skipped |

路径只能是主路径或可跳过。主路径不能标 skipped。阶段只能是代表页、依赖代表页、独立。前置写切片坐标，没有则写无。合入前证据要写抽查过的报告路径；空着不能合入。TEST_DEBT 必须写成「命令：… 退出码：数字 报告路径：… owner：… 关闭条件：…」，空词不算。
