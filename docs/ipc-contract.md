# IPC 契约

渲染进程只通过 `window.api`（preload 白名单）访问。`nodeIntegration: false`，`contextIsolation: true`。

频道只追加、不改名、不改已有字段含义。要加字段：协调者补丁 + 更新本文和 `src/shared/types.ts`。

类型均来自 `src/shared/types.ts`。

---

## 约定

| 方向 | 机制 | 命名 |
|---|---|---|
| 渲染 → 主进程（请求/响应） | `ipcRenderer.invoke` / `ipcMain.handle` | 点分名，如 `library.list` |
| 主进程 → 渲染（推送） | `webContents.send` / `ipcRenderer.on` | 点分名，如 `browse.url` |

错误：handle 抛错时渲染收到 rejected Promise。业务失败尽量用返回值里的 `ok: false` + `code`，不要用抛错表示「找不到目录」。

---

## 对话框

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `dialog.openFile` | invoke | 无 | `{ filePaths: string[] }` |
| `dialog.openDirectory` | invoke | 无 | `{ filePaths: string[] }` |
| `dialog.openZip` | invoke | 无 | `{ filePaths: string[] }` |

`openFile` 用于导入 txt / epub。`openDirectory` 用于选择书库根目录，也用于本机导出 txt / epub 与书库备份的目标目录。`openZip` 用于选择书库备份文件（zip 过滤）。主进程打开原生对话框。

---

## 浏览

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `browse.load` | invoke | `{ url: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `browse.back` | invoke | 无 | `{ ok: boolean }` |
| `browse.forward` | invoke | 无 | `{ ok: boolean }` |
| `browse.reload` | invoke | 无 | `{ ok: true }` |
| `browse.stop` | invoke | 无 | `{ ok: true }` |
| `browse.setBounds` | invoke | `{ x: number; y: number; width: number; height: number }` | `{ ok: true }` |
| `browse.setVisible` | invoke | `{ visible: boolean }` | `{ ok: true }` |
| `browse.url` | 主→渲染 | — | `{ url: string }` |
| `browse.state` | 主→渲染 | — | `BrowseState` |

`browse.load` 的 url 若无协议，主进程补 `https://`。非 http(s) 拒绝。

---

