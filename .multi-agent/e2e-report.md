# 前端统一美化 E2E 验收报告

| 项 | 值 |
|---|---|
| 状态 | PASS |
| 战役 | U1.1–U3.1 |
| 验收 HEAD | `b1623004e0068c6c6c2b8a9be4be13ae070b1652` |
| 执行时间 | 2026-08-31T01:28:14+08:00 |
| 硬验收组合 | 1280×800 夜樱、1280×800 简约、1100×720 夜樱、1100×720 简约 |
| 隔离环境 | `XDG_CONFIG_HOME=/tmp/spbf-u31-config`、`HOME=/tmp/spbf-u31-home`、书库`/tmp/spbf-u31-library` |

## 环境恢复

1. `npm run build`。
2. 用隔离 XDG/HOME 配置启动 `./node_modules/.bin/electron --no-sandbox --disable-gpu --remote-debugging-port=9222 out/main/index.js`。
3. CDP 调用 `window.api.library.import('/tmp/U31验收书.txt')`，从书库打开导入书。
4. 执行 `SKIN=sakura node .multi-agent/e2e-cdp.mjs` 与 `SKIN=minimal node .multi-agent/e2e-cdp.mjs`。

脚本仅写入 `.multi-agent/e2e-artifacts/` 和 `/tmp` 隔离书库；不读取或修改真实用户书库。

## 结果

| 路径 | 证据 | 结果 |
|---|---|---|
| CD1/2 外壳与双皮肤 | U1.1 5/5、U1.2 4/4；Reader 两皮肤独立产物、焦点和无横滚 | PASS |
| CD3 浏览双层工具区/抽屉 | U2.1 合入后 Electron 5/5：双尺寸双皮肤、97px工具区、3个36px导航、240px抽屉和BrowserView避让 | PASS |
| CD4 书库 | U2.2 Electron 6/6：空态、封面、键盘打开；U2.3 Electron 8/8：更多菜单、删除确认隔离、焦点和无横滚 | PASS |
| CD5 设置 | U2.4/U2.5 Electron 各4/4：六分类、来源定位、所有分类可见路径、180/160栏、无横滚 | PASS |
| CD6 Reader 夜樱 | `SKIN=sakura node .multi-agent/e2e-cdp.mjs`：36/36；两尺寸各18项；保留 `results-sakura.json` 与皮肤尺寸截图 | PASS |
| CD6 Reader 简约 | `SKIN=minimal node .multi-agent/e2e-cdp.mjs`：36/36；两尺寸各18项；保留 `results-minimal.json` 与皮肤尺寸截图 | PASS |

Reader 每个组合覆盖：工具栏顺序/焦点、静置隐藏与Alt唤回、沉浸模式、外观面板、章节末进度、目录、reduced-motion、外观保存、方向键换章、搜索、TTS/AI入口、选区五动作与无横向溢出。截图及按皮肤分离的 JSON 证据在 `.multi-agent/e2e-artifacts/`。

## 结论

四种尺寸/皮肤组合的关键用户路径均 PASS；U3.2 可执行全量回归和完成定义收口。
