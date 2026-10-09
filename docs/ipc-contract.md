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
| `browse.resume` | invoke | 无 | `{ ok: true; restored: boolean } \| { ok: false; message: string }` |
| `browse.zoom` | invoke | `{ factor: number }` | `{ ok: true; factor: number } \| { ok: false; message: string }` |
| `browse.readingPage` | invoke | 无 | `{ ok: true; page: BrowseReadingPage } \| { ok: false; message: string }` |
| `browse.setReadingMode` | invoke | `{ enabled: boolean }` | `{ ok: true }` |
| `browse.chapter` | invoke | `{ direction: 'previous' \| 'next' }` | `{ ok: boolean; message?: string }` |
| `browse.find` | invoke | `{ query: string; forward: boolean; findNext: boolean }` | `{ ok: boolean }` |
| `browse.stopFind` | invoke | 无 | `{ ok: true }` |
| `browse.hide` | invoke | `{ action: 'start' \| 'stop' \| 'undo' \| 'count' }` | `{ ok: true; remaining: number } \| { ok: false; message: string }` |
| `browse.url` | 主→渲染 | — | `{ url: string }` |
| `browse.state` | 主→渲染 | — | `BrowseState` |
| `browse.findResult` | 主→渲染 | — | `BrowseFindResult` |
| `browse.shortcut` | 主→渲染 | — | `{ direction?: 'previous' \| 'next'; find?: boolean }` |

`browse.load` 的 url 若无协议，主进程补 `https://`。非 http(s) 拒绝。
`BrowseState` 增加 `zoom`、可选的 `previousChapter` / `nextChapter`（`{ title, url }`）。阅读模式仅返回当前网页快照提取的纯文本；临时隐藏在导航/重载后清空。缩放与最后网页位置保存在应用数据目录 `browse-state.json`，不进入书库。

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
| `library.getReadFrontier` | invoke | `{ bookId: string }` | `{ ok: true; frontier: ReadFrontier } \| { ok: false; message: string }` |
| `library.markReadFrontier` | invoke | `{ bookId: string; chapterId: string; paragraphIndex: number; characterOffset: number }` | `{ ok: true; position: ReadFrontierPosition } \| { ok: false; message: string }` |
| `library.confirmLegacyReadRange` | invoke | `{ bookId: string }` | `{ ok: true; frontier: ReadFrontier } \| { ok: false; message: string }` |
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

`library.audit` 只报告疑似短章、截断、重复正文/链接及广告或拦截残页，不自动改章状态。广告杂质且正文足够长时可预览 AI 清理；逐章确认才应用，原文保留在 `bodyRaw`。截断、登录墙、付费页和重复正文只引导核对、重下或手修。`library.repairChapterBody` 保存非空纯文本，首次编辑前的正文留在 `bodyRaw`，并把该章设为 ready。`library.migrate` 仅接受空目标目录，在目标同级临时目录复制并逐文件校验；切换失败仍使用原书库，成功后原目录保留。搬迁与恢复共用书库维护锁。

`library.markReadFrontier` 由阅读器按视窗底部段落及字符上报，主进程验证位置并单调保存；跳章不补记跳过的章节。旧进度只作为提案，调用 `library.confirmLegacyReadRange` 后才用于 AI 取材。正文变化时旧位置失效。

`Book.tags` / `BookListItem.tags` 始终是 `string[]`，缺省 `[]`。磁盘上旧书没有 `tags` 时按空数组读取，不得因此失败。`BookListItem.coverPath` 可选，有封面时给出相对书目录的路径。`library.updateMeta` 只改书名、作者和标签；`library.setCover` 用本机图片写入封面并返回 `coverPath`。`library.pickCoverFile` 打开本机选图对话框，取消时返回 `null`。

`BookListItem.overview` 是列表读取时附加的可选视图状态，包含 `status`、可选 `text` 和 `message`。状态为 `off | waiting | pending | running | ready | stale | failed`。`bookOverview.retry` 清除本书当前失败标记并唤醒后台队列；自动生成设置关闭时不发起模型调用。

