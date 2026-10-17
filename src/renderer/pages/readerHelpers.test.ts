import { describe, expect, it } from 'vitest'
import type { ReaderFocusMode } from '@shared/types'
import {
  approximateBookRatio,
  approximateBookRatioFromIndex,
  catalogChapterBadge,
  chapterScrollRatio,
  failAdvice,
  focusHalfWindow,
  isParagraphInFocus,
  paragraphIndexAtViewportCenter,
  remainingChapterCount,
  readerScrollBehavior,
  resolveFocusAnchor,
  resolveImmersiveKey,
  resolveReaderKey,
  scrollableDistance,
  selectionPopupPosition,
  shouldAutoHideReaderTools,
  scrollTopFromRatio,
  wheelPageDirection,
} from './readerHelpers'

describe('reader progress helpers', () => {
  const chapters = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]

  it('uses only the scrollable distance', () => {
    expect(scrollableDistance(1800, 800)).toBe(1000)
    expect(scrollableDistance(600, 800)).toBe(0)
    expect(chapterScrollRatio(0, 1800, 800)).toBe(0)
    expect(chapterScrollRatio(500, 1800, 800)).toBe(0.5)
    expect(chapterScrollRatio(1000, 1800, 800)).toBe(1)
  })

  it('clamps invalid and out-of-range ratios', () => {
    expect(chapterScrollRatio(-50, 1800, 800)).toBe(0)
    expect(chapterScrollRatio(1200, 1800, 800)).toBe(1)
    expect(chapterScrollRatio(Number.NaN, 1800, 800)).toBe(0)
    // 内容不足一屏：没有可滚动距离就是已经看到底，短章要能判出「读完」
    expect(chapterScrollRatio(100, 800, 800)).toBe(1)
    expect(chapterScrollRatio(100, Number.POSITIVE_INFINITY, 800)).toBe(0)
  })

  it('restores scrollTop from the same distance formula', () => {
    expect(scrollTopFromRatio(0.5, 1800, 800)).toBe(500)
    expect(scrollTopFromRatio(1, 1800, 800)).toBe(1000)
    expect(scrollTopFromRatio(2, 1800, 800)).toBe(1000)
    expect(scrollTopFromRatio(Number.NaN, 1800, 800)).toBe(0)
    expect(scrollTopFromRatio(0.5, 600, 800)).toBe(0)
  })

  it('computes approximate whole-book progress and remaining chapters', () => {
    expect(approximateBookRatio([], null, 1)).toBe(0)
    expect(approximateBookRatio(chapters, 'c1', 0)).toBe(0)
    expect(approximateBookRatio(chapters, 'c2', 0.5)).toBe(0.5)
    expect(approximateBookRatio(chapters, 'c3', 1)).toBe(1)
    expect(approximateBookRatio(chapters, 'missing', Number.NaN)).toBe(0)
    expect(remainingChapterCount(chapters, 'c1')).toBe(2)
    expect(remainingChapterCount(chapters, 'c3')).toBe(0)
    expect(remainingChapterCount(chapters, 'missing')).toBe(3)
  })

  // 网页阅读模式没有 chapterId，只有目录序号，所以它走按序号的那条；两条必须同公式
  it('gives the same whole-book ratio by index as by chapter id', () => {
    expect(approximateBookRatioFromIndex(0, 3, 0)).toBe(approximateBookRatio(chapters, 'c1', 0))
    expect(approximateBookRatioFromIndex(1, 3, 0.5)).toBe(approximateBookRatio(chapters, 'c2', 0.5))
    expect(approximateBookRatioFromIndex(2, 3, 1)).toBe(approximateBookRatio(chapters, 'c3', 1))
  })

  it('refuses to guess a whole-book ratio without a known chapter count', () => {
    expect(approximateBookRatioFromIndex(3, 0, 0.5)).toBe(0)
    expect(approximateBookRatioFromIndex(3, Number.NaN, 0.5)).toBe(0)
    expect(approximateBookRatioFromIndex(3, -2, 0.5)).toBe(0)
    // 越界的序号与比例都夹紧，不吐出超过 1 的进度
    expect(approximateBookRatioFromIndex(99, 4, 2)).toBe(1)
    expect(approximateBookRatioFromIndex(-5, 4, -1)).toBe(0)
    expect(approximateBookRatioFromIndex(Number.NaN, 4, 0.25)).toBeCloseTo(0.0625)
  })
})

