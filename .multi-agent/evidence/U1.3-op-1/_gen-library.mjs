// U1.3-op-1 样例库生成脚本（仅 /tmp，不属于产品代码）。
// 构造：一章内有一段「约 4 行、会被屏底切断」的短段，以及一段「明显高于一屏」的超长段。
import fs from 'node:fs'
import path from 'node:path'

const root = '/tmp/U1.3-op-1'
const lib = path.join(root, 'library')
const bookId = 'sample_u13'
const bookDir = path.join(lib, bookId)

fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true })
fs.mkdirSync(path.join(bookDir, 'ai', 'index'), { recursive: true })

const filler = '用于确认屏幕翻页落点与屏底切断段是否从段首重开的样例占位文字不含任何真实作品内容'
function para(n, chars) {
  const head = `第 ${n} 段：这是样例段落的完整首句。`
  let body = head
  let i = 0
  while (body.length < chars) { body += filler[i % filler.length]; i += 1 }
  return body.slice(0, Math.max(chars, head.length))
}

const specList = [...Array(9).fill(40), 110, 40, 40, 40, 2000, ...Array(8).fill(40)]
const paras = specList.map((c, i) => para(i + 1, c))
const body = paras.join('\n\n')

const chapters = [
  { id: 'c0001', index: 1, title: '第一章 样例翻页', file: 'chapters/0001.json', body },
  {
    id: 'c0002', index: 2, title: '第二章 样例续页', file: 'chapters/0002.json',
    body: specList.map((c, i) => para(i + 101, c)).join('\n\n'),
  },
]

for (const ch of chapters) {
  fs.writeFileSync(path.join(bookDir, 'chapters', path.basename(ch.file)), JSON.stringify({
    title: ch.title, url: `https://sample.invalid/u13/${ch.index}.html`, body: ch.body,
  }, null, 2))
}

const now = '2026-10-29T11:00:00.000Z'
const book = {
  id: bookId, title: '样例·屏底翻页', author: '样例作者', tags: ['样例'],
  sourceUrl: 'https://sample.invalid/u13/', sourceHost: 'sample.invalid',
  importType: 'download', createdAt: now, updatedAt: now, status: 'partial',
  chapters: chapters.map((ch) => ({
    id: ch.id, index: ch.index, title: ch.title,
    url: `https://sample.invalid/u13/${ch.index}.html`, file: ch.file, status: 'ready',
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

fs.mkdirSync(path.join(root, 'userData'), { recursive: true })
fs.writeFileSync(path.join(root, 'userData', 'settings.json'), JSON.stringify({
  libraryPath: lib,
  appearance: { skin: 'light' },
  reader: {
    fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif',
    contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true,
    focusMode: 'off', readingMode: 'scroll', dim: 0,
  },
}, null, 2))

console.log(JSON.stringify({
  lib, paraCount: paras.length,
  targetParaIndex: 9, targetChars: paras[9].length, targetHead: paras[9].slice(0, 40),
  longParaIndex: 13, longChars: paras[13].length, longHead: paras[13].slice(0, 40),
}, null, 2))
