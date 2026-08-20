import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertImportable,
  bookIdFromUrl,
  mergeIncomingChapters,
  normalizeChapterUrl,
  setLibraryPath,
  createBookFromBootstrap,
  bookExists,
  loadBook,
  listBooks,
  markChapterStatus,
  readChapter,
  refreshBookStatus,
  rebuildIndex,
  saveBook,
  setProgress,
  writeChapterFile,
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

  it('bqg hash catalogs 65, 472 and home are three ids', () => {
    const host = 'www.bqg858.cc'
    const id65 = bookIdFromUrl(host, 'https://www.bqg858.cc/#/book/65/')
    const id472 = bookIdFromUrl(host, 'https://www.bqg858.cc/#/book/472/')
    const idHome = bookIdFromUrl(host, 'https://www.bqg858.cc/#/')
    expect(id65).toMatch(ID_RE)
    expect(id472).toMatch(ID_RE)
    expect(idHome).toMatch(ID_RE)
    expect(id65).not.toBe(id472)
    expect(id65).not.toBe(idHome)
    expect(id472).not.toBe(idHome)
    expect(bookIdFromUrl(host, 'https://www.bqg858.cc/#/book/65/')).toBe(id65)
    expect(bookIdFromUrl(host, 'https://www.bqg858.cc/#/book/472/')).toBe(id472)
    expect(bookIdFromUrl(host, 'https://www.bqg858.cc/#/')).toBe(idHome)
  })

  it('keeps path-like hash, drops in-page fragments, still strips utm/page, does not strip www.', () => {
    const host = 'www.bqg858.cc'
    const hashCatalog = bookIdFromUrl(host, 'https://www.bqg858.cc/#/book/65/')
    const origin = bookIdFromUrl(host, 'https://www.bqg858.cc/')
    expect(hashCatalog).toMatch(ID_RE)
    expect(hashCatalog).not.toBe(origin)

    expect(
      bookIdFromUrl(host, 'https://www.bqg858.cc/?utm_source=x#/book/65/'),
    ).toBe(hashCatalog)
    expect(bookIdFromUrl(host, 'https://www.bqg858.cc/?page=2#/book/65/')).toBe(hashCatalog)
    expect(bookIdFromUrl(host, 'https://www.bqg858.cc/?#/book/65/')).toBe(hashCatalog)

    const alice = 'https://www.alicesw.com/other/chapters/id/44828.html'
    expect(bookIdFromUrl('www.alicesw.com', `${alice}#top`)).toBe(
      bookIdFromUrl('www.alicesw.com', alice),
    )

    const classic = bookIdFromUrl('example.com', 'https://example.com/book/?utm_source=x#frag')
    expect(classic).toBe(bookIdFromUrl('example.com', 'https://example.com/book/'))

    const bareHost = bookIdFromUrl('bqg858.cc', 'https://bqg858.cc/#/book/65/')
    const wwwHost = bookIdFromUrl('www.bqg858.cc', 'https://www.bqg858.cc/#/book/65/')
    expect(wwwHost).not.toBe(bareHost)
  })

  it('hash catalog is not bare /book/65/ or origin', () => {
    const host = 'www.bqg858.cc'
    const hashCatalog = bookIdFromUrl(host, 'https://www.bqg858.cc/#/book/65/')
    const barePath = bookIdFromUrl(host, 'https://www.bqg858.cc/book/65/')
    const bareChapter = bookIdFromUrl(host, 'https://www.bqg858.cc/book/65/1.html')
    const origin = bookIdFromUrl(host, 'https://www.bqg858.cc/')
    const home = bookIdFromUrl(host, 'https://www.bqg858.cc/#/')
    for (const id of [hashCatalog, barePath, bareChapter, origin, home]) {
      expect(id).toMatch(ID_RE)
    }
    expect(hashCatalog).not.toBe(barePath)
    expect(hashCatalog).not.toBe(bareChapter)
    expect(hashCatalog).not.toBe(origin)
    expect(barePath).not.toBe(origin)
    expect(hashCatalog).not.toBe(home)
    expect(bookIdFromUrl(host, 'https://www.bqg858.cc/#/book/65/')).toBe(hashCatalog)
    expect(bookIdFromUrl(host, 'https://www.bqg858.cc/book/65/')).toBe(barePath)
    expect(bookIdFromUrl(host, 'https://www.bqg858.cc/')).toBe(origin)
  })

  it('trailing slash on hash route is one book', () => {
    const host = 'www.bqg858.cc'
    const withSlash = bookIdFromUrl(host, 'https://www.bqg858.cc/#/book/65/')
    const noSlash = bookIdFromUrl(host, 'https://www.bqg858.cc/#/book/65')
    expect(withSlash).toMatch(ID_RE)
    expect(withSlash).toBe(noSlash)
    expect(withSlash).not.toBe(bookIdFromUrl(host, 'https://www.bqg858.cc/#/book/472/'))
    expect(withSlash).not.toBe(bookIdFromUrl(host, 'https://www.bqg858.cc/book/65/'))
  })
})

