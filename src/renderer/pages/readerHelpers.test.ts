import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReaderFocusMode } from '@shared/types'
import { scrollTopForParagraphPage, snapScrollTopToParagraph } from './readerPager'
import { ttsBodyHash } from './ttsPosition'
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
  progressAnchorBodyMatches,
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
  isCurrentBookDownloading,
  isDownloadJustSettled,
  resolveDownloadToolsPolicy,
  shouldRevealToolsForPreference,
  scrollTopFromRatio,
  wheelPageDirection,
} from './readerHelpers'
import {
  isSiteTailParagraph,
  matchSiteTailRule,
  normalizeTailText,
  visibleParagraphIndexes,
} from './readerTail'

/** 覆盖 scheme「内置整段规则」R1–R5 与反例（U1.4 渲染层整段尾巴净化）。 */
describe('readerTail 内置整段尾巴规则', () => {
  it('R1 整段同时含「请收藏」与「本站」时整段不渲染', () => {
    expect(matchSiteTailRule('请收藏本站，下次不迷路')).toBe('R1')
    expect(isSiteTailParagraph('请收藏本站，下次不迷路')).toBe(true)
  })

  it('R2 整段同时含「请收藏」与「网址」时整段不渲染', () => {
    expect(matchSiteTailRule('请收藏我们的网址，随时续读')).toBe('R2')
    expect(isSiteTailParagraph('请收藏我们的网址，随时续读')).toBe(true)
  })

  it('R3 整段同时含「请收藏」与「地址」时整段不渲染', () => {
    expect(matchSiteTailRule('请收藏我们的地址，方便下次访问')).toBe('R3')
    expect(isSiteTailParagraph('请收藏我们的地址，方便下次访问')).toBe(true)
  })

  it('R4 以「最新网址」「最新地址」「手机用户请」「本章未完」之一开头时整段不渲染', () => {
    expect(matchSiteTailRule('最新网址：xsxz.example')).toBe('R4')
    expect(matchSiteTailRule('最新地址：xsxz.example')).toBe('R4')
    expect(matchSiteTailRule('手机用户请使用浏览器打开')).toBe('R4')
    expect(matchSiteTailRule('本章未完，点击下一页继续阅读')).toBe('R4')
  })

  it('R5 整段是纯网址或 www 开头时整段不渲染', () => {
    expect(matchSiteTailRule('https://xsxz.example/book/1')).toBe('R5')
    expect(matchSiteTailRule('http://xsxz.example')).toBe('R5')
    expect(matchSiteTailRule('www.xsxz.example')).toBe('R5')
  })

  it('叙述段「请收藏这封信」不命中任何规则，仍然渲染', () => {
    const narration = '请收藏这封信'
    expect(matchSiteTailRule(narration)).toBeNull()
    expect(isSiteTailParagraph(narration)).toBe(false)
    expect(visibleParagraphIndexes(['正文一。', narration, '正文二。'], { hideTail: true })).toEqual([0, 1, 2])
  })

  it('判断前删除段内全部 Unicode 空白再整段判断', () => {
    expect(normalizeTailText('  请 收藏\t本 站\n')).toBe('请收藏本站')
    expect(matchSiteTailRule('请  收藏\u3000本站')).toBe('R1')
    expect(matchSiteTailRule('  HTTP://XSXZ.EXAMPLE  ')).toBe('R5')
  })

  it('同一段里两句分别带「请收藏」和「本站」且中间无空行，算命中 R1', () => {
    expect(matchSiteTailRule('记得请收藏。本站每天更新')).toBe('R1')
  })

  it('不含两个关键词、不以 R4 开头、不是纯网址的段不隐藏', () => {
    expect(isSiteTailParagraph('他合上本站的旧书，走进雨里。')).toBe(false)
    expect(isSiteTailParagraph('这是最新网址吗？她问道。')).toBe(false)
    expect(isSiteTailParagraph('详见 https://xsxz.example/book/1 这一章')).toBe(false)
    expect(isSiteTailParagraph('')).toBe(false)
  })

  it('过滤只去掉命中段的元素，保留下标仍是原始段落索引', () => {
    const paragraphs = [
      '正文一。',
      '请收藏本站，下次不迷路',
      '正文二。',
      'www.xsxz.example',
      '正文三。',
      '最新网址：xsxz.example',
    ]
    expect(visibleParagraphIndexes(paragraphs, { hideTail: true })).toEqual([0, 2, 4])
    expect(visibleParagraphIndexes(paragraphs).length).toBe(3)
    expect(paragraphs[2]).toBe('正文二。')
  })

  it('关掉净化时返回全部原始下标，原文段一个不少', () => {
    expect(visibleParagraphIndexes(['正文一。', '请收藏本站', '正文二。'], { hideTail: false })).toEqual([0, 1, 2])
  })
})

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

