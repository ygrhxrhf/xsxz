import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  bookExists,
  bookIdFromBytes,
  copyOriginFile,
  createBookFromBootstrap,
  markChapterStatus,
  refreshBookStatus,
  writeChapterFile,
} from './library'
import type { ChapterFile } from '../shared/types'

const CHAPTER_RE = /^[ \t]*第[0-9一二三四五六七八九十百千万零〇两壹贰叁肆伍陆柒捌玖拾佰仟]+[章节卷回部集][^\n]{0,60}$/m

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
  if (currentBody.length > 0) {
    chapters.push({ title: currentTitle, body: currentBody.join('\n').trim() })
  }
  return chapters.filter((c) => c.body.length > 0)
}

function replacementRatio(text: string): number {
  if (!text.length) return 1
  const bad = (text.match(/\uFFFD/g) || []).length
  return bad / Math.min(text.length, 4000)
}

function decode(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le')
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf-8')
  const utf8 = buf.toString('utf-8')
  if (replacementRatio(utf8) < 0.01) return utf8
  try {
    const gbk = new TextDecoder('gbk').decode(buf)
    if (replacementRatio(gbk) < replacementRatio(utf8)) return gbk
  } catch {
    /* no gbk */
  }
  try {
    const gb18030 = new TextDecoder('gb18030').decode(buf)
    if (replacementRatio(gb18030) < replacementRatio(utf8)) return gb18030
  } catch {
    /* no gb18030 */
  }
  return utf8
}

export async function importTxt(filePath: string): Promise<{ bookId: string }> {
  const buf = await readFile(filePath)
  const bytes = new Uint8Array(buf)
  const bookId = bookIdFromBytes(bytes)
  if (await bookExists(bookId)) {
    return { bookId }
  }

  const text = decode(buf)
  const fileName = basename(filePath, extname(filePath))
  const parts = splitByChapter(text)
  const titles = parts.length > 0 ? parts.map((p) => p.title) : [fileName]
  const bodies = parts.length > 0 ? parts.map((p) => p.body) : [text]

  const book = await createBookFromBootstrap({
    bookId,
    title: fileName,
    author: '',
    importType: 'txt',
    chapterTitles: titles,
  })
  await copyOriginFile(bookId, filePath)
  for (let i = 0; i < book.chapters.length; i++) {
    const ch = book.chapters[i]
    const file: ChapterFile = { title: titles[i], body: bodies[i] ?? '', status: 'ready' }
    await writeChapterFile(bookId, ch.id, file)
    await markChapterStatus(bookId, ch.id, 'ready')
  }
  await refreshBookStatus(bookId)
  return { bookId }
}