## 书库

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `library.list` | invoke | 无 | `{ books: BookListItem[] }` |
| `bookOverview.retry` | invoke | `{ bookId: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `bookOverview.changed` | 主→渲染 | — | 无；提示刷新书库概览状态 |
| `library.get` | invoke | `{ bookId: string }` | `{ book: Book } \| { ok: false; message: string }` |
| `library.readChapter` | invoke | `{ bookId: string; chapterId: string }` | `{ chapter: ChapterFile } \| { ok: false; message: string }` |
| `library.delete` | invoke | `{ bookId: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `library.import` | invoke | `{ filePath: string }` | `{ ok: true; bookId: string } \| { ok: false; message: string }` |
| `library.setProgress` | invoke | `{ bookId: string; progress: ReadingProgress }` | `{ ok: true }` |
| `library.updateMeta` | invoke | `{ bookId: string; title: string; author: string; tags: string[] }` | `{ ok: true } \| { ok: false; message: string }` |
| `library.setCover` | invoke | `{ bookId: string; sourcePath: string }` | `{ ok: true; coverPath: string } \| { ok: false; message: string }` |
| `library.pickCoverFile` | invoke | 无 | `string \| null` |
| `library.updateChapterBody` | invoke | `{ bookId: string; chapterId: string; body: string; restoreRaw?: boolean }` | `{ ok: true } \| { ok: false; message: string }` |
| `library.export` | invoke | `{ bookId: string; format: 'txt' \| 'epub'; destDir: string }` | `{ ok: true; path: string } \| { ok: false; message: string }` |
| `library.searchInBook` | invoke | `{ bookId: string; query: string }` | `{ ok: true; hits: BookSearchHit[] } \| { ok: false; message: string }` |
| `library.audit` | invoke | `{ bookId: string }` | `{ ok: true; report: QualityReport } \| { ok: false; message: string }` |
| `library.repairChapterBody` | invoke | `{ bookId: string; chapterId: string; body: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `library.migrate` | invoke | `{ targetPath: string }` | `{ ok: true; oldPath: string; newPath: string; files: number } \| { ok: false; message: string }` |

`library.searchInBook` 只扫本书 `ready` 章节正文，大小写不敏感，按章节顺序返回命中（每章一条：次数、首个命中的摘录与段落下标）。纯本机操作。

`library.audit` 只报告疑似短章、重复正文/链接及广告或拦截残页，不自动改章状态。`library.repairChapterBody` 保存非空纯文本，首次编辑前的正文留在 `bodyRaw`，并把该章设为 ready。`library.migrate` 仅接受空目标目录，在目标同级临时目录复制并逐文件校验；切换失败仍使用原书库，成功后原目录保留。搬迁与恢复共用书库维护锁。

`Book.tags` / `BookListItem.tags` 始终是 `string[]`，缺省 `[]`。磁盘上旧书没有 `tags` 时按空数组读取，不得因此失败。`BookListItem.coverPath` 可选，有封面时给出相对书目录的路径。`library.updateMeta` 只改书名、作者和标签；`library.setCover` 用本机图片写入封面并返回 `coverPath`。`library.pickCoverFile` 打开本机选图对话框，取消时返回 `null`。

`BookListItem.overview` 是列表读取时附加的可选视图状态，包含 `status`、可选 `text` 和 `message`。状态为 `off | waiting | pending | running | ready | stale | failed`。`bookOverview.retry` 清除本书当前失败标记并唤醒后台队列；自动生成设置关闭时不发起模型调用。

`Settings.ai.autoBookOverview` 缺省为 `false`，只能由用户在设置页保存开启。开启后后台逐本处理已完整入库的书；无 API Key 或自定义服务地址未获信任时等待。概览使用全书正文，可能包含未读剧情与结局；各次 AI 调用计入该书用量。

`library.import` 的路径由主进程 `dialog.showOpenDialog` 选出后传入，或设置页先选文件再 invoke。只接受 `.txt` / `.epub`（大小写不敏感）；其它后缀或不带后缀返回 `{ ok: false, message }`（中文，说明不支持的类型）。不得把 `.docx` 等当 txt 硬读。

`restoreRaw: true` 时用 `bodyRaw` 覆盖 `body`（清正文撤销）。

`library.export` 只把已下 `ready` 章成本机 txt / epub，落到用户选的目录。不做公网分享。目录由渲染进程先调 `dialog.openDirectory` 再传入。

`library.delete` 语义（追加）：删除改为把整本书目录移入 `<libraryPath>/__trash__/<bookId>-<删除时间毫秒>`，不再直接物理删除。

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `library.listTrash` | invoke | 无 | `{ ok: true; items: TrashItem[] } \| { ok: false; message: string }` |
| `library.restoreTrash` | invoke | `{ name: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `library.purgeTrash` | invoke | `{ name?: string }`（缺省 = 清空全部） | `{ ok: true; purged: number } \| { ok: false; message: string }` |

回收站条目名固定 `<bookId>-<毫秒时间戳>`；非法名（含路径分隔符）一律拒绝。还原时书库已有同 ID 书则返回 `{ ok: false, message }`。手动管理：不自动清理。

---

## 下载

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `download.preview` | invoke | 无（以当前浏览页为起点） | `{ ok: true; preview: DownloadPreview } \| { ok: false; message: string }` |
| `download.confirm` | invoke | `{ token: string }` | `{ ok: true; bookId: string } \| { ok: false; message: string }` |
| `download.redownloadChapter` | invoke | `{ bookId: string; chapterId: string; url: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `download.cancel` | invoke | `{ bookId?: string }` | `{ ok: true }` |
| `download.retryFailed` | invoke | `{ bookId: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `download.checkUpdate` | invoke | `{ bookId: string }` | `{ ok: true; bookId: string; added: number } \| { ok: false; code?: FailCode; message: string }` |
| `download.checkAll` | invoke | 无 | `CheckAllResult`（含 total / checked / booksWithUpdates / results） |
| `download.cancelCheckAll` | invoke | 无 | `{ ok: true }` |
| `download.progress` | 主→渲染 | — | `DownloadProgress` |
| `download.checkAll.progress` | 主→渲染 | — | `CheckAllProgress` |

`DownloadProgress.failedChapters` 可选，结束事件（`done` / `error` / `cancelled`）必带，没有失败或空章时为 `[]`；`running`（及 `paused`）省略。元素字段：`chapterId`、`title`、`index`（磁盘 `ChapterMeta.index`，界面不再加减）、`reason`（优先 `failMessage`，否则 `FAIL_CODE_ZH[failCode]`，再否则「正文为空或过短」）。来源是该书 `status` 为 `failed` 或 `empty` 的章。结束事件可带 `qualityIssueCount`。

`download.preview` 不写书库；样本章也用 `persist:novel` 隐藏 webContents 加载。确认令牌一次性、十分钟内有效，当前浏览页 URL 改变后拒绝确认。`download.redownloadChapter` 只提取指定章节，失败时保留原正文与原 URL。

禁止用裸 `fetch(chapterUrl)` 作为下书主路径。必须走同一 `persist:novel` 的隐藏 webContents。

`download.checkUpdate` 只补该书已存 `sourceUrl` 的新目录项；`added` 只计新追加的目录行（重试已有 `failed` / `empty` 不加 `added`）。与 `start` / `retryFailed` 共用单任务锁。导入书或无 `sourceUrl` 时返回 `{ ok: false, message: '无原始目录地址，无法检查更新' }`。本频道只追加，不改 `start` / `retryFailed` 含义。

`download.checkAll` 对书库里每本「下载来源且有 sourceUrl」的书**串行**调 `checkUpdate`：每本等下载队列空闲再继续，两本之间留约 1s 间隔；导入书 / 无 sourceUrl 直接跳过不计入 results。任一单本失败不中断批量（记录进 results），但等待空闲超时会中止剩余。`cancelCheckAll` 停止检查剩余的书，也会取消当前正在补章的那本（等同 `download.cancel()`）。批量进行中重复调用返回 `{ ok:false }`。

---

## 备份

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `backup.create` | invoke | `{ destDir: string }` | `{ ok: true; path: string; files: number } \| { ok: false; message: string }` |
| `backup.restore` | invoke | `{ zipPath: string }` | `{ ok: true; books: number; files: number } \| { ok: false; message: string }` |
| `backup.runAuto` | invoke | 无 | `{ status: 'disabled' \| 'notDue' \| 'created' \| 'failed'; message?: string }` |

`backup.create` 把整个书库打包成 `spbf-backup-<日期>-<时间>.zip` 写入用户选的目录；顶层跳过 `__trash__` / `__tmp__`。空书库拒绝备份。`backup.restore` 是**整库覆盖**：先在书库同盘临时目录解压，拒绝不安全路径并校验索引、书籍元数据与已就绪章节；通过后将旧库移到临时回滚目录，再切换新库并重建索引。切换或重建失败时还原旧库；成功后清理旧库副本。下载、导入或 AI 保存进行中不启动恢复，恢复中拒绝新的书库写入。二次确认由渲染层负责。

自动备份使用 `spbf-auto-<日期>-<时间>.zip`，配置目录后启动时若距上次成功满七天就执行；只轮换最近五份自动备份，不动手动备份。失败记录在 `Settings.autoBackup.lastError`，下次启动重试。备份不含设置和 API Key。

---

## 设置

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `settings.get` | invoke | 无 | `Settings`（不含 apiKey 明文） |
| `settings.set` | invoke | `SettingsUpdate` | `Settings` |

`apiKey` 仅在 `settings.set` 时由渲染提交；落盘经 `safeStorage`。`settings.get` 只给 `apiKeyConfigured: boolean`。站点规则**不**经 `settings.*`，也**不**写入 `settings.json`。

在线听书配置仍经 `settings.get/set`：`tts.source` 为 `system | online`，并包含系统音色 URI、在线完整接口地址、模型、音色、语速和自动下一章。`SettingsUpdate.ttsApiKey` 单独设置在线语音密钥，空串清除；主进程加密保存，`settings.get` 仅返回 `tts.onlineKeyConfigured`，绝不返回明文。在线接口按 OpenAI 兼容的 `POST` 语音生成协议发送 `model`、`voice`、`input`、`response_format: mp3`。

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `tts.getPosition` | invoke | `{ bookId }` | `TtsPosition | null` |
| `tts.setPosition` | invoke | `{ bookId, position: TtsPosition }` | `{ ok: true }`，无效位置抛错 |
| `tts.synthesize` | invoke | `{ requestId, text }`（最多 500 字符） | MP3 `Uint8Array`，失败抛错 |
| `tts.cancel` | invoke | `{ requestId }` | `{ ok: true }` |

在线语音由主进程读取已保存接口和密钥发起请求；渲染进程不能覆盖请求地址或获取密钥。缓存位于 `userData/tts-cache`，限额 500 MB。

`Settings.downloadPace`（`'slow' | 'standard' | 'fast'`）是必填字段，`settings.get` 始终返回。默认 `'standard'`。旧 `settings.json` 缺该字段、空串或非法值都回退 `'standard'`。`SettingsUpdate.downloadPace` 可选；`settings.set` 写入合法档位，非法值回退 `'standard'` 后落盘并返回。它只影响下载时章与章之间的固定间隔：`slow` 2000ms、`standard` 600ms、`fast` 200ms。不新增 IPC 频道，仍走现有 `settings.get` / `settings.set`。

`SettingsUpdate.appearance.skin`（`'paper' | 'white' | 'night'`）用于换肤：渲染层切皮肤时提交，主进程校验合法值后并入 `settings.json`；默认 `'paper'`；旧 `'sakura'` 与 `'minimal'` 读入为 `'paper'`；非法值按 `'paper'` 处理。

`Settings.reader` / `SettingsUpdate.reader` 使用同一个 `ReaderPrefs` 契约；更新时仍通过现有 `settings.set` 提交 `Partial<ReaderPrefs>`，频道名、请求响应外形和 preload API 不变：

| 字段 | 类型 | 默认值 | 读取规则 |
|---|---|---|---|
| `fontSize` | `number` | `18` | 有限数值夹紧到 12–36 |
| `lineHeight` | `number` | `1.8` | 有限数值夹紧到 1.2–3.0 |
| `theme` | `'paper' \| 'sepia' \| 'gray' \| 'night'` | `'paper'` | 有效新值优先；缺失或非法时兼容旧 `nightMode` |
| `fontFamily` | `'serif' \| 'system' \| 'mono'` | `'serif'` | 非法值回退默认 |
| `contentWidth` | `'narrow' \| 'medium' \| 'wide'` | `'medium'` | 非法值回退默认 |
| `paragraphSpacing` | `'compact' \| 'normal' \| 'relaxed'` | `'normal'` | 非法值回退默认 |
| `paragraphIndent` | `boolean` | `true` | 非布尔值回退默认 |
| `focusMode` | `'off' \| 'one' \| 'three' \| 'five'` | `'off'` | 缺失或非法值回退 `'off'`；合法 `'one'/'three'/'five'` 保留 |
| `readingMode` | `'scroll' \| 'screen'` | `'scroll'` | 缺失或非法值回退 `'scroll'`；合法 `'scroll'/'screen'` 保留 |

读取设置时逐字段校验，一个字段损坏不会丢弃其他合法字段。旧 `nightMode: true` 迁移为 `theme: 'night'`，`false` 迁移为 `'paper'`；未知旧字段可继续留在磁盘，但返回的正式 `ReaderPrefs` 不再包含或依赖 `nightMode`。

`Settings.ai` / `SettingsUpdate.ai` 通过现有 `settings.get/set` 频道承载，不新增设置频道。A1.1 先追加兼容类型（`Settings.ai` 暂为可选，避免尚未迁移的旧主进程调用方失配）；A1.2 完成后 `settings.get` 必须始终返回规范化 `AiPrefs`：

| 字段 | 类型 | 默认值 / 兼容规则 |
|---|---|---|
| `provider` | `'deepseek' \| 'custom'` | 新设置默认 `deepseek`；旧设置按既有 baseURL/model 保留，不静默迁移 |
| `thinkingEnabled` | `boolean` | `true` |
| `recapLength` | `'short' \| 'standard' \| 'detailed'` | `standard` |
| `trustedCustomOrigins` | `string[]` | `[]`；只保存规范化 origin，非法项忽略并去重 |
| `promptMode` | `Record<AiPromptKind, 'builtin' \| 'custom'>` | 六类均为 `builtin` |
| `customPrompts` | `Partial<Record<AiPromptKind, string>>` | `{}`；只保存用户可编辑任务要求，不含固定安全约束 |

`AiPromptKind` 固定为 `clean`、`translate`、`chapterSummary`、`recap`、`memory`、`evidenceQa`。API Key 字段和安全存储语义不变。

---

## 站点规则

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `siteRules.list` | invoke | 无 | `{ rules: SiteRule[] }` |
| `siteRules.preview` | invoke | 未保存的 `SiteRule` | `{ ok: true; preview: SiteRulePreview } \| { ok: false; message: string }` |
| `siteRules.upsert` | invoke | `SiteRule` | `{ ok: true; rule: SiteRule } \| { ok: false; message: string }` |
| `siteRules.remove` | invoke | `{ host: string }` | `{ ok: true } \| { ok: false; message: string }` |

- `host` 经 `normalizeHost`：trim、小写、去掉一层前导 `www.`；URL 形态（如 `https://www.Foo.com/path`）先取 hostname 再规范化。空 / 纯空白 host 拒绝。
- `siteRules.preview` 对当前浏览页及样本章试运行，要求填写域名与当前站点一致；仅返回结果与逐项诊断，不保存规则。
- 同一规范化 host 只留一条；`upsert` 整条替换。
- 选择器字段均可空。空选择器 = 该字段走通用提取。非法 CSS 保存不拒，提取时当未命中。
- `SiteRule.adFilterEnabled` 可选，缺省为 `true`；`adHideSelectors` 可选，每行一条浏览页额外隐藏选择器。关闭时同时停用该站的 CSS 隐藏和 AdGuard 网络规则。CSS 只注入浏览 View；网络请求只在 `webContentsId` 属于浏览 View 时匹配，下载 View 不受影响。
- `siteRules.upsert` 仍整条替换；浏览页切换去广告时先读取当前规则并保留书名、作者、目录、正文等字段。保存规则后当前浏览页立即刷新隐藏 CSS，并重载页面以应用网络规则变化。
- 落盘 `%APPDATA%/spbf/site-rules.json`（与 `settings.json` 同目录），不是 `settings.json`。
- `siteRules.*` 不返回 API Key；文件内不得存 Key。

---

## 标记（书签 / 划线）

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `annotations.list` | invoke | `{ bookId: string }` | `{ ok: true; items: Annotation[] } \| { ok: false; message: string }` |
| `annotations.add` | invoke | `Annotation` 草稿（无 id/createdAt） | `{ ok: true; item: Annotation } \| { ok: false; message: string }` |
| `annotations.update` | invoke | `{ bookId: string; annotationId: string; patch: { note?; start?; end? } }` | `{ ok: true; item: Annotation } \| { ok: false; message: string }` |
| `annotations.remove` | invoke | `{ bookId: string; annotationId: string }` | `{ ok: true } \| { ok: false; message: string }` |

落盘每书 `<bookDir>/annotations.json`，写操作走 per-book 锁。坐标以「规范化正文」（按空行切段、丢空段后以 `\n\n` 连接）为准；划线必带原文摘录用于漂移校正（AI 清正文后由渲染层重定位并回写新坐标）。章节不存在、坐标非法、划线无摘录都会返回中文错误。

---

## AI

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `ai.clean` | invoke | `{ bookId: string; chapterId: string; confirmOverBudget?: boolean }` | `{ ok: true; result: AiCleanResult; budget: AiBudgetEstimate } \| { ok: false; confirmationRequired: true; message: string; budget: AiBudgetEstimate } \| { ok: false; stopped?: boolean; message: string }` |
| `ai.summarize` | invoke | `{ bookId: string; uptoChapterId: string }` | `{ ok: true; text: string } \| { ok: false; message: string }` |
| `ai.translate` | invoke | `{ text: string }` | `{ ok: true; text: string } \| { ok: false; message: string }` |
| `ai.chat` | invoke | `{ bookId: string; chapterId: string; messages: AiChatMessage[] }` | `{ ok: true; text: string } \| { ok: false; message: string }` |
| `ai.test` | invoke | `{ baseUrl?: string; model?: string; apiKey?: string; provider?: AiProvider; thinkingEnabled?: boolean }`（均可空，空则用已保存设置） | `{ ok: true; text: string } \| { ok: false; message: string }` |
| `ai.characterCard` | invoke | `{ bookId: string; uptoChapterId: string }` | `{ ok: true; card: CharacterCard } \| { ok: false; message: string }` |
| `ai.getCharacterCard` | invoke | `{ bookId: string }` | `{ ok: true; card: CharacterCard \| null } \| { ok: false; message: string }` |
| `ai.summarizeChapter` | invoke | `{ bookId: string; chapterId: string; confirmOverBudget?: boolean }` | `AiJobStart \| { ok:false; confirmationRequired:true; message:string; budget:AiBudgetEstimate }` |
| `ai.storySoFar` | invoke | `{ bookId: string; uptoChapterId: string; confirmOverBudget?: boolean }` | `AiJobStart \| { ok:false; confirmationRequired:true; message:string; budget:AiBudgetEstimate }` |
| `ai.getSummaries` | invoke | `{ bookId: string }` | `{ ok: true; summaries: AiSummaries } \| { ok: false; message: string }` |
| `ai.chatStream` | invoke | `{ bookId: string; chapterId: string; messages: AiChatMessage[] }` | `AiJobStart` |
| `ai.getChat` | invoke | `{ bookId: string }` | `AiGetChatResult`（兼容 v1/v2；`version` 过渡期可缺省） |
| `ai.clearChat` | invoke | `{ bookId: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `ai.translateStream` | invoke | `{ text: string; bookId?: string }` | `AiJobStart`；传入书籍 ID 时计入每书用量 |
| `ai.getMemory` | invoke | `{ bookId: string }` | `{ ok: true; memory: AiMemoryFile \| CharacterCard \| null } \| { ok: false; message: string }` |
| `ai.updateMemory` | invoke | `{ bookId: string; uptoChapterId: string; confirmOverBudget?: boolean }` | `AiJobStart \| { ok:false; confirmationRequired:true; message:string; budget:AiBudgetEstimate }` |
| `ai.rebuildMemory` | invoke | `{ bookId: string; uptoChapterId: string; confirmOverBudget?: boolean }` | 同 `ai.updateMemory` |
| `ai.rebuildMemoryFrom` | invoke | `{ bookId: string; fromChapterId: string; uptoChapterId: string; confirmOverBudget?: boolean }` | 同 `ai.updateMemory`；仅重算已读范围内从来源章开始的记忆，保留此前证据及用户手工修正 |
| `ai.markMemoryInaccurate` | invoke | `{ bookId: string; kind: 'character' \| 'relation' \| 'foreshadow' \| 'event'; itemId: string }` | `{ ok: true; item: AiMemoryBase } \| { ok: false; message: string }` |
| `ai.correctMemorySummary` | invoke | `{ bookId: string; kind: 'character' \| 'relation' \| 'foreshadow' \| 'event'; itemId: string; summary: string }` | `{ ok: true; item: AiMemoryBase; affectedChapterIds: string[] } \| { ok: false; message: string }` |
| `ai.correctCharacterAliases` | invoke | `{ bookId: string; itemId: string; aliases: string[] }` | `{ ok: true; character: AiMemoryCharacter; affectedChapterIds: string[] } \| { ok: false; message: string }` |
| `ai.getMaterialCoverage` | invoke | `{ bookId: string }` | `{ ok: true; coverage: AiMaterialCoverage \| null } \| { ok: false; message: string }` |
| `ai.getUsage` | invoke | `{ bookId: string }` | `{ ok: true; usage: AiBookUsage } \| { ok: false; message: string }` |
| `ai.askEvidenceStream` | invoke | `{ bookId: string; chapterId: string; question: string }` | `AiJobStart` |
| `ai.retrySave` | invoke | `{ saveToken: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `ai.cancel` | invoke | `{ jobId?: string }` | `{ ok: true }` |
| `ai.chunk` | 主→渲染 | — | `AiChunkEvent` |
| `ai.stage` | 主→渲染 | — | `AiStageEvent` |
| `ai.budget` | 主→渲染 | — | `AiBudgetEvent`（增量兼容；仅含 jobId、任务和估算，不含 prompt、Key 或正文） |
| `ai.done` | 主→渲染 | — | `AiDoneEvent` |

未配置 Key 或网络失败：返回 `{ ok: false; message }`，不得影响浏览/下载/阅读。

`ai.test` 发一条最小 chat completions 探活。401/403、429、超时、5xx 返回中文分级文案。

`AiBudgetEstimate` 统计 Unicode 字符；token 估算按中日韩字符数 ÷ 1.5、其他字符数 ÷ 4，合计乘 1.1 后向上取整，不计算金额。`ai.clean` 的完整未分批请求超过 30000 字且 `confirmOverBudget` 不为 true 时，必须在任何模型请求前返回 `confirmationRequired` 与缩减后的实际发送范围。确认后按规范化段落分批，每批仅携带目标前后各一段只读上下文；只合并模型返回的目标段。任一批失败、取消或截断时不返回可应用的 `AiCleanResult`。`ai.storySoFar` 使用同一确认门禁：只缩减已存摘要和正常记忆材料，不读取正文；确认前不得读取 Key、创建任务或联网。

`ai.summarize` 把截止夹紧到已存阅读进度 `book.progress.chapterId`（若有）：只读该截止内 `ready` 章正文，再取其中最近 10 章。不得把进度之后的未读章送进模型。无进度时以请求的 `uptoChapterId` 为截止。

`ai.characterCard`（人物卡 / 伏笔追踪）沿用同一夹紧规则：目录、已读摘要、最近 3 章已读正文节选进入提示词；未读内容绝不进模型。生成结果解析为 JSON 存 `<bookDir>/ai/characters.json` 并返回；解析失败保留 `raw` 兜底展示。`ai.getCharacterCard` 只读取上次保存的卡。

本战役新增的流式频道统一先返回 `AiJobStart`。成功的 `jobId` 对应后续零或多个 `ai.chunk`（SSE `delta`）、阶段变化时的 `ai.stage`，以及恰好一个 `ai.done`；失败也只由 `ai.done` 给出 `{ ok:false, message }`。`AiDoneEvent` 成功分支在旧 `{ jobId, ok, text }` 上只追加可选 `usage`、`truncated`、`stopped`、`citations`、`uptoChapterId`、`memoryUpdate`、`saveToken`，旧监听方保持兼容。`ai.cancel` 提供 `jobId` 时只中断当前同 ID 的任务；省略 `jobId` 时用于中断当前非流式独占任务；过期或不匹配 ID 仍返回 `{ ok:true }`。

`AiRequestStage` 固定为 `preparing`、`rewriting`、`searching`、`requesting`、`saving`。`ai.getMemory` 在 `memory.json` 存在时只返回新记忆；不存在时可返回旧 `characters.json` 兼容视图。`ai.updateMemory` / `rebuildMemory` 成功时通过 `ai.done.memoryUpdate` 传递 `AiMemoryUpdateResult`；生成成功但保存失败时仍返回 `ok:true`、完整 `memoryUpdate` 和 `saveToken`，旧正式文件不变；取消或模型/解析失败返回 `ok:false`，不得携带可误认为正式结果的 `memoryUpdate`。`ai.retrySave` 只能使用当前主进程内存中的一次性令牌，不得重新请求模型。

`ai.askEvidenceStream` 成功时通过 `ai.done` 同时返回 `text`、候选白名单内的 `citations`、`uptoChapterId` 与 `stopped`。保存失败仍保留这些字段并追加 `saveToken`；重开后 `ai.getChat` 返回 `AiGetChatResult`，v1 消息按无来源兼容读取，v2 消息保留引用、已读截止和停止状态。

`ai.getMaterialCoverage` 只统计已读截止内 `ready` 章：返回截止章节、已有本章摘要数，以及缺摘要的章节标题。无阅读进度时 `coverage` 为 `null`。`ai.correctCharacterAliases` 只改该人物的 `aliases`，不改姓名、摘要或来源；`affectedChapterIds` 是该条目来源章节，供界面从这些章节重新生成。`ai.getUsage` 读取 `<bookDir>/ai/usage.json` 的累计模型调用次数和服务报告的 token；文件缺失或损坏时返回全 0。清正文每批、前情、章节摘要、翻译、证据问答的改写和回答、记忆每批分别计次。模型服务未报告 token 时仍计次，token 记 0；不计算金额，保存重试不重复计次。

A1.1 只冻结以上类型、频道与白名单形状；handler 与 preload 方法由后续 A1.4/B1/C1 切片实现。未实现前 UI 不得调用。

---

## preload 白名单形状（实现时对齐）

```ts
window.api = {
  dialog: { openFile, openDirectory, openZip },
  browse: { load, back, forward, reload, stop, setBounds, setVisible, onUrl, onState },
  library: { list, get, readChapter, delete, import, setProgress, updateMeta, setCover, pickCoverFile, updateChapterBody, export, searchInBook, listTrash, restoreTrash, purgeTrash },
  download: { start, cancel, retryFailed, checkUpdate, checkAll, cancelCheckAll, onProgress, onCheckAllProgress },
  settings: { get, set },
  backup: { create, restore },
  siteRules: { list, upsert, remove },
  ai: { clean, summarize, translate, chat, getChat, clearChat, test, characterCard, getCharacterCard, summarizeChapter, storySoFar, getSummaries, chatStream, translateStream, getMemory, updateMemory, rebuildMemory, rebuildMemoryFrom, correctCharacterAliases, correctMemorySummary, markMemoryInaccurate, getMaterialCoverage, getUsage, askEvidenceStream, retrySave, cancel, onChunk, onStage, onDone },
  annotations: { list, add, update, remove },
}
```

`on*` 返回取消订阅函数。计划 preload 中 `getChat` 的 Promise 返回 `AiGetChatResult`，`onDone` 监听 `AiDoneEvent`，因此 v2 引用/截止/停止状态和 `AiMemoryUpdateResult` 都有明确的 renderer 通道。
