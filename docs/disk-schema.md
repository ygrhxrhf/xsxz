# 磁盘 schema

## 书库根目录

默认：当前用户家目录下的 `spbf/library`（Windows 为 `%USERPROFILE%\spbf\library`）（`Settings.libraryPath`，可改）。清空该项不会写入路径，由当前系统重新解析默认值。

```
<libraryPath>\
  index.json
  __tmp__\
  __trash__\               # 回收站：删除的书整目录移入 <bookId>-<删除毫秒>；启动时清掉超过 30 天的条目
  <bookId>\
    book.json
    annotations.json       # 书签 / 划线（见下）
    tts-position.json      # 可选，每本书独立的听书续播位置
    reading-frontier.json  # 段落级已读边界、旧进度确认与阅读会话
    origin\                 # 导入时保留的源文件
    chapters\
      0001.json
    ai\
      summaries.json
      bookOverview.json     # AI 全书概览与逐章处理缓存；可含未读剧情和结局
      characters.json      # 旧 AI 人物卡 / 伏笔追踪；兼容保留
      memory.json          # 可核验小说记忆 v1（用户触发后生成）
      chat.json            # 聊天 v1 / 证据问答 v2
      notes.json           # AI 生成或读者手写的本章笔记，见「ai/notes.json」
      follow.json          # 自动追剧的队列与进度真源，见「ai/follow.json」
      monthly-usage.json   # 每书每月自动任务额度与预留
      semantic-settings.json # 本书语义索引启用状态；默认关闭
      semantic-index.json  # 可重建的已读原文向量缓存
      resume-card.json     # 手动生成的断点续读卡缓存
      timeline.json        # 随记忆更新写入的人物与伏笔变化
      index\               # 问答检索剪枝用的按章布隆过滤器，见「ai/index/」
```

`library/` 目录（默认路径）已在 `.gitignore`。书库备份 zip 不含 `__trash__` / `__tmp__`。

`tts-position.json` 为可选文件：`{ "chapterId": "c0001", "paragraphIndex": 0, "bodyHash": "1234abcd", "updatedAt": "<ISO-8601>" }`。正文指纹或章节不匹配时，阅读器回退到当前阅读位置。文件随书库备份和搬迁。在线 MP3 缓存位于应用 `userData/tts-cache`，总量上限 500 MB，不属于书库备份。

`ai/bookOverview.json` 为可选文件，版本 1。`text` 保存含剧透的全书概览；`source` 记录各章节文件大小与修改时间；`chapterSummaries` 按章节 ID 保存正文 SHA-256 和章节摘要，用于中断续做及增量生成。`error` 与 `failedSignature` 记录当前章节版本的失败，手动重试时清除。文件缺失或损坏视为尚未生成，不影响阅读器。

`reading-frontier.json` v1 保存 `legacyConfirmed`、按章节 ID 的 `{paragraphIndex, characterOffset, bodyHash, updatedAt}` 和最近阅读会话。旧书 `progress` 只显示为待确认范围；读者确认后才补记以前章节。正文指纹变化时对应位置不能用于 AI。文件原子写入，损坏视为未读。

`ai/semantic-settings.json` v1 保存 `{enabled}`，每书默认关闭。`ai/semantic-index.json` v1 保存向量模型键与已读原文片段、向量及正文哈希；缺失、损坏或模型更换时按未生成重建。只对新增已读片段增量调用 Embeddings API，不保存 Key；Key 加密保存在应用设置存储。`ai/monthly-usage.json` v1 保存自然月、已用估算 tokens 与请求预留；自动概览、自动整理和索引共享每书默认 100000 tokens 上限。未知服务用量按预留计入；此上限不等于服务商账单金额。

`ai/resume-card.json` 保存上次会话结束时间、来源哈希、关键变化/冲突/疑问和原文引用；来源或已读范围变化后视为过期。`ai/timeline.json` 保存记忆更新产生的“出现/变化”记录；当前状态从最新记忆读取。来源失效的条目不显示，重建记忆时从受影响章节重建。所有新增缓存原子写入，损坏按未生成处理。旧聊天、摘要与记忆文件继续可读；旧回答无可核验引用时隐藏内容。

---

## reading-stats.json

书库根的全局阅读统计，版本 1。按天累计，供「阅读统计」面板展示连续天数、时长与字数。

