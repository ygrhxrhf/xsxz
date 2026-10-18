/**
 * 「一键本章笔记」的落盘（<bookDir>/ai/notes.json）：一章一条，bodyHash 决定它是否过期。
 * 读者亲手改过的笔记只提示、不覆盖 —— 笔记的价值就在于它是读者自己的话。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText, bookDir, withBookLock } from './library'
import type { AtomicWriteOptions } from './atomicFile'
import type { AiChapterNote } from '../shared/types'

interface NotesFile {
  version: 1
  notes: AiChapterNote[]
}

function notesPath(bookId: string): string {
  return join(bookDir(bookId), 'ai', 'notes.json')
}

export function chapterBodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

async function readAll(bookId: string): Promise<NotesFile> {
  try {
    const raw = JSON.parse(await readFile(notesPath(bookId), 'utf-8')) as Partial<NotesFile>
    if (!Array.isArray(raw.notes)) return { version: 1, notes: [] }
    return {
      version: 1,
      notes: raw.notes.filter(
        (note): note is AiChapterNote =>
          Boolean(note) && typeof note.chapterId === 'string' &&
          typeof note.bodyHash === 'string' && typeof note.text === 'string',
      ),
    }
  } catch {
    return { version: 1, notes: [] }
  }
}

export async function listChapterNotes(bookId: string): Promise<AiChapterNote[]> {
  return (await readAll(bookId)).notes
}

export async function findChapterNote(bookId: string, chapterId: string): Promise<AiChapterNote | null> {
  return (await readAll(bookId)).notes.find((note) => note.chapterId === chapterId) ?? null
}

/** 正文一改这条笔记就过期；只用于提示，不删除读者已经认可的内容。 */
export function isChapterNoteStale(note: AiChapterNote, bodyHash: string): boolean {
  return note.bodyHash !== bodyHash
}

export async function writeChapterNote(
  bookId: string,
  note: AiChapterNote,
  options: AtomicWriteOptions = {},
): Promise<AiChapterNote> {
  // notes.json 整文件读改写：AI 生成（走队列 :write 锁）与读者手工保存（IPC 直调，不入队列）
  // 会写同一份文件，无锁并发会丢笔记。加 per-book 锁与其它书库写串行。
  await withBookLock(bookId, async () => {
    await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
    const file = await readAll(bookId)
    const notes = file.notes.filter((item) => item.chapterId !== note.chapterId)
    notes.push(note)
    // 按章 id 定序，重复保存不产生无意义的 diff；界面展示顺序另按目录章序排。
    notes.sort((left, right) => (left.chapterId < right.chapterId ? -1 : left.chapterId > right.chapterId ? 1 : 0))
    await atomicWriteText(notesPath(bookId), JSON.stringify({ version: 1, notes } satisfies NotesFile, null, 2), options)
  })
  return note
}