describe('immersive reader helpers', () => {
  it('hides tools after three idle seconds only in an unprotected reading state', () => {
    expect(shouldAutoHideReaderTools({ idleMs: 2999, overlayOpen: false, selectionOpen: false, pointerInToolbar: false })).toBe(false)
    expect(shouldAutoHideReaderTools({ idleMs: 3000, overlayOpen: false, selectionOpen: false, pointerInToolbar: false })).toBe(true)
  })

  it('keeps tools visible for drawers, selections, and toolbar hover', () => {
    expect(shouldAutoHideReaderTools({ idleMs: 5000, overlayOpen: true, selectionOpen: false, pointerInToolbar: false })).toBe(false)
    expect(shouldAutoHideReaderTools({ idleMs: 5000, overlayOpen: false, selectionOpen: true, pointerInToolbar: false })).toBe(false)
    expect(shouldAutoHideReaderTools({ idleMs: 5000, overlayOpen: false, selectionOpen: false, pointerInToolbar: true })).toBe(false)
  })

  it('maps M, Alt, and Escape across normal and locked modes', () => {
    expect(resolveImmersiveKey('m', 'normal')).toEqual({ mode: 'locked', toolsVisible: true, temporaryReveal: false })
    expect(resolveImmersiveKey('M', 'locked')).toEqual({ mode: 'normal', toolsVisible: true, temporaryReveal: false })
    expect(resolveImmersiveKey('Alt', 'locked')).toEqual({ mode: 'locked', toolsVisible: true, temporaryReveal: true })
    expect(resolveImmersiveKey('Escape', 'locked')).toEqual({ mode: 'normal', toolsVisible: true, temporaryReveal: false })
    expect(resolveImmersiveKey('Escape', 'normal')).toEqual({ mode: 'normal', toolsVisible: true, temporaryReveal: false })
  })
})

describe('resolveReaderKey', () => {
  it('maps arrow keys to chapter navigation', () => {
    expect(resolveReaderKey({ key: 'ArrowLeft' })).toBe('prev-chapter')
    expect(resolveReaderKey({ key: 'ArrowRight' })).toBe('next-chapter')
  })

  it('maps space/J to paging and shift+space/K back up', () => {
    expect(resolveReaderKey({ key: ' ' })).toBe('page-down')
    expect(resolveReaderKey({ key: ' ', shift: true })).toBe('page-up')
    expect(resolveReaderKey({ key: 'j' })).toBe('page-down')
    expect(resolveReaderKey({ key: 'J' })).toBe('page-down')
    expect(resolveReaderKey({ key: 'k' })).toBe('page-up')
    expect(resolveReaderKey({ key: 'K' })).toBe('page-up')
  })

  it('maps T/A/R to catalog, appearance and reading', () => {
    expect(resolveReaderKey({ key: 't' })).toBe('open-catalog')
    expect(resolveReaderKey({ key: 'T' })).toBe('open-catalog')
    expect(resolveReaderKey({ key: 'a' })).toBe('open-appearance')
    expect(resolveReaderKey({ key: 'R' })).toBe('toggle-tts')
  })

  it('maps I/N to the AI shell and the chapter note tab', () => {
    expect(resolveReaderKey({ key: 'i' })).toBe('open-assistant')
    expect(resolveReaderKey({ key: 'I' })).toBe('open-assistant')
    expect(resolveReaderKey({ key: 'n' })).toBe('open-note')
    expect(resolveReaderKey({ key: 'N' })).toBe('open-note')
    expect(resolveReaderKey({ key: 'i', targetTag: 'input' })).toBeNull()
  })

  it('maps +/-/=/_ to font size, including numpad-style =', () => {
    expect(resolveReaderKey({ key: '+' })).toBe('font-larger')
    expect(resolveReaderKey({ key: '=' })).toBe('font-larger')
    expect(resolveReaderKey({ key: '-' })).toBe('font-smaller')
    expect(resolveReaderKey({ key: '_' })).toBe('font-smaller')
  })

  it('ignores keys while typing in inputs or contenteditable', () => {
    expect(resolveReaderKey({ key: ' ', targetTag: 'input' })).toBeNull()
    expect(resolveReaderKey({ key: 'ArrowRight', targetTag: 'textarea' })).toBeNull()
    expect(resolveReaderKey({ key: '-', isContentEditable: true })).toBeNull()
    expect(resolveReaderKey({ key: 'a', targetTag: 'select' })).toBeNull()
    expect(resolveReaderKey({ key: 'r', targetTag: 'input' })).toBeNull()
  })

  it('ignores ctrl/cmd combos so browser zoom keeps working', () => {
    expect(resolveReaderKey({ key: '+', ctrlOrMeta: true })).toBeNull()
    expect(resolveReaderKey({ key: 'ArrowLeft', ctrlOrMeta: true })).toBeNull()
  })

  it('while a drawer is open only Escape does something', () => {
    expect(resolveReaderKey({ key: 'Escape', anyDrawerOpen: true })).toBe('close-drawer')
    expect(resolveReaderKey({ key: ' ', anyDrawerOpen: true })).toBeNull()
    expect(resolveReaderKey({ key: 'ArrowRight', anyDrawerOpen: true })).toBeNull()
  })

  it('returns null for unrelated keys', () => {
    expect(resolveReaderKey({ key: 'q' })).toBeNull()
    expect(resolveReaderKey({ key: 'F5' })).toBeNull()
  })
})

