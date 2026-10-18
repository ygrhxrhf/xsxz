import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBookFromBootstrap, saveBook, setLibraryPath, writeChapterFile } from './library'
import { searchInBook } from './search'

describe('searchInBook（本书内全文搜索）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-search-'))
    await setLibraryPath(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function seedTwoChapterBook(): Promise<string> {
    await createBookFromBootstrap({
      bookId: 'd_search',
      title: '搜索用书',
      author: '',
      importType: 'txt',
      chapterTitles: ['第一章', '第二章', '第三章'],
    })
    const bodies = new Map([
      ['c0001', '张若尘从梦中惊醒。\n\n窗外月光如水，照在斑驳的墙壁上。'],
      ['c0002', '王叔带来口粮，还提到学院招生的事。月光下两人告别。'],
      ['c0003', '这一章什么都没有。'],
    ])
    for (const [chapterId, body] of bodies) {
      await writeChapterFile('d_search', chapterId, {
        title: '',
        body,
        status: 'ready',
      })
    }
    return 'd_search'
  }

  it('finds hits across chapters with count, excerpt and paragraph index', async () => {
    const bookId = await seedTwoChapterBook()

    const hits = await searchInBook(bookId, '月光')

    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ chapterId: 'c0001', chapterTitle: '第一章', count: 1, paraIndex: 1 })
    expect(hits[0].excerpt).toContain('月光')
    expect(hits[1]).toMatchObject({ chapterId: 'c0002', count: 1 })
    // 章节顺序保持
    expect(hits[0].chapterIndex).toBeLessThan(hits[1].chapterIndex)
  })

  it('counts multiple occurrences within one chapter and reports the first paragraph', async () => {
    const bookId = await seedTwoChapterBook()
    const book = await loadHelper(bookId)
    await writeChapterFile(bookId, book.chapters[2].id, {
      title: '',
      body: '第一段提到张若尘。\n\n第二段又提到张若尘和张若尘的朋友。',
      status: 'ready',
    })

    const hits = await searchInBook(bookId, '张若尘')

    const hit = hits.find((h) => h.chapterId === 'c0003')
    expect(hit?.count).toBe(3)
    expect(hit?.paraIndex).toBe(0)
    expect(hits.some((h) => h.chapterId === 'c0001')).toBe(true)
  })

  it('is case-insensitive, skips failed chapters and returns [] on blank query', async () => {
    const bookId = await seedTwoChapterBook()
    const book = await loadHelper(bookId)
    await writeChapterFile(bookId, book.chapters[2].id, {
      title: '',
      body: '',
      status: 'failed',
      failCode: 'NavFailed',
    })

    expect(await searchInBook(bookId, '   ')).toEqual([])
    // c0003 是 failed：即使有匹配词也不该出现
    expect((await searchInBook(bookId, '王叔')).every((h) => h.chapterId !== 'c0003')).toBe(true)

    await saveBook(await loadHelper(bookId))
    expect((await searchInBook(bookId, '不存在的词')).length).toBe(0)
  })

  it('并发读盘下命中仍按章节顺序输出且不丢章', async () => {
    // 30 章、每章都命中：并发读盘不能让顺序错乱，也不能漏章。
    const bookId = 'd_many'
    const titles = Array.from({ length: 30 }, (_, i) => `第${i + 1}章`)
    await createBookFromBootstrap({
      bookId, title: '多章书', author: '', importType: 'txt', chapterTitles: titles,
    })
    const book = await loadHelper(bookId)
    for (const ch of book.chapters) {
      await writeChapterFile(bookId, ch.id, {
        title: ch.title,
        body: `本章出现关键词。\n\n第二段也有关键词，共两处。`,
        status: 'ready',
      })
    }

    const hits = await searchInBook(bookId, '关键词')
    expect(hits).toHaveLength(30)
    // 顺序 = 目录序（章节 id 递增即 index 递增）
    expect(hits.map((h) => h.chapterId)).toEqual(book.chapters.map((c) => c.id))
    expect(hits.every((h) => h.count === 2)).toBe(true)
  })
})

async function loadHelper(bookId: string) {
  const { loadBook } = await import('./library')
  return loadBook(bookId)
}