describe('normalizeChapterUrl', () => {
  it('normalize keeps hash chapter routes and aliases #content', () => {
    const ch1 = normalizeChapterUrl('https://www.bqg858.cc/#/book/65/1.html')
    const ch1Content = normalizeChapterUrl('https://www.bqg858.cc/#/book/65/1.html#content')
    const ch2 = normalizeChapterUrl('https://www.bqg858.cc/#/book/65/2.html')
    const bare = normalizeChapterUrl('https://www.bqg858.cc/book/65/1.html')
    expect(ch1).toContain('#/book/65/1.html')
    expect(ch1).not.toContain('#content')
    expect(ch1Content).toBe(ch1)
    expect(ch2).toContain('#/book/65/2.html')
    expect(ch1).not.toBe(ch2)
    expect(ch1).not.toBe(bare)
    expect(bare).not.toContain('#/')

    const alice = 'https://www.alicesw.com/book/46268/abc.html'
    expect(normalizeChapterUrl(`${alice}#top`)).toBe(normalizeChapterUrl(alice))
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

  it('mergeIncomingChapters added 1 on hash #content plus new 2.html', () => {
    const existing = book({
      chapters: [
        {
          id: 'c0001',
          index: 1,
          title: '第1章 千金攻略（1）',
          url: 'https://www.bqg858.cc/#/book/65/1.html',
          file: 'chapters/0001.json',
          status: 'ready',
        },
      ],
    })
    const { added } = mergeIncomingChapters(existing, [
      { title: '第1章 千金攻略（1）', url: 'https://www.bqg858.cc/#/book/65/1.html#content', index: 1 },
      { title: '第2章', url: 'https://www.bqg858.cc/#/book/65/2.html', index: 2 },
    ])
    expect(added).toBe(1)
    expect(existing.chapters).toHaveLength(2)
    expect(existing.chapters[0].status).toBe('ready')
    expect(existing.chapters[0].url).toContain('#/book/65/1.html')
    expect(existing.chapters[1].status).toBe('pending')
    expect(existing.chapters[1].url).toContain('#/book/65/2.html')
    expect(existing.chapters[1].id).toBe('c0002')
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

  it('writeChapterFile with status ready persists that status onto book.json meta', async () => {
    await createBookFromBootstrap({
      bookId: 'd_ready_file',
      title: '落盘',
      author: '',
      sourceUrl: 'https://example.com/book/',
      sourceHost: 'example.com',
      importType: 'download',
      chapterTitles: ['第一章'],
      chapterUrls: ['https://example.com/book/1.html'],
    })

    await writeChapterFile('d_ready_file', 'c0001', {
      title: '第一章',
      url: 'https://example.com/book/1.html',
      body: '这是一段足够长的纯文本正文，用来确认章节文件和目录元数据一起标成 ready。',
      bodyRaw: '这是一段足够长的纯文本正文，用来确认章节文件和目录元数据一起标成 ready。',
      status: 'ready',
    })

    const book = await loadBook('d_ready_file')
    expect(book.chapters[0].status).toBe('ready')
    const raw = await readFile(join(dir, 'd_ready_file', 'chapters', '0001.json'), 'utf-8')
    expect(JSON.parse(raw).status).toBe('ready')
  })

  it('readChapter treats a pending file that already has a body as ready', async () => {
    const created = await createBookFromBootstrap({
      bookId: 'd_heal',
      title: '修复',
      author: '',
      sourceUrl: 'https://example.com/book/',
      sourceHost: 'example.com',
      importType: 'download',
      chapterTitles: ['第一章', '第二章'],
      chapterUrls: ['https://example.com/book/1.html', 'https://example.com/book/2.html'],
    })
    created.status = 'partial'
    await saveBook(created)

    await mkdir(join(dir, 'd_heal', 'chapters'), { recursive: true })
    await writeFile(
      join(dir, 'd_heal', 'chapters', '0001.json'),
      JSON.stringify({
        title: '第一章',
        url: 'https://example.com/book/1.html',
        body: '已下载的纯文本正文，但文件和 book.json 仍标 pending。',
        bodyRaw: '已下载的纯文本正文，但文件和 book.json 仍标 pending。',
        status: 'pending',
      }, null, 2),
      'utf-8',
    )

    const opened = await readChapter('d_heal', 'c0001')
    expect(opened.status).toBe('ready')
    expect(opened.body.length).toBeGreaterThan(10)

    const book = await loadBook('d_heal')
    expect(book.chapters[0].status).toBe('ready')
    const disk = JSON.parse(await readFile(join(dir, 'd_heal', 'chapters', '0001.json'), 'utf-8')) as {
      status: string
    }
    expect(disk.status).toBe('ready')
  })

  it('listBooks readyCount matches book.json after ready promotion', async () => {
    await createBookFromBootstrap({
      bookId: 'd_idx',
      title: '索引',
      author: '',
      importType: 'download',
      chapterTitles: ['一', '二'],
      chapterUrls: ['https://example.com/a.html', 'https://example.com/b.html'],
    })
    await writeChapterFile('d_idx', 'c0001', {
      title: '一',
      url: 'https://example.com/a.html',
      body: '第一章正文足够长，用来确认索引 readyCount。',
      status: 'ready',
    })
    await writeChapterFile('d_idx', 'c0002', {
      title: '二',
      url: 'https://example.com/b.html',
      body: '第二章正文足够长，用来确认索引 readyCount。',
      status: 'ready',
    })
    await refreshBookStatus('d_idx')

    const items = await rebuildIndex()
    const item = items.find((b) => b.id === 'd_idx')
    expect(item?.readyCount).toBe(2)
    expect(item?.chapterCount).toBe(2)
    expect(item?.status).toBe('ready')
    const listed = await listBooks()
    expect(listed.find((b) => b.id === 'd_idx')?.readyCount).toBe(2)
  })

  it('setProgress does not revert chapter status back to pending', async () => {
    const created = await createBookFromBootstrap({
      bookId: 'd_prog',
      title: '进度',
      author: '',
      importType: 'download',
      chapterTitles: ['一'],
      chapterUrls: ['https://example.com/a.html'],
    })
    created.chapters[0].status = 'ready'
    await saveBook(created)
    await writeFile(
      join(dir, 'd_prog', 'chapters', '0001.json'),
      JSON.stringify({ title: '一', url: 'https://example.com/a.html', body: '正文', status: 'ready' }, null, 2),
      'utf-8',
    )

    await setProgress('d_prog', {
      chapterId: 'c0001',
      scrollRatio: 0.2,
      updatedAt: new Date().toISOString(),
    })
    const after = await loadBook('d_prog')
    expect(after.chapters[0].status).toBe('ready')
    expect(after.progress?.chapterId).toBe('c0001')
  })
})