describe('readerScrollBehavior', () => {
  it('uses auto when reduced motion is requested and smooth otherwise', () => {
    expect(readerScrollBehavior(true)).toBe('auto')
    expect(readerScrollBehavior(false)).toBe('smooth')
  })
})

describe('reader focus window', () => {
  it('treats off as fully focused', () => {
    for (let i = 0; i < 5; i++) {
      expect(isParagraphInFocus({ mode: 'off', anchorIndex: 1, paragraphIndex: i, paragraphCount: 5 })).toBe(true)
    }
  })

  it('keeps a three-paragraph window around anchor 1 of 5', () => {
    const hits = [0, 1, 2, 3, 4].map((i) =>
      isParagraphInFocus({ mode: 'three', anchorIndex: 1, paragraphIndex: i, paragraphCount: 5 }),
    )
    expect(hits).toEqual([true, true, true, false, false])
  })

  it('clamps out-of-range anchors into the paragraph list', () => {
    expect(isParagraphInFocus({ mode: 'three', anchorIndex: -10, paragraphIndex: 0, paragraphCount: 5 })).toBe(true)
    expect(isParagraphInFocus({ mode: 'three', anchorIndex: -10, paragraphIndex: 1, paragraphCount: 5 })).toBe(true)
    expect(isParagraphInFocus({ mode: 'three', anchorIndex: -10, paragraphIndex: 2, paragraphCount: 5 })).toBe(false)
    expect(isParagraphInFocus({ mode: 'three', anchorIndex: 99, paragraphIndex: 3, paragraphCount: 5 })).toBe(true)
    expect(isParagraphInFocus({ mode: 'three', anchorIndex: 99, paragraphIndex: 4, paragraphCount: 5 })).toBe(true)
    expect(isParagraphInFocus({ mode: 'three', anchorIndex: 99, paragraphIndex: 2, paragraphCount: 5 })).toBe(false)
    expect(isParagraphInFocus({ mode: 'three', anchorIndex: Number.NaN, paragraphIndex: 0, paragraphCount: 5 })).toBe(true)
  })

  it('prefers spokenPara and returns -1 when both anchors are invalid', () => {
    expect(resolveFocusAnchor({ spokenPara: 2, viewportCenterPara: 4 })).toBe(2)
    expect(resolveFocusAnchor({ spokenPara: -1, viewportCenterPara: 3 })).toBe(3)
    expect(resolveFocusAnchor({ spokenPara: Number.NaN, viewportCenterPara: 1 })).toBe(1)
    expect(resolveFocusAnchor({ spokenPara: Number.NaN, viewportCenterPara: Number.NaN })).toBe(-1)
    expect(resolveFocusAnchor({ spokenPara: -1, viewportCenterPara: -1 })).toBe(-1)
  })

  it('uses half-window 0 for one and unknown modes', () => {
    expect(focusHalfWindow('one')).toBe(0)
    expect(focusHalfWindow('off')).toBe(0)
    expect(focusHalfWindow('three')).toBe(1)
    expect(focusHalfWindow('five')).toBe(2)
    expect(focusHalfWindow('huge' as ReaderFocusMode)).toBe(0)
  })
})

