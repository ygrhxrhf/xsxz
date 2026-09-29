# 磁盘 schema

## 书库根目录

默认：`D:\spbf\library`（`Settings.libraryPath`，可改）。

```
<libraryPath>\
  index.json
  __tmp__\
  __trash__\               # 回收站：删除的书整目录移入 <bookId>-<删除毫秒>；不自动清理
  <bookId>\
    book.json
    annotations.json       # 书签 / 划线（见下）
    origin\                 # 导入时保留的源文件
    chapters\
      0001.json
    ai\
      summaries.json
      characters.json      # 旧 AI 人物卡 / 伏笔追踪；兼容保留
      memory.json          # 可核验小说记忆 v1（用户触发后生成）
      chat.json            # 聊天 v1 / 证据问答 v2
```

`library/` 目录（默认路径）已在 `.gitignore`。书库备份 zip 不含 `__trash__` / `__tmp__`。

---

## index.json

书列表缓存。启动时若缺失或与目录不一致，扫描各 `<bookId>/book.json` 重建。

```json
{
  "version": 1,
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
| progress | `{ chapterId, scrollRatio, updatedAt }` 或 `null` |

---

## chapters/NNNN.json

对齐 `ChapterFile`。

```json
{
  "title": "第一章",
  "url": "https://example.com/book/1.html",
  "body": "当前可读正文（纯文本）",
  "bodyRaw": "下载时的原文，清正文前写入",
  "status": "ready"
}
```

- 阅读器只读 `body`。
- 下载成功时：`body` 与 `bodyRaw` 相同。
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
- `review` / `uncertain` 默认折叠且不得进入前情事实；模型不能覆盖用户已标记的保守状态。

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

---

## ai/characters.json

AI 人物卡 / 伏笔追踪，对齐 `CharacterCard`：

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

材料红线与摘要一致：只允许已读进度之前的章节进入提示词。缺省文件视为无人物卡。

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
  "reader": {
    "fontSize": 18,
    "lineHeight": 1.8,
    "theme": "paper",
    "fontFamily": "serif",
    "contentWidth": "medium",
    "paragraphSpacing": "normal",
    "paragraphIndent": true,
    "focusMode": "off",
    "readingMode": "scroll"
  },
  "tts": {
    "rate": 1,
    "autoNextChapter": true
  },
  "appearance": {
    "skin": "paper"
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
- 旧设置缺 `ai` 或其中字段损坏时逐字段补默认：`thinkingEnabled=true`、`recapLength=standard`、trusted 空、六类 `promptMode=builtin`、`customPrompts={}`。非法 provider/origin/prompt kind 单项忽略，不丢弃其他合法字段。
- `trustedCustomOrigins` 只保存协议 + hostname + 有效端口组成的规范化 origin；路径变化不产生新信任项，协议或端口变化需要重新确认。
- `settings.json` **不含**站点规则（没有 `rules` / `siteRules` 数组）。规则见同级 `site-rules.json`。
- `appearance.skin` 取值 `paper`（暖纸，默认）/ `white`（白纸）/ `night`（夜间）；旧 `sakura`、`minimal` 读入为 `paper`；非法值回退 `paper`。
- `reader.fontSize` 为 12–36 的有限数值，默认 18；`reader.lineHeight` 为 1.2–3.0 的有限数值，默认 1.8。越界值夹紧，NaN/Infinity 或非数值回退默认。
- `reader.theme` 取值 `paper`（默认）/ `sepia` / `gray` / `night`；`reader.fontFamily` 取值 `serif`（默认）/ `system` / `mono`；`reader.contentWidth` 取值 `narrow` / `medium`（默认）/ `wide`；`reader.paragraphSpacing` 取值 `compact` / `normal`（默认）/ `relaxed`；`reader.paragraphIndent` 为布尔值，默认 `true`；`reader.focusMode` 取值 `off`（默认）/ `one` / `three` / `five`；`reader.readingMode` 取值 `scroll`（默认）/ `screen`。非法字段逐项回退，不影响其他合法设置。缺失或非法的 `focusMode` 回退 `off`。缺失或非法的 `readingMode` 回退 `scroll`。
- 向后兼容：有效的新 `theme` 优先；新主题缺失或非法时，旧 `nightMode: true` 迁移为 `night`、`false` 迁移为 `paper`。首次成功保存新偏好后写入新字段；未知旧字段允许继续保留，但读取逻辑不再依赖它们。设置文件整体损坏时按默认值启动，不重建书库、章节、进度或标记数据。

---

## 站点规则

路径：`%APPDATA%/spbf/site-rules.json`（与 `settings.json` 同目录）。

```json
{
  "version": 1,
  "rules": [
    { "host": "example.com", "title": "h1", "author": ".author", "catalog": "#list", "body": "#content" }
  ]
}
```

- 缺省文件视为 `{ version: 1, rules: [] }`。
- 文件内不得存 API Key。
