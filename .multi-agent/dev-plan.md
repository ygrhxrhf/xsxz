# 交付切片

> 战役 weread-shell-20260322。覆盖全部完成定义。W2 在代表页批准前不得开工。

## 项目信息

- 任务源：升级顾问 scheme.md（全量切片）
- 创建时间：2026-03-22
- 总子任务数：6

| 坐标 | 里程碑 | 行为事实 | 目标文件 | 验收标准 | 验证 | 状态 | 尝试 |
|---|---|---|---|---|---|---|---|
| W1.1 | W1 | Skin 改为 paper、white、night；旧 sakura 与 minimal 读入为 paper | src/shared/types.ts, src/main/settings.ts | 契约测试覆盖三值与两种旧值；无其他字段变化 | build,contract | integrated | 2/3 |
| W1.2 | W1 | 阅读代表页为暖纸正文、封面书脊、规定顶栏与底栏 | src/renderer/pages/Reader.vue | 有书时阅读区符合线框；背景切四种正文纸色；字体面板含现有排版项；目录可跳章；aria-label 仍在。旧全局侧栏留到 W2.4 | build,contract,e2e | integrated | 1/3 |
| W2.1 | W2 | 书架从书脊展开，封面打开，管理能力仍在 | src/renderer/pages/Library.vue | 继续读和浏览下载可见；检查更新、导入导出、回收站、失败章、每书编辑导出删除仍可到达 | build,contract,e2e | integrated | 1/3 |
| W2.2 | W2 | 浏览页纸面化，下载操作仍在 | src/renderer/pages/Browse.vue | 能输入网址、打开、下载本书、配置本站规则；网页仍在内置视图 | build,contract,e2e | integrated | 1/3 |
| W2.3 | W2 | 设置外观为暖纸、白纸、夜间并写入 skin | src/renderer/pages/Settings.vue | 三项可选；重启保持；旧值首次打开为暖纸；其余设置行为不变 | build,contract,e2e | integrated | 1/3 |
| W2.4 | W2 | 去掉夜樱装饰和四页同级大侧栏 | src/renderer/App.vue, src/renderer/styles.css | 无樱花装饰文案；换页不再出现旧四功能大侧栏 | build | integrated | 1/3 |

状态：planned / ready / running / verified / integrated / done / blocked / skipped。当前全部 planned。

## 分阶段验证与依赖

| 坐标 | 前置依赖/代表页批准 | 合入前 commit/结果/证据 | 合入后 commit/结果/证据 | 债务分类/owner/关闭条件 |
|---|---|---|---|---|
| W1.1 | 无 | f2feacc；契约 PASS 28；build PASS 于父提交 9e186de，差异仅测试 | 无 E2E。页面类型债留给 W1.2 | 页面旧皮肤名不是本刀债务 |
| W1.2 | W1.1 |  |  | 视觉未截图不得 done |
| W2.1 | W1.2 用户批准实际窗口 |  |  | 批准前不得开工 |
| W2.2 | W1.2 用户批准实际窗口 |  |  | 批准前不得开工 |
| W2.3 | W1.1 且 W1.2 用户批准 |  |  | 批准前不得开工 |
| W2.4 | W2.1 W2.2 W2.3 |  |  | 批准前不得开工 |
