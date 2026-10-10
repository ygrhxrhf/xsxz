

# FILE world.md

# 世界模型

对照日期：2026-03-22（顾问检索 + 仓库）

## 产品

Windows 单机小说浏览器 spbf：浏览 → 下载本书 → 书库/阅读 → 自备 Key AI。  
栈：Electron + electron-vite + Vue 3 + TS + Naive UI。禁 native、禁 v-html、禁裸 fetch 下书、禁云同步、禁书源市场。

## 书库现状

- `Library.vue` 已有搜索（书名/作者）、状态筛选、排序（最近更新/书名/作者）、导出、删除回收站、批量检查更新、色块封面。
- `Book.coverPath` 与 disk-schema 已有；`BookListItem` 未暴露 coverPath/tags。
- 无 tags、无编辑元数据对话框、无本机选封面写入、无查重组、无「已读 x / 共 y」独立文案（已有 formatLibraryProgress）。
- 上一战役 `reader-true-pagination-20260908` 状态=完成，本战役不改 Reader 分页。

## 市面对照

| 来源 | 可借鉴 | 本项目落地 |
|---|---|---|
| [Koodo 功能](https://www.koodoreader.com/zh) | 标签/书架、封面、元数据 | 标签+封面+编辑；云同步不做 |
| [Calibre what's new](https://calibre-ebook.com/whats-new) | 元数据、查重 | 提示不合并 |
| [Legado](https://github.com/youfengknight/Legado_Max) | 书架/净化 | 净化与书源市场本战役不做 |

## 已确认缺口 → 完成定义 / 切片

| 缺口 | 完成定义 | 切片 |
|---|---|---|
| tags 契约与磁盘 | 3 | U1.1 U1.2 |
| 搜索含标签 + Ctrl+F | 1 | U2.1 |
| 标签芯片过滤 | 2 | U3.1 |
| 编辑信息 | 3 | U4.1 |
| 本机封面 | 4 | U5.1 |
| 查重 Modal | 5 | U6.1 |
| 已读章数字 | 6 | U7.1 |
| 空态文案与验证 | 7 | U8.1 |


# FILE scheme.md

# 开发方案（升级顾问 → 导演环）

> 经用户完全确认。导演必须按本方案推进，直到 `objective.md` 完成定义全部满足。禁止再问已拍板的产品问题，禁止追加方案外能力。

## 元信息

- 项目：spbf / xsxz
- 确认日期：2026-03-22
- 选定方案：书库经营
- 明确不选：本机正文规则、浏览下载工作台、词典+本地字体、在线书源市场
- 推进模式：无人值守，直到完成
- 市面关键来源：[Koodo](https://www.koodoreader.com/zh)、[Calibre](https://calibre-ebook.com/whats-new)、[Legado](https://github.com/youfengknight/Legado_Max)

## 一句话目标

使用者打开书库页，能用搜索和标签找到书，能改书名作者封面，能看到重复书提示和已读章数；旧书不用重建。

## 完成定义

见 `objective.md` 1–7，必须全部可独立验证。

## 非目标

- 云同步、账号、书源市场、选择器市场
- 虚拟书库查询语言、设备推送、多书架拖拽
- 自动合并重复书
- 跨书正文搜索、章节标题搜索
- 阅读分钟、剩余时间估算
- 改 Reader 排版/分页/TTS
- 改导入导出流程
- 设置页全局标签字典
- native 模块、v-html、裸 fetch 下书

## 选定理由

阅读器已多轮升级；市面差距在书库经营。只改书库契合所有权，风险中等。

## 默认体验（已拍板）

- 入口：现有书库页；卡片新增「编辑信息」；顶栏沿用搜索框
- 布局：现有卡片网格 + 顶栏；搜索框下方标签芯片行
- 默认值：排序「最近更新」；状态筛选「全部状态」；无标签过滤
- 空态：无书且无筛选 → 「还没有书」+「去浏览」；有筛选无结果 → 「没有匹配的书」无按钮
- 加载中：首载沿用现有转圈；保存时对话框保存按钮 loading
- 错误提示：toast
- 成功反馈：toast「已保存」，不弹成功对话框
- 破坏性操作确认：删除沿用现有回收站确认；保存元数据不二次确认
- 快捷键：书库页 Ctrl+F（及 mac Meta+F）聚焦搜索框；其它不新增
- 文案语气：短句、陈述、中文
- 语言：只中文
- 窗口：不改默认尺寸、不分栏、不全屏

```text
[搜索框] [状态筛选] [排序] [可能重复 n 组]
[芯片: 标签A] [标签B]     ← 无标签则本行不存在
[卡片 封面图或色块]
  书名
  作者
  已读 x / 共 y 章 · 时间或未读
  [打开] [编辑信息] [导出…] [删除…]
```

## 文案表（已拍板）

| ID | 位置 | 中文文案 | 何时出现 |
|---|---|---|---|
| COPY-1 | 空态 | 还没有书 | 书库 0 本且未筛选 |
| COPY-2 | 空态按钮 | 去浏览 | 同上 |
| COPY-3 | 筛选空 | 没有匹配的书 | 搜索或标签或状态筛空 |
| COPY-4 | 卡片按钮 | 编辑信息 | 每张卡片 |
| COPY-5 | 对话框标题 | 编辑信息 | 打开对话框 |
| COPY-6 | 字段 | 书名 | 表单 |
| COPY-7 | 字段 | 作者 | 表单 |
| COPY-8 | 字段 | 标签 | 表单 |
| COPY-9 | 按钮 | 选择封面 | 对话框 |
| COPY-10 | 按钮 | 保存 | 对话框主按钮 |
| COPY-11 | 按钮 | 取消 | 对话框 |
| COPY-12 | toast | 已保存 | 元数据或封面成功 |
| COPY-13 | toast | 书名不能为空 | 书名 trim 后空 |
| COPY-14 | toast | 封面不能超过 8MB | 选图 >8MB |
| COPY-15 | toast | 仅支持 jpg、png、webp | 扩展名不符 |
| COPY-16 | toast | 保存失败，已保留原来的信息 | 写盘失败 |
| COPY-17 | 顶栏 | 可能重复 n 组 | n 替换为组数，≥1 组才显示 |
| COPY-18 | Modal 标题 | 可能重复的书 | 点 COPY-17 |
| COPY-19 | 卡片 | 未读 | 无 progress |
| COPY-20 | 卡片 | 已读 {x} / 共 {y} 章 | 恒显示；无 progress 时 x=0 |
| COPY-21 | 查重 Modal | 打开 | 每行书 |

已有按钮「打开」「导出」「删除」文案不改。

## 设置项（已拍板）

无新设置。标签只存在每本 `book.json`。

## 边界与异常（已拍板）

| 场景 | 处置 | 用户可见 |
|---|---|---|
| 无网络 / 超时 | 不适用 | — |
| 解析/抽正文失败 | 不适用 | — |
| 磁盘满或无权限 | 不写新 meta/封面；保留旧文件 | COPY-16 |
| 重复书 | 只提示，不合并、不自动删 | COPY-17 Modal |
| 用户取消 | 关对话框不写盘；文件对话框取消不改封面 | 无 toast |
| API Key | 不适用 | — |
| 超大封面 | 拒绝复制 | COPY-14 |
| 错误扩展名 | 拒绝 | COPY-15 |
| 并发下载 | 不适用 | — |
| 标签重复 | 同书 trim 后大小写不敏感去重，保留先出现的写法 | 芯片不重复 |
| 无封面书 | 沿用现有色块 | 无 img |

## 数据与兼容（已拍板）

- 策略：必须向后兼容
- 细节：`book.json` 增加可选 `tags: string[]`；缺省或非法当 `[]`。`coverPath` 已有则继续用；新封面写入 `cover.jpg|png|webp` 并更新 coverPath。不碰 `chapters/` 正文。index.json 的 BookListItem 同步 tags、coverPath。
- 禁止：重建书库、改 chapter 坐标、新增 lastReadAt

## 技术约束（必须遵守）

- Electron + Vue3 + Naive UI
- 无 native
- 正文与封面展示禁止 v-html（封面用 img src 经已有或新增的文件协议/转换，与现有色块兼容）
- 下载仍禁止裸 fetch 当下书主路径（本战役不改下载）
- 无云同步、无书源市场
- 工人不私自改 types/preload；走协调者补丁

## 文件所有权与契约

- 可直接改：`src/main/library.ts`、`src/renderer/pages/Library.vue`、`src/renderer/pages/libraryCard.ts` 及对应 `*.test.ts`
- 必须经协调者：`src/shared/types.ts`、`src/preload/index.ts`、`src/main/index.ts` 挂 IPC、`docs/ipc-contract.md`、`docs/disk-schema.md`

契约补丁字段：

```
Book.tags: string[]           // 缺省 []
BookListItem.tags: string[]
BookListItem.coverPath?: string

library.updateMeta(payload: { bookId: string; title: string; author: string; tags: string[] })
  → { ok: true } | { ok: false; message: string }

library.setCover(payload: { bookId: string; sourcePath: string })
  → { ok: true; coverPath: string } | { ok: false; message: string }
```

选文件：渲染进程用现有或 `dialog` 经主进程；若需 `library.pickCoverFile(): Promise<string | null>` 允许作为 setCover 的前置 IPC，取消返回 null。

preload 白名单增加上述 invoke。message 给用户看时必须映射到文案表，禁止把系统 errno 直接当中文。

## 阶段与全量切片

### 阶段 A 契约

| 坐标 | 标题 | 目标文件 | 完成标准 | 测试 | 依赖 | 路径 | 对应完成定义 |
|---|---|---|---|---|---|---|---|
| U1.1 | types+disk tags | types.ts, disk-schema.md, ipc-contract.md, preload, main/index.ts | 字段与 IPC 名按上文；旧 book.json 无 tags 列出不炸 | build,contract | 无 | 主路径 | #3 #4 |
| U1.2 | library 读写 tags/coverPath | library.ts | list 返回 tags 与 coverPath；缺省 [] | build,contract | U1.1 | 主路径 | #3 #4 |

### 阶段 B 查找

| 坐标 | 标题 | 目标文件 | 完成标准 | 测试 | 依赖 | 路径 | 对应完成定义 |
|---|---|---|---|---|---|---|---|
| U2.1 | 搜索含标签 + Ctrl+F | libraryCard.ts, Library.vue | q 匹配 title/author/tags；空 q 全显示；Ctrl+F 聚焦 | build,contract | U1.2 | 主路径 | #1 |
| U3.1 | 标签芯片单选 | Library.vue, libraryCard.ts | 聚合芯片；无标签不渲染行；单击过滤再点取消 | build,contract,e2e | U2.1 | 主路径 | #2 |

### 阶段 C 编辑

| 坐标 | 标题 | 目标文件 | 完成标准 | 测试 | 依赖 | 路径 | 对应完成定义 |
|---|---|---|---|---|---|---|---|
| U4.1 | 编辑信息对话框 | Library.vue, library.ts | 字段与文案表；空书名 COPY-13；成功写盘 COPY-12 | build,contract,e2e | U1.2 | 主路径 | #3 |
| U5.1 | 本机封面 | library.ts, Library.vue | 8MB/扩展名/取消/覆盖 cover.* | build,contract,e2e | U4.1 | 主路径 | #4 |

### 阶段 D 查重与进度

| 坐标 | 标题 | 目标文件 | 完成标准 | 测试 | 依赖 | 路径 | 对应完成定义 |
|---|---|---|---|---|---|---|---|
| U6.1 | 查重 Modal | libraryCard.ts, Library.vue | 组数文案；Modal 打开该书；不合并 | build,contract,e2e | U1.2 | 主路径 | #5 |
| U7.1 | 已读章数字 | libraryCard.ts, Library.vue | COPY-19/20；用 progress.updatedAt | build,contract | 无 | 主路径 | #6 |
| U8.1 | 空态收口与全量验证 | Library.vue | COPY-1/2/3 行为；npm test 与 build 0 | build,contract,e2e | U2–U7 | 主路径 | #7 |

## 逐刀实现说明（已拍板）

### U1.1

- 改什么：Book.tags；BookListItem.tags 与 coverPath；IPC 文档与 preload 白名单
- 不改什么：ReaderPrefs、下载 IPC、progress 形状
- 关键分支：tags 非数组则 []
- 完成时：类型与契约测试通过

### U1.2

- 改什么：读 book.json 时规范化 tags；list/index 带出 coverPath、tags；updateMeta 只改 title/author/tags/updatedAt
- 不改什么：章节文件、progress
- 关键分支：书不存在 → ok false message 内部，渲染映射 COPY-16
- 完成时：单测旧书无 tags 能 list

### U2.1

- 改什么：filterLibraryBooks 的 q 包含 tags.join；Library 搜索框加 ref，keydown Ctrl/Meta+F preventDefault 聚焦
- 不改什么：状态筛选、排序键集合（可保留现有三项）
- 关键分支：大小写不敏感；空串不过滤文本
- 完成时：单测标签命中

### U3.1

- 改什么：计算 unique tags 排序（localeCompare zh）；n-tag 可单击；activeTag 参与 filter
- 不改什么：多选 AND/OR
- 关键分支：无标签不渲染容器
- 完成时：e2e 或组件测单击过滤

### U4.1

- 改什么：Naive Modal 表单；n-dynamic-tags 或输入逗号拆分；保存调 updateMeta 后刷新 list
- 不改什么：sourceUrl、id、导入类型
- 关键分支：title trim 空 → 不调用 IPC，COPY-13；作者可空字符串
- 完成时：保存后卡片书名变

### U5.1

- 改什么：选文件；校验 size≤8*1024*1024 与 ext in jpg,jpeg,png,webp（jpeg 存 cover.jpg）；copy 到书目录；删或忽略其它 cover.* 旧文件以免混用；更新 coverPath
- 不改什么：从 URL 下载封面
- 关键分支：取消 → 无 toast；失败 COPY-16
- 完成时：磁盘有 cover 文件，卡片 img 可见

### U6.1

- 改什么：纯函数 groupDuplicateBooks(list)：key = title.trim().toLowerCase() + '\0' + author.trim().toLowerCase()；组内 ≥2 计入 n
- 不改什么：自动删、合并章节
- 关键分支：n=0 不显示按钮；Modal 点打开 emit 现有 open-book
- 完成时：两本同名同作者顶栏出现 COPY-17

### U7.1

- 改什么：format 函数：y=chapterCount；x=progress 对应 chapter 的 index+1，找不到则 0；无 progress 文案「未读」且 x=0；有则格式化 updatedAt 本地字符串（`toLocaleString('zh-CN')`）
- 不改什么：不写 lastReadAt；不改 Reader 心跳
- 关键分支：progress 章已删 → x=0 仍显示时间
- 完成时：卡片可见 COPY-20

### U8.1

- 改什么：对齐空态文案与「去浏览」emit go-browse；跑全测试
- 不改什么：浏览页内部
- 关键分支：有筛选时空态不出现「去浏览」
- 完成时：定义 7 为真

## 失败处置（已授权，不必问）

- 单刀最多 4 轮。
- 主路径 FAIL：拆更小 ⏳ 继续，不暂停、不 ⏭️。
- 可跳过路径：无。
- 验证通过后无冲突合入默认分支。
- 禁止 git push，除非用户另说。

## 越权墙

无，已授权做到完成。

仅外部事故可暂停（本机不能跑 npm test/build、工作区被脏改无法安全合入）。

## 验证命令（从本仓库抄）

- build：`npm run build`
- contract：`npm test`
- e2e：仅标 e2e 的切片；用仓库已有 vitest/electron 测法，不引入新框架；可给 Library 交互写 vitest + 测试工具函数代替完整 Electron e2e

## 完成判定

完成定义 1–7 在默认分支均为真，主路径切片均为 ✅。objective 状态=已完成。不要开启下一场未确认战役。

## 导演禁止猜测清单

- 文案表
- 默认体验
- 边界与异常
- 数据与兼容
- 逐刀「不改什么」

## 交接

新开 DSH 会话，预设选「导演环」（`director-loop`），工作区为本仓库，对导演说「继续推进」。


# FILE dev-plan.md

# 开发计划

## 项目信息

- 任务源：升级顾问 scheme.md
- 创建时间：2026-03-22
- 总子任务数：9
- 收口：全部 ✅ 合入 `c6f0e67`

## 任务清单

| 坐标 | 阶段 | 标题 | 状态 | 合入 |
|---|---|---|---|---|
| U1.1 | A | types+disk tags 与 IPC | ✅ | 4d5c786 |
| U1.2 | A | library 读写 tags/cover | ✅ | aa026e2 |
| U2.1 | B | 搜索含标签 + Ctrl+F | ✅ | efb989a |
| U3.1 | B | 标签芯片单选 | ✅ | 524a332 |
| U4.1 | C | 编辑信息对话框 | ✅ | a9639f8 |
| U5.1 | C | 本机封面 | ✅ | c169363 |
| U6.1 | D | 查重 Modal | ✅ | 37ccc9d |
| U7.1 | D | 已读章数字 | ✅ | fc189c6 |
| U8.1 | D | 空态收口与验证 | ✅ | c6f0e67 |

TEST_DEBT：无。


# FILE interview-log.md

# 访谈勾选

> 战役 `library-ops-20260322`。状态只能是：已拍板 / 不适用。无未问。

| ID | 主题 | 状态 | 用户决定（一句话） | 写入 |
|---|---|---|---|---|
| A1 | 谁与场景 | 已拍板 | 书库三项同等：找书、元数据/查重、进度数字 | objective |
| A2 | 战役类型 | 已拍板 | 增加能力 + 优化书库体验 | objective |
| A3 | 完成定义 | 已拍板 | 7 条可观察事实 | objective |
| A4 | 非目标 | 已拍板 | 无云同步、无虚拟书库、无设备推送、无书源市场、不多书架、不改分页 | objective |
| A5 | 范围模块 | 已拍板 | 只改书库页+书库主进程 | scheme |
| A6 | 打破钉死项 | 已拍板 | 不打破；书源市场不做 | decision-log |
| B1 | 选定方案 | 已拍板 | 书库经营 | scheme |
| B2 | 明确不选 | 已拍板 | 正文规则、下载工作台、词典字体 | scheme |
| B3 | 组合冲突 | 不适用 | 只选一项 | scheme |
| B4 | 一次做完或分阶段 | 已拍板 | 一次做完 | scheme |
| C1 | 入口 | 已拍板 | 现有书库页顶栏与卡片按钮 | 默认体验 |
| C2 | 布局 | 已拍板 | 现有卡片 + 顶栏筛选 | 默认体验 |
| C3 | 按钮 | 已拍板 | 保留打开/导出/删除；加编辑信息 | 文案表 |
| C4 | 默认值 | 已拍板 | 排序最近更新 | 默认体验 |
| C5 | 空态 | 已拍板 | 还没有书+去浏览；无匹配无按钮 | 文案表 |
| C6 | 加载 | 已拍板 | 顶栏转圈 | 默认体验 |
| C7 | 错误 | 已拍板 | toast | 文案表 |
| C8 | 成功反馈 | 已拍板 | toast 不弹窗 | 默认体验 |
| C9 | 破坏性确认 | 已拍板 | 删除沿用回收站；改元数据不确认 | 默认体验 |
| C10 | 快捷键 | 已拍板 | Ctrl+F 聚焦搜索 | 默认体验 |
| C11 | 窗口布局 | 已拍板 | 不改窗口尺寸 | 默认体验 |
| C12 | 语言 | 已拍板 | 只中文 | 默认体验 |
| D1 | 数据策略 | 已拍板 | 向后兼容 | 数据与兼容 |
| D2 | 格式兼容 | 已拍板 | 不碰章节正文；tags 缺省 [] | 数据与兼容 |
| D3 | 脏文件 | 已拍板 | 写盘失败保留旧 meta | 边界与异常 |
| D4 | 导入导出 | 已拍板 | 本战役不改导入导出 | 非目标 |
| D5 | 设置持久化 | 已拍板 | 无新设置；标签在每本 meta | 设置项 |
| E1 | 依赖升级 | 已拍板 | 不改 major | 技术约束 |
| E2 | 契约补丁 | 已拍板 | tags/coverPath IPC | 文件所有权与契约 |
| E3 | 跨所有权 | 已拍板 | 协调者改 types/preload/docs | 文件所有权与契约 |
| E4 | 禁令仍遵守 | 已拍板 | 全部遵守 | 技术约束 |
| E5 | 验证命令 | 已拍板 | npm test 与 npm run build | 验证命令 |
| F1 | 无网络 | 不适用 | 本战役不访问网络 | 边界与异常 |
| F2 | 抽正文失败 | 不适用 | 不改下载提取 | 边界与异常 |
| F3 | 磁盘 | 已拍板 | 失败保留旧 meta | 边界与异常 |
| F4 | 重复书 | 已拍板 | 提示不合并 | 边界与异常 |
| F5 | 用户取消 | 已拍板 | 取消选图不改封面；对话框取消不写盘 | 边界与异常 |
| F6 | API Key | 不适用 | 不改 AI | 边界与异常 |
| F7 | 大文件 | 已拍板 | 封面 >8MB 拒绝 | 边界与异常 |
| F8 | 并发 | 不适用 | 不改下载并发 | 边界与异常 |
| G1 | 主路径 | 已拍板 | 搜索标签编辑封面查重进度 | 失败处置 |
| G2 | 可跳过 | 已拍板 | 无 | 失败处置 |
| G3 | 合入授权 | 已拍板 | 验证通过合入默认分支 | decision-log |
| G4 | 越权墙 | 已拍板 | 空 | 越权墙 |
| G5 | 无人值守完全确认 | 已拍板 | 完全确认，导演环可无人值守推进直到完成 | objective |
| H1 | 模糊点清扫 | 已拍板 | 扩搜索、无 lastReadAt、单选芯片、三格式+Modal | scheme |

## 清扫记录

- 轮次 1：搜索框复用、lastReadAt、过滤单选、封面格式与查重 Modal
- 轮次 2：标签行隐藏、空书名、封面文件名、作者可空；0 条新问题


# FILE readiness.md

# Campaign Readiness

> 仅用于 objective 中 `执行模式=campaign`、`状态=进行中` 的长期战役。

| 项 | 值 |
|---|---|
| 战役 ID | `library-ops-20260322` |
| 目标修订 | r1 |
| 默认分支 HEAD | fc189c68661de9094dd95d44ef2d0c0ca72b61da |
| 对照日期 | 2026-03-22 |
| 结果 | PASS |
| 处置 | 进入 U8.1 |

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1 | 当前切片目标、范围、非目标明确 | PASS | U8.1 空态：还没有书+去浏览；筛选空没有匹配的书无按钮；npm test 与 build 0。 |
| 2 | 当前切片验收标准可观察 | PASS | 0 本且未筛选 vs 有筛选无结果。 |
| 3 | 验证命令来自仓库且可执行 | PASS | npm test、npm run build。 |
| 4 | worktree、回滚与集成策略明确 | PASS | session-e495e69a；ff-only。 |
| 5 | 目标修订和默认分支 HEAD 已核对 | PASS | r1；HEAD fc189c68661de9094dd95d44ef2d0c0ca72b61da。 |
| 6 | 未决假设 | PASS | 无。 |
| 7 | 跨模块接口 | PASS | 不改 IPC。 |
| 8 | 数据策略 | PASS | 不写盘。 |
| 9 | 安全边界 | PASS | 不碰密钥。 |
| 10 | 授权 | PASS | 继续推进=合入。 |
| 11 | 文案 | PASS | COPY-1/2/3。 |
| 12 | 风险停止 | PASS | 战役收口。 |


# FILE expert-board.md

# 专家证据账本

- 模式：campaign `library-ops-20260322` 完成

| Task ID | 角色 | 状态 |
|---|---|---|
| U1.1-IMPL-2 | implementer | accepted `4d5c786` |
| U1.1-TEST-1 | tester | accepted 0 |
| U1.2-IMPL-1 | implementer | accepted `aa026e2` |
| U1.2-TEST-1 | tester | accepted 0 |
| U2.1-IMPL-1 | implementer | accepted `efb989a` |
| U2.1-TEST-1 | tester | accepted 0 |
| U3.1-IMPL-1 | implementer | accepted `524a332` |
| U3.1-TEST-1 | tester | accepted 0 |
| U4.1-IMPL-1 | implementer | accepted `a9639f8` |
| U4.1-TEST-1 | tester | accepted 0 |
| U5.1-IMPL-1 | implementer | accepted `c169363` |
| U5.1-TEST-1 | tester | accepted 0 |
| U6.1-IMPL-1 | implementer | accepted `37ccc9d` |
| U6.1-TEST-1 | tester | accepted 0 |
| U7.1-IMPL-1 | implementer | accepted `fc189c6` |
| U7.1-TEST-1 | tester | accepted 0 |
| U8.1-IMPL-1 | implementer | accepted `c6f0e67` |
| U8.1-TEST-1 | tester | accepted 0 |


# FILE main-log.md

# 主循环日志

> 战役 `library-ops-20260322` r1 完成。HEAD `c6f0e67`。未 push。
