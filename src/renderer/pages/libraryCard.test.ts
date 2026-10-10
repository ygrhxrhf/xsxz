import { describe, expect, it } from 'vitest'
import {
  applyAddedChapterCount,
  checkUpdateMessage,
  checkUpdateNeedsBrowse,
  createLibraryRefreshTracker,
  collectLibraryTags,
  filterLibraryBooks,
  findLibraryDuplicateGroups,
  formatChapterOrdinal,
  formatLibraryProgress,
  formatLibraryProgressTime,
  libraryUnlockedNote,
  groupFailedChaptersByCode,
  hasFailedChapters,
  libraryReadChapterOrdinal,
  isDownloadBook,
  isLibraryFindShortcut,
  libraryCoverFileName,
  libraryCoverHue,
  libraryCoverHues,
  libraryCoverSrc,
  libraryCoverText,
  libraryDuplicateKey,
  libraryFailureLabel,
  mapLibraryCoverError,
  libraryMenuEntries,
  normalizeEditTags,
  sortLibraryBooks,
} from './libraryCard'
import { failAdvice, filterCatalogChapters, readerProgressLabel, remainingChapterCount } from './readerHelpers'

describe('library cover helpers', () => {
  it('creates stable paired hues exactly 36 degrees apart', () => {
    expect(libraryCoverHue('book-1')).toBe(libraryCoverHue('book-1'))
    expect(libraryCoverHue('book-1')).not.toBe(libraryCoverHue('book-2'))
    const hues = libraryCoverHues('book-1')
    expect(hues.primary).toBeGreaterThanOrEqual(0)
    expect(hues.primary).toBeLessThan(360)
    expect(hues.secondary).toBe((hues.primary + 36) % 360)
  })

  it('uses the fixed CJK, latin, numeric, bracket, and empty title rules', () => {
    expect(libraryCoverText('《万古神帝》')).toBe('万')
    expect(libraryCoverText('  「 東京物语 」 ')).toBe('東')
    expect(libraryCoverText('deep seek')).toBe('DE')
    expect(libraryCoverText('  #a9故事')).toBe('A9')
    expect(libraryCoverText('123 书')).toBe('12')
    expect(libraryCoverText('éclair')).toBe('ÉC')
    expect(libraryCoverText('１２三')).toBe('１２')
    expect(libraryCoverText('📚𠀀故事')).toBe('𠀀')
    expect(libraryCoverText('…É9混合')).toBe('É9')
    expect(libraryCoverText('《 》')).toBe('书')
    expect(libraryCoverText('---')).toBe('书')
  })

  it('keeps overlapping refreshes loading and only applies the latest response', () => {
    const tracker = createLibraryRefreshTracker()
    const first = tracker.begin()
    const second = tracker.begin()
    expect(tracker.loading).toBe(true)
    expect(tracker.isLatest(first)).toBe(false)
    expect(tracker.isLatest(second)).toBe(true)
    tracker.end()
    expect(tracker.loading).toBe(true)
    tracker.end()
    expect(tracker.loading).toBe(false)
  })

  it('creates an explicit failure line only for books with missing ready chapters', () => {
    expect(libraryFailureLabel({ status: 'partial', readyCount: 7, chapterCount: 10 })).toBe('3 章下载失败')
    expect(libraryFailureLabel({ status: 'ready', readyCount: 10, chapterCount: 10 })).toBe('')
  })

  it('builds a file:// cover src and maps setCover errors', () => {
    expect(libraryCoverFileName('cover.jpg')).toBe('cover.jpg')
    expect(libraryCoverFileName('cover.PNG')).toBe('cover.png')
    expect(libraryCoverFileName('../cover.jpg')).toBe(null)
    expect(libraryCoverFileName('cover.gif')).toBe(null)
    expect(libraryCoverSrc('D:\\spbf\\library', 'd_abc', 'cover.jpg')).toBe(
      'file:///D:/spbf/library/d_abc/cover.jpg',
    )
    expect(libraryCoverSrc('/tmp/library', 'd_abc', 'cover.webp')).toBe(
      'file:///tmp/library/d_abc/cover.webp',
    )
    expect(libraryCoverSrc('D:\\spbf\\My Library', 'd_abc', 'cover.png')).toBe(
      'file:///D:/spbf/My%20Library/d_abc/cover.png',
    )
    expect(libraryCoverSrc('/tmp/library', '../escape', 'cover.jpg')).toBe(null)
    expect(libraryCoverSrc('/tmp/library', 'd_abc', 'cover.jpeg')).toBe(null)
    expect(mapLibraryCoverError('封面超过 8MB')).toBe('封面不能超过 8MB')
    expect(mapLibraryCoverError('封面不能超过 8MB')).toBe('封面不能超过 8MB')
    expect(mapLibraryCoverError('仅支持 jpg / png / webp 封面')).toBe('仅支持 jpg、png、webp')
    expect(mapLibraryCoverError('仅支持 jpg、png、webp')).toBe('仅支持 jpg、png、webp')
    expect(mapLibraryCoverError('书不存在')).toBe('保存失败，已保留原来的信息')
    expect(mapLibraryCoverError('')).toBe('保存失败，已保留原来的信息')
  })
})