describe('paragraphIndexAtViewportCenter', () => {
  it('returns -1 for an empty paragraphCenters list', () => {
    expect(paragraphIndexAtViewportCenter({ viewportCenter: 100, paragraphCenters: [] })).toBe(-1)
  })

  it('hits the paragraph whose center is nearest the viewport center', () => {
    expect(paragraphIndexAtViewportCenter({ viewportCenter: 50, paragraphCenters: [10, 50, 90] })).toBe(1)
  })

  it('breaks equal distance toward the smaller index', () => {
    expect(paragraphIndexAtViewportCenter({ viewportCenter: 20, paragraphCenters: [10, 30] })).toBe(0)
  })
})

describe('failAdvice', () => {
  it('stays silent for codes without advice', () => {
    expect(failAdvice(undefined)).toBe('')
    expect(failAdvice('CatalogNotFound')).toBe('')
  })
})

describe('wheelPageDirection', () => {
  it('returns 0 for zero, NaN, and sub-threshold deltas', () => {
    expect(wheelPageDirection(0)).toBe(0)
    expect(wheelPageDirection(Number.NaN)).toBe(0)
    expect(wheelPageDirection(7)).toBe(0)
  })

  it('returns 1 at the positive threshold and -1 at the negative threshold', () => {
    expect(wheelPageDirection(8)).toBe(1)
    expect(wheelPageDirection(-8)).toBe(-1)
  })

  it('returns 1 for a typical page-wheel delta', () => {
    expect(wheelPageDirection(40)).toBe(1)
  })
})

describe('selectionPopupPosition', () => {
  const viewport = { width: 800, height: 600 }
  const popup = { width: 200, height: 80 }

  it('places the popup below the range when there is room', () => {
    const pos = selectionPopupPosition({
      range: { top: 100, right: 400, bottom: 140, left: 300, width: 100, height: 40 },
      viewport,
      popup,
    })
    expect(pos).toEqual({ x: 250, y: 148, placement: 'below' })
  })

  it('falls back above when the below edge would overflow the viewport', () => {
    const pos = selectionPopupPosition({
      range: { top: 520, right: 400, bottom: 560, left: 300, width: 100, height: 40 },
      viewport,
      popup,
    })
    expect(pos).toEqual({ x: 250, y: 432, placement: 'above' })
  })

  it('clamps horizontally to the left margin', () => {
    const pos = selectionPopupPosition({
      range: { top: 100, right: 30, bottom: 140, left: 10, width: 20, height: 40 },
      viewport,
      popup,
    })
    expect(pos.x).toBe(8)
    expect(pos.placement).toBe('below')
  })

  it('clamps horizontally to the right margin', () => {
    const pos = selectionPopupPosition({
      range: { top: 100, right: 790, bottom: 140, left: 750, width: 40, height: 40 },
      viewport,
      popup,
    })
    expect(pos.x).toBe(592)
    expect(pos.placement).toBe('below')
  })

  it('returns finite coordinates for NaN, Infinity, negative sizes, and a zero viewport', () => {
    const bad = selectionPopupPosition({
      range: {
        top: Number.NaN,
        right: Number.POSITIVE_INFINITY,
        bottom: Number.NEGATIVE_INFINITY,
        left: Number.NaN,
        width: -40,
        height: Number.NaN,
      },
      viewport: { width: 0, height: 0 },
      popup: { width: -12, height: Number.POSITIVE_INFINITY },
      gap: Number.NaN,
      margin: Number.POSITIVE_INFINITY,
    })
    expect(Number.isFinite(bad.x)).toBe(true)
    expect(Number.isFinite(bad.y)).toBe(true)
    expect(bad.placement === 'above' || bad.placement === 'below').toBe(true)
  })
})

