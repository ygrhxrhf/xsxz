import { describe, expect, it } from 'vitest'
import {
  applyAddedChapterCount,
  checkUpdateMessage,
  checkUpdateNeedsBrowse,
  createLibraryRefreshTracker,
  filterLibraryBooks,
  formatChapterOrdinal,
  formatLibraryProgress,
  hasFailedChapters,
  isDownloadBook,
  libraryCoverHue,
  libraryCoverHues,
  libraryCoverText,
  libraryFailureLabel,
  libraryMenuEntries,
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
      'recap',
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
    expect(
      formatLibraryProgress({
        id: 'd_1',
        title: '测',
        author: '甲',
        importType: 'download',
        status: 'partial',
        chapterCount: 10,
        readyCount: 6,
        progress: { chapterId: 'c0003', scrollRatio: 0.42, updatedAt: '2026-01-01T00:00:00.000Z' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe('第 3 章 · 42% · 6/10 章')
  })

  it('filters title/author/status and sorts locally', () => {
    const books = [
      {
        id: '1',
        title: '万古神帝',
        author: '飞天鱼',
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
    expect(filterLibraryBooks(books, { status: 'partial' }).map((b) => b.id)).toEqual(['2'])
    expect(sortLibraryBooks(books, 'title').map((b) => b.id)).toEqual(['2', '1'])
  })

  it('sends NeedLogin / Intercepted back to the browse page', () => {
    expect(checkUpdateNeedsBrowse('NeedLogin')).toBe(true)
    expect(checkUpdateNeedsBrowse('Intercepted')).toBe(true)
    expect(checkUpdateNeedsBrowse('CatalogNotFound')).toBe(false)
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
})