```json
{
  "version": 1,
  "lastAt": 1760000000000,
  "days": {
    "2026-10-18": { "seconds": 1830, "chars": 12400, "books": ["d_ab12", "i_cd34"] }
  }
}
```

- `lastAt` 是最后一次上报的时间戳（ms），用于按「距上次上报的间隔」估算时长；单次间隔封顶 5 分钟，挂机不虚增。
- `days` 键为本地日期 `YYYY-MM-DD`；`seconds` 为当天累计阅读秒数，`chars` 为当天累计阅读字数（按已读前沿前进的字符数估算），`books` 为当天读过的书 id。
- 写入点：`markReadFrontier`（已读前沿上报）内顺带累加，不新增 IPC；`chars` 只在同一份正文内前进时累加，换章/改写算 0。
- 最多保留最近 400 天，超出按日期淘汰。文件缺失或损坏视为无统计，不影响阅读与书库。随书库备份与搬迁。

---

## index.json

书列表缓存。启动时若缺失或与目录不一致，扫描各 `<bookId>/book.json` 重建。
```json
{
  "version": 1,
  "writtenAt": "2026-10-14T09:20:00.000Z",
  "mtimes": { "d_0a776795d22acb41": 1760435200123.456 },
  "books": [
    {
      "id": "…",
      "title": "…",
      "author": "…",
      "tags": [],
      "coverPath": "cover.jpg",
      "importType": "download",
      "status": "ready",
      "chapterCount": 12,
      "readyCount": 12,
      "progress": null,
      "updatedAt": "2026-08-13T00:00:00.000Z"
    }
  ]
}
```

字段对齐 `BookListItem`。

---

## book.json

对齐 `Book`（含完整 `chapters: ChapterMeta[]`）。

| 字段 | 说明 |
|---|---|
| id | 见下方身份算法 |
| title / author | 提取或导入得到；作者可空字符串 |
| tags | 可选 `string[]`，缺省或非法当 `[]`。旧书无此字段、非数组或含非字符串项时按空数组读取，不得因此失败 |
| sourceUrl | 规范化后的目录 URL；导入可空 |
| sourceHost | hostname |
| coverPath | 可选，相对书目录；`index.json` / `BookListItem` 同样可选 |
| importType | `download` \| `txt` \| `epub` |
| createdAt / updatedAt | ISO 8601 |
| status | `downloading` \| `ready` \| `partial` |
| chapters[].id | 建议 `c0001` 与文件名序号一致 |
| chapters[].file | 相对书目录，如 `chapters/0001.json` |
| chapters[].url | 下载章的源 URL；导入可空 |
| chapters[].status | `pending` \| `ready` \| `failed` \| `empty` |
| chapters[].failCode | 可选，`status` 为 `failed` 时携带：`CatalogNotFound` \| `BodyEmpty` \| `BodyGarbled` \| `NeedLogin` \| `Paywall` \| `Intercepted` \| `RateLimited` \| `NavFailed` \| `UnknownPage`；文案取 `FAIL_CODE_ZH`，配套 `failMessage` 为可读说明 |
| progress | `{ chapterId, scrollRatio, bodyHash?, renderedRatio?, paragraphIndex?, paragraphOffset?, updatedAt }` 或 `null`；段落锚点无效时回退到滚动比例。`bodyHash` 为正文指纹，`renderedRatio` 记录当时已渲染到的比例，只用于判「这一章是否读到过末尾」，两者都可选、旧书缺省 |

---

## chapters/NNNN.json

对齐 `ChapterFile`。

```json
{
  "title": "第一章",
  "url": "https://example.com/book/1.html",
  "body": "当前可读正文（纯文本）",
  "bodyRaw": "下载时抽取出的原文，自动清理或 AI 清正文前保留",
  "status": "ready",
  "unlockedBy": "hiddenDom"
}
```

- 阅读器只读 `body`。
- 下载成功时：`bodyRaw` 保留抽取原文；若高置信度广告段落被自动清理，`body` 为清理结果，否则两者相同。只对新下载和重试章应用自动清理，不批量改旧章。
- `unlockedBy` 可选，缺省表示正常抓取。本章正文是付费墙自动恢复来的才携带，取值 `rule` \| `hiddenDom` \| `embeddedJson` \| `encoded` \| `paged` \| `api` \| `ocr`（中文见 `UNLOCK_METHOD_ZH`）。`paged` = 隐藏续页拼接，`api` = 站点章节接口，`ocr` = 图片 / 字形 OCR 认出来的字（可能有错字，务必核对）。旧书没有这个字段，按正常抓取读。`book.json` 的 `chapters[].unlockedBy` 与章节文件保持一致。
- `failCode` / `failMessage` 可选，`status` 为 `failed` 时携带失败码与可读说明；与 `book.json` 的 `chapters[].failCode` / `chapters[].failMessage` 保持一致，随章节文件一次写入。
- 清正文确认后：只改 `body`；撤销 = `body = bodyRaw`。
- 禁止存 HTML；禁止阅读器 `v-html`。

