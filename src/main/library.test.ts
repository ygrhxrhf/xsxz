import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertImportable,
  bookIdFromUrl,
  mergeIncomingChapters,
  setLibraryPath,
  createBookFromBootstrap,
  bookExists,
  loadBook,
  listBooks,
  markChapterStatus,
  refreshBookStatus,
  saveBook,
} from './library'
import type { Book, CatalogChapter } from '../shared/types'

function book(partial?: Partial<Book>): Book {
  return {
    id: 'd_test',
    title: '测',
    author: '',
    importType: 'download',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'partial',
    progress: null,
    chapters: [
      {
        id: 'c0001',
        index: 1,
        title: '第一章',
        url: 'https://example.com/book/1.html',
        file: 'chapters/0001.json',
        status: 'ready',
      },
    ],
    ...partial,
  }
}

describe('bookIdFromUrl', () => {
  const ID_RE = /^d_[0-9a-f]{16}$/

  it('is stable after stripping hash, page, utm and trailing slash', () => {
    const a = bookIdFromUrl('example.com', 'https://Example.com/book/?utm_source=x#frag')
    const b = bookIdFromUrl('example.com', 'https://example.com/book/')
    expect(a).toBe(b)
    expect(a.startsWith('d_')).toBe(true)
    expect(a.length).toBe(18)
  })

  it('strips leftover question mark / empty search / page / utm so one catalog is one id', () => {
    const urls = [
      'https://example.com/book/',
      'https://Example.com/book/?utm_source=x#frag',
      'https://example.com/book/?',
      'https://example.com/book',
      'https://example.com/book/?utm_campaign=spring&',
      'https://example.com/book/?page=2',
      'https://example.com/book/?page=2&utm_source=x',
    ]
    const ids = urls.map((url) => bookIdFromUrl('example.com', url))
    for (const id of ids) {
      expect(id).toMatch(ID_RE)
      expect(id).toBe(ids[0])
    }
  })

  it('does not strip www. from the identity string', () => {
    const bare = bookIdFromUrl('example.com', 'https://example.com/book/')
    const www = bookIdFromUrl('www.example.com', 'https://www.example.com/book/')
    expect(bare).toMatch(ID_RE)
    expect(www).toMatch(ID_RE)
    expect(www).not.toBe(bare)
  })

  it('differs for different catalog paths', () => {
    const a = bookIdFromUrl('example.com', 'https://example.com/book/')
    const b = bookIdFromUrl('example.com', 'https://example.com/book-2/')
    expect(a).not.toBe(b)
  })
})

describe('assertImportable', () => {
  it('accepts txt and epub case-insensitively', () => {
    for (const path of [
      'C:\\books\\novel.txt',
      'C:\\books\\novel.TXT',
      'C:\\books\\novel.epub',
      'C:\\books\\novel.EPUB',
      'C:\\books\\novel.Epub',
    ]) {
      expect(assertImportable(path)).toEqual({ ok: true })
    }
  })

  it('rejects docx / pdf / html / suffix-less paths with a Chinese unsupported-type message', () => {
    const cases = [
      { path: 'C:\\books\\novel.docx', hint: 'docx' },
      { path: 'C:\\books\\novel.pdf', hint: 'pdf' },
      { path: 'C:\\books\\novel.html', hint: 'html' },
      { path: 'C:\\books\\novel', hint: '' },
    ]
    for (const { path, hint } of cases) {
      const result = assertImportable(path)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toMatch(/不支持/)
        expect(result.message).toMatch(/txt|epub/i)
        if (hint) expect(result.message.toLowerCase()).toContain(hint)
      }
    }
  })
})

describe('mergeIncomingChapters', () => {
  it('aligns by normalized URL and keeps ready chapters', () => {
    const existing = book()
    const incoming: CatalogChapter[] = [
      { title: '第一章 改名', url: 'https://example.com/book/1.html#x', index: 1 },
      { title: '第二章', url: 'https://example.com/book/2.html', index: 2 },
    ]
    const { added } = mergeIncomingChapters(existing, incoming)
    expect(added).toBe(1)
    expect(existing.chapters).toHaveLength(2)
    expect(existing.chapters[0].status).toBe('ready')
    expect(existing.chapters[0].title).toBe('第一章')
    expect(existing.chapters[1].title).toBe('第二章')
    expect(existing.chapters[1].status).toBe('pending')
    expect(existing.chapters[1].id).toBe('c0002')
  })

  it('falls back to title when URL is missing', () => {
    const existing = book({
      chapters: [
        { id: 'c0001', index: 1, title: '第一章', file: 'chapters/0001.json', status: 'failed' },
      ],
    })
    const { added } = mergeIncomingChapters(existing, [
      { title: '第一章', url: 'https://example.com/book/1.html', index: 1 },
    ])
    expect(added).toBe(0)
    expect(existing.chapters[0].url).toBe('https://example.com/book/1.html')
    expect(existing.chapters[0].status).toBe('failed')
  })

  it('does not delete existing chapters', () => {
    const existing = book({
      chapters: [
        { id: 'c0001', index: 1, title: '旧章', url: 'https://example.com/old.html', file: 'chapters/0001.json', status: 'ready' },
      ],
    })
    mergeIncomingChapters(existing, [{ title: '新章', url: 'https://example.com/new.html', index: 1 }])
    expect(existing.chapters.map((c) => c.title)).toEqual(['旧章', '新章'])
  })
})

describe('setLibraryPath + createBookFromBootstrap', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-lib-'))
    await setLibraryPath(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes chapter urls and reports existence', async () => {
    const created = await createBookFromBootstrap({
      bookId: 'd_demo',
      title: '演示',
      author: '甲',
      sourceUrl: 'https://example.com/book/',
      sourceHost: 'example.com',
      importType: 'download',
      chapterTitles: ['第一章', '第二章'],
      chapterUrls: ['https://example.com/book/1.html', 'https://example.com/book/2.html'],
    })
    expect(await bookExists('d_demo')).toBe(true)
    const loaded = await loadBook('d_demo')
    expect(loaded.chapters[1].url).toBe('https://example.com/book/2.html')
    expect(created.id).toBe('d_demo')
  })

  it('keeps book.status downloading while markChapterStatus writes chapters mid-job', async () => {
    const created = await createBookFromBootstrap({
      bookId: 'd_dl',
      title: '下载中',
      author: '',
      sourceUrl: 'https://example.com/book/',
      sourceHost: 'example.com',
      importType: 'download',
      chapterTitles: ['第一章', '第二章'],
      chapterUrls: ['https://example.com/book/1.html', 'https://example.com/book/2.html'],
    })
    created.status = 'downloading'
    await saveBook(created)

    await markChapterStatus('d_dl', 'c0001', 'ready', { url: 'https://example.com/book/1.html' })
    const mid = await loadBook('d_dl')
    expect(mid.chapters[0].status).toBe('ready')
    expect(mid.status).toBe('downloading')
    const listed = await listBooks()
    expect(listed.find((b) => b.id === 'd_dl')?.status).toBe('downloading')

    await markChapterStatus('d_dl', 'c0002', 'ready', { url: 'https://example.com/book/2.html' })
    const still = await loadBook('d_dl')
    expect(still.chapters.every((c) => c.status === 'ready')).toBe(true)
    expect(still.status).toBe('downloading')

    await refreshBookStatus('d_dl')
    const done = await loadBook('d_dl')
    expect(done.status).toBe('ready')
  })
})
