import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  catalog: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/spbf-web-shelf-test' },
}))

vi.mock('./readingSession', () => ({
  loadPageBootstrap: (url: string) => mocks.bootstrap(url),
  loadCatalog: (url: string) => mocks.catalog(url),
}))

import {
  WEB_SHELF_CHAPTER_LIMIT,
  addWebShelf,
  getWebShelfBook,
  getWebShelfChapters,
  listWebShelf,
  locateChapterInShelf,
  refreshAllWebShelf,
  refreshWebShelf,
  removeWebShelf,
  setWebShelfChangeListener,
  setWebShelfDirForTests,
  setWebShelfProgress,
} from './webShelf'
import type { WebShelfBook, WebShelfChapter } from '../shared/types'

const PAGE_URL = 'https://example.com/book/65/'

function chapters(count: number): WebShelfChapter[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `第 ${index + 1} 章 起风`,
    url: `https://example.com/book/65/c${index + 1}.html`,
  }))
}

function catalogResult(list: WebShelfChapter[]) {
  return { ok: true as const, catalogUrl: PAGE_URL, chapters: list }
}

let dir = ''

beforeEach(async () => {
  mocks.bootstrap.mockReset()
  mocks.catalog.mockReset()
  dir = await mkdtemp(join(tmpdir(), 'spbf-web-shelf-'))
  setWebShelfDirForTests(dir)
})

afterEach(async () => {
  vi.useRealTimers()
  setWebShelfChangeListener(null)
  setWebShelfDirForTests(null)
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function addBook(list = chapters(3)): Promise<WebShelfBook> {
  mocks.bootstrap.mockResolvedValue({
    ok: true,
    bootstrap: {
      pageUrl: PAGE_URL,
      pageKind: 'catalog',
      title: '示例书',
      author: '示例作者',
      catalogUrl: PAGE_URL,
      chapters: list,
    },
  })
  const res = await addWebShelf({ url: PAGE_URL })
  if (!res.ok) throw new Error(res.message)
  return res.book
}

async function refreshOk(id: string): Promise<{ added: number; book: WebShelfBook }> {
  const res = await refreshWebShelf(id)
  if (!res.ok) throw new Error(res.message)
  return { added: res.added, book: res.book }
}

describe('web shelf storage', () => {
  it('adds a web book with its catalog snapshot and book id', async () => {
    const book = await addBook()
    expect(book.title).toBe('示例书')
    expect(book.author).toBe('示例作者')
    expect(book.chapters).toHaveLength(3)
    expect(book.host).toBe('example.com')
    const listed = await listWebShelf()
    expect(listed.map((item) => item.id)).toEqual([book.id])
    const raw = JSON.parse(await readFile(join(dir, 'web-shelf.json'), 'utf-8'))
    expect(raw.version).toBe(1)
    expect(raw.books[0].id).toBe(book.id)
  })

  it('updates the same book instead of adding a duplicate and keeps progress', async () => {
    const book = await addBook()
    await setWebShelfProgress(book.id, chapters(3)[1], 12, 0.4)
    const again = await addBook(chapters(4))
    expect(again.id).toBe(book.id)
    expect((await listWebShelf())).toHaveLength(1)
    const stored = await getWebShelfBook(book.id)
    expect(stored?.chapters).toHaveLength(4)
    expect(stored?.progress?.paragraphIndex).toBe(12)
  })

  it('keeps a book when the site has no recognizable catalog', async () => {
    mocks.catalog.mockResolvedValue({ ok: false, message: '这个页面里没有找到章节目录' })
    mocks.bootstrap.mockResolvedValue({
      ok: true,
      bootstrap: { pageUrl: PAGE_URL, pageKind: 'chapter', title: '无目录书', author: '', catalogUrl: PAGE_URL, chapters: [] },
    })
    const res = await addWebShelf({ url: PAGE_URL })
    if (!res.ok) throw new Error(res.message)
    expect(res.book.chapters).toEqual([])
    expect(res.book.lastChapter.url).toBe(PAGE_URL)
    const located = await locateChapterInShelf(PAGE_URL)
    expect(located?.bookId).toBe(res.book.id)
    expect(located?.index).toBe(-1)
  })

  it('rejects a non-http url and a page it cannot read', async () => {
    expect((await addWebShelf({ url: 'about:blank' })).ok).toBe(false)
    mocks.bootstrap.mockResolvedValue({ ok: false, message: '这个页面里没有识别出书名或正文' })
    const res = await addWebShelf({ url: PAGE_URL })
    expect(res.ok).toBe(false)
    expect(await listWebShelf()).toEqual([])
  })
})

describe('web shelf refresh', () => {
  it('counts new chapters, then skips within the backoff window', async () => {
    const book = await addBook()
    mocks.catalog.mockResolvedValue(catalogResult(chapters(5)))
    expect((await refreshOk(book.id)).added).toBe(2)
    expect((await refreshOk(book.id)).added).toBe(0)
    expect(mocks.catalog).toHaveBeenCalledTimes(1)
    const stored = await getWebShelfBook(book.id)
    expect(stored?.chapters).toHaveLength(5)
    expect(stored?.addedChapters).toBe(2)
  })

  it('fetches again after the backoff window has passed', async () => {
    const book = await addBook()
    mocks.catalog.mockResolvedValue(catalogResult(chapters(4)))
    await refreshWebShelf(book.id)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    mocks.catalog.mockResolvedValue(catalogResult(chapters(6)))
    expect((await refreshOk(book.id)).added).toBe(2)
    vi.useRealTimers()
    expect(mocks.catalog).toHaveBeenCalledTimes(2)
  })

  it('reports a failure without touching the snapshot', async () => {
    const book = await addBook()
    mocks.catalog.mockResolvedValue(catalogResult(chapters(3)))
    await refreshWebShelf(book.id)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000))
    mocks.catalog.mockResolvedValue({ ok: false, message: '目录加载失败' })
    const res = await refreshWebShelf(book.id)
    vi.useRealTimers()
    expect(res.ok).toBe(false)
    const stored = await getWebShelfBook(book.id)
    expect(stored?.chapters).toHaveLength(3)
  })

  it('refreshes every book and reports counters', async () => {
    const book = await addBook()
    mocks.catalog.mockResolvedValue(catalogResult(chapters(5)))
    const res = await refreshAllWebShelf()
    expect(res.checked).toBe(1)
    expect(res.updated).toBe(1)
    expect((await getWebShelfBook(book.id))?.chapters).toHaveLength(5)
  })
})

