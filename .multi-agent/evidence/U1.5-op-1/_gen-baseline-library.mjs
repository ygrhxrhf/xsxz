// U1.5-op-1 基线样例库：给「未下载时顶栏默认收起」一组对照读数。只写 /tmp。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LIB = process.argv[2] || '/tmp/U1.5-op-1/library'
const BOOK_ID = 'sample_baseline'
const dir = join(LIB, BOOK_ID)
const now = new Date().toISOString()

const chapters = [1, 2].map((i) => ({
  id: `c000${i}`,
  index: i,
  title: `第${i}章 基线样例章`,
  file: `chapters/000${i}.json`,
  status: 'ready',
}))

const book = {
  id: BOOK_ID,
  title: '样例·基线书',
  author: '样例作者',
  tags: ['样例'],
  importType: 'download',
  sourceUrl: 'http://127.0.0.1:37855/book1/index.html',
  sourceHost: '127.0.0.1',
  createdAt: now,
  updatedAt: now,
  status: 'ready',
  chapters,
  progress: { chapterId: 'c0001', scrollRatio: 0, updatedAt: now },
}

await mkdir(join(dir, 'chapters'), { recursive: true })
await mkdir(join(dir, 'ai'), { recursive: true })
for (const ch of chapters) {
  const paras = Array.from({ length: 8 }, (_, p) =>
    `验收占位段落 ${ch.index}-${p + 1}：这一段只是样例正文，用来给阅读页顶栏的默认收起状态做对照，不含任何作品内容。`)
  // ChapterFile 契约：title/url/body/status（不是 paragraphs）
  await writeFile(join(dir, ch.file), JSON.stringify({
    title: ch.title,
    url: `http://127.0.0.1:37855/book1/c00${ch.index}.html`,
    body: paras.join('\n\n'),
    status: 'ready',
  }, null, 2))
}
await writeFile(join(dir, 'book.json'), JSON.stringify(book, null, 2))
await writeFile(join(LIB, 'index.json'), JSON.stringify({
  version: 1,
  books: [{
    id: BOOK_ID, title: book.title, author: book.author, tags: book.tags,
    status: 'ready', importType: 'download', chapterCount: 2,
    createdAt: now, updatedAt: now, sourceHost: '127.0.0.1', progress: book.progress,
  }],
}, null, 2))
console.log('baseline library:', LIB)
