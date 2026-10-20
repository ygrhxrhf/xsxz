# pstack 流程实测：整站镜像「撞墙停批」（2026-10-20）

结论先行：playbook 的**结构**是跑通的，8 步都有落点、有产物、有验证。**执行面**不顺畅，三处系统性降级：`code` 座位连续失败、无 `gh` 的 PR 只能产出正文、审查期间工作区被**第三方写者**改写并最终改坏（build 红）。所以答案是「骨架一致，执行不连贯」。

## 测法

- 入口：`pstack` → `poteto-mode` → 匹配 **Feature** playbook，按 8 步走，`todo_write` 原样抄步骤。
- 工作负载：真实增量，不是演练。整站镜像撞墙时不再空等下载锁 30 分钟，等锁期间取消 1 秒内生效。
- 记录每步的产物、耗时、降级点与证据。所有命令都在本工作区跑过。

## 逐步对照

| 步骤 | 官方期待 | 实际发生 | 判定 |
|---|---|---|---|
| 0 路由 | 先读 poteto-mode，再选唯一 playbook | Feature 匹配成功；`todo_write` 抄了 8 步 | 顺 |
| 1 `how` | 简单范围一个 explainer，只读 | `pstack_task`（judgment）5 分 23 秒产出 266 行报告，含调用链、时序图、Gotchas；还发现两个真问题（30 分钟误杀长书、取消在等锁期无效且会多下一本） | 顺，且有超额价值 |
| 2 `architect` | 默认 arena 多模型并行设计 | 3 个候选的设计叉子表落盘（`.multi-agent/evidence/mirror-wall-design-2026-10-20.md`），未起 arena。port 允许「设计成本高于决策时写表」，这次成立 | 顺，但非官方原味 |
| 3 吞吐检查点 | 四项 todo | 合并成一条带四问的检查点；没有逐步展开成四个 todo。**这是本会话对 playbook 的偏离** | 部分 |
| 4 委派实现 | 一个子代理写代码，父级审查 | 第一次 `code`（gpt-6-luna）71 秒 error，最后消息停在 `<think>`；换 `judgment` 149 秒成功，改 5 文件、+360/−100，自带单测与类型检查 | 不顺，但按 port 的降级规则收口 |
| 5 真表面验证 | 不许拿「能编译」当通过 | typecheck 0；mirror 单测 21/21；全量 1234/1234；build 0；`mirror-e2e` 19/19（真起 Electron，撞墙 5917ms 停批，第 4 本没下） | 顺 |
| 6 小步提交 | 每个可验证单元一个 commit | 我的提交计划是 2 个（行为+单测、端到端）。实际由第三方在 12:11:58 抢先提交成 1 个 `10efaa7`，把我的改名、报告、设计一起带进去了 | 不顺（并发写者） |
| 7 `interrogate` | 多模型对抗审查，lead 分桶 | A（judgment）24KB，0 critical / 8 warning / 5 nit；B（code）68 秒 error、无报告。收掉 12 条，1 条留作后续（目录页级整站拦截） | 部分（单模型） |
| 8 Opening a PR | 真 PR + 链接 | 本机无 `gh`，远端是 Gitee + SSH GitHub；只能产出 PR 正文与证据，没有伪造链接 | 降级（环境） |

## 数字与证据

- 实现规模：6 个文件（`mirror.ts` 重构成 `runOneBook`、`download.ts` 加 `waitForIdleSlice`/`getPausedForHuman`、`index.ts` 接线、契约、单测、e2e）。
- 单测：`npx vitest run` → 135 文件 / 1234 通过（12:08，提交前）。
- 端到端：`node scripts/mirror-e2e.mjs` → 19 项 PASS；撞墙任务 `status: error`、`skipped 2 / failed 1`、第 4 本未下载、5917ms 结束。
- 审查去重后收掉的高价值项：取消落点从「等锁后」挪到「目录页加载后」；停批收尾等待从 30 分钟改成 5 秒；撞墙感知从「只认自己那本」扩到「任意 pausedForHuman」；等锁超时从逐本重来改成停批；`waitIdle` 不再用异常当控制流；文案不再嵌「点『我已处理好』」这种被取消后必然失败的指令。

### 干净工作树复核（隔离第三方改动）

主工作区被第三方改坏后，用 `git worktree add` 在 `fa194f1` 建隔离工作树复核同一份提交：

