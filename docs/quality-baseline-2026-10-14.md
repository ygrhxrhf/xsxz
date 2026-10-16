# 质量基线（2026-10-14）

## 范围

本记录对应当前 `master` HEAD `44a4501`，用于后续修复的回归对照。当前工作区在基线执行前保持干净。

## 环境

- Node.js：`v24.20.0`
- npm：`11.19.0`
- 依赖安装：`npm ci`（项目目录 `xsxz`）成功
- 直接依赖：通过 `npm ls --depth=0` 核对
- 安装提示：`npm audit` 报告 20 个漏洞（10 moderate、10 high），本轮不升级依赖，后续单独评估

## 命令结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | PASS | 主进程、preload、renderer 类型检查通过 |
| `npm run build` | PASS | main、preload、renderer 均成功构建 |
| `npm test` | FAIL | 完整测试退出码为 1；当前不能宣称全绿 |
| `git diff --check` | PASS | 基线期间无源码差异 |

## 测试规模

当前源码中有 121 个测试文件。仓库旧文档中的“121 个文件 / 1076 个用例全绿”已过期：测试文件数量仍为 121，但完整测试当前失败。

## 已确认失败

测试文件：`src/main/settings.test.ts`

测试名称：`keeps both disk and cache at the previous value when commit fails`

现象：

- 测试通过 `setAtomicWriteBeforeCommitForTests` 注入 `disk full`。
- 测试期望 `updateSettings({ model: 'new-model' })` reject。
- 当前实际结果为 Promise resolve，并返回包含 `model: 'new-model'` 的设置。
- 因此测试还验证到：提交失败时磁盘和内存缓存未保持旧值，属于需要继续调查的原子持久化问题，而不是应忽略的过期 UI 断言。

涉及代码：

- `src/main/settings.test.ts`
- `src/main/settings.ts`
- `src/main/atomicFile.ts`

当前暂不在基线阶段修复，后续作为第一个回归修复项处理。

## 当前分类结论

1. **可通过基线**：`typecheck`、`build`。
2. **阻塞主干的真实问题**：设置文件原子提交故障注入场景未按契约失败。
3. **已排除**：当前工作区未提交改动、格式差异和基本 Node/npm 版本异常。
4. **尚未验证**：Windows 10/11 打包版、真实站点编码兼容性、完整 GUI 验收。

## 后续规则

每个修复至少需要：

1. 先复现对应失败或用户场景；
2. 增加或更新聚焦测试；
3. 运行相关聚焦测试；
4. 运行 `npm run typecheck` 和 `npm run build`；
5. 在宿主时间限制允许时运行完整 `npm test`，否则按测试组拆分并记录未覆盖范围；
6. 检查 `git diff --check` 和最终差异。

---

## 复核更正（2026-10-16）

上面「已确认失败」与「当前分类结论」里有两条作废：

- **`settings.test.ts` 的失败不是产品缺陷。** 真因在测试侧：mock 的 `app.getPath` 返回 POSIX 串 `/tmp/spbf-settings-test`，而 `settingsPath()` 经 win32 的 `path.join` 得到 `\tmp\spbf-settings-test\settings.json`（反斜杠），故障注入的判据是严格相等 `path === SETTINGS_FILE`（正斜杠），永不命中 → 注入的 `disk full` 从未触发，`updateSettings` 合法 resolve。把路径分隔符归一后该断言立即通过，`atomicFile.ts` 的原子落盘语义本身正确，无需改动。
- 用例总数已变：现为 **122 个测试文件 / 1091 个用例**（原文的 121 / 1076 已过期）。

在干净 HEAD（`44a4501`，stash 掉当时未提交的改动）与本机工作区分别复核，失败集合一致，均为本机环境所致、与被测改动无关：

| 失败用例 | 原因 |
|---|---|
| `src/main/settings.test.ts` 原子提交故障注入 | win32 `path.join` 反斜杠 vs 正斜杠常量 |
| `src/main/libraryPath.test.ts` | `defaultLibraryPath` 用宿主 `join`，传 `'linux'` 也拼出反斜杠 |
| `src/preload/ipcContract.test.ts` | 文档围栏 ```` ```ts\n ```` 撞上检出为 CRLF 的 `ipc-contract.md` |
| `Settings.ui.contract.test.ts`、`visualShell.contract.test.ts`、`aiAssistantBudget.ipc.contract.test.ts` | 断言 `.vue` 源码里的 `\n`，而本机检出为 CRLF |

上述 6 条已全部按测试侧修复（行尾归一、分隔符归一、按入参平台拼路径），修后 6 个文件 54 条用例全绿，`npm run typecheck` 仍 PASS。

另记录一次波动：本机首次全量运行出现 13 条失败（含并发/超时类），复跑降为 6 条；那批多出来的失败未逐条定位，排查时不要把它当成本次改动的回归。

