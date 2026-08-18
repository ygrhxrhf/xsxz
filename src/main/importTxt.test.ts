import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importTxt } from './importTxt'
import { loadBook, setLibraryPath } from './library'

describe('importTxt', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-txt-'))
    await setLibraryPath(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('splits chapters, copies origin, and does not overwrite on reimport', async () => {
    const src = join(dir, 'sample.txt')
    await writeFile(src, '前言\n第一章 起\n正文甲\n第二章 承\n正文乙\n', 'utf-8')
    const first = await importTxt(src)
    const book = await loadBook(first.bookId)
    expect(book.chapters.map((c) => c.title)).toEqual(['正文', '第一章 起', '第二章 承'])
    expect(book.importType).toBe('txt')
    const origin = await readFile(join(dir, first.bookId, 'origin', 'sample.txt'), 'utf-8')
    expect(origin).toContain('第一章 起')

    const ch1 = JSON.parse(await readFile(join(dir, first.bookId, 'chapters', '0002.json'), 'utf-8'))
    ch1.body = '已被用户改过'
    await writeFile(join(dir, first.bookId, 'chapters', '0002.json'), JSON.stringify(ch1), 'utf-8')

    const second = await importTxt(src)
    expect(second.bookId).toBe(first.bookId)
    const again = JSON.parse(await readFile(join(dir, first.bookId, 'chapters', '0002.json'), 'utf-8'))
    expect(again.body).toBe('已被用户改过')
  })

  it('treats unsplittable txt (no 第x章) as one ready chapter', async () => {
    const src = join(dir, 'plain.txt')
    await writeFile(src, '只是一段没有章节标题的散文。\n第二段也还是同一章。\n', 'utf-8')
    const { bookId } = await importTxt(src)
    expect(bookId.startsWith('i_')).toBe(true)
    const book = await loadBook(bookId)
    expect(book.importType).toBe('txt')
    expect(book.chapters).toHaveLength(1)
    expect(book.chapters[0].status).toBe('ready')
    expect(book.status).toBe('ready')
    const file = JSON.parse(await readFile(join(dir, bookId, book.chapters[0].file), 'utf-8'))
    expect(file.body).toContain('没有章节标题的散文')
    expect(file.status).toBe('ready')
  })

  it('gives a different i_ id for different bytes', async () => {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    await writeFile(a, '第一章 甲\n正文甲\n', 'utf-8')
    await writeFile(b, '第一章 乙\n正文乙\n', 'utf-8')
    const first = await importTxt(a)
    const second = await importTxt(b)
    expect(first.bookId).not.toBe(second.bookId)
    expect(second.bookId.startsWith('i_')).toBe(true)
  })
})