文件名四位序号，与 `ChapterMeta.index`（从 1 起）对应：`0001.json`。

---

## ai/summaries.json

对齐 `AiSummaries` v2。缺省文件视为 `{ version: 2, byChapter: {}, updatedAt: <当前 ISO-8601> }`。

```json
{
  "version": 2,
  "byChapter": { "c0001": "本章摘要" },
  "storySoFar": {
    "uptoChapterId": "c0012",
    "text": "合成前情",
    "updatedAt": "ISO-8601"
  },
  "updatedAt": "ISO-8601"
}
```

- `byChapter` 的值只能是单章摘要，不能写合成前情；只可包含已读范围内章节。
- `storySoFar` 只保存基于已读范围内现有 `byChapter` 合成的前情；缺省表示尚未合成。
- 读取旧版（无 `version: 2`）时：旧 `byChapter` 不得作为章摘要送模型。优先把 `book.progress.chapterId` 对应旧文本搬到 `storySoFar`；否则搬迁 chapters 中 index 最大且有旧文本的一条；之后清空 `byChapter` 并以 v2 回写。非对象或 `byChapter` 非对象视为空 v2，不能导致阅读器崩溃。

---

## ai/memory.json

对齐 `AiMemoryFile` v1。文件不存在时表示尚未生成新记忆；损坏时按无新记忆处理，不影响旧 `characters.json` 或阅读器启动。

用户直接修正的条目可带 `userEditedSummary: true`，人物别名可带 `userEditedAliases: true`。重建时这些字段和对应文字优先于模型输出；重新分析来源章节仍只使用已读正文。

```json
{
  "version": 1,
  "uptoChapterId": "c0012",
  "characters": [
    {
      "id": "character-guqing-ev-c0001-p3",
      "name": "顾清",
      "aliases": ["阿清"],
      "role": "主角",
      "status": "正在寻找父亲留下的账册",
      "summary": "顾家长女，回到旧宅调查父亲失踪前留下的线索。",
      "sources": [
        {
          "id": "ev-c0001-p3",
          "chapterId": "c0001",
          "chapterTitle": "第一章 归来",
          "paragraphIndex": 3,
          "excerpt": "顾清拖着旧箱子站在顾宅门前，门环上的铜锈沾了她一手。"
        }
      ],
      "accuracy": "normal",
      "updatedAt": "ISO-8601"
    }
  ],
  "relations": [],
  "foreshadows": [],
  "events": [],
  "updatedAt": "ISO-8601"
}
```

四类数组字段：

- `characters`: `AiMemoryCharacter`，追加 `name`、`aliases`、`role`、`status`。
- `relations`: `AiMemoryRelation`，追加 `from`、`to`、`relation`、`status`。
- `foreshadows`: `AiMemoryForeshadow`，追加 `desc`、`status: open | resolved | uncertain`。
- `events`: `AiMemoryEvent`，追加 `title`、`participants`、`result`。

所有条目共享 `id`、`summary`、`sources`、`accuracy: normal | review | uncertain`、`updatedAt`。每个来源对齐 `AiCitation`，必须包含真实 `chapterId`、章节标题、纯文本段落下标和 80–160 字摘录；未知 citation id 不得入库。

- 稳定 id 由类别、规范化主键和首个来源组成；同批重复先本地合并。
- 写入同目录临时文件，完成 fsync/close 后 rename 原子替换；失败清理临时文件并保留旧正式文件。
- 新 `memory.json` 一旦存在，UI 只展示新记忆；旧 `characters.json` 不删除、不合并，可用于回退兼容读取。
- 读者纠正人物别名时只替换该人物的 `aliases`，保留 id、来源和准确性；同名、空值和重复别名丢弃，单个别名不超过 20 字，最多 12 个。
- `review` / `uncertain` 默认折叠且不得进入前情事实；模型不能覆盖用户已标记的保守状态。

