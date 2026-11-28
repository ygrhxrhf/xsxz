# 计划：网页书架书名 / 简介 / 最近阅读

> 规则：勾选必须有命令证据。没有跑过的项不许勾成 `[x]`。

## 目标

网页阅读加入书架后：卡片与提示显示**书名**而不是章名；站点书页的**简介**一起存下并显示；
书架「最近在读」把网页书和书库书放在一起按阅读时间排，加入即可续读。

## 步骤

- [x] 1. 定位：书名来自 `loadPageBootstrap().title`，章节页回退到章名；`WebShelfBook` 没有简介字段；Library 的「最近在读」只读本地书
      - 验：`git show --stat a070314` 与本轮 `git diff` → 改动落在 extract / readingSession / webShelf / Library
- [x] 2. 提取书页口径的书目：`extractBookIdentity`（`og:novel:book_name`、书页容器、目录/上级链接文字、`<title>` 剥章名与站点名）与简介容器 / meta 描述
      - 验：`npx vitest run src/main/readingSession.test.ts` → 16 条通过（含「章节页拿书名而不是章名」「面包屑取书名」）
- [x] 3. 落盘与刷新：`WebShelfBook.description`、加入时优先目录页书目、刷新时修掉旧条目的章名书名并补简介；加入时接住已存的阅读位置
      - 验：`npx vitest run src/main/webShelf.test.ts` → 18 条通过
- [x] 4. 界面：网页书架卡片显示简介（两行封顶）；「最近在读」合并本地书与网页书，点开走 `open-web-book`
      - 验：`npx vitest run src/renderer/pages/Library.recentWeb.ui.test.ts` → 3 条通过
- [x] 5. 契约文档：`docs/disk-schema.md` 补 `description` 与书目口径；`docs/ipc-contract.md` 补书架口径
      - 验：`git diff docs/` → 两处说明
- [x] 6. 全量验证
      - 验：`npm run typecheck` 通过；`npm test` 2049/2050（唯一失败为 `aiEvidenceIndex` 800 章性能用例在全量并行下超时，单独跑 13 条全绿）；`npm run build` 通过
- [x] 7. 提交：`fix(shelf): 网页书架存书名与简介，最近在读并入网页书`
      - 验：`git log --oneline -1`

## 不做（显式出范围）

- 不改下载器的书库书目结构（网页书仍不存正文）。
- 不给站点规则加「书名选择器」新字段：现有规则里的 `title` 选择器已参与书名候选。

## 已知边界

- 站点既没有书页 meta / 书页容器，也没有目录或上级链接、`<title>` 里也只有章名时，书名无法还原，仍退回章名（此时只能靠刷新目录页修）。
- 简介只认明确的简介容器与书页 meta，章节页的 `.summary` / `.description` 不收，避免把正文当简介。

## 断点记录（每次停下前更新）

- 状态：待推送（本地已提交）
- 下一步第一条命令：`git push`
- 未验证项：未在真实站点上逐个手测；提取策略按常见国内小说站结构（`og:novel:*`、`#info h1`、`#intro`、面包屑目录链接）实现。
