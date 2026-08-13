# 磁盘 schema

## 书库根目录

默认：`D:\spbf\library`（`Settings.libraryPath`，可改）。

```
<libraryPath>\
  index.json
  <bookId>\
    book.json
    origin\                 # 导入时保留的源文件
    chapters\
      0001.json
    ai\
      summaries.json
```

`library/` 目录（默认路径）已在 `.gitignore`。

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
| sourceUrl | 规范化后的目录 URL；导入可空 |
| sourceHost | hostname |
| coverPath | 可选，相对书目录 |
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

对齐 `AiSummaries`。只写已读章摘要。缺省文件视为无摘要。

---

## 书身份 / 去重

**下载**

1. 取目录页 URL（章节页则先解析出目录 URL）。
2. 规范化：小写 host；去掉 hash；去掉常见分页/追踪查询参数（`page`、`utm_*` 等）；去掉末尾 `/`。
3. `bookId = "d_" + sha256(host + "\n" + normalizedUrl).slice(0, 16)`

同一 `bookId` 再次「下载本书」= 合并目录、只补 `pending` / `failed` / `empty` 章，**不建第二本**。

**导入**

1. 读取文件字节，`bookId = "i_" + sha256(bytes).slice(0, 16)`。
2. 不与在线书自动合并。
3. 源文件复制到 `origin/`（保留原名）。

---

## 设置

路径：`%APPDATA%/spbf/settings.json`（Electron `app.getPath('userData')` 若产品名定为 spbf，即此目录）。

```json
{
  "libraryPath": "D:\\spbf\\library",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKeyEnc": "safeStorage 产出的 base64，未配置则省略",
  "reader": {
    "fontSize": 18,
    "lineHeight": 1.8,
    "nightMode": false
  }
}
```

- API Key **不得**明文写入书库或 git。
- `settings.get` IPC 不返回明文，只返回 `apiKeyConfigured`。