---

## ai/usage.json

对齐 `AiBookUsage`。缺省或损坏文件按全 0 读取，不阻断阅读。每次成功返回的模型请求计一次调用；服务未报告 token 时仍计次，token 记 0。保存重试不重复计次。不保存金额、提示词或 API Key。

```json
{
  "calls": 3,
  "inputTokens": 1200,
  "outputTokens": 400,
  "cacheHitTokens": 0,
  "cacheMissTokens": 0,
  "updatedAt": "ISO-8601"
}
```

---

## ai/chat.json

旧版对齐 `AiChatFile` v1；新版证据问答对齐 `AiChatFileV2`：

```json
{
  "version": 2,
  "messages": [
    { "role": "user", "content": "顾清为什么回到旧宅？", "uptoChapterId": "c0012" },
    {
      "role": "assistant",
      "content": "她回来是为了寻找父亲留下的账册。",
      "uptoChapterId": "c0012",
      "stopped": false,
      "citations": [
        {
          "id": "ev-c0012-p8",
          "chapterId": "c0012",
          "chapterTitle": "第十二章 旧宅",
          "paragraphIndex": 8,
          "excerpt": "她推开积灰的书房门，想起父亲信中反复提到的那本旧账。"
        }
      ]
    }
  ],
  "updatedAt": "ISO-8601"
}
```

- v1 消息无 `citations` / `uptoChapterId` / `stopped`，按“旧版回答，无来源”读取；首次成功保存证据问答时升级为 v2。
- 每书独立保存，不含 system、reasoning 或 API Key。
- 最多 40 条；超限时删除最旧的完整问答，不能留下没有对应问题的孤立 assistant。
- v2 正式写入必须同目录临时文件完成 fsync/close 后 rename 原子替换；失败保留旧正式文件。缺失或损坏按空历史读取。

---

## annotations.json

对齐 `Annotation[]`（`{ version: 1, items: [...] }`）。书签与划线共用；坐标以「规范化正文」（按空行切段、丢空段后 `\n\n` 连接）为准，划线必带 `excerpt` 供漂移校正。缺省文件视为无标记。

`note` 可空；`noteSource` 只允许 `"user"` 或 `"ai"`，缺省视为 `"user"`。它记的是「这段批注的话是谁写的」：读者自己敲的、或在选区里让 AI 解释后存回来的。只有 AI 来源的批注在界面上标「AI 解释」，改了 `note` 正文就必须同时把 `noteSource` 落回 `"user"`，否则读者改过的话会一直顶着 AI 的名。书签不带 `note`，也就永远不带 `noteSource`。

---

## web-annotations.json

网页阅读模式的标注，对齐 `WebAnnotation[]`（`{ version: 1, items: [...] }`）。放在 `userData` 根目录（与 `web-shelf.json`、`browse-state.json` 同级），**不进书库备份**。

与 `annotations.json` 的唯一差别是归属键：本地标记挂书库 `bookId` + 章节 `chapterId`，网页阅读模式没有书库条目，改用**规范化章节地址** `url`（`canonicalizeUrl` 归一，与 `browse-state.json` 的阅读位置同键）。坐标空间、`excerpt` 漂移校正、`noteSource` 语义与 `annotations.json` 完全一致。

```json
{
  "version": 1,
  "items": [
    {
      "id": "<uuid>",
      "url": "https://example.com/book/1/2.html",
      "kind": "highlight",
      "start": 128,
      "end": 141,
      "excerpt": "风从山口压下来",
      "note": "这段写得好",
      "noteSource": "user",
      "createdAt": "ISO 8601"
    }
  ]
}
```

- 地址非法（非 http/https 或无法解析）的条目在读盘时丢弃；同一 `url` 的不同参数（`?page=`、`utm_*`）经归一后视为同一章。
- 全文件上限 5000 条，超限时保留最新的（按 `createdAt`）；缺省或坏 JSON 视为「还没有标记」。
- 写操作走单文件原子写（临时文件 + fsync + rename）；本文件不与书库共享锁，主进程内按串行 promise 链落盘。

---

## ai/notes.json

「一键本章笔记」的结果，对齐 `AiChapterNote[]`：

```json
{
  "version": 1,
  "notes": [
    {
      "chapterId": "c0012",
      "bodyHash": "<64 位十六进制 sha256>",
      "text": "这一章记下：玉印交到了码头账房手里。",
      "updatedAt": "ISO 8601",
      "userEdited": true
    }
  ]
}
```