/** 覆盖完成定义 6：下载 running 时顶栏自动可见，结束后自动收起。 */
describe('reader download tools policy', () => {
  const running = { status: 'running', bookId: 'book-1' }
  const done = { status: 'done', bookId: 'book-1' }
  const cancelled = { status: 'cancelled', bookId: 'book-1' }
  const errored = { status: 'error', bookId: 'book-1' }

  it('running 时自动可见：不必等用户点正文', () => {
    // 从「没有进度」直接进 running，也要立刻露出顶栏。
    expect(resolveDownloadToolsPolicy({ previous: null, next: running, currentBookId: 'book-1', intent: 'untouched' }))
      .toEqual({ visible: true, intent: 'untouched' })
    // 进度 tick（running → running）保持可见，不抖动。
    expect(resolveDownloadToolsPolicy({ previous: running, next: running, currentBookId: 'book-1', intent: 'untouched' }))
      .toEqual({ visible: true, intent: 'untouched' })
    // 撞到登录/付费页暂停等人工时，进度与取消仍要看得见。
    const awaiting = { status: 'awaitingHuman', bookId: 'book-1' }
    expect(resolveDownloadToolsPolicy({ previous: running, next: awaiting, currentBookId: 'book-1', intent: 'untouched' }).visible).toBe(true)
    expect(isCurrentBookDownloading(awaiting, 'book-1')).toBe(true)
  })

  it('结束后自动收起：done / error / cancelled 三种结束态都收', () => {
    expect(resolveDownloadToolsPolicy({ previous: running, next: done, currentBookId: 'book-1', intent: 'untouched' }).visible).toBe(false)
    expect(resolveDownloadToolsPolicy({ previous: running, next: errored, currentBookId: 'book-1', intent: 'untouched' }).visible).toBe(false)
    expect(resolveDownloadToolsPolicy({ previous: running, next: cancelled, currentBookId: 'book-1', intent: 'untouched' }).visible).toBe(false)
    // 收起后把意图归零，下一次下载重新由自动逻辑决定。
    expect(resolveDownloadToolsPolicy({ previous: running, next: done, currentBookId: 'book-1', intent: 'untouched' }).intent).toBe('untouched')
  })

  it('只认当前书：别的书在下载不动这本书的顶栏', () => {
    const other = { status: 'running', bookId: 'book-2' }
    expect(isCurrentBookDownloading(other, 'book-1')).toBe(false)
    expect(resolveDownloadToolsPolicy({ previous: null, next: other, currentBookId: 'book-1', intent: 'untouched' }))
      .toEqual({ visible: null, intent: 'untouched' })
    expect(resolveDownloadToolsPolicy({ previous: other, next: done, currentBookId: 'book-1', intent: 'untouched' }).visible).toBeNull()
    // 没选中任何书时不下结论。
    expect(isCurrentBookDownloading(running, null)).toBe(false)
  })

  it('running 期间手动收起/展开都算数，自动逻辑不再抢', () => {
    // 用户手动收起后，后续进度 tick 不再把顶栏顶回来。
    expect(resolveDownloadToolsPolicy({ previous: running, next: running, currentBookId: 'book-1', intent: 'collapsed' }))
      .toEqual({ visible: null, intent: 'collapsed' })
    // 用户手动展开过，下载结束后保留他的选择。
    expect(resolveDownloadToolsPolicy({ previous: running, next: done, currentBookId: 'book-1', intent: 'revealed' }))
      .toEqual({ visible: null, intent: 'untouched' })
  })

  it('本来就没在跑不算结束，不误收顶栏', () => {
    expect(isDownloadJustSettled(null, done, 'book-1')).toBe(false)
    expect(resolveDownloadToolsPolicy({ previous: null, next: done, currentBookId: 'book-1', intent: 'untouched' }).visible).toBeNull()
    expect(resolveDownloadToolsPolicy({ previous: done, next: done, currentBookId: 'book-1', intent: 'untouched' }).visible).toBeNull()
  })

  it('阅读页把自动露出挂进进页面路径，并用中性文案展示进度', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    // 进页面收起后立刻按下载状态露出：不依赖用户点正文。
    const collapse = source.slice(source.indexOf('function collapseToolsForEntry'), source.indexOf('function currentDownloadSignal'))
    expect(collapse).toContain('revealToolsForDownload()')
    // loadBook 里设好 book 就判一次，覆盖「在阅读页内切到正在下载的书」。
    const loadBook = source.slice(source.indexOf('async function loadBook'), source.indexOf('async function openChapter'))
    expect(loadBook).toContain('revealToolsForDownload()')
    // 顶栏进度与取消用同一个判定，且带稳定钩子供端到端定位。
    expect(source).toContain('<template v-if="isCurrentBookDownloading(downloadProgress, book.id)">')
    expect(source).toContain('data-reader-dl="progress"')
    expect(source).toContain('data-reader-dl="cancel"')
    expect(source).toContain('已下 {{ downloadProgress!.done }} / {{ downloadProgress!.total }} 章')
  })
})

