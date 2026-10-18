import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBookFromBootstrap, setLibraryPath } from './library'
import {
  chapterBodyHash,
  findChapterNote,
  isChapterNoteStale,
  listChapterNotes,
  writeChapterNote,
} from './aiChapterNotes'
import type { AiChapterNote } from '../shared/types'

function note(chapterId: string, text: string, bodyHash = `hash-${text}`): AiChapterNote {
  return { chapterId, bodyHash, text, updatedAt: '2026-10-08T00:00:00.000Z' }
}

const notesPath = (dir: string) => join(dir, 'd_note', 'ai', 'notes.json')

describe('本章笔记落盘', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-notes-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: 'd_note',
      title: '笔记用书',
      author: '',
      importType: 'txt',
      chapterTitles: ['第一章', '第二章'],
    })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('一章只留最新一条，别的章不受影响', async () => {
    await writeChapterNote('d_note', note('c0001', '第一版'))
    await writeChapterNote('d_note', note('c0002', '第二章'))
    await writeChapterNote('d_note', note('c0001', '第二版', 'hash-第二版'))

    expect((await listChapterNotes('d_note')).map((item) => [item.chapterId, item.text]))
      .toEqual([['c0001', '第二版'], ['c0002', '第二章']])
    expect(await findChapterNote('d_note', 'c0001')).toMatchObject({ text: '第二版', bodyHash: 'hash-第二版' })
    expect(await findChapterNote('d_note', 'c0099')).toBeNull()
  })

  it('顺序按章 id 定，跟写入先后无关', async () => {
    await writeChapterNote('d_note', note('c0003', '后写的'))
    await writeChapterNote('d_note', note('c0001', '先写的'))
    expect((await listChapterNotes('d_note')).map((item) => item.chapterId)).toEqual(['c0001', 'c0003'])
    const onDisk = JSON.parse(await readFile(notesPath(dir), 'utf-8')) as { notes: AiChapterNote[] }
    expect(onDisk.notes.map((item) => item.chapterId)).toEqual(['c0001', 'c0003'])
  })

  it('正文一改就过期，一字没动就不过期', () => {
    const body = '顾清推开了门。\n\n她把玉印交了出去。'
    const saved = note('c0001', '笔记', chapterBodyHash(body))
    expect(isChapterNoteStale(saved, chapterBodyHash(body))).toBe(false)
    expect(isChapterNoteStale(saved, chapterBodyHash(`${body}\n\n漏了一段`))).toBe(true)
  })

  it('文件或字段坏了当「没有笔记」，读路径永不抛', async () => {
    await mkdir(join(dir, 'd_note', 'ai'), { recursive: true })
    await writeFile(notesPath(dir), '{ 这不是 JSON', 'utf-8')
    expect(await listChapterNotes('d_note')).toEqual([])
    expect(await findChapterNote('d_note', 'c0001')).toBeNull()

    await writeFile(notesPath(dir), JSON.stringify({
      version: 1,
      notes: [
        note('c0001', '可用'),
        { chapterId: 'c0002' },
        null,
        { chapterId: 'c0003', bodyHash: 'h', text: 42 },
      ],
    }), 'utf-8')
    expect((await listChapterNotes('d_note')).map((item) => item.chapterId)).toEqual(['c0001'])
  })

  it('从未建过笔记的书返回空列表，不创建任何文件', async () => {
    expect(await listChapterNotes('d_note')).toEqual([])
    await expect(readFile(notesPath(dir), 'utf-8')).rejects.toThrow()
  })

  it('保存被中断时旧笔记原样保留，不留半截文件', async () => {
    await writeChapterNote('d_note', note('c0001', '已保存的笔记'))
    const controller = new AbortController()
    controller.abort()
    await expect(writeChapterNote('d_note', note('c0001', '半截'), { signal: controller.signal }))
      .rejects.toThrow()
    expect((await listChapterNotes('d_note')).map((item) => item.text)).toEqual(['已保存的笔记'])
    expect(await readdir(join(dir, 'd_note', 'ai'))).toEqual(['notes.json'])
  })

  it('读者手写的笔记带 userEdited，AI 重新生成的不带', async () => {
    await writeChapterNote('d_note', { ...note('c0001', '自己的话'), userEdited: true })
    expect(await findChapterNote('d_note', 'c0001')).toMatchObject({ userEdited: true })
    await writeChapterNote('d_note', note('c0001', 'AI 的话'))
    expect('userEdited' in (await findChapterNote('d_note', 'c0001'))!).toBe(false)
  })

  it('并发写不同章的笔记互不覆盖', async () => {
    // notes.json 是整文件读改写：AI 生成与手工保存并发时，无锁会丢笔记。
    await Promise.all([
      writeChapterNote('d_note', note('c0001', '第一章笔记')),
      writeChapterNote('d_note', note('c0002', '第二章笔记')),
      writeChapterNote('d_note', note('c0003', '第三章笔记')),
    ])
    expect((await listChapterNotes('d_note')).map((item) => item.chapterId)).toEqual(['c0001', 'c0002', 'c0003'])
  })
})