describe('web shelf progress and lookup', () => {
  it('remembers the chapter and paragraph a reader left off at', async () => {
    const book = await addBook()
    const second = chapters(3)[1]
    await setWebShelfProgress(book.id, second, 7, 0.25)
    const stored = await getWebShelfBook(book.id)
    expect(stored?.lastChapter.url).toBe(second.url)
    expect(stored?.progress).toMatchObject({ paragraphIndex: 7, scrollRatio: 0.25 })
    const lookup = await getWebShelfChapters(book.id)
    expect(lookup.ok && lookup.currentIndex).toBe(1)
    const located = await locateChapterInShelf(second.url)
    expect(located).toMatchObject({ bookId: book.id, index: 1, total: 3 })
  })

  it('falls back to the catalog prefix when the chapter is not in the snapshot', async () => {
    const book = await addBook()
    const located = await locateChapterInShelf('https://example.com/book/65/c99.html')
    expect(located?.bookId).toBe(book.id)
    expect(located?.index).toBe(-1)
  })

  it('marks books as read-most-recent first', async () => {
    const first = await addBook()
    await addBook(chapters(2))
    await setWebShelfProgress(first.id, chapters(3)[0], 1, 0.1)
    const listed = await listWebShelf()
    expect(listed[0].id).toBe(first.id)
  })

  it('broadcasts shelf changes and removes books', async () => {
    const reasons: string[] = []
    setWebShelfChangeListener((reason) => reasons.push(reason))
    const book = await addBook()
    await setWebShelfProgress(book.id, chapters(3)[0], 0, 0)
    expect((await removeWebShelf(book.id)).ok).toBe(true)
    expect((await removeWebShelf(book.id)).ok).toBe(false)
    expect(await listWebShelf()).toEqual([])
    expect(reasons).toEqual(['add', 'progress', 'remove'])
  })
})

describe('web shelf file tolerance', () => {
  it('reads an empty shelf from a corrupt file', async () => {
    await writeFile(join(dir, 'web-shelf.json'), '{ not json', 'utf-8')
    setWebShelfDirForTests(dir)
    expect(await listWebShelf()).toEqual([])
    mocks.bootstrap.mockResolvedValue({
      ok: true,
      bootstrap: { pageUrl: PAGE_URL, pageKind: 'catalog', title: '示例书', author: '', catalogUrl: PAGE_URL, chapters: chapters(2) },
    })
    const res = await addWebShelf({ url: PAGE_URL })
    if (!res.ok) throw new Error(res.message)
    expect((await listWebShelf())).toHaveLength(1)
  })

  it('drops only the invalid entries of a damaged file', async () => {
    const good = {
      id: 'good-id',
      host: 'example.com',
      title: '好书',
      author: '',
      catalogUrl: PAGE_URL,
      lastChapter: chapters(1)[0],
      chapters: chapters(2),
      progress: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await writeFile(join(dir, 'web-shelf.json'), JSON.stringify({ version: 1, books: [good, { id: 'bad' }, 'nonsense'] }), 'utf-8')
    setWebShelfDirForTests(dir)
    const listed = await listWebShelf()
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe('good-id')
    expect(listed[0].addedChapters).toBe(0)
  })

  it('caps the chapter snapshot', async () => {
    const book = await addBook(chapters(WEB_SHELF_CHAPTER_LIMIT + 120))
    expect(book.chapters).toHaveLength(WEB_SHELF_CHAPTER_LIMIT)
  })
})