`Settings.ai.autoBookOverview` 缺省为 `false`，只能由用户在设置页保存开启。开启后后台逐本处理已完整入库的书；无 API Key 或自定义服务地址未获信任时等待。概览使用全书正文，可能包含未读剧情与结局；各次 AI 调用计入该书用量。

`Settings.ai.autoReadingFollow` 缺省为 `false`，同样只能由用户显式开启。`Settings.ai.followMaxChaptersPerRun` 缺省 `12`，是增量记忆与自动追剧单次运行最多处理的章节数（记忆仍按每 5 章一批送模型），主进程只接受 `1..50` 的安全整数，其它值回退缺省。两者都由 `normalizeAiPrefs` 白名单补齐；设置页保存时省略这两个键表示保持磁盘上的原值，不得当成 `false` / 缺省清零。

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
| `download.openUnblock` | invoke | `{ bookId: string; chapterId: string }` | `{ ok: true; url: string } \| { ok: false; message: string }` |
| `download.resumeUnblock` | invoke | `{ bookId: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `download.blocked` | 主→渲染 | — | `DownloadBlocked` |
| `download.checkUpdate` | invoke | `{ bookId: string }` | `{ ok: true; bookId: string; added: number } \| { ok: false; code?: FailCode; message: string }` |
| `download.checkAll` | invoke | 无 | `CheckAllResult`（含 total / checked / booksWithUpdates / results） |
| `download.cancelCheckAll` | invoke | 无 | `{ ok: true }` |
| `download.progress` | 主→渲染 | — | `DownloadProgress` |
| `download.checkAll.progress` | 主→渲染 | — | `CheckAllProgress` |

`DownloadProgress.failedChapters` 可选，结束事件（`done` / `error` / `cancelled`）必带，没有失败或空章时为 `[]`；`running` 省略。元素字段：`chapterId`、`title`、`index`（磁盘 `ChapterMeta.index`，界面不再加减）、`reason`（优先 `failMessage`，否则 `FAIL_CODE_ZH[failCode]`，再否则「正文为空或过短」）、`failCode`（可选，无码失败时省略；界面按码分组）。来源是该书 `status` 为 `failed` 或 `empty` 的章。结束事件可带 `qualityIssueCount`。

**撞墙暂停（人在环）**：同一类墙（`NeedLogin` / `Paywall` / `Intercepted` 中同一个码）连撞 `WALL_PAUSE_STREAK`（当前 3）章后不再逐章硬撞：当章仍记为 `failed`，`DownloadProgress.status` 置 `awaitingHuman`（非结束态，不带 `failedChapters`），并推送一次 `download.blocked`（`DownloadBlocked`：`bookId` / `chapterId` / `chapterTitle` / `url` / `failCode` / `message`）。`download.openUnblock` **只把内置浏览页导航到该章 URL**；登录、付费、人机验证一律由用户本人完成。红线：任何频道都不得代替用户登录、绕过付费流程、自动解答验证码或伪造/复用他人凭据——本契约只到「识别墙 + 交给本人」为止。`download.resumeUnblock` 唤醒停在当章的循环：把所有因墙码 `failed` 的章退回 `pending`（清 `failCode` / `failMessage`），再从头跑一趟新的串行通道，同类连击计数也随之重置；处理未生效时会再次暂停。等待期间该任务仍占单任务锁，`download.cancel` 可随时打断并保留已下章节。

`RateLimited`（HTTP 429 / 503）不计入撞墙暂停：按站点 `Retry-After` 提示退避（缺失时用默认 30s，上限截到 120s），单章最多重试一次；连续 `RATE_LIMIT_STOP_COUNT` 章被限流则整本停止并提示稍后「重试失败章」，避免对已被限流的站零间隔硬撞。

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
| `promptMode` | `Record<AiPromptKind, 'builtin' \| 'custom'>` | 七类均为 `builtin` |
| `customPrompts` | `Partial<Record<AiPromptKind, string>>` | `{}`；只保存用户可编辑任务要求，不含固定安全约束 |

`AiPromptKind` 固定为 `clean`、`translate`、`chapterSummary`、`chapterNote`、`recap`、`memory`、`evidenceQa`。API Key 字段和安全存储语义不变。

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
- `SiteRule.previousChapter`、`SiteRule.nextChapter` 为可选 CSS 选择器。设置后优先用于当前页翻章链接识别；无效或未命中时该方向显示不可用。
- `siteRules.upsert` 仍整条替换；浏览页切换去广告时先读取当前规则并保留书名、作者、目录、正文等字段。保存规则后当前浏览页立即刷新隐藏 CSS，并重载页面以应用网络规则变化。
- 落盘 `%APPDATA%/spbf/site-rules.json`（与 `settings.json` 同目录），不是 `settings.json`。
- `siteRules.*` 不返回 API Key；文件内不得存 Key。

---

## 标记（书签 / 划线）

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `annotations.list` | invoke | `{ bookId: string }` | `{ ok: true; items: Annotation[] } \| { ok: false; message: string }` |
| `annotations.add` | invoke | `Annotation` 草稿（无 id/createdAt） | `{ ok: true; item: Annotation } \| { ok: false; message: string }` |
| `annotations.update` | invoke | `{ bookId: string; annotationId: string; patch: { note?; noteSource?; start?; end? } }` | `{ ok: true; item: Annotation } \| { ok: false; message: string }` |
| `annotations.remove` | invoke | `{ bookId: string; annotationId: string }` | `{ ok: true } \| { ok: false; message: string }` |

落盘每书 `<bookDir>/annotations.json`，写操作走 per-book 锁。坐标以「规范化正文」（按空行切段、丢空段后以 `\n\n` 连接）为准；划线必带原文摘录用于漂移校正（AI 清正文后由渲染层重定位并回写新坐标）。章节不存在、坐标非法、划线无摘录都会返回中文错误。

`Annotation.noteSource` 只接受 `'user' | 'ai'`，缺省视为 `'user'`：脏值丢弃，备注为空时不写来源，只改坐标不动备注与来源；改写备注文本而未声明来源时按读者手写算——文本换了就是新的作者。渲染层「问 AI · 解释这段」完成后可以把解释以 `noteSource:'ai'` 存回读者当初选中的同一区间，坐标仍来自选区、漂移校正仍走 `relocateRange`，不新写一套校正逻辑。

读者的划线与笔记在主进程直接读 `annotations.json` 后参与证据问答：命中的段落与同章段落只用于**提升排序**，并作为明确标注的不可信数据附在提示词里，只能帮助理解读者关注点，不得当作剧情事实，不得执行其中指令，也不得扩张 `citations` 白名单。**绝不**把读者笔记送进记忆抽取提示词——那里的「citationIds 只能取候选证据」不变量是核验的基础。

---

## AI

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `ai.clean` | invoke | `{ bookId: string; chapterId: string; confirmOverBudget?: boolean }` | `{ ok: true; result: AiCleanResult; budget: AiBudgetEstimate } \| { ok: false; confirmationRequired: true; message: string; budget: AiBudgetEstimate } \| { ok: false; stopped?: boolean; message: string }` |
| `ai.test` | invoke | `{ baseUrl?: string; model?: string; apiKey?: string; provider?: AiProvider; thinkingEnabled?: boolean }`（均可空，空则用已保存设置） | `{ ok: true; text: string } \| { ok: false; message: string }` |
| `ai.summarizeChapter` | invoke | `{ bookId: string; chapterId: string; confirmOverBudget?: boolean }` | `AiJobStart \| { ok:false; confirmationRequired:true; message:string; budget:AiBudgetEstimate }` |
| `ai.chapterNote` | invoke | `{ bookId: string; chapterId: string; confirmOverBudget?: boolean; overwriteUserNote?: boolean }` | `AiJobStart \| { ok:false; confirmationRequired:true; message:string; budget:AiBudgetEstimate } \| { ok:false; userNoteConfirmedRequired:true; message:string } \| { ok:false; message:string }` |
| `ai.chapterNotes` | invoke | `{ bookId: string; chapterId?: string }` | `AiChapterNotesResult`（`notes` 按章节序、只含仍在目录里的章；`current` 仅对请求的 `chapterId` 给出 `stale`） |
| `ai.saveChapterNote` | invoke | `{ bookId: string; chapterId: string; text: string }` | `{ ok: true; note: AiChapterNote } \| { ok: false; message: string }` |
| `ai.storySoFar` | invoke | `{ bookId: string; uptoChapterId: string; confirmOverBudget?: boolean }` | `AiJobStart \| { ok:false; confirmationRequired:true; message:string; budget:AiBudgetEstimate }` |
| `ai.getSummaries` | invoke | `{ bookId: string }` | `{ ok: true; summaries: AiSummaries } \| { ok: false; message: string }` |
| `ai.chatStream` | invoke | `{ bookId: string; chapterId: string; messages: AiChatMessage[] }` | `AiJobStart`（已读证据问答，最后一条 user 消息即问题） |
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
| `ai.chapterFinished` | invoke | `{ bookId: string; chapterId: string; ratio: number }` | `{ ok: true; coverage: AiFollowCoverage } \| { ok: false; message: string }` |
| `ai.followSet` | invoke | `{ bookId: string; mode: 'manual' \| 'ask' \| 'auto'; confirmOverBudget?: boolean }` | `AiFollowStart \| { ok: false; message: string }` |
| `ai.followRetry` | invoke | `{ bookId: string }` | `{ ok: true; coverage: AiFollowCoverage } \| { ok: false; message: string }` |
| `ai.getUsage` | invoke | `{ bookId: string }` | `{ ok: true; usage: AiBookUsage } \| { ok: false; message: string }` |
| `ai.semanticIndexStatus` | invoke | `{ bookId: string }` | `{ ok: true; status: { enabled: boolean; indexed: number; total: number; message: string } } \| { ok: false; message: string }` |
| `ai.semanticIndexSet` | invoke | `{ bookId: string; enabled: boolean }` | 同上 |
| `ai.findScenes` | invoke | `{ bookId: string; question: string }` | `{ ok: true; hits: AiCitation[]; mode: 'semantic' \| 'local'; message: string } \| { ok: false; message: string }` |
| `ai.resumeCard` | invoke | `{ bookId: string }` | `{ ok: true; view: AiResumeCardView } \| { ok: false; message: string }` |
| `ai.generateResumeCard` | invoke | `{ bookId: string; confirmOverBudget?: boolean }` | `{ ok: true; card: AiResumeCard; budget: AiBudgetEstimate } \| { ok: false; message: string }` |
| `ai.timeline` | invoke | `{ bookId: string }` | `{ ok: true; timeline: AiTimelineView } \| { ok: false; message: string }` |
| `ai.retrySave` | invoke | `{ saveToken: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `ai.cancel` | invoke | `{ jobId?: string }` | `{ ok: true }` |
| `ai.chunk` | 主→渲染 | — | `AiChunkEvent` |
| `ai.stage` | 主→渲染 | — | `AiStageEvent` |
| `ai.budget` | 主→渲染 | — | `AiBudgetEvent`（增量兼容；仅含 jobId、任务 `recap \| chapterSummary \| chapterNote \| memory \| qa` 和估算，不含 prompt、Key 或正文。`ai.summarizeChapter` 报 `chapterSummary`，`ai.chapterNote` 报 `chapterNote`） |
| `ai.done` | 主→渲染 | — | `AiDoneEvent` |

未配置 Key 或网络失败：返回 `{ ok: false; message }`，不得影响浏览/下载/阅读。

主进程 AI 队列分 `interactive`（用户点开）与 `background`（全书概览等自动任务）两条车道，各车道一次只跑一个任务，因此最多两个任务在飞；后台车道取活前要求交互车道完全空闲，排队中的用户任务同样算占用。`start` 与独占频道一律只排队不拒绝，不再因为「已有任务」返回忙；`{ ok:false, message:'请先停止当前生成' }` 只剩「同一本书的记忆族任务（`memory` / `follow`）已在跑或已排队」这一种触发场景，共用 `bookId:write` 资源的章节摘要改为排队串行。同一 `dedupeKey`（书 + 类别 + 章，证据问答再含问题原文）重复提交时复用已在跑或已排队的任务并返回同一 `jobId`，连点不再重复花额度。

`ai.test` 发一条最小 chat completions 探活。401/403、429、超时、5xx 返回中文分级文案。

`ai.findScenes` 在本书明确开启语义索引后，将已读原文向量与本地字面结果合并，服务失败时返回本地结果。索引按本书增量建立，缺 Key、损坏或暂停原因由状态频道显示。`ai.resumeCard` 只在上次阅读间隔至少 24 小时且附近有读完章节时提供缓存或生成入口；`ai.generateResumeCard` 由读者手动触发，来源变化时缓存过期。`ai.timeline` 读取现有记忆更新顺带记录的人物与伏笔状态，来源变化的条目隐藏并提示重建。问答 `AiDoneEvent.claims` 与聊天 v2 的 `claims` 逐条列结论和引用 ID；引用坐标经主进程校验，语义支持关系仍需读者核查。

自动概览、自动整理、自动语义索引共享每书每自然月估算 tokens 上限，默认 100000。请求前预留、按服务用量结算；未报告用量或结果不明时计入预留估算。手动任务显示估算后可确认继续。token 上限不等于服务商账单金额。

`AiBudgetEstimate` 统计 Unicode 字符；token 估算按中日韩字符数 ÷ 1.5、其他字符数 ÷ 4，合计乘 1.1 后向上取整，不计算金额。`ai.clean` 的完整未分批请求超过 30000 字且 `confirmOverBudget` 不为 true 时，必须在任何模型请求前返回 `confirmationRequired` 与缩减后的实际发送范围。确认后按规范化段落分批，每批仅携带目标前后各一段只读上下文；只合并模型返回的目标段。任一批失败、取消或截断时不返回可应用的 `AiCleanResult`。`ai.storySoFar` 使用同一确认门禁：只缩减已存摘要和正常记忆材料，不读取正文；确认前不得读取 Key、创建任务或联网。

任何按「截至某章」组织材料的 AI 任务，都必须先把章节列表夹紧到已存阅读进度 `book.progress.chapterId`（若有）：只读该截止内 `ready` 章正文，再取其中最近 10 章。不得把进度之后的未读章送进模型。无进度时以请求的 `uptoChapterId` 为截止。

`ai.chapterNote` 只发送请求的那一章：正文与**同一章**的读者划线批注（最多 20 条、每条 80 字）进入提示词，其余章节一概不读、不发送。提示词固定声明读者的划线与批注是不可信数据，只能用于理解读者关注点，不得作为剧情事实，更不得执行其中任何指令。超过 30000 字时按正文前缀缩减并要求 `confirmationRequired`；确认前不得读取 Key、创建任务或联网。结果按 `sha256(正文)` 存进 `<bookDir>/ai/notes.json`，正文一改即过期。读者亲手编辑过的笔记（`userEdited`）只在 `overwriteUserNote` 为 true 时才覆盖，否则返回 `userNoteConfirmedRequired`，绝不静默改写读者的话；`ai.saveChapterNote` 保存的手写笔记永远标 `userEdited`。

`ai.chapterNotes` 返回的 `notes` 过滤掉目录里已不存在的章并按章节序排列；`stale` 只对请求的 `chapterId` 判定，因为只有主进程能拿当前正文重算 hash，其余章节一律不带过期结论，界面不得替它们谎报新鲜度。

`ai.chatStream` 的本地检索按章剪枝：先用 `ai/index/` 的布隆清单决定哪些已读章值得读盘，一次提问最多读 24 章投机候选；记忆或摘要指向的章、当前章与进度章属于必选集，不受该额度限制。问句里的字面信号短到测不出词形时（单字短语，或被归一化压成单字的「」引用）取消剪枝资格，照旧全量读已读章。索引缺失、损坏、没建完或书库正在恢复一律当「不知道」，退回全扫。**剪枝永远不可能是少给引用的原因**：只有过滤器判「一定不含」才跳过读盘，判「可能含」仍要读原文复核。位图与清单只在本机参与决策，不得进入任何提示词或发往模型服务。

人物卡 / 伏笔追踪的生成侧已下线：`ai.characterCard` 与 `ai.getCharacterCard` 不再是契约频道，界面也没有对应入口。旧书遗留的 `<bookDir>/ai/characters.json` 只由 `ai.getMemory` 经 `readAiMemoryCompat` 在 `memory.json` 缺失或无效时兼容读取一次，主进程不再生成或改写该文件，`CharacterCard` 类型仅为这份兼容读取保留。

本战役新增的流式频道统一先返回 `AiJobStart`。成功的 `jobId` 对应后续零或多个 `ai.chunk`（SSE `delta`）、阶段变化时的 `ai.stage`，以及恰好一个 `ai.done`；失败也只由 `ai.done` 给出 `{ ok:false, message }`。`AiJobStart` 成功分支可携带可选 `queued` 与 `position`：`position` 是同一车道等待队列里的位次（从 1 开始），已经开跑则为 0，省略这两个字段视为未排队。队列只排队不拒绝，因此不再有「忙」这种失败分支；排队中的提交在返回结果之外还会收到一个带文案的 `queued` 阶段。`indexing` 阶段承载本次检索的剪枝计划（如「检索索引已覆盖 812/812 章，本次只读 9 章」），索引尚未覆盖时必须如实说「本次通读全部已读正文」，不得谎报覆盖率。`ai.stage` 除 `detail` 外还可携带可选 `citations` 与 `uptoChapterId`：证据问答的引用由本地检索算出、早于回答数十秒，随 `requesting` 阶段一并推送，供界面先渲染「依据」；旧监听方可忽略。`AiDoneEvent` 成功分支在旧 `{ jobId, ok, text }` 上只追加可选 `usage`、`truncated`、`stopped`、`citations`、`uptoChapterId`、`memoryUpdate`、`saveToken`，旧监听方保持兼容。`ai.cancel` 提供 `jobId` 时：在跑的同 ID 任务被中断，仍在排队的同 ID 任务出队并补发恰好一个 `{ ok:false, message:'已从队列取消' }`，不能只留界面永久「生成中」；省略 `jobId` 时收掉交互车道的在跑与排队任务（渲染层「停止」拿不到 jobId 的入口即此，如停止清正文），后台自动任务不受该调用误杀，仍由各自的按 ID 停止收口；过期或不匹配 ID 仍返回 `{ ok:true }`。退出前用 `cancelAll()` 收两条车道，备份与导入守卫用 `hasInFlight()` 判断，不再依赖单个全局任务槽。

`AiRequestStage` 固定为 `preparing`、`queued`、`indexing`、`rewriting`、`searching`、`requesting`、`saving`。`queued` 与 `indexing` 只携带 `detail` 文案、不改变终态，也不参与成败判断；界面必须为每个阶段留兜底文案，`detail` 缺失或全空白时按阶段名显示，不得显示空白。`ai.getMemory` 在 `memory.json` 存在时只返回新记忆；不存在时可返回旧 `characters.json` 兼容视图。`ai.updateMemory` / `rebuildMemory` 成功时通过 `ai.done.memoryUpdate` 传递 `AiMemoryUpdateResult`；生成成功但保存失败时仍返回 `ok:true`、完整 `memoryUpdate` 和 `saveToken`，旧正式文件不变；取消或模型/解析失败返回 `ok:false`，不得携带可误认为正式结果的 `memoryUpdate`。`ai.retrySave` 只能使用当前主进程内存中的一次性令牌，不得重新请求模型。`memoryUpdate.remainingChapters` 是被 `followMaxChaptersPerRun` 截断后仍未处理的已读章节数，不是「每次固定 5 章」的排队余量；增量更新一次可以跑完多批，重建恒为 `0`。

`ai.chatStream`（已读证据问答）成功时通过 `ai.done` 同时返回 `text`、候选白名单内的 `citations`、`uptoChapterId` 与 `stopped`。保存失败仍保留这些字段并追加 `saveToken`；重开后 `ai.getChat` 返回 `AiGetChatResult`，v1 消息按无来源兼容读取，v2 消息保留引用、已读截止和停止状态。

`ai.chatStream` 的回答按 `ai.chunk` 流式推送：任务要求 `response_format` 为 JSON，因此只转发 `answer` 字段中已完成解码的部分（不完整的 `\`、`\uXXXX` 或代理对必须挂起等后续帧），改写与检索阶段不发 `ai.chunk`；服务不守 JSON 约定时不转发任何字符，改由 `ai.done.text` 一次性给出，两种路径下终态文本必须一致。用户在任意时刻停止（阶段之间或流中途 abort）时，`ai.done` 仍必须恰好一个：已流出非空正文时走 `ok:true` 分支，携带 `stopped:true`、停止前的 `text`、当次候选 `citations` 与 `uptoChapterId`，并把这条部分回答写进 `chat.json`；只有正文为空才允许 `text:''` 且不留空消息。

`ai.chatStream` 先用原始问题做本地检索，命中足够（不少于 3 段可核验依据，且最强候选的打分达到字面命中线）时跳过 `queryRewrite` 这次模型往返，`ai.stage` 只出现一次 `searching` 就进 `requesting`；不足才改写并二次检索，二次依据更少时沿用原句结果，改写失败同样只退回原句结果、不再重复检索。跳过与否不新增 `AiRequestStage` 取值，也不放松引用白名单：最终 `citations` 仍只能取自当次候选。

`ai.getMaterialCoverage` 只统计已读截止内 `ready` 章：返回截止章节、已有本章摘要数，以及缺摘要的章节标题。无阅读进度时 `coverage` 为 `null`。`ai.correctCharacterAliases` 只改该人物的 `aliases`，不改姓名、摘要或来源；`affectedChapterIds` 是该条目来源章节，供界面从这些章节重新生成。`ai.getUsage` 读取 `<bookDir>/ai/usage.json` 的累计模型调用次数和服务报告的 token；文件缺失或损坏时返回全 0。清正文每批、前情、章节摘要、翻译、证据问答的改写和回答、记忆每批分别计次。模型服务未报告 token 时仍计次，token 记 0；不计算金额，保存重试不重复计次。`stream_options.include_usage` 与 `response_format` 一样只在官方 DeepSeek 端点注入，自建或第三方端点的流式回答常常不带 usage，此时界面显示「服务未返回 token 用量」属正常，不代表统计丢失。

自动追剧（`ai.chapterFinished` / `ai.followSet` / `ai.followRetry`）：「这一章读完了」只有渲染层能判定（主进程拿不到滚动位置），所以由界面按比率上报，`ratio` 必须是 `0..1` 的有限数，主进程只兜住明显不合理的值（低于 `0.8` 不入队）。这个频道**只往 `ai/follow.json` 排队**，因此不受队列忙、也不受同一本书其他 AI 任务的影响——把它挡掉就等于把追剧打断；`ask` / `manual` 模式下同样只记账，不花额度。追剧的运行状态一律通过 `ai.getMaterialCoverage` 的 `follow: AiFollowCoverage` 字段**拉取**，不新增事件通道：`follow.running` 为真表示主进程正为这本书跑单元或还在同一轮 drain 里，界面据此继续轮询；`paused` 带 `pauseReason`（达到单次章数上限，或退避用尽的网络失败）时只等用户操作。`ai.followSet` 首次从非 `auto` 切到 `auto` 且未带 `confirmOverBudget` 时，必须在任何模型请求、落盘或排队之前返回 `{ ok:false, confirmationRequired:true, message, budget }`，`budget` 按本轮最多 `followMaxChaptersPerRun` 章的实际提示词估算；确认后带 `confirmOverBudget:true` 重来才落盘。`ai.followRetry` 是界面上的「继续 / 现在整理」，算读者当场授权，这一次不受设置页 `ai.autoReadingFollow` 总开关约束（总开关只约束自动触发）。整理单元跑在 background 车道、与同书记忆族共用 `bookId:write` 资源，下载忙、书库恢复中、或交互车道取到活时退让，退让既不算失败也不计次；只处理 `status === 'ready'` 且章序不超过 `book.progress.chapterId` 的章，未读正文永不送模型。任何追剧内部异常都转成中文 `message` 或 `failed` 标记，不外抛，也不影响浏览、下载与阅读。

A1.1 只冻结以上类型、频道与白名单形状；handler 与 preload 方法由后续 A1.4/B1/C1 切片实现。未实现前 UI 不得调用。

---

## preload 白名单形状（与 `src/preload/index.ts` 一致）

```ts
window.api = {
  dialog: { openFile, openDirectory, openZip },
  tts: { getPosition, setPosition, synthesize, cancel },
  browse: { load, back, forward, reload, stop, setBounds, setVisible, resume, zoom, readingPage, setReadingMode, chapter, find, stopFind, hide, onFindResult, onShortcut, onUrl, onState },
  library: { list, get, readChapter, delete, import, setProgress, getReadFrontier, markReadFrontier, confirmLegacyReadRange, updateMeta, setCover, pickCoverFile, updateChapterBody, repairChapterBody, audit, migrate, export, searchInBook, listTrash, restoreTrash, purgeTrash },
  bookOverview: { retry, onChanged },
  download: { preview, confirm, redownloadChapter, cancel, retryFailed, openUnblock, resumeUnblock, checkUpdate, checkAll, cancelCheckAll, onProgress, onBlocked, onCheckAllProgress },
  settings: { get, set },
  backup: { create, restore, runAuto },
  annotations: { list, add, update, remove },
  siteRules: { list, preview, upsert, remove },
  ai: { clean, getChat, clearChat, test, summarizeChapter, chapterNote, chapterNotes, saveChapterNote, storySoFar, getSummaries, chatStream, translateStream, getMemory, updateMemory, rebuildMemory, rebuildMemoryFrom, markMemoryInaccurate, correctCharacterAliases, correctMemorySummary, getMaterialCoverage, chapterFinished, followSet, followRetry, getUsage, semanticIndexStatus, semanticIndexSet, findScenes, resumeCard, timeline, generateResumeCard, retrySave, cancel, onChunk, onStage, onBudget, onDone },
}
```

`src/preload/ipcContract.test.ts` 逐组比对这份形状与真实 preload，并检查每条频道在渲染侧、主进程 handler 和本文档表格三处都对得上；加频道时三处一起改。

`on*` 返回取消订阅函数。preload 中 `getChat` 的 Promise 返回 `AiGetChatResult`，`onDone` 监听 `AiDoneEvent`，因此 v2 引用/截止/停止状态和 `AiMemoryUpdateResult` 都有明确的 renderer 通道。