- 一章只留最新一条：同 `chapterId` 再写就覆盖，笔记多了不堆历史。文件内按 `chapterId` 定序，重复保存不产生无意义的 diff；界面展示顺序另按 `book.json` 的目录章序排。
- `bodyHash` 是 `chapters/NNNN.json` 里 `body` 字段**原文**的 SHA-256，即生成这条笔记时发给模型的那份正文。读者改过正文（清正文、重新下载、撤销清理）之后 hash 变了，笔记就过期，但内容不删——过期只是提示，不是作废。
- 过期判定要拿正文重算 hash，所以只有阅读器正看着的那一章能被判；其余章节既不为难读者也不谎报新鲜度，界面上不得给它们挂「正文已变」。
- `userEdited` 为真表示这条是读者自己保存的话：AI 重新生成前必须先经读者确认（`ai.chapterNote` 带 `overwriteUserNote`），主进程在没有该标记时才直接覆写。`ai.saveChapterNote` 写入一律带 `userEdited: true`。
- 缺省文件或坏 JSON 视为「还没有笔记」，读取路径照常返回空列表；这个文件随书库备份和搬迁，删掉只等于丢掉笔记，不影响阅读。
- 笔记是读者的私人痕迹：`text` 只作为生成本章笔记与证据问答时「读者关心什么」的不可信线索发往模型，永不当作剧情事实，也永不参与全书概览、记忆抽取等需要引用可核验的 prompt。

---

## ai/follow.json

自动追剧的队列与进度真源，对齐主进程 `FollowFile`。放在磁盘而不是渲染进程，是为了关窗、切书、重启后都能接着跑。

```json
{
  "version": 1,
  "mode": "auto",
  "uptoChapterId": "c0012",
  "queued": ["c0013"],
  "done": { "c0012": { "sig": "<64 位十六进制 sha256>", "at": "ISO-8601", "memoryApplied": true } },
  "paused": false,
  "runChapters": 3,
  "budget": { "calls": 4, "estimatedTokens": 1800 },
  "updatedAt": "ISO-8601"
}
```

- `mode` 只有 `manual | ask | auto`；缺省 `manual`，即永不自己花额度。`ask` 只记账，等读者点「现在整理」。
- `queued` 是「已判定读完、摘要还没跑完」的章；`done[chapterId].sig` 是那次整理所用的正文指纹，同一份正文不会再花第二次钱。`memoryApplied` 表示这一章已进过记忆批次，攒够 5 章才送一批。
- `uptoChapterId` 只记**摘要真正落盘**的最后一章：正文没了、超出已读范围而跳过的章不推进它，也永不倒退。
- 写入必须在书锁内基于「此刻磁盘上的最新内容」只套用增量。一次模型请求要跑几十秒，期间读者还会继续上报新章，把开始时读到的整份快照写回去会抹掉那些新章和 `runChapters`，单次章数上限就此失效、额度白花。
- `runChapters` 对应 `ai.followMaxChaptersPerRun` 护栏，到点置 `paused: true` 并写 `pauseReason`；`retry`（界面「继续 / 现在整理」）清零后才继续。
- `failed.sig` 存的是**本批第一章自己的正文指纹**（记忆批次也一样）。它必须能和「这一章正文变了没」直接比较，存整批合成哈希会让同一批正文被当成正文已变而无限重试。指纹相同就停住等用户，正文真的变了才自动重来。
- 连续网络失败按 5s / 15s / 60s 退避，用尽才落 `failed` 并 `paused`；退避期间被取消不算失败，也不计次。
- 文件缺失、JSON 损坏或字段类型不符一律按缺省读取（`manual`、空队列、计数 0），非法字段单项忽略，不影响阅读与浏览。
- `budget.calls` / `estimatedTokens` 只记次数与估算字数，不记金额、正文或提示词；实际用量以 `ai/usage.json` 为准。
- 这个文件随书库备份和搬迁，删掉只等于「追剧进度没了」；它本身也永不作为任何提示词的材料。

---

## ai/characters.json（只读兼容）

