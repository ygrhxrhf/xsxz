import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { bookIdFromBytes, createBookFromBootstrap, writeChapterFile, markChapterReady } from './library'
import type { ChapterFile, ChapterStatus } from '../shared/types'

const CHAPTER_RE = /^[ \t]*第[0-9一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+[章节卷回部集][^\n]{0,60}$/m

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function splitByChapter(text: string): { title: string; body: string }[] {
  const lines = text.split('\n')
  const chapters: { title: string; body: string }[] = []
  let currentTitle = '正文'
  let currentBody: string[] = []

  for (const line of lines) {
    if (CHAPTER_RE.test(line)) {
      if (currentBody.length > 0 || chapters.length === 0) {
        chapters.push({ title: currentTitle, body: currentBody.join('\n').trim() })
      }
      currentTitle = line.trim()
      currentBody = []
    } else {
      currentBody.push(line)
    }
  }
  // last chapter
  if (currentBody.length > 0) {
    chapters.push({ title: currentTitle, body: currentBody.join('\n').trim() })
  }
  // filter empty
  return chapters.filter((c) => c.body.length > 0)
}

function detectEncoding(buf: Buffer): string {
  const str = buf.toString('latin1')
  // BOM
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le'
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be'
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8'
  // heuristic: lots of high bytes → gbk
  let high = 0
  for (let i = 0; i < Math.min(2000, str.length); i++) {
    if (str.charCodeAt(i) > 0x7f) high++
  }
  return high > 100 ? 'gbk' : 'utf-8'
}

function decode(buf: Buffer): string {
  const enc = detectEncoding(buf)
  if (enc === 'utf-8') return buf.toString('utf-8')
  // TextDecoder supports gbk
  return new TextDecoder(enc).decode(buf)
}

export async function importTxt(filePath: string): Promise<{ bookId: string }> {
  const buf = await readFile(filePath)
  const bytes = new Uint8Array(buf)
  const bookId = bookIdFromBytes(bytes)
  const text = decode(buf)
  const fileName = basename(filePath, extname(filePath))

  const parts = splitByChapter(text)
  if (parts.length === 0) {
    // single chapter
    const book = await createBookFromBootstrap({
      bookId,
      title: fileName,
      author: '',
      importType: 'txt',
      chapterTitles: [fileName],
    })
    const ch = book.chapters[0]
    const file: ChapterFile = { title: fileName, body: text, status: 'ready' }
    await writeChapterFile(bookId, ch.id, file)
    await markChapterReady(bookId, ch.id, 'ready')
    return { bookId }
  }

  const book = await createBookFromBootstrap({
    bookId,
    title: fileName,
    author: '',
    importType: 'txt',
    chapterTitles: parts.map((p) => p.title),
  })
  for (let i = 0; i < parts.length; i++) {
    const ch = book.chapters[i]
    const file: ChapterFile = { title: parts[i].title, body: parts[i].body, status: 'ready' }
    await writeChapterFile(bookId, ch.id, file)
    await markChapterReady(bookId, ch.id, 'ready')
  }
  return { bookId }
}
