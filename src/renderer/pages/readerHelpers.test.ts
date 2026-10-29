import { describe, expect, it } from 'vitest'
import type { ReaderFocusMode } from '@shared/types'
import { scrollTopForParagraphPage, snapScrollTopToParagraph } from './readerPager'
import {
  approximateBookRatio,
  approximateBookRatioFromIndex,
  catalogChapterBadge,
  chapterScrollRatio,
  failAdvice,
  focusHalfWindow,
  chapterIndexFromBookRatio,
  isParagraphInFocus,
  paragraphIndexAtViewportCenter,
  progressScrubLabel,
  progressScrubTarget,
  remainingChapterCount,
  readerScrollBehavior,
  resolveFocusAnchor,
  readerContentZone,
  readerTapCanPage,
  resolveImmersiveKey,
  resolveReaderKey,
  scrollableDistance,
  selectionPopupPosition,
  shouldAutoHideReaderTools,
  shouldResetReaderToolsOnEntry,
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

  it('re-collapses reader tools only when the page becomes visible again', () => {
    // 首次观测（还没登记过）不是重入，不能顺手收起。
    expect(shouldResetReaderToolsOnEntry(null, true)).toBe(false)
    expect(shouldResetReaderToolsOnEntry(null, false)).toBe(false)
    // 离开再回来才是进入阅读页。
    expect(shouldResetReaderToolsOnEntry(false, true)).toBe(true)
    // 常驻可见期间不打断正在阅读的人。
    expect(shouldResetReaderToolsOnEntry(true, true)).toBe(false)
    expect(shouldResetReaderToolsOnEntry(true, false)).toBe(false)
    expect(shouldResetReaderToolsOnEntry(false, false)).toBe(false)
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

describe('reader content tap zones', () => {
  const box = { contentLeft: 100, contentWidth: 300 }

  it('splits the content box into left, center, and right thirds', () => {
    expect(readerContentZone({ clientX: 100, ...box })).toBe('left')
    expect(readerContentZone({ clientX: 199.9, ...box })).toBe('left')
    expect(readerContentZone({ clientX: 200, ...box })).toBe('center')
    expect(readerContentZone({ clientX: 299.9, ...box })).toBe('center')
    expect(readerContentZone({ clientX: 300, ...box })).toBe('right')
    expect(readerContentZone({ clientX: 400, ...box })).toBe('right')
  })

  it('ignores clicks on controls and an uncollapsed selection', () => {
    const button = { closest: (selector: string) => (selector.includes('button') ? {} : null) } as unknown as Element
    expect(readerContentZone({ clientX: 250, ...box, target: button })).toBeNull()
    expect(readerContentZone({ clientX: 250, ...box, selectionCollapsed: false })).toBeNull()
    expect(readerContentZone({ clientX: 99, ...box })).toBeNull()
    expect(readerContentZone({ clientX: 401, ...box })).toBeNull()
  })

  it('stops at the chapter edges instead of turning the page', () => {
    expect(readerTapCanPage({ zone: 'left', scrollTop: 0, scrollHeight: 2000, clientHeight: 800 })).toBe(false)
    expect(readerTapCanPage({ zone: 'left', scrollTop: 9, scrollHeight: 2000, clientHeight: 800 })).toBe(true)
    expect(readerTapCanPage({ zone: 'right', scrollTop: 1193, scrollHeight: 2000, clientHeight: 800 })).toBe(false)
    expect(readerTapCanPage({ zone: 'right', scrollTop: 1192, scrollHeight: 2000, clientHeight: 800 })).toBe(true)
    expect(readerTapCanPage({ zone: 'right', scrollTop: 1191, scrollHeight: 2000, clientHeight: 800 })).toBe(true)
    expect(readerTapCanPage({ zone: 'center', scrollTop: 400, scrollHeight: 2000, clientHeight: 800 })).toBe(false)
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

describe('进度条按章拖动', () => {
  const chapters = [
    { id: 'c1', index: 1, title: '开篇' },
    { id: 'c2', index: 2, title: '风起' },
    { id: 'c3', index: 3, title: '落潮' },
  ]

  it('maps a book ratio onto the chapter the bar points at', () => {
    expect(chapterIndexFromBookRatio(0, 3)).toBe(0)
    expect(chapterIndexFromBookRatio(0.33, 3)).toBe(0)
    expect(chapterIndexFromBookRatio(1 / 3, 3)).toBe(1)
    expect(chapterIndexFromBookRatio(0.5, 3)).toBe(1)
    expect(chapterIndexFromBookRatio(2 / 3, 3)).toBe(2)
    expect(chapterIndexFromBookRatio(1, 3)).toBe(2)
    // 反向验证：映射回来的章首比例必须落在该章自己的区间里
    for (const ratio of [0, 0.2, 0.34, 0.5, 0.67, 0.9]) {
      const index = chapterIndexFromBookRatio(ratio, 3)
      expect(approximateBookRatioFromIndex(index, 3, 0)).toBeLessThanOrEqual(ratio + 1e-9)
      expect(approximateBookRatioFromIndex(index + 1, 3, 0)).toBeGreaterThan(ratio)
    }
  })

  it('survives degenerate inputs without inventing a chapter', () => {
    expect(chapterIndexFromBookRatio(0.5, 0)).toBe(-1)
    expect(chapterIndexFromBookRatio(0.5, Number.NaN)).toBe(-1)
    expect(chapterIndexFromBookRatio(Number.NaN, 3)).toBe(0)
    expect(chapterIndexFromBookRatio(-3, 3)).toBe(0)
    expect(chapterIndexFromBookRatio(9, 3)).toBe(2)
    expect(progressScrubTarget([], 0.5)).toBeNull()
    // clampRatio 把非有限值收成 0：拖拽坐标不可能真是 Infinity，落首章即可
    expect(progressScrubTarget(chapters, Number.POSITIVE_INFINITY)?.chapter.id).toBe('c1')
  })

  it('drops onto the start of the target chapter', () => {
    expect(progressScrubTarget(chapters, 0)?.chapter.id).toBe('c1')
    expect(progressScrubTarget(chapters, 0.5)?.chapter.id).toBe('c2')
    expect(progressScrubTarget(chapters, 1)?.chapter.id).toBe('c3')
    // 松手一律落章首：拖到 96% 也不能把读者丢进章尾
    expect(progressScrubTarget(chapters, 0.96)?.scrollRatio).toBe(0)
    expect(progressScrubTarget(chapters, 0.5)?.index).toBe(1)
    for (const ratio of [0, 0.1, 0.5, 0.77, 1]) {
      expect(progressScrubTarget(chapters, ratio)?.scrollRatio).toBe(0)
    }
  })

  it('labels the floating hint with chapter ordinal and title', () => {
    expect(progressScrubLabel(chapters[1], 1)).toBe('第 2 章 · 风起')
    expect(progressScrubLabel({ id: 'c9', index: 9, title: '   ' }, 8)).toBe('第 9 章')
    expect(progressScrubLabel({ id: 'raw-id', index: 0, title: '无序号' }, 0)).toBe('第 1 章 · 无序号')
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

// U1.3 —— 屏幕翻页对齐段落边界。视口统一 800px；top/bottom 相对正文内容顶。
const PAGER_PARAS = [
  { top: 0, bottom: 300 },
  { top: 300, bottom: 700 },
  { top: 700, bottom: 900 },
  { top: 900, bottom: 1200 },
  { top: 1200, bottom: 1500 },
]

describe('scrollTopForParagraphPage 短段对齐', () => {
  it('lands on the top of the paragraph the next screen would cut in half', () => {
    // 朴素整屏落点 800 会把 [700, 900] 拦腰切开
    const target = scrollTopForParagraphPage({
      paragraphs: PAGER_PARAS, scrollTop: 0, clientHeight: 800, scrollHeight: 3000, direction: 1,
    })
    expect(target).toBe(700)
    // 该段第一句在新屏顶部完整可见：段首就是视口顶
    expect(PAGER_PARAS[2]!.top).toBe(target)
    expect(PAGER_PARAS[2]!.bottom).toBeLessThanOrEqual(target + 800)
  })

  it('snaps to the next paragraph start when the screen bottom lands in the gap', () => {
    const paragraphs = [{ top: 0, bottom: 300 }, { top: 800, bottom: 1000 }]
    expect(scrollTopForParagraphPage({
      paragraphs, scrollTop: 0, clientHeight: 800, scrollHeight: 3000, direction: 1,
    })).toBe(800)
  })

  it('falls back to a plain screen when there is no paragraph info', () => {
    expect(scrollTopForParagraphPage({
      paragraphs: [], scrollTop: 0, clientHeight: 800, scrollHeight: 3000, direction: 1,
    })).toBe(800)
  })
})

describe('scrollTopForParagraphPage 超长段不跳过', () => {
  // 第二段 2000px > 一屏 800px
  const paragraphs = [{ top: 0, bottom: 400 }, { top: 400, bottom: 2400 }, { top: 2400, bottom: 2700 }]

  it('advances at most one screen inside an over-long paragraph', () => {
    const first = scrollTopForParagraphPage({ paragraphs, scrollTop: 400, clientHeight: 800, scrollHeight: 3000, direction: 1 })
    expect(first).toBe(1200)
    expect(first - 400).toBeLessThanOrEqual(800)
    const second = scrollTopForParagraphPage({ paragraphs, scrollTop: 1200, clientHeight: 800, scrollHeight: 3000, direction: 1 })
    expect(second - 1200).toBeLessThanOrEqual(800)
    expect(second).toBe(1600)
  })

  it('leaves no text of the long paragraph unread before moving on', () => {
    // 1600 起视口覆盖到段尾 2400，剩余文字全看过；再前进落到下一段段首
    const next = scrollTopForParagraphPage({ paragraphs, scrollTop: 1600, clientHeight: 800, scrollHeight: 3500, direction: 1 })
    expect(next).toBe(2400)
    expect(paragraphs[2]!.top).toBe(next)
  })
})

describe('scrollTopForParagraphPage 向上落段首', () => {
  it('bounces a mid-paragraph landing up to that paragraph start', () => {
    expect(scrollTopForParagraphPage({
      paragraphs: PAGER_PARAS, scrollTop: 1400, clientHeight: 800, scrollHeight: 3000, direction: -1,
    })).toBe(300)
    expect(scrollTopForParagraphPage({
      paragraphs: PAGER_PARAS, scrollTop: 1500, clientHeight: 800, scrollHeight: 3000, direction: -1,
    })).toBe(700)
  })

  it('retreats a single screen inside an over-long paragraph instead of its start', () => {
    const paragraphs = [{ top: 0, bottom: 400 }, { top: 400, bottom: 2400 }]
    const target = scrollTopForParagraphPage({ paragraphs, scrollTop: 1600, clientHeight: 800, scrollHeight: 3000, direction: -1 })
    expect(target).toBe(800)
    expect(1600 - target).toBeLessThanOrEqual(800)
  })

  it('stops at the chapter start instead of going negative', () => {
    expect(scrollTopForParagraphPage({ paragraphs: PAGER_PARAS, scrollTop: 0, clientHeight: 800, scrollHeight: 3000, direction: -1 })).toBe(0)
    expect(scrollTopForParagraphPage({ paragraphs: PAGER_PARAS, scrollTop: 200, clientHeight: 800, scrollHeight: 3000, direction: -1 })).toBe(0)
  })
})

describe('snapScrollTopToParagraph 回吸不跨屏', () => {
  const paragraphs = [{ top: 0, bottom: 400 }, { top: 400, bottom: 2400 }, { top: 2400, bottom: 2700 }]

  it('keeps the current position inside an over-long paragraph', () => {
    expect(snapScrollTopToParagraph(paragraphs, 1300, 2, 800)).toBe(1300)
  })

  it('pulls a half-shown short paragraph back to its start', () => {
    expect(snapScrollTopToParagraph(paragraphs, 2420, 2, 800)).toBe(2400)
    expect(snapScrollTopToParagraph(paragraphs, 250, 2, 800)).toBe(0)
  })
})
