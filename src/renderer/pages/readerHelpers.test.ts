import { describe, expect, it } from 'vitest'
import type { ReaderFocusMode } from '@shared/types'
import {
  approximateBookRatio,
  chapterScrollRatio,
  failAdvice,
  focusHalfWindow,
  formatCharacterCard,
  isParagraphInFocus,
  remainingChapterCount,
  readerScrollBehavior,
  resolveFocusAnchor,
  resolveImmersiveKey,
  resolveReaderKey,
  scrollableDistance,
  shouldAutoHideReaderTools,
  scrollTopFromRatio,
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
    expect(chapterScrollRatio(100, 800, 800)).toBe(0)
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

describe('failAdvice', () => {
  it('stays silent for codes without advice', () => {
    expect(failAdvice(undefined)).toBe('')
    expect(failAdvice('CatalogNotFound')).toBe('')
  })
})

describe('formatCharacterCard', () => {
  it('renders characters and foreshadows with chapter label', () => {
    const text = formatCharacterCard(
      {
        uptoChapterId: 'c0003',
        characters: [{ name: '张若尘', role: '主角', relations: '池瑶的未婚夫' }],
        foreshadows: [{ desc: '九转轮回诀', where: '第一章', open: true }],
      },
      (id) => (id === 'c0003' ? '第 3 章 入门' : id),
    )
    expect(text).toContain('截至：第 3 章 入门')
    expect(text).toContain('【人物】')
    expect(text).toContain('· 张若尘 （主角）；池瑶的未婚夫')
    expect(text).toContain('【伏笔】')
    expect(text).toContain('九转轮回诀（首次出现：第一章） [未回收]')
  })

  it('falls back to raw output when nothing parsed', () => {
    expect(formatCharacterCard({ raw: '模型直接写的文字' })).toBe('模型直接写的文字')
    expect(formatCharacterCard({})).toBe('（人物卡为空）')
  })
})