旧版本生成的人物卡 / 伏笔追踪，对齐 `CharacterCard`。**本程序不再生成或改写这个文件**（`ai.characterCard` / `ai.getCharacterCard` 频道已移除），只在 `memory.json` 缺失或无效时由 `ai.getMemory` 经 `readAiMemoryCompat` 读取一次，供升级后仍能取到旧数据。文件不存在或损坏时按「没有旧卡」处理。形状保留如下，便于解读历史文件：

```json
{
  "version": 1,
  "uptoChapterId": "c0012",
  "characters": [{ "name": "张若尘", "role": "主角", "relations": "…", "status": "…" }],
  "foreshadows": [{ "desc": "…", "where": "第三章", "open": true }],
  "raw": "模型原始返回（解析失败时兜底展示）",
  "updatedAt": "ISO 8601"
}
```

---

## ai/index/

问答检索的剪枝索引，可选、可整目录删除。`index-manifest.json` 对齐：

```json
{
  "version": 1,
  "chapters": { "c0012": { "sig": "48123:1728350000000.5", "bits": 16384, "terms": 1432 } }
}
```

每章一个位图侧挂文件 `<chapterId>.json`（`chapterId` 必须匹配 `^[A-Za-z0-9_-]+$`，否则当没建过）：

```json
{ "version": 1, "sig": "48123:1728350000000.5", "bits": 16384, "k": 4, "filter": "base64 位图" }
```

- `sig` 是该章 `chapters/NNNN.json` 的 `size:mtimeMs`，与 `ai/bookOverview.json` 的 `source` 同一口径。正文变了只有那一章重算，其余不动；备份恢复后时间戳全变只会触发重建，不影响正确性。
- 位图里只有该章的词形哈希（归一化视图的相邻二元窗 + 二元组与拉丁词），**不含任何连续正文**，因此不可能泄漏未读剧情；`bits: 0` 表示空章或解析不出正文，不写侧挂。
- 只索引 `index ≤ book.progress.chapterId` 的章。构建点：读章成功后 `wakeEvidenceIndex(bookId)` 后台补建，不阻塞读章返回；提问时只读清单、不建索引。
- 缺文件、坏 JSON、清单损坏、没建完、书库正在恢复 —— 一律按「不知道」处理，调用方照旧全量读盘。**索引坏掉的后果只能是问答变慢，绝不可能是漏引用**；剪枝只在布隆过滤器判「一定不含」时跳过读盘，判「可能含」仍要读原文复核。
- 这些文件只在本机参与剪枝决策，永不进提示词、永不发往模型服务。

---

## 书身份 / 去重

**下载**

1. 取目录页 URL（章节页则先解析出目录 URL）。
2. 规范化：小写 host + URL；去掉 hash；去掉 `page` / `utm_*` 查询参数；再去掉残留的 `?`、末尾 `&`、空 search；去掉末尾 `/`。**不**去掉 `www.`（那是站点规则 `normalizeHost` 的事）。
3. `bookId = "d_" + sha256(host + "\n" + normalizedUrl).slice(0, 16)`

同一 `bookId` 再次「下载本书」= 合并目录、只补 `pending` / `failed` / `empty` 章，**不建第二本**。

**导入**

1. 读取文件字节，`bookId = "i_" + sha256(bytes).slice(0, 16)`。
2. 不与在线书自动合并。
3. 源文件复制到 `origin/`（保留原名）。

---

## 设置

路径：`%APPDATA%/spbf/settings.json`。主进程在读取设置 / `userData` 之前调用 `app.setName('spbf')`，因此 `app.getPath('userData')` 即此目录。不从 `%APPDATA%/小说浏览器` 迁移。

```json
{
  "libraryPath": "D:\\spbf\\library",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-v4-flash",
  "apiKeyEnc": "safeStorage 产出的 base64，未配置则省略",
  "ttsApiKeyEnc": "独立的在线语音 Key，safeStorage 产出的 base64，未配置则省略",
  "reader": {
    "fontSize": 18,
    "lineHeight": 1.8,
    "theme": "paper",
    "fontFamily": "serif",
    "contentWidth": "medium",
    "paragraphSpacing": "normal",
    "paragraphIndent": true,
    "focusMode": "off",
    "readingMode": "scroll",
    "dim": 0
  },
  "tts": {
    "rate": 1,
    "autoNextChapter": true,
    "source": "system",
    "systemVoiceURI": "",
    "onlineEndpoint": "",
    "onlineModel": "",
    "onlineVoice": ""
  },
  "appearance": {
    "skin": "light"
  },
  "autoBackup": {
    "destDir": "D:\\spbf\\backups",
    "lastSuccessAt": "2026-09-30T00:00:00.000Z",
    "lastError": ""
  },
  "ai": {
    "provider": "deepseek",
    "thinkingEnabled": true,
    "recapLength": "standard",
    "trustedCustomOrigins": [],
    "promptMode": {
      "clean": "builtin",
      "translate": "builtin",
      "chapterSummary": "builtin",
      "recap": "builtin",
      "memory": "builtin",
      "evidenceQa": "builtin"
    },
    "customPrompts": {}
  }
}
```

