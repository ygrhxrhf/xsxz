// U1.6-op-1 样例库：/tmp 下自建，书名带「样例」，第一章含正常叙述段 + 整段站点尾巴。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LIB = process.argv[2] || '/tmp/U1.6-op-1/library'
const BOOK_ID = 'sample_tail'
const now = new Date().toISOString()
const dir = join(LIB, BOOK_ID)

const ch1 = [
  '样例正文第一段：雨停之后，街灯把水面照成一条条亮线，他沿着巷口慢慢往家走。',
  '样例正文第二段：这一段是正常叙述，用来对照站点尾巴是否被整段藏掉。',
  '请收藏本站，下次不迷路。本站域名 www.example.com 请记住。',
  '样例正文第三段：这是尾巴之后的正常段落，净化打开时它仍然应当显示。',
]
const ch2 = [
  '样例正文第二章第一段：样例数据，只用于验收阅读页的净化与顶栏显示。',
  '样例正文第二章第二段：这里不含任何作品内容。',
]

const chapters = [
  { id: 'c0001', index: 1, title: '第1章 样例章·带站尾', file: 'chapters/0001.json', status: 'ready' },
  { id: 'c0002', index: 2, title: '第2章 样例章·无站尾', file: 'chapters/0002.json', status: 'ready' },
]

const book = {
  id: BOOK_ID,
  title: '样例·站尾样书',
  author: '样例作者',
  tags: ['样例'],
  importType: 'download',
  sourceUrl: 'http://127.0.0.1:37856/book1/index.html',
  sourceHost: '127.0.0.1',
  createdAt: now,
  updatedAt: now,
  status: 'ready',
  chapters,
  progress: { chapterId: 'c0001', scrollRatio: 0, paragraphIndex: 0, paragraphOffset: 0, updatedAt: now },
}

await mkdir(join(dir, 'chapters'), { recursive: true })
await mkdir(join(dir, 'ai'), { recursive: true })
await writeFile(join(dir, 'chapters/0001.json'), JSON.stringify({
  title: chapters[0].title, url: 'http://127.0.0.1:37856/book1/c001.html',
  body: ch1.join('\n\n'), status: 'ready',
}, null, 2))
await writeFile(join(dir, 'chapters/0002.json'), JSON.stringify({
  title: chapters[1].title, url: 'http://127.0.0.1:37856/book1/c002.html',
  body: ch2.join('\n\n'), status: 'ready',
}, null, 2))
await writeFile(join(dir, 'book.json'), JSON.stringify(book, null, 2))
console.log('library ready:', dir)