/** U1.6：字体面板「净化」与「工具一直显示」两个开关的语义方向。 */
describe('reader prefs switches (hideSiteTail / hideReaderChrome)', () => {
  it('工具一直显示只由 hideReaderChrome === false 成立，缺字段按收起', () => {
    expect(shouldRevealToolsForPreference(false)).toBe(true)
    expect(shouldRevealToolsForPreference(true)).toBe(false)
    expect(shouldRevealToolsForPreference(undefined)).toBe(false)
    expect(shouldRevealToolsForPreference(null)).toBe(false)
  })

  it('净化开关直连 hideSiteTail：开着净化才藏整段尾巴', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    // 净化 = hideSiteTail 正向：true 才净；关掉即整段显示。
    expect(source).toContain('const tailPurgeOffForChapter = computed(() => !hideSiteTail.value || showRawThisChapter.value)')
    // 两开关文案严格用 COPY-1 / COPY-3，方向不写反。
    expect(source).toContain('<n-switch v-model:value="hideSiteTail" /> 净化')
    expect(source).toContain('<n-switch v-model:value="alwaysShowTools" /> 工具一直显示')
    // 「工具一直显示」是反义字段：开 = hideReaderChrome false。
    expect(source).toContain('get: () => hideReaderChrome.value === false')
    expect(source).toContain('set: (value: boolean) => { hideReaderChrome.value = value !== true }')
    // 两个字段都进持久偏好快照，读回时缺字段按缺省 true。
    const prefs = source.slice(source.indexOf('function currentReaderPrefs'), source.indexOf('async function saveReaderPrefsSnapshot'))
    expect(prefs).toContain('hideSiteTail: hideSiteTail.value')
    expect(prefs).toContain('hideReaderChrome: hideReaderChrome.value')
    expect(source).toContain('hideSiteTail.value = s.reader.hideSiteTail ?? DEFAULT_READER_PREFS.hideSiteTail ?? true')
    expect(source).toContain('hideReaderChrome.value = s.reader.hideReaderChrome ?? DEFAULT_READER_PREFS.hideReaderChrome ?? true')
    // 进页面先让下载 running 露出，再让偏好常显生效；running 优先。
    const collapse = source.slice(source.indexOf('function collapseToolsForEntry'), source.indexOf('function currentDownloadSignal'))
    expect(collapse.indexOf('revealToolsForDownload()')).toBeLessThan(collapse.indexOf('revealToolsForPreference()'))
    // 「本章显示原文」仍是内存态，不因这次接线进设置。
    expect(prefs).not.toContain('showRawThisChapter')
    // 正文仍纯文本渲染。
    expect(source).not.toContain('v-html')
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

describe('progressAnchorBodyMatches 锚点正文指纹校验', () => {
  it('缺省 bodyHash（旧书）跳过校验，保持锚点恢复兼容', () => {
    expect(progressAnchorBodyMatches(undefined, '第一段\n\n第二段')).toBe(true)
  })

  it('bodyHash 与当前正文指纹一致时放行', () => {
    const body = '第一段\n\n第二段'
    expect(progressAnchorBodyMatches(ttsBodyHash(body), body)).toBe(true)
  })

  it('正文被清理/重下后指纹不一致，拒绝按旧锚点恢复', () => {
    const oldBody = '第一段\n\n第二段'
    const newBody = '第一段\n\n替换后的第二段'
    expect(progressAnchorBodyMatches(ttsBodyHash(oldBody), newBody)).toBe(false)
  })

  it('正文被替换但段数相同（最危险形态）也会被指纹识破', () => {
    const oldBody = Array.from({ length: 200 }, (_, i) => `旧第${i + 1}段`).join('\n\n')
    const newBody = Array.from({ length: 200 }, (_, i) => `新第${i + 1}段`).join('\n\n')
    expect(progressAnchorBodyMatches(ttsBodyHash(oldBody), newBody)).toBe(false)
  })
})