- API Key **不得**明文写入书库或 git。
- `settings.get` IPC 不返回明文，只返回 `apiKeyConfigured`。
- 新安装默认 `baseUrl=https://api.deepseek.com/v1`、`model=deepseek-v4-flash`、`ai.provider=deepseek`；已有用户的 `baseUrl`、`model`、`apiKeyEnc` 原样保留，旧模型名只提示、不得静默改写。
- 旧设置缺 `ai` 或其中字段损坏时逐字段补默认：`thinkingEnabled=true`、`recapLength=standard`、`budgetWarningTokens=8000`、trusted 空、`autoBookOverview=false`、`autoReadingFollow=false`、`followMaxChaptersPerRun=12`（只接受 1–50 的整数）、六类 `promptMode=builtin`、`customPrompts={}`。预算提醒阈值限制在 1000–50000 tokens。非法 provider/origin/prompt kind 单项忽略，不丢弃其他合法字段。
- `trustedCustomOrigins` 只保存协议 + hostname + 有效端口组成的规范化 origin；路径变化不产生新信任项，协议或端口变化需要重新确认。
- `settings.json` **不含**站点规则（没有 `rules` / `siteRules` 数组）。规则见同级 `site-rules.json`。
- 同级 `browse-state.json` 保存最近网页 `{ url, ratio, updatedAt }` 与按规范化域名映射的缩放比例；不属于书库备份。缺失或损坏时按无恢复位置、默认 100% 缩放读取。
- `browse-state.json` 另存 `readingByUrl`：按 `canonicalizeUrl` 归一后的网页地址映射到阅读模式的 `{ paragraphIndex, scrollRatio, updatedAt }`，最多 200 条（超出按 `updatedAt` 淘汰最旧）。缺这个字段或条目非法时按无位置读取，不影响 `last` 与 `zoomByHost`。
- `settings.json` 的 `webReading` 保存网页阅读模式偏好：`autoSpeed` 为 1–5 的整数（默认 3，越界夹紧、非数值回退默认），`autoPage` 为布尔值（默认 `true`）。缺失或损坏时补默认，不丢弃其他设置。
- `autoBackup.destDir` 为空表示关闭；主进程启动时距上次成功满七天则创建 `spbf-auto-*.zip`，仅保留最近五份自动备份。旧设置缺失时按关闭读取。备份包不含设置与 API Key。
- `appearance.skin` 取值 `light`（浅色，默认）/ `dark`（深色）。旧 `paper`、`white`、`sakura`、`minimal` 读入为 `light`，旧 `night` 读入为 `dark`；非法值回退 `light`。读取迁移不改动其他设置，下一次保存外观时写入正式值。
- `reader.fontSize` 为 12–36 的有限数值，默认 18；`reader.lineHeight` 为 1.2–3.0 的有限数值，默认 1.8。越界值夹紧，NaN/Infinity 或非数值回退默认。
- `reader.theme` 取值 `paper`（默认）/ `sepia` / `gray` / `night`；`reader.fontFamily` 取值 `serif`（默认）/ `system` / `mono`；`reader.contentWidth` 取值 `narrow` / `medium`（默认）/ `wide`；`reader.paragraphSpacing` 取值 `compact` / `normal`（默认）/ `relaxed`；`reader.paragraphIndent` 为布尔值，默认 `true`；`reader.focusMode` 取值 `off`（默认）/ `one` / `three` / `five`；`reader.readingMode` 取值 `scroll`（默认）/ `screen`。非法字段逐项回退，不影响其他合法设置。缺失或非法的 `focusMode` 回退 `off`。缺失或非法的 `readingMode` 回退 `scroll`。
- `reader.dim` 为护眼压暗百分比（正文区黑色遮罩的不透明度），有限数值四舍五入并夹紧到 0–70，默认 `0`（关）；缺失/非数值回退 `0`。旧设置无此字段时按 `0` 启动，不改变其他偏好。
- 向后兼容：有效的新 `theme` 优先；新主题缺失或非法时，旧 `nightMode: true` 迁移为 `night`、`false` 迁移为 `paper`。首次成功保存新偏好后写入新字段；未知旧字段允许继续保留，但读取逻辑不再依赖它们。设置文件整体损坏时按默认值启动，不重建书库、章节、进度或标记数据。