describe('catalogChapterBadge', () => {
  const chapters = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]

  it('lets failed override current', () => {
    expect(
      catalogChapterBadge({
        status: 'failed',
        chapterId: 'c2',
        currentChapterId: 'c2',
        progressChapterId: 'c3',
        chapters,
      }),
    ).toBe('failed')
  })

  it('marks undownloaded pending chapters', () => {
    expect(
      catalogChapterBadge({
        status: 'pending',
        chapterId: 'c1',
        currentChapterId: 'c2',
        progressChapterId: 'c2',
        chapters,
      }),
    ).toBe('pending')
  })

  it('marks empty chapters', () => {
    expect(
      catalogChapterBadge({
        status: 'empty',
        chapterId: 'c1',
        currentChapterId: 'c2',
        progressChapterId: 'c2',
        chapters,
      }),
    ).toBe('empty')
  })

  it('lets current override already-read', () => {
    expect(
      catalogChapterBadge({
        status: 'ready',
        chapterId: 'c1',
        currentChapterId: 'c1',
        progressChapterId: 'c3',
        chapters,
      }),
    ).toBe('current')
  })

  it('marks chapters before the progress chapter as read', () => {
    expect(
      catalogChapterBadge({
        status: 'ready',
        chapterId: 'c1',
        currentChapterId: 'c3',
        progressChapterId: 'c2',
        chapters,
      }),
    ).toBe('read')
  })

  it('returns null when there is no progress chapter', () => {
    expect(
      catalogChapterBadge({
        status: 'ready',
        chapterId: 'c1',
        currentChapterId: 'c3',
        progressChapterId: null,
        chapters,
      }),
    ).toBeNull()
  })

  it('returns null when the progress chapter is not in the list', () => {
    expect(
      catalogChapterBadge({
        status: 'ready',
        chapterId: 'c1',
        currentChapterId: 'c3',
        progressChapterId: 'missing',
        chapters,
      }),
    ).toBeNull()
  })

  it('returns null for unknown status that is not current', () => {
    expect(
      catalogChapterBadge({
        status: 'unknown' as 'ready',
        chapterId: 'c2',
        currentChapterId: 'c1',
        progressChapterId: 'c2',
        chapters,
      }),
    ).toBeNull()
  })

  it('does not throw on missing chapters, empty ids, or non-array chapters', () => {
    expect(
      catalogChapterBadge({
        status: 'ready',
        chapterId: '',
        currentChapterId: '',
        progressChapterId: 'c2',
        chapters,
      }),
    ).toBeNull()
    expect(
      catalogChapterBadge({
        status: 'ready',
        chapterId: 'c1',
        currentChapterId: 'c1',
        chapters: undefined as unknown as typeof chapters,
      }),
    ).toBe('current')
    expect(
      catalogChapterBadge({
        status: 'ready',
        chapterId: 'c1',
        progressChapterId: 'c2',
        chapters: undefined as unknown as typeof chapters,
      }),
    ).toBeNull()
  })

  it('marks an auto-unlocked chapter with its own badge, ahead of current/read', () => {
    const chapters = [{ id: 'c1' }, { id: 'c2' }]
    expect(
      catalogChapterBadge({
        status: 'ready',
        chapterId: 'c1',
        currentChapterId: 'c1',
        progressChapterId: 'c2',
        chapters,
        unlockedBy: 'api',
      }),
    ).toBe('unlocked')
    expect(
      catalogChapterBadge({ status: 'ready', chapterId: 'c1', chapters, unlockedBy: 'hiddenDom' }),
    ).toBe('unlocked')
    // 失败/未下/空仍然优先，正文都不在就别谈来源
    expect(
      catalogChapterBadge({ status: 'failed', chapterId: 'c1', chapters, unlockedBy: 'api' }),
    ).toBe('failed')
    expect(
      catalogChapterBadge({ status: 'ready', chapterId: 'c1', chapters }),
    ).toBeNull()
  })
})

describe('chapterScrollRatio 尺寸未测出时', () => {
  it('treats a zero-sized pane as unknown instead of 读完', () => {
    // 章刚切进去、元素还没量出尺寸：不能算读到章末
    expect(chapterScrollRatio(0, 0, 0)).toBe(0)
    // 量出来了但整章只有一屏：确实看到底了
    expect(chapterScrollRatio(0, 600, 600)).toBe(1)
  })
})
