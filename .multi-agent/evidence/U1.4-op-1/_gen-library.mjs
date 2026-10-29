// U1.4-op-1 样例库生成（只写 /tmp，不属于产品代码）。
import fs from 'node:fs'
import path from 'node:path'

const root = '/tmp/U1.4-op-1'
const lib = path.join(root, 'library')
const bookId = 'sample_u14'
const bookDir = path.join(lib, bookId)

fs.rmSync(path.join(root, 'library'), { recursive: true, force: true })
fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true })
fs.mkdirSync(path.join(bookDir, 'ai', 'index'), { recursive: true })
fs.mkdirSync(path.join(root, 'userData'), { recursive: true })

const TAIL_1 = '请收藏本站，下次不迷路。本站域名 www.example.com 请记住。'
const KEEP_1 = '请收藏这封信。信上只写了三行字，字迹很轻，末尾没有署名。'
const TAIL_2 = '请收藏本站：本章已完，下一章更精彩。本站域名 www.example.com 请记住。'

const normal = (n, tail) => `第 ${n} 段样例正文（验收占位，不含真实作品内容）。${tail}`

const ch1 = [
  normal(1, '窗外下着小雨，街上的车灯把水洼照得发亮，远处有人撑着伞快步走过。'),
  TAIL_1,
  KEEP_1,
  normal(2, '台灯下的纸边微微卷起，他伸手把折角压平，又放下笔。'),
  normal(3, '橡木桌上摆着一只旧茶杯，杯沿有一道洗不掉的茶渍。'),
  normal(4, '他把窗关上，屋里的风声立刻退到玻璃外面去了。'),
  normal(5, '走廊尽头的灯忽明忽暗，脚步声在狭窄的楼道里来回折返。'),
  normal(6, '书页之间夹着一张车票，边角已经磨毛，日期看不太清了。'),
  normal(7, '雨停之后，空气里有一种潮湿的铁锈味，从排水口慢慢升上来。'),
].join('\n\n')

const ch2 = [
  normal(21, '第二天早上，楼道里贴了一张褪色的通知，字迹被水洇开了一半。'),
  TAIL_2,
  normal(22, '他把伞靠在门后，伞尖的水在地砖上积成小小的一洼。'),
  normal(23, '楼下的早餐摊刚支起来，铁板上滋滋作响，白汽顺着棚子往上走。'),
  normal(24, '有人在他背后喊了一声，他回头看见一个抱着纸箱的人。'),
  normal(25, '纸箱里装的都是旧书，边角压得整整齐齐，最上面一本没有了封面。'),
  normal(26, '他翻了两页，纸上有一行铅笔字，写得很轻，像是随时准备擦掉。'),
].join('\n\n')

const chapters = [
  { id: 'c0001', index: 1, title: '第一章 样例尾巴章', file: 'chapters/0001.json', body: ch1 },
  { id: 'c0002', index: 2, title: '第二章 样例换章', file: 'chapters/0002.json', body: ch2 },
]

for (const ch of chapters) {
  fs.writeFileSync(path.join(bookDir, 'chapters', path.basename(ch.file)), JSON.stringify({
    title: ch.title, url: `https://sample.invalid/u14/${ch.index}.html`, body: ch.body,
  }, null, 2))
}

const now = '2026-10-29T12:20:00.000Z'
const book = {
  id: bookId, title: '样例·整段净化', author: '样例作者', tags: ['样例'],
  sourceUrl: 'https://sample.invalid/u14/', sourceHost: 'sample.invalid',
  importType: 'download', createdAt: now, updatedAt: now, status: 'partial',
  chapters: chapters.map((ch) => ({
    id: ch.id, index: ch.index, title: ch.title,
    url: `https://sample.invalid/u14/${ch.index}.html`, file: ch.file, status: 'ready',
  })),
  progress: { chapterId: 'c0001', scrollRatio: 0, paragraphIndex: 0, paragraphOffset: 0, updatedAt: now },
}
fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify(book, null, 2))
fs.writeFileSync(path.join(bookDir, 'reading-frontier.json'), JSON.stringify({
  version: 1, bookId, legacyConfirmed: true, chapters: {}, updatedAt: now,
}, null, 2))
fs.writeFileSync(path.join(bookDir, 'ai', 'index', 'index-manifest.json'), JSON.stringify({ version: 1, chapters: {} }, null, 2))

fs.writeFileSync(path.join(lib, 'index.json'), JSON.stringify({
  version: 2,
  books: [{
    id: bookId, title: book.title, author: book.author, tags: ['样例'],
    sourceUrl: book.sourceUrl, importType: 'download', status: 'partial',
    chapterCount: 2, readyCount: 2, unlockedCount: 0,
    progress: { chapterId: 'c0001', scrollRatio: 0, updatedAt: now }, updatedAt: now,
  }],
  writtenAt: now, mtimes: { [bookId]: Date.now() },
}, null, 2))
fs.writeFileSync(path.join(lib, 'reading-stats.json'), JSON.stringify({ version: 1, books: {} }, null, 2))
fs.mkdirSync(path.join(lib, '__tmp__'), { recursive: true })

fs.writeFileSync(path.join(root, 'userData', 'settings.json'), JSON.stringify({
  libraryPath: lib,
  appearance: { skin: 'light' },
  reader: {
    fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif',
    contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true,
    focusMode: 'off', readingMode: 'scroll', dim: 0,
  },
}, null, 2))

const p1 = ch1.split(/\n{2,}/)
const p2 = ch2.split(/\n{2,}/)
console.log(JSON.stringify({
  lib, ch1Paras: p1.length, ch2Paras: p2.length,
  tail1Index: p1.indexOf(TAIL_1), keep1Index: p1.indexOf(KEEP_1), tail2Index: p2.indexOf(TAIL_2),
  TAIL_1, KEEP_1, TAIL_2,
}, null, 2))
