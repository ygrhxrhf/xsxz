import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertImportable,
  atomicWriteText,
  bookIdFromUrl,
  deleteBook,
  listTrash,
  mergeIncomingChapters,
  normalizeChapterUrl,
  purgeTrash,
  restoreFromTrash,
  setLibraryPath,
  createBookFromBootstrap,
  bookExists,
  getBook,
  loadBook,
  listBooks,
  updateMeta,
  setCover,
  markChapterStatus,
  readChapter,
  readAiMemory,
  readAiMemoryCompat,
  readChat,
  readSummaries,
  refreshBookStatus,
  rebuildIndex,
  saveBook,
  setProgress,
  stableAiMemoryId,
  markAiMemoryAccuracy,
  writeAiMemory,
  writeCharacterCard,
  writeChapterFile,
  writeChapterSummary,
  writeChat,
} from './library'
import type { AiMemoryFile, Book, CatalogChapter } from '../shared/types'

function book(partial?: Partial<Book>): Book {
  return {
    id: 'd_test',
    title: '测',
    author: '',
    tags: [],
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

describe('novel memory v1 storage', () => {
  let dir: string
  let memory: AiMemoryFile

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-memory-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: 'd_memory',
      title: '记忆测试',
      author: '',
      importType: 'download',
      chapterTitles: ['第一章'],
    })
    memory = {
      version: 1,
      uptoChapterId: 'c0001',
      characters: [{
        id: stableAiMemoryId('character', ' 顾 清 ', 'ev-c0001-p3'),
        name: '顾清',
        aliases: ['阿清'],
        role: '主角',
        status: '调查账册',
        summary: '顾家长女。',
        sources: [{
          id: 'ev-c0001-p3', chapterId: 'c0001', chapterTitle: '第一章',
          paragraphIndex: 3, excerpt: `顾清回到旧宅，开始调查父亲失踪前留下的账册。${'旧宅门前的铜环仍覆着青绿色锈迹。'.repeat(5)}`,
        }],
        accuracy: 'normal',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      relations: [],
      foreshadows: [],
      events: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('uses stable ids across Unicode and whitespace normalization', () => {
    expect(stableAiMemoryId('character', ' 顾  清 ', 'ev-c0001-p3'))
      .toBe(stableAiMemoryId('character', '顾 清', 'ev-c0001-p3'))
    expect(stableAiMemoryId('event', '顾 清', 'ev-c0001-p3'))
      .not.toBe(stableAiMemoryId('character', '顾 清', 'ev-c0001-p3'))
  })

  it('atomically writes and strictly reads memory v1', async () => {
    await writeAiMemory('d_memory', memory)
    expect(await readAiMemory('d_memory')).toEqual(memory)
    await writeFile(join(dir, 'd_memory', 'ai', 'memory.json'), '{broken', 'utf-8')
    expect(await readAiMemory('d_memory')).toBeNull()
  })

  it('snapshots the validated value before asynchronous file work begins', async () => {
    const writing = writeAiMemory('d_memory', memory)
    memory.characters[0]!.name = '异步篡改'
    await writing
    expect((await readAiMemory('d_memory'))?.characters[0]?.name).toBe('顾清')
  })

  it('prefers valid new memory and otherwise falls back to the legacy character card', async () => {
    await writeCharacterCard('d_memory', {
      version: 1,
      characters: [{ name: '旧人物' }],
      foreshadows: [],
      raw: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect((await readAiMemoryCompat('d_memory') as { characters: Array<{ name: string }> }).characters[0]?.name)
      .toBe('旧人物')
    await writeAiMemory('d_memory', memory)
    const current = await readAiMemoryCompat('d_memory')
    expect(current).toEqual(memory)
    await writeFile(join(dir, 'd_memory', 'ai', 'memory.json'), '{}', 'utf-8')
    expect((await readAiMemoryCompat('d_memory') as { characters: Array<{ name: string }> }).characters[0]?.name)
      .toBe('旧人物')
  })

  it('persists review and uncertain accuracy without changing the stable id', async () => {
    await writeAiMemory('d_memory', memory)
    const id = memory.characters[0]!.id
    const review = await markAiMemoryAccuracy('d_memory', 'characters', id, 'review')
    expect(review.id).toBe(id)
    expect(review.accuracy).toBe('review')
    const uncertain = await markAiMemoryAccuracy('d_memory', 'characters', id, 'uncertain')
    expect(uncertain.accuracy).toBe('uncertain')
    expect((await readAiMemory('d_memory'))?.characters[0]?.accuracy).toBe('uncertain')
  })

  it('keeps the prior accuracy when marking fails before the atomic commit', async () => {
    await writeAiMemory('d_memory', memory)
    await expect(markAiMemoryAccuracy(
      'd_memory',
      'characters',
      memory.characters[0]!.id,
      'review',
      { hooks: { rename: async () => { throw new Error('rename failed') } } },
    )).rejects.toThrow('rename failed')
    expect((await readAiMemory('d_memory'))?.characters[0]?.accuracy).toBe('normal')
  })

  it('preserves the old formal memory when atomic rename fails', async () => {
    await writeAiMemory('d_memory', memory)
    const replacement: AiMemoryFile = { ...memory, uptoChapterId: 'c0002' }
    await expect(writeAiMemory('d_memory', replacement, {
      hooks: { rename: async () => { throw new Error('rename failed') } },
    })).rejects.toThrow('rename failed')
    expect((await readAiMemory('d_memory'))?.uptoChapterId).toBe('c0001')
    expect((await readdir(join(dir, 'd_memory', 'ai'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('rejects malformed memory before replacing the formal file', async () => {
    await writeAiMemory('d_memory', memory)
    const malformed = { ...memory, characters: [{ ...memory.characters[0], accuracy: 'wrong' }] } as unknown as AiMemoryFile
    await expect(writeAiMemory('d_memory', malformed)).rejects.toThrow('小说记忆数据格式无效')
    expect((await readAiMemory('d_memory'))?.characters[0]?.accuracy).toBe('normal')
  })
})

describe('atomic AI file writes', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-atomic-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('preserves the old file and cleans the temporary file when rename fails', async () => {
    const target = join(dir, 'state.json')
    await writeFile(target, 'old-content', 'utf-8')
    await expect(atomicWriteText(target, 'new-content', {
      hooks: { rename: async () => { throw new Error('rename failed') } },
    })).rejects.toThrow(/rename failed/)
    expect(await readFile(target, 'utf-8')).toBe('old-content')
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('checks cancellation after fsync and before the atomic rename commit', async () => {
    const target = join(dir, 'state.json')
    await writeFile(target, 'old-content', 'utf-8')
    const controller = new AbortController()
    await expect(atomicWriteText(target, 'new-content', {
      signal: controller.signal,
      hooks: { beforeCommit: () => controller.abort() },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readFile(target, 'utf-8')).toBe('old-content')
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('summaries v2 migration', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-summaries-'))
    await setLibraryPath(dir)
    const created = await createBookFromBootstrap({
      bookId: 'd_summary',
      title: '迁移测试',
      author: '',
      importType: 'download',
      chapterTitles: ['第一章', '第二章', '第三章'],
    })
    created.progress = { chapterId: 'c0002', scrollRatio: 0.5, updatedAt: '2026-01-01T00:00:00.000Z' }
    await saveBook(created)
    await mkdir(join(dir, 'd_summary', 'ai'), { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('moves legacy progress summary into storySoFar and never exposes it in byChapter', async () => {
    await writeFile(
      join(dir, 'd_summary', 'ai', 'summaries.json'),
      JSON.stringify({ byChapter: { c0001: '旧前情一', c0002: '旧前情二' }, updatedAt: '2026-01-01T00:00:00.000Z' }),
      'utf-8',
    )

    const migrated = await readSummaries('d_summary')
    expect(migrated).toMatchObject({ version: 2, byChapter: {}, storySoFar: { uptoChapterId: 'c0002', text: '旧前情二' } })

    await writeChapterSummary('d_summary', 'c0002', '第二章的新摘要')
    const saved = JSON.parse(await readFile(join(dir, 'd_summary', 'ai', 'summaries.json'), 'utf-8'))
    expect(saved).toMatchObject({ version: 2, byChapter: { c0002: '第二章的新摘要' }, storySoFar: { uptoChapterId: 'c0002', text: '旧前情二' } })
  })

  it('moves the highest indexed legacy chapter when progress has no old entry', async () => {
    await writeFile(
      join(dir, 'd_summary', 'ai', 'summaries.json'),
      JSON.stringify({ byChapter: { c0001: '旧一', c0003: '旧三' } }),
      'utf-8',
    )

    const migrated = await readSummaries('d_summary')
    expect(migrated.storySoFar).toMatchObject({ uptoChapterId: 'c0003', text: '旧三' })
    expect(migrated.byChapter).toEqual({})
  })

  it('treats malformed summaries as an empty v2 file without throwing', async () => {
    await writeFile(join(dir, 'd_summary', 'ai', 'summaries.json'), JSON.stringify({ byChapter: ['bad'] }), 'utf-8')

    await expect(readSummaries('d_summary')).resolves.toMatchObject({ version: 2, byChapter: {} })
  })

  it('keeps the previous summaries file intact when the atomic commit fails', async () => {
    const file = join(dir, 'd_summary', 'ai', 'summaries.json')
    const previous = JSON.stringify({ version: 2, byChapter: { c0001: '旧摘要' }, updatedAt: 'old' })
    await writeFile(file, previous, 'utf-8')
    await expect(writeChapterSummary('d_summary', 'c0002', '新摘要', {
      hooks: { rename: async () => { throw new Error('disk commit failed') } },
    })).rejects.toThrow(/disk commit failed/)
    expect(await readFile(file, 'utf-8')).toBe(previous)
  })
})

describe('chat storage', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'spbf-chat-')); await setLibraryPath(dir); await createBookFromBootstrap({ bookId: 'd_chat', title: '聊书', author: '', importType: 'download', chapterTitles: ['一'] }) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('clips the newest messages by user-assistant units without orphan assistants', async () => {
    const messages = Array.from({ length: 41 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}` }))
    await writeChat('d_chat', messages)
    const saved = await readChat('d_chat')
    expect(saved.version).toBe(2)
    expect(saved.messages).toHaveLength(39)
    expect(saved.messages[0]?.content).toBe('m2')
    expect(saved.messages[0]?.role).toBe('user')
    expect(saved.messages.at(-1)).toEqual({ role: 'user', content: 'm40' })
  })

  it('keeps a continuous newest suffix instead of backfilling an older short unit', async () => {
    const messages = [
      { role: 'user' as const, content: 'old-single' },
      ...Array.from({ length: 20 }, (_, index) => [
        { role: 'user' as const, content: `q${index}` },
        { role: 'assistant' as const, content: `a${index}` },
      ]).flat(),
      { role: 'user' as const, content: 'latest-single' },
    ]
    await writeChat('d_chat', messages)
    const saved = await readChat('d_chat')
    expect(saved.messages).toHaveLength(39)
    expect(saved.messages[0]?.content).toBe('q1')
    expect(saved.messages.map((item) => item.content)).not.toContain('old-single')
    expect(saved.messages.at(-1)?.content).toBe('latest-single')
  })

  it('reads v1 compatibly and preserves v2 citations, cutoff, and stopped state', async () => {
    const file = join(dir, 'd_chat', 'ai', 'chat.json')
    await writeFile(file, JSON.stringify({ version: 1, messages: [
      { role: 'assistant', content: 'orphan' },
      { role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答', citations: [{ id: 'ignored' }] },
    ], updatedAt: 'old' }), 'utf-8')
    await expect(readChat('d_chat')).resolves.toEqual({
      version: 1, messages: [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }], updatedAt: 'old',
    })
    const citation = { id: 'qa-c0001-p0', chapterId: 'c0001', chapterTitle: '一', paragraphIndex: 0, excerpt: '证据' }
    await writeChat('d_chat', [
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '部分回答', citations: [citation], uptoChapterId: 'c0001', stopped: true },
    ])
    await expect(readChat('d_chat')).resolves.toMatchObject({
      version: 2,
      messages: [
        { role: 'user', content: '新问题' },
        { role: 'assistant', content: '部分回答', citations: [citation], uptoChapterId: 'c0001', stopped: true },
      ],
    })
    await writeFile(file, JSON.stringify({ version: 3, messages: [{ role: 'user', content: '未来格式' }] }), 'utf-8')
    await expect(readChat('d_chat')).resolves.toMatchObject({ version: 1, messages: [] })
    await writeFile(file, JSON.stringify({ version: 2, messages: [
      { role: 'user', content: 'Q1' }, { role: 'user' }, { role: 'assistant', content: 'A2' },
    ] }), 'utf-8')
    await expect(readChat('d_chat')).resolves.toMatchObject({ version: 1, messages: [] })
    await writeFile(file, '{ bad', 'utf-8')
    await expect(readChat('d_chat')).resolves.toMatchObject({ version: 1, messages: [] })
  })

  it('keeps the previous chat file intact when the atomic commit fails', async () => {
    const file = join(dir, 'd_chat', 'ai', 'chat.json')
    const previous = JSON.stringify({ version: 1, messages: [{ role: 'user', content: '旧消息' }], updatedAt: 'old' })
    await writeFile(file, previous, 'utf-8')
    await expect(writeChat('d_chat', [{ role: 'assistant', content: '新消息' }], {
      hooks: { rename: async () => { throw new Error('disk commit failed') } },
    })).rejects.toThrow(/disk commit failed/)
    expect(await readFile(file, 'utf-8')).toBe(previous)
  })
})

describe('trash（回收站）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-trash-'))
    await setLibraryPath(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function seedBook(id: string, title: string) {
    const created = await createBookFromBootstrap({
      bookId: id,
      title,
      author: '作者甲',
      sourceUrl: `https://example.com/${id}/`,
      sourceHost: 'example.com',
      importType: 'download',
      chapterTitles: ['第一章', '第二章'],
      chapterUrls: [`https://example.com/${id}/1.html`, `https://example.com/${id}/2.html`],
    })
    created.chapters[0].status = 'ready'
    await saveBook(created)
    return created
  }

  it('deleteBook moves the book into __trash__ instead of removing it', async () => {
    await seedBook('d_trash_a', '要删的书')
    expect((await listBooks()).map((b) => b.id)).toContain('d_trash_a')

    await deleteBook('d_trash_a')

    expect(await bookExists('d_trash_a')).toBe(false)
    expect((await listBooks()).map((b) => b.id)).not.toContain('d_trash_a')

    const items = await listTrash()
    expect(items).toHaveLength(1)
    expect(items[0].bookId).toBe('d_trash_a')
    expect(items[0].title).toBe('要删的书')
    expect(items[0].chapterCount).toBe(2)
    expect(new Date(items[0].trashedAt).toString()).not.toBe('Invalid Date')
  })

  it('restoreFromTrash puts the same book back with its data intact', async () => {
    await seedBook('d_trash_b', '还原的书')
    await deleteBook('d_trash_b')
    const items = await listTrash()

    await restoreFromTrash(items[0].name)

    expect(await bookExists('d_trash_b')).toBe(true)
    const back = await loadBook('d_trash_b')
    expect(back.title).toBe('还原的书')
    expect(back.chapters[0].status).toBe('ready')
    expect((await listTrash())).toHaveLength(0)
    expect((await listBooks()).map((b) => b.id)).toContain('d_trash_b')
  })

  it('restore refuses when a live book already occupies the id', async () => {
    await seedBook('d_trash_c', '第一份')
    await deleteBook('d_trash_c')
    await seedBook('d_trash_c', '第二份')
    const items = await listTrash()

    await expect(restoreFromTrash(items[0].name)).rejects.toThrow('无法还原')
    // 原条目仍在回收站
    expect(await listTrash()).toHaveLength(1)
  })

  it('purgeTrash removes one entry or empties everything', async () => {
    await seedBook('d_trash_d', '甲')
    await seedBook('d_trash_e', '乙')
    await deleteBook('d_trash_d')
    await deleteBook('d_trash_e')
    const items = await listTrash()
    expect(items).toHaveLength(2)

    await purgeTrash(items[0].name)
    expect(await listTrash()).toHaveLength(1)

    const purged = await purgeTrash()
    expect(purged).toBe(1)
    expect(await listTrash()).toHaveLength(0)
  })

  it('rejects illegal trash names (path traversal)', async () => {
    await expect(restoreFromTrash('../escape')).rejects.toThrow('不合法')
    await expect(purgeTrash('..\\escape')).rejects.toThrow('不合法')
  })
})

describe('updateMeta + setCover (U1.2)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-meta-'))
    await setLibraryPath(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function seed(id = 'd_meta') {
    const created = await createBookFromBootstrap({
      bookId: id,
      title: '原标题',
      author: '原作者',
      sourceUrl: `https://example.com/${id}/`,
      sourceHost: 'example.com',
      importType: 'download',
      chapterTitles: ['第一章'],
      chapterUrls: [`https://example.com/${id}/1.html`],
    })
    created.progress = { chapterId: 'c0001', scrollRatio: 0.4, updatedAt: '2026-01-01T00:00:00.000Z' }
    created.chapters[0].status = 'ready'
    await saveBook(created)
    await mkdir(join(dir, id, 'chapters'), { recursive: true })
    await writeFile(
      join(dir, id, 'chapters', '0001.json'),
      JSON.stringify({
        title: '第一章',
        url: `https://example.com/${id}/1.html`,
        body: '正文不得被改',
        status: 'ready',
      }, null, 2),
      'utf-8',
    )
    return created
  }

  it('list/get return tags and coverPath; missing or illegal tags become []', async () => {
    await mkdir(join(dir, 'd_legacy'), { recursive: true })
    const legacy = {
      id: 'd_legacy',
      title: '旧书',
      author: '',
      importType: 'txt',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'ready',
      progress: null,
      chapters: [],
    }
    await writeFile(join(dir, 'd_legacy', 'book.json'), JSON.stringify(legacy), 'utf-8')
    await expect(listBooks()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'd_legacy', tags: [] })]),
    )
    await expect(getBook('d_legacy')).resolves.toMatchObject({ id: 'd_legacy', tags: [] })

    await writeFile(
      join(dir, 'd_legacy', 'book.json'),
      JSON.stringify({ ...legacy, tags: '玄幻', coverPath: 'cover.jpg' }),
      'utf-8',
    )
    const listed = await listBooks()
    expect(listed.find((b) => b.id === 'd_legacy')).toMatchObject({ tags: [], coverPath: 'cover.jpg' })
    await expect(getBook('d_legacy')).resolves.toMatchObject({ tags: [], coverPath: 'cover.jpg' })

    await writeFile(
      join(dir, 'd_legacy', 'book.json'),
      JSON.stringify({ ...legacy, tags: [1, '玄幻'] }),
      'utf-8',
    )
    await expect(getBook('d_legacy')).resolves.toMatchObject({ tags: [] })
  })

  it('updateMeta writes title/author/tags/updatedAt to book.json and index.json', async () => {
    await seed()
    await listBooks()
    const before = await loadBook('d_meta')
    const result = await updateMeta({
      bookId: 'd_meta',
      title: '  新标题  ',
      author: '  乙  ',
      tags: [' 玄幻 ', '', 'XuanHuan', 'xuanhuan', ' 穿越 '],
    })
    expect(result).toEqual({ ok: true })
    const loaded = await loadBook('d_meta')
    expect(loaded.title).toBe('新标题')
    expect(loaded.author).toBe('乙')
    expect(loaded.tags).toEqual(['玄幻', 'XuanHuan', '穿越'])
    expect(loaded.updatedAt).not.toBe(before.updatedAt)
    expect(loaded.progress).toEqual(before.progress)
    expect(loaded.chapters).toEqual(before.chapters)
    const chapter = JSON.parse(await readFile(join(dir, 'd_meta', 'chapters', '0001.json'), 'utf-8')) as { body: string }
    expect(chapter.body).toBe('正文不得被改')
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf-8')) as {
      books: Array<{ id: string; title: string; author: string; tags: string[]; updatedAt: string }>
    }
    expect(index.books.find((b) => b.id === 'd_meta')).toMatchObject({
      title: '新标题',
      author: '乙',
      tags: ['玄幻', 'XuanHuan', '穿越'],
      updatedAt: loaded.updatedAt,
    })
  })

  it('updateMeta rejects missing books and empty titles without writing', async () => {
    await seed()
    const missing = await updateMeta({ bookId: 'd_nope', title: '有名', author: '', tags: [] })
    expect(missing).toEqual({ ok: false, message: '书不存在' })
    const blank = await updateMeta({ bookId: 'd_meta', title: '   ', author: '甲', tags: ['x'] })
    expect(blank.ok).toBe(false)
    if (!blank.ok) expect(blank.message.length).toBeGreaterThan(0)
    const loaded = await loadBook('d_meta')
    expect(loaded.title).toBe('原标题')
    expect(loaded.author).toBe('原作者')
    expect(loaded.tags).toEqual([])
  })

  it('setCover copies jpg/png/webp, overwrites stale covers, and rejects bad files', async () => {
    await seed()
    const srcDir = await mkdtemp(join(tmpdir(), 'spbf-cover-src-'))
    const jpg = join(srcDir, 'photo.JPEG')
    const png = join(srcDir, 'art.png')
    const webp = join(srcDir, 'art.webp')
    const gif = join(srcDir, 'art.gif')
    const huge = join(srcDir, 'huge.jpg')
    await writeFile(jpg, 'fake-jpeg')
    await writeFile(png, 'fake-png')
    await writeFile(webp, 'fake-webp')
    await writeFile(gif, 'fake-gif')
    await writeFile(huge, Buffer.alloc(8 * 1024 * 1024 + 1))

    const first = await setCover({ bookId: 'd_meta', sourcePath: jpg })
    expect(first).toEqual({ ok: true, coverPath: 'cover.jpg' })
    expect(await readFile(join(dir, 'd_meta', 'cover.jpg'), 'utf-8')).toBe('fake-jpeg')
    expect((await getBook('d_meta')).coverPath).toBe('cover.jpg')

    const second = await setCover({ bookId: 'd_meta', sourcePath: png })
    expect(second).toEqual({ ok: true, coverPath: 'cover.png' })
    const names = await readdir(join(dir, 'd_meta'))
    expect(names).toContain('cover.png')
    expect(names).not.toContain('cover.jpg')
    expect((await listBooks()).find((b) => b.id === 'd_meta')?.coverPath).toBe('cover.png')

    const third = await setCover({ bookId: 'd_meta', sourcePath: webp })
    expect(third).toEqual({ ok: true, coverPath: 'cover.webp' })
    expect((await readdir(join(dir, 'd_meta'))).filter((name) => name.startsWith('cover.'))).toEqual(['cover.webp'])

    expect(await setCover({ bookId: 'd_meta', sourcePath: gif })).toEqual({ ok: false, message: '仅支持 jpg、png、webp' })
    expect(await setCover({ bookId: 'd_meta', sourcePath: huge })).toEqual({ ok: false, message: '封面不能超过 8MB' })
    expect(await setCover({ bookId: 'd_nope', sourcePath: png })).toEqual({ ok: false, message: '书不存在' })
    expect(await setCover({ bookId: 'd_meta', sourcePath: join(srcDir, 'missing.jpg') })).toMatchObject({ ok: false })

    const after = await loadBook('d_meta')
    expect(after.title).toBe('原标题')
    expect(after.progress?.chapterId).toBe('c0001')
    const chapter = JSON.parse(await readFile(join(dir, 'd_meta', 'chapters', '0001.json'), 'utf-8')) as { body: string }
    expect(chapter.body).toBe('正文不得被改')
    await rm(srcDir, { recursive: true, force: true })
  })
})
