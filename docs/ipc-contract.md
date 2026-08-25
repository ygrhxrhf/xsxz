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

`openFile` 用于导入 txt / epub。`openDirectory` 用于选择书库根目录，也用于本机导出 txt / epub 的目标目录。主进程打开原生对话框。

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
| `library.get` | invoke | `{ bookId: string }` | `{ book: Book } \| { ok: false; message: string }` |
| `library.readChapter` | invoke | `{ bookId: string; chapterId: string }` | `{ chapter: ChapterFile } \| { ok: false; message: string }` |
| `library.delete` | invoke | `{ bookId: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `library.import` | invoke | `{ filePath: string }` | `{ ok: true; bookId: string } \| { ok: false; message: string }` |
| `library.setProgress` | invoke | `{ bookId: string; progress: ReadingProgress }` | `{ ok: true }` |
| `library.updateChapterBody` | invoke | `{ bookId: string; chapterId: string; body: string; restoreRaw?: boolean }` | `{ ok: true } \| { ok: false; message: string }` |
| `library.export` | invoke | `{ bookId: string; format: 'txt' \| 'epub'; destDir: string }` | `{ ok: true; path: string } \| { ok: false; message: string }` |

`library.import` 的路径由主进程 `dialog.showOpenDialog` 选出后传入，或设置页先选文件再 invoke。只接受 `.txt` / `.epub`（大小写不敏感）；其它后缀或不带后缀返回 `{ ok: false, message }`（中文，说明不支持的类型）。不得把 `.docx` 等当 txt 硬读。

`restoreRaw: true` 时用 `bodyRaw` 覆盖 `body`（清正文撤销）。

`library.export` 只把已下 `ready` 章成本机 txt / epub，落到用户选的目录。不做公网分享。目录由渲染进程先调 `dialog.openDirectory` 再传入。

---

## 下载

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `download.start` | invoke | 无（以当前浏览页为起点） | `{ ok: true; bookId: string } \| { ok: false; code: FailCode; message: string }` |
| `download.cancel` | invoke | `{ bookId?: string }` | `{ ok: true }` |
| `download.retryFailed` | invoke | `{ bookId: string }` | `{ ok: true } \| { ok: false; message: string }` |
| `download.checkUpdate` | invoke | `{ bookId: string }` | `{ ok: true; bookId: string; added: number } \| { ok: false; code?: FailCode; message: string }` |
| `download.progress` | 主→渲染 | — | `DownloadProgress` |

禁止用裸 `fetch(chapterUrl)` 作为下书主路径。必须走同一 `persist:novel` 的隐藏 webContents。

`download.checkUpdate` 只补该书已存 `sourceUrl` 的新目录项；`added` 只计新追加的目录行（重试已有 `failed` / `empty` 不加 `added`）。与 `start` / `retryFailed` 共用单任务锁。导入书或无 `sourceUrl` 时返回 `{ ok: false, message: '无原始目录地址，无法检查更新' }`。本频道只追加，不改 `start` / `retryFailed` 含义。

---

## 设置

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `settings.get` | invoke | 无 | `Settings`（不含 apiKey 明文） |
| `settings.set` | invoke | `SettingsUpdate` | `Settings` |

`apiKey` 仅在 `settings.set` 时由渲染提交；落盘经 `safeStorage`。`settings.get` 只给 `apiKeyConfigured: boolean`。站点规则**不**经 `settings.*`，也**不**写入 `settings.json`。

---

## 站点规则

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `siteRules.list` | invoke | 无 | `{ rules: SiteRule[] }` |
| `siteRules.upsert` | invoke | `SiteRule` | `{ ok: true; rule: SiteRule } \| { ok: false; message: string }` |
| `siteRules.remove` | invoke | `{ host: string }` | `{ ok: true } \| { ok: false; message: string }` |

- `host` 经 `normalizeHost`：trim、小写、去掉一层前导 `www.`；URL 形态（如 `https://www.Foo.com/path`）先取 hostname 再规范化。空 / 纯空白 host 拒绝。
- 同一规范化 host 只留一条；`upsert` 整条替换。
- 选择器字段均可空。空选择器 = 该字段走通用提取。非法 CSS 保存不拒，提取时当未命中。
- 落盘 `%APPDATA%/spbf/site-rules.json`（与 `settings.json` 同目录），不是 `settings.json`。
- `siteRules.*` 不返回 API Key；文件内不得存 Key。

---

## AI

| 频道 | 方向 | 请求 | 响应 |
|---|---|---|---|
| `ai.clean` | invoke | `{ bookId: string; chapterId: string }` | `{ ok: true; result: AiCleanResult } \| { ok: false; message: string }` |
| `ai.summarize` | invoke | `{ bookId: string; uptoChapterId: string }` | `{ ok: true; text: string } \| { ok: false; message: string }` |
| `ai.translate` | invoke | `{ text: string }` | `{ ok: true; text: string } \| { ok: false; message: string }` |
| `ai.chat` | invoke | `{ bookId: string; chapterId: string; messages: AiChatMessage[] }` | `{ ok: true; text: string } \| { ok: false; message: string }` |
| `ai.test` | invoke | `{ baseUrl?: string; model?: string; apiKey?: string }`（均可空，空则用已保存设置） | `{ ok: true; text: string } \| { ok: false; message: string }` |

未配置 Key 或网络失败：返回 `{ ok: false; message }`，不得影响浏览/下载/阅读。

`ai.test` 发一条最小 chat completions 探活。401/403、429、超时、5xx 返回中文分级文案。

`ai.summarize` 把截止夹紧到已存阅读进度 `book.progress.chapterId`（若有）：只读该截止内 `ready` 章正文，再取其中最近 10 章。不得把进度之后的未读章送进模型。无进度时以请求的 `uptoChapterId` 为截止。

---

## preload 白名单形状（实现时对齐）

```ts
window.api = {
  dialog: { openFile, openDirectory },
  browse: { load, back, forward, reload, stop, setBounds, setVisible, onUrl, onState },
  library: { list, get, readChapter, delete, import, setProgress, updateChapterBody, export },
  download: { start, cancel, retryFailed, checkUpdate, onProgress },
  settings: { get, set },
  siteRules: { list, upsert, remove },
  ai: { clean, summarize, translate, chat, test },
}
```

`on*` 返回取消订阅函数。
