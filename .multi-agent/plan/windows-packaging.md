# 计划：Windows 安装包

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。
> 一步一个提交；`npm run plan:status` 通过才算收工。

## 目标

`npm run dist:local` 能产出一个带应用图标、能装能跑的 NSIS 安装包；打包版打开书库并读到
WebGL 真实书籍；顺带把两条非破坏性的依赖告警清掉。

## 步骤

- [x] 1. 现状：`release/` 不存在，`electron-builder.yml` 已配 NSIS，但没图标、`package.json` 缺 author
      - 验：`ls release` → 不存在；`npm audit` → 10 high / 7 moderate 量级
      - 证据：审计实跑 9 条（7 moderate + 2 high）
- [x] 2. 打第一次安装包
      - 验：`npm run dist:local` → EXIT 0，产物 `release/小说浏览器 Setup 0.1.0.exe`
      - 证据：`.multi-agent/tmp/logs-2026-11-20/dist.log`；日志两条警告：`author is missed`、`default Electron icon is used`
- [x] 3. 打包版冒烟：`release/win-unpacked/小说浏览器.exe` + 临时书库
      - 验：外壳导航出现、书卡可点、WebGL 真实书籍页打开（canvas 在、无回退提示）
      - 证据：`SHELL true`、`READER true {"label":"第 1 / 3 页","canvas":true,"paras":9,"fail":""}`
- [x] 4. 图标与元数据：`build/icon.ico`（PIL 生成 16/24/32/48/64/128/256），`package.json` 加 `author: zmz`
      - 验：重打后日志不再出现 `default Electron icon is used` 与 `author is missed`；
            `[System.Drawing.Icon]::ExtractAssociatedIcon` 读出 32×32，像素 (16,16) = (216,194,160) 纸色
      - 证据：`.multi-agent/tmp/logs-2026-11-20/dist-icon.log`；exe 图标提取结果
- [x] 5. 依赖告警：`@modelcontextprotocol/sdk` 1.30.0 → 1.32.2（high，运行时）、`vite` 7.3.6 → 7.3.8（high，构建）
      - 验：`npm audit` → high 0，total 7 → 6；`npm run typecheck` 0；`npm test` 197 文件 / 1995 用例全绿
      - 证据：`.multi-agent/tmp/logs-2026-11-20/fulltest-deps.log`
- [x] 6. 真实安装（用户批准「装一遍」）：`/S` 静默装到默认目录
      - 验：`%LOCALAPPDATA%\Programs\spbf\小说浏览器.exe` 存在；桌面 + 开始菜单有 `小说浏览器.lnk`；
            HKCU 卸载项 `小说浏览器 0.1.0`；已安装版冒烟 `SHELL true` / `READER true`（canvas 在、无回退）
      - 证据：安装目录清单、快捷方式清单、注册表 DisplayVersion=0.1.0、`pkg-smoke-installed.mjs` 输出
      - 注：Git Bash 会把 `/S` 改写成 `S:/`（MSYS 路径转换）；下次静默安装用
            `MSYS2_ARG_CONV_EXCL='*'` 或 PowerShell `Start-Process -ArgumentList '/S'`。
- [x] 7. 最终安装包 + 冒烟
      - 验：`npm run dist:local` EXIT 0；冒烟 SHELL/READER 均 true
      - 证据：`dist-final.log`；`release/小说浏览器 Setup 0.1.0.exe`（175,318,002 字节，2026-11-21 00:00）
- [x] 8. 交付物：README「打包」节；本计划；HANDOFF
      - 验：`grep -n "## 打包" README.md`

## 不做（显式出范围）

- 不做代码签名与自动更新（个人自用；签证书要付费主体信息，自动更新还要发布通道）。
- 不在没有用户点头时替用户安装到本机（会写注册表、建桌面/开始菜单快捷方式）；本轮已获准执行一次。
- 不给 electron-builder 的 `minimatch` 链条做 `overrides` 强升：审计建议的「修复」是把
  electron-builder 降到 24.13.3（跨两个大版本回退），且这些包只在本机构建时跑，不进安装包。

## 已知边界

- 安装包未签名：Windows 会提示「未知发布者」。
- `release/` 与 `out/` 都在 `.gitignore` 里，产物不入库；`build/icon.ico` 入库。
- 打包体积 175 MB（Electron 45 + tesseract 语言包各一份 + 地图数据）。

## 断点记录（每次停下前更新）

- 状态：待推送
- 下一步第一条命令：`git push origin master`（需用户点头）
- 未验证项：交互式向导（双击、选目录）未点过；未在另一台干净机器上装。