---

## 站点规则

路径：`%APPDATA%/spbf/site-rules.json`（与 `settings.json` 同目录）。

```json
{
  "version": 1,
  "rules": [
    { "host": "example.com", "title": "h1", "author": ".author", "catalog": "#list", "body": "#content", "previousChapter": ".prev a", "nextChapter": ".next a", "adFilterEnabled": true, "adHideSelectors": ".floating-ad\n#banner", "bodyCleanPatterns": "^最新网址$|^手机版阅读$" }
  ]
}
```

- 缺省文件视为 `{ version: 1, rules: [] }`。
- 旧规则缺少 `adFilterEnabled` 时浏览页去广告默认开启；`adHideSelectors` 缺省为空。每行一条额外隐藏选择器，无效选择器不影响内置隐藏规则。
- `previousChapter` 与 `nextChapter` 可选，分别指向本页上一章、下一章的链接元素；旧规则缺少时自动识别。
- `bodyCleanPatterns` 可选，每行一条正则，命中整段正文即删除（阅读模式与下载共用）。最多 20 行、每行 200 字符；非法正则忽略该行，不影响其它行与内置噪音规则。
- 文件内不得存 API Key。
- `%APPDATA%/spbf/adguard-network.bin` 是从 [AdGuard Base filter](https://filters.adtidy.org/extension/chromium/filters/2.txt) 编译出的本地网络规则缓存；只解析网络规则，不加载浏览器扩展或脚本注入规则。`adguard-network.json` 记录来源和更新时间。应用启动后后台加载缓存，并在缓存超过 8 天时从官方 HTTPS 地址更新。下载或解析失败时保留上次有效缓存；首次离线时只有本地 CSS 隐藏生效。缓存不含浏览历史或 API Key。

---

## 网页书架

路径：`%APPDATA%/spbf/web-shelf.json`（与 `settings.json` 同目录），**不属于**书库备份，不保存在书库根目录里。

```json
{
  "version": 1,
  "books": [
    {
      "id": "site-9f2c1a4b",
      "host": "example.com",
      "title": "示例书名",
      "author": "示例作者",
      "coverUrl": "https://example.com/cover.jpg",
      "catalogUrl": "https://example.com/book/65/",
      "lastChapter": { "title": "第 12 章 起风", "url": "https://example.com/book/65/12.html" },
      "chapters": [
        { "title": "第 1 章 开端", "url": "https://example.com/book/65/1.html" }
      ],
      "chaptersFetchedAt": "2026-10-12T09:00:00.000Z",
      "addedChapters": 3,
      "lastRefreshedAt": "2026-10-12T09:00:00.000Z",
      "progress": { "paragraphIndex": 24, "scrollRatio": 0.31, "updatedAt": "2026-10-12T09:20:00.000Z" },
      "createdAt": "2026-10-10T08:00:00.000Z",
      "updatedAt": "2026-10-12T09:20:00.000Z"
    }
  ]
}
```

- 网页书只保存书目、目录快照与阅读位置，**不保存正文**；打开与续读都在内置浏览器里进行。
- 上限：最多 500 本；每本 `chapters` 最多 3000 条，超出时保留靠前的 3000 条并把目录标为截断。
- `chapters` 允许为空数组（抓不到目录的站），此时书架显示「目录待识别」，跳章依赖页面里的上一章 / 下一章。
- `id` 由 host + 规范化 `catalogUrl` 生成，同一本书重复加入时更新原条目而不新增。
- 文件缺失视为空书架；整体损坏时按空读取，不重建书库。单条非法（缺 `id` / 非 http(s) 地址 / 字段类型不对）时只丢弃该条，不影响其他条目。
- `addedChapters` 是上次刷新发现的更新章数，只用于书架角标；刷新之间的变化不累计。
- 读取顺序：先 `createdAt` 倒序，`progress` 非空的书按 `progress.updatedAt` 优先。（渲染侧排序口径见书架卡片实现。）