- `mirror.test.ts` 21/21。
- `download.test.ts` 撞墙探针 75 用例中目标用例通过。
- `npm run build` 退出 0。
- `node scripts/mirror-e2e.mjs` 19/19，撞墙停批 5842ms。
- 全量 1233/1234。唯一失败是 `aiReadingFollow` 的 `ENOTEMPTY` 临时目录竞态，单跑 14/14 通过；改动前的 PR 已把这条记为已知 flaky，与镜像无关。
- `typecheck` 在隔离路径被 tsc 的 `tsbuildinfo` 写入拒绝挡住（环境限制，不是源码问题）；主工作区 12:17 的 `npm run typecheck` 退出 0 覆盖同一份源码。

### 上一轮遗留审查与第三方改动

`review-b.md`（上一会话留下，未提交）列出 B1「镜像/下载互斥只有单向检查」、M1「`mirror-state.json` 非原子写」等。12:12–12:14 的第三方改动正是在补这些：`setExternalBusyProbe`、`atomicWriteText`、`before-quit` 里 `cancelMirror`、续跑过滤。它停在 `Browse.vue:1503` 的语法错误，属于半截工作，不能按「已完成」处理。

## 并发写者事件（最严重的不连贯）

| 时间 | 事件 |
|---|---|
| 12:08:45 | `src/main/download.test.ts` 被回退到 HEAD（我 12:04 加的断言消失） |
| 12:11:58 | 第三方以 `zmzzmz` 身份提交 `10efaa7 feat(mirror): 撞墙即停…`，把我的工作区、报告、设计一并提交；未包含我的 `download.test.ts` |
| 12:12:51–12:14:59 | 同一写者继续改 `index.ts`、`mirror.ts`、`library.ts`、`Browse.vue`、两份文档；新增原子写、退出取消、续跑过滤、借书库并发判定 |
| 12:17 | 当前工作区 `mirror.test.ts` 22 条里 2 条红（续跑过滤的新断言与实现不一致） |
| 12:20 | `npm run build` 失败：`Browse.vue:1503` JavaScript 表达式语法错误 |

这不是 pstack 的步骤问题，而是「一个 worktree 一个写者」假设被破坏。pstack 没有「冻结 diff / 工作区指纹」这一步，`opening-a-pr` 也假设分支独占。结果是：审查 A 明确记录行号漂移；我的验证只能绑定 `10efaa7`；`plan:status` 不可能绿；PR 正文不能覆盖未提交的第三方改动。

## 与官方期待的差距（按类别）

1. **座位稳定性**：`code`（gpt-6-luna）本会话 2 次失败（实现 1、审查 1），上一轮另记 2 次失败；`scout`（mimo）上一轮超时。多模型审查实际退化成单模型。
2. **PR 工具面**：`gh`、Origin 都不存在，step 8 没有等价的「创建 PR」动作；port 文档写了降级方式，playbook 没有写死。
3. **工作区独占**：pstack 全程假设一个写者；仓库自己的 `AGENTS.md` 反而有「出现来源不明的提交先停手对账」的规则，这次靠它才没有在坏树上继续加码。
4. **证据寿命**：`how` 报告按行号写，重构后全部失效；审查也按行号写，并发写者让行号漂移。pstack 的 `how` 没有「按符号引用」的约束。
5. **两套断点协议并存**：pstack 用 todo + playbook，仓库用 goal + `plan:status` + HANDOFF。二者不冲突，但同一条「收工」要过两套门，本次 `plan:status` 因第三方脏工作区必然失败。

## 建议（可复现的补丁）

1. Feature step 2 之后加「冻结工作区」：记录 `HEAD` + `git status --porcelain` 指纹；审查与提交前比对，不一致先对账。
2. `MODELS.md` 把 `code` 默认从 gpt-6-luna 换到稳定座位，或把实现默认给 `judgment`；`code` 连续 error 时自动降级，不再等父级发现。
3. `opening-a-pr` 在无 `gh`/Origin 时明确要求三件套：PR 正文文件、验证证据、不可合并声明。
4. `interrogate` 先落 `git diff > review-snapshot.patch`，审查者只认快照与符号名，不认行号。
5. `how` 报告引用「文件 + 符号」优先于行号；重构后重跑或标注快照。

## 判定

- 结构一致性：8/10。Feature 的八步与官方文档逐字对得上，产物也齐。
- 执行顺畅度：5/10。座位失败两次、审查只剩一个模型、PR 降级。
- 可复现性：4/10。第三方写者把最终工作区改到 build 红，验证只能绑定被抢先提交的 `10efaa7`。

一句话：pstack 的 playbook 适合这个仓库，但需要补「工作区冻结」和「座位降级」两条硬规则，否则流程会在并发写者与模型故障处断掉。