describe('library check-update card helpers', () => {
  it('shows 检查更新 only for download books', () => {
    expect(isDownloadBook({ importType: 'download' })).toBe(true)
    expect(isDownloadBook({ importType: 'txt' })).toBe(false)
    expect(isDownloadBook({ importType: 'epub' })).toBe(false)
  })

  it('keeps 重试失败章 on partial download cards only', () => {
    expect(
      hasFailedChapters({ status: 'partial', readyCount: 2, chapterCount: 6 }),
    ).toBe(true)
    expect(
      hasFailedChapters({ status: 'ready', readyCount: 6, chapterCount: 6 }),
    ).toBe(false)
    expect(
      hasFailedChapters({ status: 'partial', readyCount: 6, chapterCount: 6 }),
    ).toBe(false)
  })

  it('keeps the fixed more-menu order while hiding inapplicable maintenance items', () => {
    expect(libraryMenuEntries({
      importType: 'download',
      status: 'partial',
      readyCount: 2,
      chapterCount: 6,
    })).toEqual([
      'edit',
      'recap',
      'quality',
      'check-update',
      'retry-failed',
      'view-failed',
      'divider-export',
      'export-txt',
      'export-epub',
      'divider-trash',
      'trash',
    ])
    expect(libraryMenuEntries({
      importType: 'txt',
      status: 'ready',
      readyCount: 2,
      chapterCount: 2,
    })).toEqual([
      'edit',
      'recap',
      'divider-export',
      'export-txt',
      'export-epub',
      'divider-trash',
      'trash',
    ])
  })

  it('maps checkUpdate results to exact Chinese strings', () => {
    expect(checkUpdateMessage({ ok: true, added: 3 })).toBe('新增 3 章')
    expect(checkUpdateMessage({ ok: true, added: 0 })).toBe('没有更新')
    expect(
      checkUpdateMessage({
        ok: false,
        message: '已有下载任务在进行中，请等待完成或取消后再试',
      }),
    ).toBe('已有下载任务在进行中，请等待完成或取消后再试')
    expect(
      checkUpdateMessage({
        ok: false,
        message: '无原始目录地址，无法检查更新',
      }),
    ).toBe('无原始目录地址，无法检查更新')
  })

  it('bumps chapterCount by added when new chapters exist', () => {
    expect(applyAddedChapterCount(6, 1)).toBe(7)
    expect(applyAddedChapterCount(6, 0)).toBe(6)
  })

  it('shows 第 x 章 instead of a raw chapterId', () => {
    expect(formatChapterOrdinal('c0005')).toBe('第 5 章')
    expect(formatChapterOrdinal('c0005', 5)).toBe('第 5 章')
  })

  it('shows 已读 x / 共 y 章 from catalog ordinal and chapterCount', () => {
    const unread = {
      id: 'd_1',
      title: '测',
      author: '甲',
      tags: [] as string[],
      importType: 'download' as const,
      status: 'partial' as const,
      chapterCount: 10,
      readyCount: 6,
      progress: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    expect(libraryReadChapterOrdinal(unread)).toBe(0)
    expect(formatLibraryProgress(unread)).toBe('已读 0 / 共 10 章')
    expect(formatLibraryProgressTime(unread)).toBe('未读')
    const reading = {
      ...unread,
      progress: { chapterId: 'c0003', scrollRatio: 0.42, updatedAt: '2026-01-01T00:00:00.000Z' },
    }
    expect(libraryReadChapterOrdinal(reading)).toBe(3)
    expect(formatLibraryProgress(reading)).toBe('已读 3 / 共 10 章')
    expect(formatLibraryProgressTime(reading)).toBe(
      new Date('2026-01-01T00:00:00.000Z').toLocaleString('zh-CN'),
    )
    expect(
      formatLibraryProgress({
        ...unread,
        progress: { chapterId: 'unknown', scrollRatio: 0, updatedAt: 'not-a-date' },
      }),
    ).toBe('已读 0 / 共 10 章')
    expect(
      formatLibraryProgressTime({
        progress: { chapterId: 'c0001', scrollRatio: 0, updatedAt: 'not-a-date' },
      }),
    ).toBe('not-a-date')
  })

  it('filters title/author/tags/status case-insensitively and sorts locally', () => {
    const books = [
      {
        id: '1',
        title: '万古神帝',
        author: '飞天鱼',
        tags: ['XuanHuan', '穿越'],
        importType: 'download' as const,
        status: 'ready' as const,
        chapterCount: 2,
        readyCount: 2,
        progress: null,
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: '2',
        title: '导入书',
        author: '乙',
        tags: ['都市'],
        importType: 'txt' as const,
        status: 'partial' as const,
        chapterCount: 3,
        readyCount: 1,
        progress: null,
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
    ]
    expect(filterLibraryBooks(books, { q: '万古' }).map((b) => b.id)).toEqual(['1'])
    expect(filterLibraryBooks(books, { q: '乙' }).map((b) => b.id)).toEqual(['2'])
    expect(filterLibraryBooks(books, { q: 'xuanhuan' }).map((b) => b.id)).toEqual(['1'])
    expect(filterLibraryBooks(books, { q: '  穿越  ' }).map((b) => b.id)).toEqual(['1'])
    expect(filterLibraryBooks(books, { q: '都市', status: 'ready' }).map((b) => b.id)).toEqual([])
    expect(filterLibraryBooks(books, { q: '', status: 'partial' }).map((b) => b.id)).toEqual(['2'])
    expect(filterLibraryBooks(books, { q: '   ' }).map((b) => b.id)).toEqual(['1', '2'])
    expect(filterLibraryBooks(books, { status: 'partial' }).map((b) => b.id)).toEqual(['2'])
    expect(filterLibraryBooks(books, { selectedTag: 'xuanhuan' }).map((b) => b.id)).toEqual(['1'])
    expect(filterLibraryBooks(books, { selectedTag: '  穿越  ' }).map((b) => b.id)).toEqual(['1'])
    expect(filterLibraryBooks(books, { selectedTag: '都' }).map((b) => b.id)).toEqual([])
    expect(filterLibraryBooks(books, { q: '万古', selectedTag: '都市' }).map((b) => b.id)).toEqual([])
    expect(filterLibraryBooks(books, { q: '导入', status: 'partial', selectedTag: '都市' }).map((b) => b.id)).toEqual(['2'])
    expect(filterLibraryBooks(books, { selectedTag: '' }).map((b) => b.id)).toEqual(['1', '2'])
    expect(sortLibraryBooks(books, 'title').map((b) => b.id)).toEqual(['2', '1'])
  })

  it('collects unique library tags, case-insensitively keeping first spelling', () => {
    expect(collectLibraryTags([])).toEqual([])
    expect(collectLibraryTags([{ tags: [] }, { tags: ['  ', ''] }])).toEqual([])
    expect(
      collectLibraryTags([
        { tags: ['XuanHuan', '穿越', ' xuanhuan '] },
        { tags: ['都市', '穿越', 'XUANHUAN'] },
      ]),
    ).toEqual(['XuanHuan', '穿越', '都市'])
  })

  it('normalizes edit tags by comma/trim/empty-drop/same-book dedupe', () => {
    expect(normalizeEditTags([])).toEqual([])
    expect(normalizeEditTags(['  ', '', '  ,  ， '])).toEqual([])
    expect(normalizeEditTags([' 玄幻 ', 'XuanHuan,xuanhuan， 穿越 ', '穿越'])).toEqual([
      '玄幻',
      'XuanHuan',
      '穿越',
    ])
    expect(normalizeEditTags(['都市, 都市', '都市'])).toEqual(['都市'])
  })

  it('groups books whose trimmed title and author match case-insensitively', () => {
    const book = (
      id: string,
      title: string,
      author: string,
      updatedAt = '2026-01-01T00:00:00.000Z',
    ) => ({
      id,
      title,
      author,
      tags: [] as string[],
      importType: 'txt' as const,
      status: 'ready' as const,
      chapterCount: 1,
      readyCount: 1,
      progress: null,
      updatedAt,
    })
    expect(findLibraryDuplicateGroups([])).toEqual([])
    expect(findLibraryDuplicateGroups([book('1', '万古神帝', '飞天鱼')])).toEqual([])
    expect(
      findLibraryDuplicateGroups([
        book('1', '万古神帝', '飞天鱼'),
        book('2', '导入书', '乙'),
      ]),
    ).toEqual([])
    expect(
      findLibraryDuplicateGroups([
        book('1', '万古神帝', '飞天鱼'),
        book('2', '万古神帝', '乙'),
      ]),
    ).toEqual([])
    expect(
      findLibraryDuplicateGroups([
        book('1', '甲', '同作者'),
        book('2', '乙', '同作者'),
      ]),
    ).toEqual([])
    const pair = findLibraryDuplicateGroups([
      book('keep', '  万古神帝  ', '飞天鱼'),
      book('dup', '万古神帝', '  飞天鱼  '),
    ])
    expect(pair).toHaveLength(1)
    expect(pair[0].books.map((b) => b.id)).toEqual(['keep', 'dup'])
    expect(pair[0].title).toBe('  万古神帝  ')
    expect(pair[0].author).toBe('飞天鱼')
    expect(libraryDuplicateKey({ title: '  Foo ', author: ' Bar ' })).toBe(
      libraryDuplicateKey({ title: 'foo', author: 'bar' }),
    )
    const mixed = findLibraryDuplicateGroups([
      book('a', 'Alpha', 'Ann'),
      book('b', 'Beta', ''),
      book('c', 'ALPHA', 'ANN'),
      book('d', 'Beta', '  '),
      book('e', 'Gamma', 'G'),
      book('f', 'alpha', 'ann'),
    ])
    expect(mixed.map((g) => g.books.map((b) => b.id))).toEqual([
      ['a', 'c', 'f'],
      ['b', 'd'],
    ])
    expect(mixed[0].title).toBe('Alpha')
    expect(mixed[0].author).toBe('Ann')
    expect(mixed[1].title).toBe('Beta')
    expect(mixed[1].author).toBe('')
  })

  it('treats Ctrl+F and Meta+F without Shift as the library find shortcut', () => {
    expect(isLibraryFindShortcut({ key: 'f', ctrlKey: true, metaKey: false })).toBe(true)
    expect(isLibraryFindShortcut({ key: 'F', ctrlKey: false, metaKey: true, shiftKey: false })).toBe(true)
    expect(isLibraryFindShortcut({ key: 'f', ctrlKey: true, metaKey: false, shiftKey: true })).toBe(false)
    expect(isLibraryFindShortcut({ key: 'f', ctrlKey: false, metaKey: false })).toBe(false)
    expect(isLibraryFindShortcut({ key: 'g', ctrlKey: true, metaKey: false })).toBe(false)
  })

  it('sends NeedLogin / Paywall / Intercepted back to the browse page', () => {
    expect(checkUpdateNeedsBrowse('NeedLogin')).toBe(true)
    expect(checkUpdateNeedsBrowse('Paywall')).toBe(true)
    expect(checkUpdateNeedsBrowse('Intercepted')).toBe(true)
    expect(checkUpdateNeedsBrowse('CatalogNotFound')).toBe(false)
    expect(checkUpdateNeedsBrowse('RateLimited')).toBe(false)
  })

  it('groups failed chapters by wall code, first-seen first', () => {
    expect(
      groupFailedChaptersByCode([
        { failCode: 'NeedLogin' },
        { failCode: 'NeedLogin' },
        { failCode: 'BodyEmpty' },
        { failCode: 'RateLimited' },
        { failCode: 'BodyEmpty' },
        { failCode: undefined },
      ]),
    ).toEqual([
      { code: 'NeedLogin', label: '需要登录后才能看', count: 2 },
      { code: 'BodyEmpty', label: '正文为空或过短', count: 2 },
      { code: 'RateLimited', label: '站点限流，请求过于频繁', count: 1 },
      { code: '', label: '未记录原因', count: 1 },
    ])
    expect(groupFailedChaptersByCode([])).toEqual([])
  })
})

describe('reader progress / catalog helpers', () => {
  const chapters = [
    { id: 'c0001', index: 1, title: '第一章 苏醒' },
    { id: 'c0002', index: 2, title: '第二章 入门' },
    { id: 'c0003', index: 3, title: '第三章 下山' },
  ]

  it('summarizes remaining chapters without exposing raw ids', () => {
    expect(remainingChapterCount(chapters, 'c0001')).toBe(2)
    expect(readerProgressLabel(chapters, 'c0002', 0.5)).toBe('第 2 章 · 本章 50% · 还剩 1 章')
  })

  it('filters the catalog by title keyword', () => {
    expect(filterCatalogChapters(chapters, '入门').map((c) => c.id)).toEqual(['c0002'])
    expect(filterCatalogChapters(chapters, '').map((c) => c.id)).toEqual(['c0001', 'c0002', 'c0003'])
  })

  it('gives NeedLogin a browse hint', () => {
    expect(failAdvice('NeedLogin')).toMatch(/浏览页登录/)
    expect(failAdvice('BodyEmpty')).toMatch(/重试/)
  })

  it('tells the reader a paid chapter needs unlocking in the browse page', () => {
    expect(failAdvice('Paywall')).toMatch(/付费或会员/)
    expect(failAdvice('Paywall')).toMatch(/浏览页/)
  })

  it('asks a rate-limited chapter to wait instead of visiting the browse page', () => {
    expect(failAdvice('RateLimited')).toMatch(/限流/)
    expect(failAdvice('RateLimited')).not.toMatch(/浏览页/)
  })
})

describe('库卡片上的自动恢复提示', () => {
  it('有恢复章才提示，并给出章数', () => {
    expect(libraryUnlockedNote({ unlockedCount: 3 })).toBe('含 3 章自动恢复')
    expect(libraryUnlockedNote({ unlockedCount: 0 })).toBe('')
    expect(libraryUnlockedNote({})).toBe('')
  })
})
