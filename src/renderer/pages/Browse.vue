<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NProgress, NTag, useMessage } from 'naive-ui'
import { DEFAULT_READER_PREFS, DEFAULT_TTS_PREFS, DEFAULT_WEB_READING_PREFS } from '@shared/types'
import { READER_THEME_COLORS } from '@shared/readerTheme'
import type { BrowseReadingPage, BrowseState, BrowseFindResult, DownloadPreview, DownloadProgress, FailCode, PreviewPageKind, ReaderPrefs, WebAnnotation, WebReadingPrefs, WebShelfChapter } from '@shared/types'
import { adjacentVisualPage, scrollTopForVisualPage, visualPageCount, visualPageIndex, visualPageLabel } from './readerPager'
import { approximateBookRatioFromIndex, clampRatio, paragraphIndexAtViewportCenter, readerScrollBehavior, selectionPopupPosition, shouldAutoHideReaderTools, wheelPageDirection } from './readerHelpers'
import { autoScrollSpeedPx, createAutoScroll } from './readingAutoScroll'
import { selectionRangeOffsets } from './selectionOffsets'
import { decorateText } from '@shared/paragraphSearch'
import { relocateRange } from '@shared/paragraphSearch'
import { useTts } from './useTts'

const props = defineProps<{
  active?: boolean
  prefillUrl?: string
  prefillNonce?: number
  /** 网页书架续读：预填地址后直接进阅读模式。 */
  prefillReading?: boolean
}>()

const emit = defineEmits<{
  (e: 'open-book', bookId: string): void
  (e: 'edit-site-rule', host: string): void
}>()
const message = useMessage()

const address = ref('')
const state = ref<BrowseState>({
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  zoom: 1,
})
const toolbarCollapsed = ref(false)
const readingPage = ref<BrowseReadingPage | null>(null)
const readingBusy = ref(false)
const readerPrefs = ref<ReaderPrefs>(DEFAULT_READER_PREFS)
const webReading = ref<WebReadingPrefs>(DEFAULT_WEB_READING_PREFS)
const readingPanel = ref(false)
const readingStage = ref<HTMLElement | null>(null)
const readingViewport = ref<HTMLElement | null>(null)
const readingPageIndex = ref(0)
const readingPageCount = ref(1)
const readingRatio = ref(0)
const readingCenterParagraph = ref(-1)
const readingChapterTitle = ref('')
/** 网页阅读模式的标注（划线/书签/备注）：归属键是当前章的规范化地址。 */
const webMarks = ref<WebAnnotation[]>([])
const webMarkLostIds = ref<Set<string>>(new Set())
const marksOpen = ref(false)
const markNoteEditingId = ref('')
const markNoteDraft = ref('')
/** 选区工具条：选中正文后浮出，提供 复制/划线/备注/翻译/问 AI。 */
const selPopup = ref<{ x: number; y: number; excerpt: string; range: { start: number; end: number; text: string } } | null>(null)
const noteEditorOpen = ref(false)
const noteEditorDraft = ref('')
/** 书内搜索：在当前章正文里找，命中高亮并可上下跳。 */
const inBookFindOpen = ref(false)
const inBookFindQuery = ref('')
const inBookFindIndex = ref(0)
/** AI 选区结果（翻译/解释）：只在网页阅读模式里用，不落盘。 */
const webAiResult = ref('')
const webAiTitle = ref('')
const webAiLoading = ref(false)
let webAiJobId = ''
/** 网页阅读模式的「AI」面板：说明就地可用什么、跨章 AI 要怎么拿到。 */
const webAiPanelOpen = ref(false)
/**
 * 当前网页书是否已在书库里。网页书架 id 与下载书 id 都由 `canonicalBookId(host, catalogUrl)`
 * 派生，同一本书两条路径得到同一个 id，所以直接拿书库列表比对即可，不必为此加 IPC。
 */
const webBookDownloadedId = ref<string | null>(null)
const webBookDownloadChecked = ref(false)
const readingToolsVisible = ref(true)
const catalogOpen = ref(false)
const catalogChapters = ref<WebShelfChapter[]>([])
const catalogIndex = ref(-1)
const catalogBusy = ref(false)
const catalogListEl = ref<HTMLElement | null>(null)
const autoScrolling = ref(false)
const shelfSaving = ref(false)
const ttsRate = ref(DEFAULT_TTS_PREFS.rate)
const ttsAutoNext = ref(DEFAULT_TTS_PREFS.autoNextChapter)
const ttsSource = ref<'system' | 'online'>(DEFAULT_TTS_PREFS.source)
const ttsVoiceURI = ref(DEFAULT_TTS_PREFS.systemVoiceURI)
let readingHideTimer: ReturnType<typeof setTimeout> | null = null
let readingToolsLocked = false
let lastToolActivityAt = Date.now()
let readingSaveTimer: ReturnType<typeof setTimeout> | null = null
let readingRestoreTimer: ReturnType<typeof setTimeout> | null = null
let readingParagraphIndex = 0
/** 位置恢复期间不写回，避免把恢复动作当成用户滚动。 */
let readingRestoring = false
let autoScrollRaf: number | null = null
let lastAutoTickAt = 0
const findOpen = ref(false)
const findQuery = ref('')
const findInput = ref<HTMLInputElement | null>(null)
const findResult = ref<BrowseFindResult>({ matches: 0, activeMatch: 0 })
const hidePicking = ref(false)
const hiddenCount = ref(0)
let resumeAttempted = false
const resumeError = ref('')
let browseUrlForHide = ''
let hideCountTimer: ReturnType<typeof setInterval> | null = null
const readingStyle = computed(() => {
  const p = readerPrefs.value
  const colors = READER_THEME_COLORS[p.theme]
  return {
    '--web-paper': colors.paper,
    '--web-ink': colors.text,
    '--web-outer': colors.outer,
    '--web-font': p.fontFamily === 'serif' ? '"STSong", "Songti SC", "SimSun", serif' : p.fontFamily === 'mono' ? '"Cascadia Mono", "Consolas", monospace' : '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    '--web-width': p.contentWidth === 'narrow' ? '32em' : p.contentWidth === 'wide' ? '46em' : '38em',
    '--web-size': `${p.fontSize}px`,
    '--web-line': String(p.lineHeight),
    '--web-spacing': p.paragraphSpacing === 'compact' ? '0.2em' : p.paragraphSpacing === 'relaxed' ? '0.8em' : '0.45em',
    '--web-indent': p.paragraphIndent ? '2em' : '0',
  }
})
const readingParagraphs = computed(() => readingPage.value?.body.split(/\n\s*\n/).filter(Boolean) ?? [])
/** 规范化正文（段落以空行连接）：标注坐标与选区换算的坐标空间，与本地阅读器一致。 */
const readingNormalizedBody = computed(() => readingParagraphs.value.join('\n\n'))
/** 每段在规范化正文里的起始下标。 */
const readingParagraphStarts = computed(() => {
  const starts: number[] = []
  let acc = 0
  for (const paragraph of readingParagraphs.value) {
    starts.push(acc)
    acc += paragraph.length + 2
  }
  return starts
})
/** 当前章的标注键（规范化地址）；没有阅读页时为空串。 */
const currentMarkUrl = computed(() => readingPage.value?.url ?? '')
/** 本章有效的划线区间（漂移校正后仍找不到的会标记为丢失）。 */
const currentWebHighlights = computed(() => {
  if (!currentMarkUrl.value) return []
  const body = readingNormalizedBody.value
  const out: Array<{ start: number; end: number }> = []
  for (const item of webMarks.value) {
    if (item.kind !== 'highlight' || webMarkLostIds.value.has(item.id)) continue
    const relocated = relocateRange(body, item.start, item.end, item.excerpt)
    if (relocated) out.push(relocated)
    else webMarkLostIds.value.add(item.id)
  }
  return out
})
/** 每段内的划线区间（段内坐标），供 decorateText 叠加高亮。 */
function paragraphHighlightRanges(index: number): Array<{ start: number; end: number }> {
  const start = readingParagraphStarts.value[index] ?? 0
  const len = readingParagraphs.value[index]?.length ?? 0
  return currentWebHighlights.value
    .map((r) => ({ start: Math.max(0, r.start - start), end: Math.min(len, r.end - start) }))
    .filter((r) => r.end > r.start)
}
/** 段落渲染切片：叠加书内搜索命中与划线。 */
function readingParagraphSegments(index: number) {
  return decorateText(readingParagraphs.value[index] ?? '', inBookFindQuery.value, paragraphHighlightRanges(index))
}
/** 书内搜索命中段（用于上下跳）。 */
const inBookFindHits = computed(() => {
  const q = inBookFindQuery.value.trim().toLowerCase()
  if (!q) return [] as number[]
  return readingParagraphs.value
    .map((paragraph, index) => (paragraph.toLowerCase().includes(q) ? index : -1))
    .filter((index) => index >= 0)
})
const readingPaged = computed(() => readerPrefs.value.readingMode === 'screen')
const readingChapter = computed(() => readingPage.value?.chapter ?? null)
/** 上一章 / 下一章：阅读页上下文优先，找不到时退回可见网页识别到的链接。 */
const canPrevChapter = computed(() => Boolean(readingChapter.value?.previous || state.value.previousChapter))
const canNextChapter = computed(() => Boolean(readingChapter.value?.next || state.value.nextChapter))
const readingChapterLabel = computed(() => readingChapterTitle.value || readingPage.value?.title || '')
const autoScrollSpeed = computed(() => autoScrollSpeedPx(webReading.value.autoSpeed))
/**
 * 全书比例（章节等权估算），与本地阅读器同一个公式。
 *
 * 目录没拿到时返回 null：宁可不显示，也不拿「不知道总共几章」猜一个百分比给读者。
 */
const readingBookRatio = computed(() => {
  const chapter = readingChapter.value
  const total = chapter?.total ?? catalogChapters.value.length
  const index = chapter?.index ?? catalogIndex.value
  if (index < 0 || !total) return null
  return approximateBookRatioFromIndex(index, total, readingRatio.value)
})
const readingProgressLabel = computed(() => {
  const chapter = readingChapter.value
  // 章节序号优先用主进程从网页书架快照算出的，拿不到时退回后台目录的定位结果
  const total = chapter?.total ?? catalogChapters.value.length
  const index = chapter?.index ?? catalogIndex.value
  const position = index >= 0 && total ? `第 ${index + 1}/${total} 章` : ''
  const book = readingBookRatio.value === null ? '' : `全书 ${Math.round(readingBookRatio.value * 100)}%`
  if (readingPaged.value) return [position, visualPageLabel(readingPageIndex.value, readingPageCount.value), book].filter(Boolean).join(' · ')
  return [position, `本章 ${Math.round(readingRatio.value * 100)}%`, book].filter(Boolean).join(' · ')
})
watch(findOpen, (open) => { if (open) void nextTick(() => findInput.value?.focus()) })
const slot = ref<HTMLElement | null>(null)
let ro: ResizeObserver | null = null
const unsubs: Array<() => void> = []

// Download state
const downloading = ref(false)
const retryingFailed = ref(false)
const downloadProgress = ref<DownloadProgress | null>(null)
const showProgress = ref(false)
const showPreview = ref(false)
const previewing = ref(false)
const downloadPreview = ref<DownloadPreview | null>(null)
const previewFailure = ref<{ message: string; pageKind: PreviewPageKind; code?: FailCode } | null>(null)
const adFilterEnabled = ref(true)
const adFilterBusy = ref(false)
let lastAdHost = ''

const canOpenDownloadedBook = computed(() => {
  const p = downloadProgress.value
  return Boolean(p?.bookId) && (p!.status === 'done' || p!.status === 'error')
})

const progressEnded = computed(() => {
  const status = downloadProgress.value?.status
  return status === 'done' || status === 'error' || status === 'cancelled'
})

const failedChapterRows = computed(() => downloadProgress.value?.failedChapters ?? [])

function currentHost(): string {
  try {
    const u = new URL(state.value.url)
    return u.hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

async function refreshAdSetting(host: string): Promise<void> {
  if (!host) {
    adFilterEnabled.value = true
    return
  }
  try {
    const { rules } = await window.api.siteRules.list()
    if (currentHost() !== host) return
    adFilterEnabled.value = rules.find((rule) => rule.host === host)?.adFilterEnabled !== false
  } catch {
    adFilterEnabled.value = true
  }
}

async function toggleAdFilter(): Promise<void> {
  const host = currentHost()
  if (!host || adFilterBusy.value) return
  adFilterBusy.value = true
  try {
    const { rules } = await window.api.siteRules.list()
    const existing = rules.find((rule) => rule.host === host)
    const enabled = !(existing?.adFilterEnabled !== false)
    const result = await window.api.siteRules.upsert({ ...existing, host, adFilterEnabled: enabled })
    if (!result.ok) {
      message.error(result.message || '去广告设置保存失败')
      return
    }
    if (currentHost() === host) {
      adFilterEnabled.value = enabled
      try {
        await window.api.browse.reload()
      } catch {
        message.warning('去广告设置已保存，请手动刷新网页')
      }
    }
  } catch (e: unknown) {
    message.error(e instanceof Error ? e.message : '去广告设置保存失败')
  } finally {
    adFilterBusy.value = false
  }
}

const siteLabel = computed(() => {
  const host = currentHost()
  return host ? `当前站点：${host}` : '尚未打开网页'
})

function editCurrentSiteRule() {
  const host = currentHost()
  if (!host) {
    message.warning('请先打开一个有效网址')
    return
  }
  emit('edit-site-rule', host)
}

function openThisBook() {
  const p = downloadProgress.value
  if (!p?.bookId || !canOpenDownloadedBook.value) return
  emit('open-book', p.bookId)
  showProgress.value = false
}

function restoreProgressDrawer() {
  if (downloadProgress.value) showProgress.value = true
}

/** 窗口尺寸变化：网页视图重算边界，阅读模式重算页码。 */
function onWindowResize() {
  reportBounds()
  if (readingPage.value) syncReadingPage()
}

function reportBounds() {
  const el = slot.value
  if (!el) return
  const r = el.getBoundingClientRect()
  // v-show hide (display:none) yields 0×0; do not overwrite lastBounds with 1×1.
  if (r.width < 8 || r.height < 8) return
  const slotHeight = Math.round(r.height)
  // Native persist:novel view sits above Vue; inset by the 240px drawer so
  // 打开这本书 / 取消下载 receive the real pointer. ResizeObserver will not fire.
  const inset = showPreview.value ? 430 : showProgress.value ? 240 : 0
  const height = Math.max(1, slotHeight - inset)
  void window.api.browse.setBounds({
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(1, Math.round(r.width)),
    height,
  })
}

watch(showProgress, reportBounds)
watch(showPreview, reportBounds)
watch(() => props.active, (active) => {
  if (active) {
    void refreshAdSetting(currentHost())
    void resumeBrowse()
  }
})

watch(
  () => props.prefillNonce,
  () => {
    if (!props.prefillUrl) return
    address.value = props.prefillUrl
    void go({ reading: props.prefillReading })
  },
)

async function go(options: { reading?: boolean } = {}) {
  if (readingPage.value) await exitReadingMode()
  const target = address.value
  const res = await window.api.browse.load(target)
  if (!res.ok) {
    message.error(res.message)
    return
  }
  // 网页书架续读：直接用这一章地址进阅读模式，不等可见网页渲染完。
  if (options.reading) await enterReadingMode(target)
}

async function resumeBrowse() {
  if (resumeAttempted || !props.active || props.prefillUrl) return
  resumeAttempted = true
  const res = await window.api.browse.resume()
  if (!res.ok) {
    address.value = ''
    resumeError.value = res.message || '上次网页无法打开，请检查网络或网址'
  }
}

function retryResume() {
  resumeAttempted = false
  resumeError.value = ''
  void resumeBrowse()
}

async function setZoom(delta: number | 'reset') {
  const factor = delta === 'reset' ? 1 : state.value.zoom + delta
  const res = await window.api.browse.zoom(factor)
  if (!res.ok) message.warning(res.message || '缩放失败')
}

function clearReadingHideTimer() {
  if (readingHideTimer) { clearTimeout(readingHideTimer); readingHideTimer = null }
}

/** 工具条自动隐藏：锁常显或有浮层时不藏。 */
function revealReadingTools(locked = readingToolsLocked) {
  readingToolsVisible.value = true
  lastToolActivityAt = Date.now()
  clearReadingHideTimer()
  if (locked || readingPanel.value || catalogOpen.value) return
  readingHideTimer = setTimeout(() => {
    readingHideTimer = null
    const idleMs = Date.now() - lastToolActivityAt
    if (shouldAutoHideReaderTools({ idleMs, overlayOpen: readingPanel.value || catalogOpen.value, selectionOpen: false, pointerInToolbar: false })) {
      readingToolsVisible.value = false
    } else {
      revealReadingTools()
    }
  }, Math.max(0, 2600 - (Date.now() - lastToolActivityAt)))
}

function scheduleReadingTools() {
  if (readingToolsLocked) { readingToolsVisible.value = true; return }
  revealReadingTools()
}

function toggleReadingToolsLock() {
  readingToolsLocked = !readingToolsLocked
  readingToolsVisible.value = true
  lastToolActivityAt = Date.now()
  if (readingToolsLocked) clearReadingHideTimer()
  else scheduleReadingTools()
}

function readingViewportEl(): HTMLElement | null {
  return readingViewport.value
}

/** 页码、滚动比例都从真实滚动容器读，不用位移模拟。 */
function syncReadingPage() {
  const el = readingViewportEl()
  if (!el) { readingPageIndex.value = 0; readingPageCount.value = 1; readingRatio.value = 0; return }
  readingPageCount.value = visualPageCount(el.scrollHeight, el.clientHeight)
  readingPageIndex.value = visualPageIndex(el.scrollTop, el.scrollHeight, el.clientHeight)
  readingRatio.value = clampRatio(el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0)
}

/** 视口中心最近的段落下标，作为位置记忆的锚点。 */
function resolveParagraphAnchor(): number {
  const el = readingViewportEl()
  const total = readingParagraphs.value.length
  if (!el || total === 0) return 0
  const article = el.querySelector('.web-reading-article')
  if (!article) return Math.round(readingRatio.value * Math.max(0, total - 1))
  const containerTop = el.getBoundingClientRect().top
  const centers = [...article.querySelectorAll('p')].map((node) => {
    const rect = (node as HTMLElement).getBoundingClientRect()
    return rect.top + rect.height / 2 - containerTop
  })
  const index = paragraphIndexAtViewportCenter({ viewportCenter: el.clientHeight / 2, paragraphCenters: centers })
  readingCenterParagraph.value = index
  return index >= 0 ? index : Math.round(readingRatio.value * Math.max(0, total - 1))
}

/** 恢复上次读到的段落；没有段落锚点时按滚动比例粗略还原。 */
function restoreReadingPosition(position: { paragraphIndex: number; scrollRatio: number }) {
  const el = readingViewportEl()
  if (!el) { readingRestoring = false; return }
  readingRestoring = true
  const article = el.querySelector('.web-reading-article')
  const paragraphs = article ? [...article.querySelectorAll('p')] : []
  const target = paragraphs[position.paragraphIndex] as HTMLElement | undefined
  if (target) {
    const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - el.clientHeight * 0.28
    el.scrollTop = Math.max(0, top)
  } else if (position.scrollRatio > 0) {
    el.scrollTop = position.scrollRatio * Math.max(0, el.scrollHeight - el.clientHeight)
  }
  readingCenterParagraph.value = position.paragraphIndex
  readingParagraphIndex = position.paragraphIndex
  syncReadingPage()
  if (readingRestoreTimer) clearTimeout(readingRestoreTimer)
  readingRestoreTimer = setTimeout(() => { readingRestoreTimer = null; readingRestoring = false }, 400)
}

/** 位置保存节流 800ms；退出、翻章时立即写一次。 */
function saveReadingPosition(force = false) {
  const page = readingPage.value
  if (!page || readingRestoring) return
  if (readingSaveTimer) { clearTimeout(readingSaveTimer); readingSaveTimer = null }
  const write = () => {
    readingSaveTimer = null
    if (!readingPage.value || readingPage.value.url !== page.url) return
    try {
      void window.api.browse.saveReadingPos({
        url: page.url,
        title: readingChapterTitle.value || page.title,
        paragraphIndex: resolveParagraphAnchor(),
        scrollRatio: readingRatio.value,
      }).catch(() => { /* 位置保存失败不打断阅读 */ })
    } catch { /* 同上 */ }
  }
  if (force) write()
  else readingSaveTimer = setTimeout(write, 800)
}

function pageByScreen(direction: 1 | -1) {
  const el = readingViewportEl()
  if (!el) return
  const behavior = readerScrollBehavior(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true)
  if (readingPaged.value) {
    const count = visualPageCount(el.scrollHeight, el.clientHeight)
    const current = visualPageIndex(el.scrollTop, el.scrollHeight, el.clientHeight)
    const next = adjacentVisualPage(current, direction, count)
    el.scrollTo({ top: scrollTopForVisualPage(next, el.scrollHeight, el.clientHeight), behavior })
    readingPageIndex.value = next
    return
  }
  el.scrollBy({ top: direction * el.clientHeight * 0.9, behavior })
}

/** 翻页；到本章头尾接着翻章。滚动模式与翻页模式都走真实滚动容器。 */
function turnReadingPage(delta: number) {
  const el = readingViewportEl()
  if (!el) return
  stopAutoScroll()
  if (readingPaged.value) {
    const count = visualPageCount(el.scrollHeight, el.clientHeight)
    const current = visualPageIndex(el.scrollTop, el.scrollHeight, el.clientHeight)
    const next = current + delta
    if (next < 0) { void changeChapter('previous'); return }
    if (next > count - 1) { void changeChapter('next'); return }
  } else {
    const atTop = el.scrollTop <= 2
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    if (delta < 0 && atTop) { void changeChapter('previous'); return }
    if (delta > 0 && atBottom) { void changeChapter('next'); return }
  }
  pageByScreen(delta > 0 ? 1 : -1)
}

function onReadingWheel(event: WheelEvent) {
  if (!readingPaged.value || event.ctrlKey || event.metaKey) return
  const direction = wheelPageDirection(event.deltaY)
  if (!direction) return
  event.preventDefault()
  stopAutoScroll()
  turnReadingPage(direction)
}

function onReadingScroll() {
  syncReadingPage()
  saveReadingPosition()
  if (selPopup.value) closeSelectionTools()
}

// ---------------------------------------------------------------------------
// 网页阅读模式：标注（划线 / 书签 / 备注）
// ---------------------------------------------------------------------------

async function reloadWebMarks() {
  const url = currentMarkUrl.value
  webMarkLostIds.value = new Set()
  if (!url) { webMarks.value = []; return }
  const res = await window.api.webAnnotations.list(url)
  webMarks.value = res.ok ? res.items : []
  // 触发一次重算，把找不到的划线标为丢失
  void currentWebHighlights.value
}

function markExcerpt(paragraphIndex: number, range: { start: number; end: number }): string {
  const start = readingParagraphStarts.value[paragraphIndex] ?? 0
  return readingNormalizedBody.value.slice(start + range.start, start + range.end)
}

function selectionOffsets(): { start: number; end: number; text: string } | null {
  return selectionRangeOffsets(window.getSelection(), readingParagraphStarts.value, readingNormalizedBody.value)
}

function onReadingMouseup(event: MouseEvent) {
  if (!readingPage.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('button, input, textarea')) return
  setTimeout(() => {
    const range = selectionOffsets()
    const selection = window.getSelection()
    if (!range || !selection?.rangeCount) { closeSelectionTools(); return }
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    const pos = selectionPopupPosition({
      range: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      popup: { width: 320, height: 44 },
    })
    selPopup.value = { x: pos.x, y: pos.y, excerpt: range.text.trim(), range }
  }, 0)
}

function closeSelectionTools(clear = true) {
  selPopup.value = null
  noteEditorOpen.value = false
  noteEditorDraft.value = ''
  if (clear) window.getSelection()?.removeAllRanges()
}

async function copySelectedText() {
  const excerpt = selPopup.value?.excerpt
  if (!excerpt) return
  try { await navigator.clipboard.writeText(excerpt); message.success('已复制'); closeSelectionTools() }
  catch { message.error('复制失败，请重试') }
}

async function addWebHighlight() {
  const sel = selPopup.value?.range ?? selectionOffsets()
  if (!sel || !currentMarkUrl.value) return
  const res = await window.api.webAnnotations.add({
    url: currentMarkUrl.value, kind: 'highlight', start: sel.start, end: sel.end, excerpt: sel.text,
  })
  if (res.ok) { webMarks.value = [...webMarks.value, res.item]; message.success('已划线') }
  else message.error(res.message || '划线失败')
  closeSelectionTools()
}

function openWebNoteEditor() {
  if (!selPopup.value) return
  noteEditorOpen.value = true
  noteEditorDraft.value = ''
}

async function saveWebNote() {
  const sel = selPopup.value?.range
  if (!sel || !currentMarkUrl.value) return
  const text = noteEditorDraft.value.trim()
  if (!text) return
  const res = await window.api.webAnnotations.add({
    url: currentMarkUrl.value, kind: 'highlight', start: sel.start, end: sel.end, excerpt: sel.text, note: text, noteSource: 'user',
  })
  if (res.ok) { webMarks.value = [...webMarks.value, res.item]; message.success('已保存备注') }
  else message.error(res.message || '保存失败')
  closeSelectionTools()
}

async function toggleWebBookmark() {
  if (!currentMarkUrl.value) return
  const existing = webMarks.value.find((item) => item.kind === 'bookmark')
  if (existing) {
    const res = await window.api.webAnnotations.remove(currentMarkUrl.value, existing.id)
    if (res.ok) { webMarks.value = webMarks.value.filter((item) => item.id !== existing.id); message.success('已取消书签') }
    else message.error(res.message || '操作失败')
    return
  }
  const anchor = readingParagraphIndex
  const res = await window.api.webAnnotations.add({
    url: currentMarkUrl.value, kind: 'bookmark', start: readingParagraphStarts.value[anchor] ?? 0, end: readingParagraphStarts.value[anchor] ?? 0, excerpt: '',
  })
  if (res.ok) { webMarks.value = [...webMarks.value, res.item]; message.success('已加书签') }
  else message.error(res.message || '操作失败')
}

const webChapterBookmark = computed(() => webMarks.value.find((item) => item.kind === 'bookmark') ?? null)
const webSortedMarks = computed(() => [...webMarks.value].sort((a, b) => a.start - b.start))

async function saveMarkNote(item: WebAnnotation) {
  const text = markNoteDraft.value.trim()
  const res = await window.api.webAnnotations.update(currentMarkUrl.value, item.id, { note: text, noteSource: 'user' })
  if (res.ok) {
    webMarks.value = webMarks.value.map((mark) => (mark.id === item.id ? res.item : mark))
    markNoteEditingId.value = ''
    markNoteDraft.value = ''
    message.success('备注已更新')
  } else message.error(res.message || '更新失败')
}

async function removeWebMark(item: WebAnnotation) {
  const res = await window.api.webAnnotations.remove(currentMarkUrl.value, item.id)
  if (res.ok) {
    webMarks.value = webMarks.value.filter((mark) => mark.id !== item.id)
    message.success('已删除')
  } else message.error(res.message || '删除失败')
}

function jumpToWebMark(item: WebAnnotation) {
  const index = readingParagraphStarts.value.findIndex((start, i) => {
    const end = start + (readingParagraphs.value[i]?.length ?? 0)
    return item.start >= start && item.start <= end
  })
  if (index < 0) { message.info('这一段在当前章里找不到了'); return }
  const el = readingViewport.value?.querySelectorAll('p')[index] as HTMLElement | undefined
  if (el) el.scrollIntoView({ block: 'center' })
  marksOpen.value = false
}

// ---------------------------------------------------------------------------
// 网页阅读模式：书内搜索
// ---------------------------------------------------------------------------

function openInBookFind() {
  inBookFindOpen.value = true
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.web-find-input')
    input?.focus()
  })
}

function closeInBookFind() {
  inBookFindOpen.value = false
  inBookFindQuery.value = ''
  inBookFindIndex.value = 0
}

function jumpInBookFind(delta: number) {
  const hits = inBookFindHits.value
  if (!hits.length) return
  inBookFindIndex.value = (inBookFindIndex.value + delta + hits.length) % hits.length
  const el = readingViewport.value?.querySelectorAll('p')[hits[inBookFindIndex.value]!] as HTMLElement | undefined
  if (el) el.scrollIntoView({ block: 'center' })
}

// ---------------------------------------------------------------------------
// 网页阅读模式：选区问 AI（无书库条目，只做翻译与解释）
// ---------------------------------------------------------------------------

function stopWebAi() {
  if (webAiJobId) void window.api.ai.cancel()
  webAiJobId = ''
  webAiLoading.value = false
}

async function askWebAi(kind: 'translate' | 'explain') {
  const excerpt = selPopup.value?.excerpt
  if (!excerpt) return
  const title = kind === 'translate' ? '翻译选中文字' : '解释这段'
  webAiTitle.value = title
  webAiResult.value = ''
  webAiLoading.value = true
  closeSelectionTools()
  const res = kind === 'translate'
    ? await window.api.ai.translateStream(excerpt)
    : await window.api.ai.explainText(excerpt)
  if (!res.ok) { webAiLoading.value = false; webAiResult.value = `错误：${res.message}`; return }
  webAiJobId = res.jobId
}

/** 把 AI 解释存回读者当初选中的同一区间（noteSource: 'ai'）。 */
async function saveWebAiAsNote() {
  const sel = selPopup.value?.range
  const text = webAiResult.value.trim()
  if (!sel || !text || !currentMarkUrl.value) { message.info('没有可存回的解释'); return }
  const res = await window.api.webAnnotations.add({
    url: currentMarkUrl.value, kind: 'highlight', start: sel.start, end: sel.end, excerpt: sel.text, note: text, noteSource: 'ai',
  })
  if (res.ok) { webMarks.value = [...webMarks.value, res.item]; message.success('已存回备注'); webAiResult.value = ''; webAiTitle.value = '' }
  else message.error(res.message || '保存失败')
}

// ---------------------------------------------------------------------------
// 网页阅读模式：AI 面板（跨章 AI 走「下载本书」这条既有路）
// ---------------------------------------------------------------------------

/**
 * 判当前网页书有没有下到书库。书不在网页书架时拿不到 `shelfBookId`，按未下载处理——
 * 面板仍给「下载本书」，只是少一句「已下载」的确认。
 */
async function resolveWebBookDownloaded() {
  const shelfId = readingChapter.value?.shelfBookId
  webBookDownloadChecked.value = false
  webBookDownloadedId.value = null
  if (!shelfId) return
  try {
    const res = await window.api.library.list()
    webBookDownloadedId.value = res.books?.some((book) => book.id === shelfId) ? shelfId : null
  } catch { /* 判不出来就按未下载处理，不打扰阅读 */ }
  webBookDownloadChecked.value = true
}

function toggleWebAiPanel() {
  webAiPanelOpen.value = !webAiPanelOpen.value
  if (webAiPanelOpen.value) {
    readingPanel.value = false
    void resolveWebBookDownloaded()
  }
}

/** 从阅读模式直接开下载预览：主进程读的是可见网页，阅读层是覆盖层，不冲突。 */
function downloadFromReadingMode() {
  webAiPanelOpen.value = false
  void startDownload()
}

function openDownloadedBook() {
  const id = webBookDownloadedId.value ?? downloadProgress.value?.bookId
  if (!id) return
  webAiPanelOpen.value = false
  emit('open-book', id)
}

/** 下载跑完就把「是否已下载」重新判一次，面板当场从「下载本书」翻成「去书库读这本」。 */
watch(downloadProgress, (progress) => {
  if (!readingPage.value || !progress) return
  if (progress.status === 'done' || progress.status === 'error') void resolveWebBookDownloaded()
})

// ---------------------------------------------------------------------------
// 自动滚动
// ---------------------------------------------------------------------------

const autoScroll = createAutoScroll(
  {
    scrollTop: () => readingViewportEl()?.scrollTop ?? 0,
    scrollHeight: () => readingViewportEl()?.scrollHeight ?? 0,
    viewportHeight: () => readingViewportEl()?.clientHeight ?? 0,
    setScrollTop: (value) => {
      const el = readingViewportEl()
      if (el) el.scrollTop = value
    },
    onTick: () => syncReadingPage(),
    onReachEnd: () => {
      // 到底：开了自动翻页且还有下一章就续章，否则停下
      if (!webReading.value.autoPage || !readingChapter.value?.next) return false
      void changeChapter('next', { keepAutoScroll: true })
      return true
    },
  },
  { speedPx: () => autoScrollSpeed.value },
)

function autoScrollStep(timestamp: number) {
  if (!autoScrolling.value) return
  const elapsed = lastAutoTickAt ? timestamp - lastAutoTickAt : 16
  lastAutoTickAt = timestamp
  if (!autoScroll.tick(elapsed)) {
    autoScrolling.value = false
    lastAutoTickAt = 0
    return
  }
  saveReadingPosition()
  autoScrollRaf = requestAnimationFrame(autoScrollStep)
}

function startAutoScroll() {
  if (!readingPage.value || autoScrolling.value) return
  autoScrolling.value = true
  lastAutoTickAt = 0
  autoScroll.start()
  autoScrollRaf = requestAnimationFrame(autoScrollStep)
}

function stopAutoScroll() {
  if (!autoScrolling.value && autoScrollRaf == null) return
  autoScrolling.value = false
  autoScroll.stop()
  if (autoScrollRaf != null) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = null }
  lastAutoTickAt = 0
}

function toggleAutoScroll() {
  if (autoScrolling.value) {
    stopAutoScroll()
    message.info('已暂停自动滚动')
    return
  }
  startAutoScroll()
  if (autoScrolling.value) message.info(`自动滚动中（${autoScrollSpeed.value} px/秒，速度 ${webReading.value.autoSpeed}）`)
}

// ---------------------------------------------------------------------------
// 听书
// ---------------------------------------------------------------------------

function scrollToParagraph(index: number) {
  const el = readingViewportEl()
  const article = el?.querySelector('.web-reading-article')
  const paragraphs = article ? [...article.querySelectorAll('p')] : []
  const target = paragraphs[index] as HTMLElement | undefined
  if (!el || !target) return
  const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - el.clientHeight * 0.4
  el.scrollTo({ top: Math.max(0, top), behavior: readerScrollBehavior(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true) })
}

const tts = useTts({
  paragraphs: () => readingParagraphs.value,
  rate: () => ttsRate.value,
  autoNext: () => ttsAutoNext.value,
  onChapterEnd: () => continueTtsChapter(),
  source: () => ttsSource.value,
  voiceURI: () => ttsVoiceURI.value,
  synthesize: (requestId, text) => window.api.tts.synthesize(requestId, text),
  cancelSynthesis: (requestId) => { void window.api.tts.cancel(requestId) },
  onParagraphStart: (index) => scrollToParagraph(index),
})

async function continueTtsChapter() {
  const next = readingChapter.value?.next
  if (!next) { message.info('已经是最后一章'); return }
  await switchReadingChapter(next.url)
  if (readingPage.value) tts.start(0, true)
}

function toggleTts() {
  if (tts.speaking.value) { tts.stop(); return }
  stopAutoScroll()
  if (readingParagraphs.value.length === 0) { message.info('这一章没有可朗读的正文'); return }
  tts.start(Math.max(0, Math.min(readingParagraphIndex, readingParagraphs.value.length - 1)))
}

function stopTts() {
  if (tts.speaking.value || tts.paused.value) tts.stop()
}

/** 模板里用的听书状态（嵌套 ref 在模板中不解包，这里显式取）。 */
const ttsSpeaking = computed(() => tts.speaking.value)
const ttsSpokenPara = computed(() => tts.spokenPara.value)

// ---------------------------------------------------------------------------
// 进入 / 退出 / 翻章
// ---------------------------------------------------------------------------

function openReadingPage(page: BrowseReadingPage) {
  readingPage.value = page
  readingChapterTitle.value = page.chapter?.title || page.title
  readingPageIndex.value = 0
  readingRatio.value = 0
  readingCenterParagraph.value = -1
  readingParagraphIndex = 0
  // 换章：旧章的选区工具条与搜索状态作废，再拉本章标注
  closeSelectionTools(false)
  closeInBookFind()
  webAiTitle.value = ''
  webAiResult.value = ''
  webAiPanelOpen.value = false
  void reloadWebMarks()
  void resolveWebBookDownloaded()
  void ensureReadingCatalog()
}

function prefetchNeighborChapter() {
  const next = readingPage.value?.chapter?.next
  if (next?.url) void window.api.browse.prefetchChapter(next.url)
}

/** 进阅读模式；带 url 时直接取该章（续读 / 目录跳章），不带时取当前可见网页。 */
async function enterReadingMode(url?: string) {
  if (readingBusy.value || readingPage.value) return
  readingBusy.value = true
  try {
    const res = url ? await window.api.browse.readingPage(url) : await window.api.browse.readingPage()
    if (!res.ok) { message.warning(res.message); return }
    const settings = await window.api.settings.get()
    readerPrefs.value = settings.reader
    webReading.value = settings.webReading ?? DEFAULT_WEB_READING_PREFS
    ttsRate.value = settings.tts.rate
    ttsAutoNext.value = settings.tts.autoNextChapter
    ttsSource.value = settings.tts.source
    ttsVoiceURI.value = settings.tts.systemVoiceURI
    readingPanel.value = false
    catalogOpen.value = false
    catalogChapters.value = []
    readingToolsVisible.value = true
    readingToolsLocked = false
    clearReadingHideTimer()
    openReadingPage(res.page)
    await window.api.browse.setReadingMode(true)
    await nextTick()
    syncReadingPage()
    const saved = await window.api.browse.getReadingPos(res.page.url)
    if (saved.ok && saved.position && (saved.position.paragraphIndex > 0 || saved.position.scrollRatio > 0)) {
      restoreReadingPosition(saved.position)
      message.info(`已回到上次读到的地方（第 ${saved.position.paragraphIndex + 1} 段）`)
    } else {
      readingRestoring = false
    }
    scheduleReadingTools()
    prefetchNeighborChapter()
  } catch { message.error('无法开启网页阅读模式') }
  finally { readingBusy.value = false }
}

async function exitReadingMode() {
  stopAutoScroll()
  stopTts()
  saveReadingPosition(true)
  readingPage.value = null
  readingPanel.value = false
  catalogOpen.value = false
  catalogChapters.value = []
  readingPageIndex.value = 0
  readingRatio.value = 0
  readingCenterParagraph.value = -1
  readingChapterTitle.value = ''
  readingRestoring = false
  clearReadingHideTimer()
  if (readingSaveTimer) { clearTimeout(readingSaveTimer); readingSaveTimer = null }
  await window.api.browse.setReadingMode(false)
  await nextTick()
  reportBounds()
}

let readingSeq = 0

/** 阅读模式内换章：走阅读会话，不进原网页；非阅读模式仍驱动可见网页。 */
async function changeChapter(direction: 'previous' | 'next', options: { keepAutoScroll?: boolean } = {}) {
  if (readingPage.value) {
    const link = direction === 'previous' ? readingChapter.value?.previous : readingChapter.value?.next
    const fallback = direction === 'previous' ? state.value.previousChapter?.url : state.value.nextChapter?.url
    const target = link?.url || fallback
    if (!target) { message.info(direction === 'previous' ? '已经是第一章' : '已经是最后一章'); return }
    await switchReadingChapter(target, { keepAutoScroll: options.keepAutoScroll })
    return
  }
  const res = await window.api.browse.chapter(direction)
  if (!res.ok) message.warning(res.message || '章节打开失败')
}

async function switchReadingChapter(url: string, options: { keepAutoScroll?: boolean } = {}) {
  if (readingBusy.value) return
  const previous = readingPage.value
  if (previous?.url === url) return
  const seq = ++readingSeq
  readingBusy.value = true
  const resumeAuto = options.keepAutoScroll || autoScrolling.value
  stopAutoScroll()
  try {
    saveReadingPosition(true)
    const res = await window.api.browse.readingPage(url)
    if (seq !== readingSeq) return
    if (!res.ok) { message.warning(res.message || '这一章打不开'); return }
    openReadingPage(res.page)
    readingPanel.value = false
    scheduleReadingTools()
    await nextTick()
    const el = readingViewportEl()
    if (el) el.scrollTop = 0
    syncReadingPage()
    readingRestoring = false
    const saved = await window.api.browse.getReadingPos(url)
    if (seq !== readingSeq) return
    if (saved.ok && saved.position && saved.position.paragraphIndex > 0) restoreReadingPosition(saved.position)
    if (resumeAuto) startAutoScroll()
    prefetchNeighborChapter()
  } catch { message.error('章节加载失败') }
  finally {
    if (seq === readingSeq) readingBusy.value = false
  }
}

// ---------------------------------------------------------------------------
// 目录 / 书架 / 排版
// ---------------------------------------------------------------------------

/**
 * 后台取一次目录：底栏的「第 X/Y 章」和全书比例都要靠章节序号。
 *
 * 不能拿它挡住进阅读模式——所以只在后台跑，失败就安静留着，底栏退回只显示本章比例。
 * 主进程对目录有内存缓存，逐章调用命中缓存，不会每翻一章打站点。
 */
async function ensureReadingCatalog() {
  const url = readingPage.value?.url
  if (!url) return
  try {
    const res = await window.api.browse.chapterCatalog({ catalogUrl: '', url })
    if (!res.ok) return
    catalogChapters.value = res.chapters
    catalogIndex.value = res.currentIndex
  } catch { /* 拿不到目录就不显示全书比例 */ }
}

async function openCatalog() {
  if (catalogOpen.value) { catalogOpen.value = false; return }
  catalogOpen.value = true
  catalogBusy.value = true
  clearReadingHideTimer()
  try {
    const res = await window.api.browse.chapterCatalog({ catalogUrl: '', url: readingPage.value?.url })
    if (!res.ok) {
      catalogChapters.value = []
      catalogIndex.value = -1
      message.warning(res.message || '没有识别到目录，可用上一章 / 下一章')
      return
    }
    catalogChapters.value = res.chapters
    catalogIndex.value = res.currentIndex
    await nextTick()
    catalogListEl.value?.querySelector('.catalog-item.current')?.scrollIntoView({ block: 'center' })
  } catch { message.warning('目录加载失败') }
  finally { catalogBusy.value = false }
}

async function jumpToCatalogChapter(index: number) {
  const chapter = catalogChapters.value[index]
  if (!chapter) return
  catalogOpen.value = false
  await switchReadingChapter(chapter.url)
}

function catalogIsCurrent(index: number): boolean {
  const chapter = catalogChapters.value[index]
  if (!chapter) return false
  if (readingPage.value?.url === chapter.url) return true
  return index === catalogIndex.value
}

async function addCurrentToShelf() {
  const url = readingPage.value?.url || state.value.url
  if (!url || shelfSaving.value) return
  shelfSaving.value = true
  try {
    const res = await window.api.shelf.add(url)
    if (!res.ok) { message.warning(res.message || '加入书架失败'); return }
    const count = res.book.chapters.length
    message.success(`已加入网页书架：${res.book.title}${count ? `（${count} 章）` : '（目录待识别）'}`)
  } catch { message.error('加入书架失败') }
  finally { shelfSaving.value = false }
}

function setReaderPref<K extends keyof ReaderPrefs>(key: K, value: ReaderPrefs[K]) {
  readerPrefs.value = { ...readerPrefs.value, [key]: value }
  void window.api.settings.set({ reader: { [key]: value } })
  void nextTick(() => {
    syncReadingPage()
    const el = readingViewportEl()
    if (el && readingPaged.value) el.scrollTop = scrollTopForVisualPage(readingPageIndex.value, el.scrollHeight, el.clientHeight)
  })
  saveReadingPosition()
}

function setWebReading<K extends keyof WebReadingPrefs>(key: K, value: WebReadingPrefs[K]) {
  webReading.value = { ...webReading.value, [key]: value }
  void window.api.settings.set({ webReading: { [key]: value } })
  if (key === 'autoSpeed' && autoScrolling.value) message.info(`自动滚动速度 ${value}`)
}

/** 聚焦模式：朗读中跟朗读段，否则跟视口中心段。 */
function focusedParagraph(index: number): boolean {
  if (readerPrefs.value.focusMode === 'off') return false
  if (tts.speaking.value && tts.spokenPara.value >= 0) return index === tts.spokenPara.value
  if (readingCenterParagraph.value < 0) return false
  const span = readerPrefs.value.focusMode === 'one' ? 0 : readerPrefs.value.focusMode === 'three' ? 1 : 2
  return Math.abs(index - readingCenterParagraph.value) <= span
}

function runFind(forward = true, findNext = false) {
  const query = findQuery.value.trim()
  if (query && !readingPage.value) void window.api.browse.find(query, forward, findNext)
}

function closeFind() {
  findOpen.value = false
  findQuery.value = ''
  findResult.value = { matches: 0, activeMatch: 0 }
  void window.api.browse.stopFind()
}

async function hideAction(action: 'start' | 'stop' | 'undo') {
  const result = await window.api.browse.hide(action)
  if (!result.ok) { message.warning(result.message || '操作失败'); return }
  hiddenCount.value = result.remaining ?? 0
  hidePicking.value = action === 'start' ? true : action === 'stop' ? false : hidePicking.value
}

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
  if (event.ctrlKey && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    if (!readingPage.value) findOpen.value = true
    return
  }
  if (event.altKey && event.key === 'ArrowUp') {
    event.preventDefault(); scheduleReadingTools(); void changeChapter('previous'); return
  }
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault(); scheduleReadingTools(); void changeChapter('next'); return
  }
  const key = event.key
  if (key === 'Escape') {
    if (catalogOpen.value) { catalogOpen.value = false; return }
    if (readingPanel.value) { readingPanel.value = false; return }
    if (webAiPanelOpen.value) { webAiPanelOpen.value = false; return }
    if (inBookFindOpen.value) { closeInBookFind(); return }
    if (marksOpen.value) { marksOpen.value = false; return }
    if (noteEditorOpen.value || selPopup.value) { closeSelectionTools(); return }
    if (readingPage.value && autoScrolling.value) { stopAutoScroll(); return }
    if (readingPage.value && tts.speaking.value) { stopTts(); return }
    if (readingPage.value) { void exitReadingMode(); return }
    if (findOpen.value) { closeFind(); return }
    if (hidePicking.value) { void hideAction('stop'); return }
    return
  }
  if (!readingPage.value) return
  if (key === 'ArrowLeft' || key === 'PageUp') {
    event.preventDefault(); scheduleReadingTools(); turnReadingPage(-1); return
  }
  if (key === 'ArrowRight' || key === 'PageDown' || key === ' ') {
    event.preventDefault(); scheduleReadingTools(); turnReadingPage(1); return
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    stopAutoScroll()
    scheduleReadingTools()
    return
  }
  if (key === 'm' || key === 'M') { event.preventDefault(); toggleReadingToolsLock(); return }
  if (key === 't' || key === 'T') { event.preventDefault(); void openCatalog(); return }
  if (key === 'a' || key === 'A') { event.preventDefault(); toggleAutoScroll(); return }
  if (key === 'f' || key === 'F') { event.preventDefault(); openInBookFind(); return }
  if (key === 'b' || key === 'B') { event.preventDefault(); void toggleWebBookmark(); return }
}

async function back() {
  if (readingPage.value) await exitReadingMode()
  void window.api.browse.back()
}

async function forward() {
  if (readingPage.value) await exitReadingMode()
  void window.api.browse.forward()
}

async function reload() {
  if (readingPage.value) await exitReadingMode()
  void window.api.browse.reload()
}

function stop() {
  void window.api.browse.stop()
}

async function startDownload() {
  if (previewing.value || downloading.value) return
  previewing.value = true
  previewFailure.value = null
  try {
    const res = await window.api.download.preview()
    if (!res.ok) {
      // 目录页和章节页的失败要留在页面上，附下一步；其余仍用浮层提示。
      const pageKind = res.pageKind ?? 'unknown'
      const code = res.code
      if (pageKind === 'catalog' || pageKind === 'chapter' || code === 'BodyGarbled') {
        const messageText = code === 'BodyGarbled'
          ? '页面编码可能不正确，正文疑似乱码，未开始下载。请先刷新页面；如果仍异常，请检查站点规则或使用浏览器确认页面显示正常。'
          : res.message
        previewFailure.value = { message: messageText, pageKind, code }
      } else {
        message.error(res.message)
      }
      return
    }
    downloadPreview.value = res.preview
    showPreview.value = true
  } catch (error) {
    message.error(error instanceof Error ? error.message : '预览失败')
  } finally { previewing.value = false }
}

async function confirmDownload() {
  const token = downloadPreview.value?.token
  if (!token) return
  downloading.value = true
  downloadProgress.value = null
  const res = await window.api.download.confirm(token)
  if (!res.ok) {
    downloading.value = false
    message.error(res.message || '下载失败，请重新预览')
    showPreview.value = false
    downloadPreview.value = null
    return
  }
  showPreview.value = false
  downloadPreview.value = null
  showProgress.value = true
}

async function cancelDownload() {
  await window.api.download.cancel()
}

async function retryFailedChapters() {
  const bookId = downloadProgress.value?.bookId
  if (!bookId || retryingFailed.value || downloading.value) return
  retryingFailed.value = true
  downloading.value = true
  try {
    const res = await window.api.download.retryFailed(bookId)
    if (!res.ok) {
      message.error(res.message || '重试失败')
      retryingFailed.value = false
      downloading.value = false
    }
  } catch (e: unknown) {
    message.error(e instanceof Error ? e.message : '重试失败')
    retryingFailed.value = false
    downloading.value = false
  }
}

function onSubmit(e: Event) {
  e.preventDefault()
  void go()
}

onMounted(async () => {
  await nextTick()
  reportBounds()
  ro = new ResizeObserver(() => reportBounds())
  if (slot.value) ro.observe(slot.value)
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('keydown', onKeydown)
  void resumeBrowse()
  unsubs.push(window.api.browse.onState((s) => {
    state.value = s
    if (s.loading) { hidePicking.value = false; hiddenCount.value = 0 }
    // 阅读模式与可见网页解耦：站内跳转不再把读者踢出阅读模式。
    if (s.url !== browseUrlForHide) {
      browseUrlForHide = s.url
      hidePicking.value = false
      hiddenCount.value = 0
      if (findOpen.value) closeFind()
    }
    if (s.url && s.url !== 'about:blank') address.value = s.url
    const host = currentHost()
    if (host !== lastAdHost) {
      lastAdHost = host
      void refreshAdSetting(host)
    }
  }))
  unsubs.push(window.api.browse.onUrl(({ url }) => {
    if (url && url !== 'about:blank') address.value = url
  }))
  unsubs.push(window.api.browse.onFindResult((result) => { findResult.value = result }))
  unsubs.push(window.api.browse.onReadingChapter((chapter) => {
    if (!readingPage.value) return
    readingChapterTitle.value = chapter.title || readingPage.value.title
    readingPage.value = { ...readingPage.value, chapter }
  }))
  unsubs.push(window.api.browse.onShortcut((shortcut) => {
    if (shortcut.find && !readingPage.value) findOpen.value = true
    if (shortcut.direction) {
      scheduleReadingTools()
      void changeChapter(shortcut.direction)
    }
  }))
  // 网页阅读模式的 AI 流式结果：只认当前 job，避免与书库 AI 串流
  unsubs.push(window.api.ai.onChunk(({ jobId, delta }) => {
    if (jobId === webAiJobId) webAiResult.value += delta
  }))
  unsubs.push(window.api.ai.onDone((event) => {
    if (event.jobId !== webAiJobId) return
    webAiJobId = ''
    webAiLoading.value = false
    if (!event.ok) webAiResult.value = webAiResult.value || `错误：${event.message || '生成失败'}`
  }))
  hideCountTimer = setInterval(() => {
    if (!hidePicking.value) return
    void window.api.browse.hide('count').then((result) => { if (result.ok) hiddenCount.value = result.remaining ?? 0 })
  }, 500)
  unsubs.push(window.api.download.onProgress((p) => {
    downloadProgress.value = p
    if (p.status === 'done' || p.status === 'cancelled' || p.status === 'error') {
      downloading.value = false
      retryingFailed.value = false
      // Closed mid-run must not cancel; surface the terminal tag + open button.
      showProgress.value = true
    }
  }))
})

onUnmounted(() => {
  ro?.disconnect()
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('keydown', onKeydown)
  if (hideCountTimer) clearInterval(hideCountTimer)
  clearReadingHideTimer()
  if (readingSaveTimer) clearTimeout(readingSaveTimer)
  if (readingRestoreTimer) { clearTimeout(readingRestoreTimer); readingRestoreTimer = null }
  stopAutoScroll()
  stopTts()
  if (readingPage.value) void window.api.browse.setReadingMode(false)
  unsubs.forEach((u) => u())
})
</script>

<template>
  <div class="page browse-page">
    <form v-show="!toolbarCollapsed && !readingPage" class="browse-toolbar" @submit="onSubmit">
      <div class="browser-nav-row">
        <button class="browser-icon-button" type="button" title="后退" aria-label="后退" :disabled="!state.canGoBack" @click="back">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <button class="browser-icon-button" type="button" title="前进" aria-label="前进" :disabled="!state.canGoForward" @click="forward">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </button>
        <button
          class="browser-icon-button"
          type="button"
          :title="state.loading ? '停止加载' : '刷新'"
          :aria-label="state.loading ? '停止加载' : '刷新'"
          @click="state.loading ? stop() : reload()"
        >
          <svg v-if="state.loading" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v7h-7" /></svg>
        </button>
        <input v-model="address" aria-label="网页地址" placeholder="粘贴或输入网址，回车打开" spellcheck="false" />
        <button class="browser-open-button" type="submit">打开</button>
      </div>
      <div class="browser-action-row">
        <div class="site-status" :class="{ inactive: !currentHost() }" :title="siteLabel">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
          <span>{{ siteLabel }}</span>
        </div>
        <div class="browser-actions">
          <n-button
            type="primary"
            size="small"
            :disabled="downloading || !address"
            :loading="previewing || downloading"
            @click.prevent="startDownload"
          >
            下载本书
          </n-button>
          <details class="browser-more">
            <summary>更多工具</summary>
            <div class="browser-more-content">
              <n-button size="small" secondary :disabled="!currentHost()" @click.prevent="editCurrentSiteRule">
                配置本站规则
              </n-button>
              <n-button size="small" secondary :disabled="!currentHost()" :loading="adFilterBusy" @click.prevent="toggleAdFilter">
                {{ adFilterEnabled ? '去广告：已开启' : '去广告：已关闭' }}
              </n-button>
              <button type="button" aria-label="缩小网页" @click.prevent="setZoom(-0.1)">－</button>
              <button type="button" title="恢复默认缩放" @click.prevent="setZoom('reset')">{{ Math.round(state.zoom * 100) }}%</button>
              <button type="button" aria-label="放大网页" @click.prevent="setZoom(0.1)">＋</button>
              <button type="button" @click.prevent="findOpen ? closeFind() : findOpen = true">{{ findOpen ? '关闭查找' : '网页查找' }}</button>
              <button type="button" @click.prevent="hideAction(hidePicking ? 'stop' : 'start')">{{ hidePicking ? '退出点选' : '点选隐藏' }}</button>
              <button type="button" :disabled="hiddenCount === 0" @click.prevent="hideAction('undo')">撤销隐藏{{ hiddenCount ? `（${hiddenCount}）` : '' }}</button>
              <n-button
                v-if="downloadProgress && !showProgress"
                size="small"
                tertiary
                @click.prevent="restoreProgressDrawer"
              >
                下载进度
              </n-button>
            </div>
          </details>
        </div>
      </div>
    </form>
    <div v-if="!readingPage" class="web-reading-controls">
      <button type="button" @click="toolbarCollapsed = !toolbarCollapsed">{{ toolbarCollapsed ? '展开工具栏' : '收起工具栏' }}</button>
      <template v-if="toolbarCollapsed">
        <button type="button" :disabled="!state.canGoBack" @click="back">后退</button>
        <button type="button" :disabled="!state.canGoForward" @click="forward">前进</button>
        <button type="button" @click="state.loading ? stop() : reload()">{{ state.loading ? '停止' : '刷新' }}</button>
        <span class="web-current-site" :title="state.url">{{ currentHost() || '尚未打开网页' }}</span>
      </template>
      <button type="button" :disabled="!state.previousChapter" :title="state.previousChapter?.title || '未识别到上一章'" @click="changeChapter('previous')">上一章</button>
      <button type="button" :disabled="!state.nextChapter" :title="state.nextChapter?.title || '未识别到下一章'" @click="changeChapter('next')">下一章</button>
      <button type="button" :disabled="!state.url || readingBusy" @click="readingPage ? exitReadingMode() : enterReadingMode()">{{ readingPage ? '返回原网页' : '阅读模式' }}</button>
      <span class="web-shortcut-hint">Alt＋↑ / Alt＋↓ 翻章</span>
    </div>
    <div v-if="findOpen && !readingPage" class="web-find-row">
      <input ref="findInput" v-model="findQuery" aria-label="查找网页文字" placeholder="查找当前网页" @input="runFind()" @keydown.enter.prevent="runFind(true, true)" />
      <span>{{ findResult.matches ? `${findResult.activeMatch} / ${findResult.matches}` : '无匹配' }}</span>
      <button type="button" @click="runFind(false, true)">上一处</button>
      <button type="button" @click="runFind(true, true)">下一处</button>
      <button type="button" @click="closeFind">关闭</button>
    </div>
    <div v-if="!readingPage && (resumeError || previewFailure)" class="browse-notice" role="alert">
      <p>{{ resumeError || previewFailure?.message }}</p>
      <button v-if="resumeError" type="button" @click="retryResume">重试</button>
      <button v-else-if="previewFailure?.code === 'BodyGarbled'" type="button" @click="previewFailure = null; reload()">刷新页面</button>
      <button v-else-if="previewFailure?.pageKind === 'chapter'" type="button" @click="editCurrentSiteRule">配置本站规则</button>
      <button type="button" @click="resumeError ? resumeError = '' : previewFailure = null">关闭</button>
    </div>
    <div ref="slot" v-show="!readingPage" class="browse-slot" />
    <div
      v-if="readingPage"
      ref="readingStage"
      class="web-reading-stage"
      :class="{ paged: readingPaged, 'tools-hidden': !readingToolsVisible, 'catalog-open': catalogOpen }"
      :style="readingStyle"
      @mousemove="scheduleReadingTools"
      @click.self="readingToolsVisible = !readingToolsVisible"
    >
      <header
        v-show="readingToolsVisible || readingToolsLocked"
        class="web-reading-chrome top"
        @mouseenter="clearReadingHideTimer"
      >
        <button type="button" title="返回原网页（Esc）" @click="exitReadingMode">← 返回</button>
        <span class="web-reading-title" :title="readingChapterLabel">{{ readingChapterLabel }}</span>
        <div class="web-chrome-actions">
          <button type="button" @click="openCatalog">目录</button>
          <button type="button" @click="openInBookFind">搜索</button>
          <button type="button" @click="marksOpen = true">标记</button>
          <button type="button" :class="{ active: autoScrolling }" @click="toggleAutoScroll">{{ autoScrolling ? '暂停' : '自动' }}</button>
          <button type="button" :class="{ active: ttsSpeaking }" @click="toggleTts">{{ ttsSpeaking ? '停止' : '听书' }}</button>
          <button type="button" :class="{ active: webAiPanelOpen }" @click="toggleWebAiPanel">AI</button>
          <button type="button" :disabled="shelfSaving" @click="addCurrentToShelf">加书架</button>
          <button type="button" :class="{ active: readingPanel }" @click="readingPanel = !readingPanel; webAiPanelOpen = false">排版</button>
        </div>
      </header>

      <aside v-if="catalogOpen" class="web-reading-catalog" role="dialog" aria-label="章节目录">
        <div class="catalog-head">
          <strong :title="readingPage.title">{{ readingPage.title }}</strong>
          <button type="button" @click="catalogOpen = false">关闭</button>
        </div>
        <div v-if="catalogBusy" class="catalog-empty">正在读取目录…</div>
        <div v-else-if="catalogChapters.length === 0" class="catalog-empty">
          这个站没有识别出目录，用底部「上一章 / 下一章」也能一直读下去。
        </div>
        <ol v-else ref="catalogListEl" class="catalog-list">
          <li v-for="(chapter, index) in catalogChapters" :key="chapter.url">
            <button
              type="button"
              class="catalog-item"
              :class="{ current: catalogIsCurrent(index) }"
              :title="chapter.title"
              @click="jumpToCatalogChapter(index)"
            >{{ chapter.title }}</button>
          </li>
        </ol>
      </aside>

      <div v-if="readingPanel" class="web-reading-panel" role="dialog" aria-label="阅读排版">
        <div class="web-panel-row">
          <span>背景</span>
          <button type="button" :class="{ active: readerPrefs.theme === 'paper' }" @click="setReaderPref('theme', 'paper')">纸白</button>
          <button type="button" :class="{ active: readerPrefs.theme === 'sepia' }" @click="setReaderPref('theme', 'sepia')">暖黄</button>
          <button type="button" :class="{ active: readerPrefs.theme === 'gray' }" @click="setReaderPref('theme', 'gray')">柔灰</button>
          <button type="button" :class="{ active: readerPrefs.theme === 'night' }" @click="setReaderPref('theme', 'night')">夜间</button>
        </div>
        <div class="web-panel-row">
          <span>字号</span>
          <button type="button" @click="setReaderPref('fontSize', Math.max(12, readerPrefs.fontSize - 1))">A−</button>
          <strong>{{ readerPrefs.fontSize }}</strong>
          <button type="button" @click="setReaderPref('fontSize', Math.min(36, readerPrefs.fontSize + 1))">A＋</button>
          <button type="button" :class="{ active: readingPaged }" @click="setReaderPref('readingMode', readingPaged ? 'scroll' : 'screen')">
            {{ readingPaged ? '翻页模式' : '滚动模式' }}
          </button>
        </div>
        <div class="web-panel-row">
          <span>版心</span>
          <button type="button" :class="{ active: readerPrefs.contentWidth === 'narrow' }" @click="setReaderPref('contentWidth', 'narrow')">窄</button>
          <button type="button" :class="{ active: readerPrefs.contentWidth === 'medium' }" @click="setReaderPref('contentWidth', 'medium')">中</button>
          <button type="button" :class="{ active: readerPrefs.contentWidth === 'wide' }" @click="setReaderPref('contentWidth', 'wide')">宽</button>
          <button type="button" :class="{ active: readerPrefs.fontFamily === 'serif' }" @click="setReaderPref('fontFamily', 'serif')">宋体</button>
          <button type="button" :class="{ active: readerPrefs.fontFamily === 'system' }" @click="setReaderPref('fontFamily', 'system')">黑体</button>
        </div>
        <div class="web-panel-row">
          <span>行距</span>
          <button type="button" @click="setReaderPref('lineHeight', Math.max(1.2, Math.round((readerPrefs.lineHeight - 0.1) * 10) / 10))">－</button>
          <strong>{{ readerPrefs.lineHeight.toFixed(1) }}</strong>
          <button type="button" @click="setReaderPref('lineHeight', Math.min(3, Math.round((readerPrefs.lineHeight + 0.1) * 10) / 10))">＋</button>
        </div>
        <div class="web-panel-row">
          <span>段间距</span>
          <button type="button" :class="{ active: readerPrefs.paragraphSpacing === 'compact' }" @click="setReaderPref('paragraphSpacing', 'compact')">紧凑</button>
          <button type="button" :class="{ active: readerPrefs.paragraphSpacing === 'normal' }" @click="setReaderPref('paragraphSpacing', 'normal')">标准</button>
          <button type="button" :class="{ active: readerPrefs.paragraphSpacing === 'relaxed' }" @click="setReaderPref('paragraphSpacing', 'relaxed')">宽松</button>
          <button type="button" :class="{ active: readerPrefs.paragraphIndent }" @click="setReaderPref('paragraphIndent', !readerPrefs.paragraphIndent)">
            首行缩进{{ readerPrefs.paragraphIndent ? '开' : '关' }}
          </button>
        </div>
        <div class="web-panel-row">
          <span>行焦点</span>
          <button type="button" :class="{ active: readerPrefs.focusMode === 'off' }" @click="setReaderPref('focusMode', 'off')">关</button>
          <button type="button" :class="{ active: readerPrefs.focusMode === 'one' }" @click="setReaderPref('focusMode', 'one')">1 段</button>
          <button type="button" :class="{ active: readerPrefs.focusMode === 'three' }" @click="setReaderPref('focusMode', 'three')">3 段</button>
          <button type="button" :class="{ active: readerPrefs.focusMode === 'five' }" @click="setReaderPref('focusMode', 'five')">5 段</button>
        </div>
        <div class="web-panel-row">
          <span>自动</span>
          <button type="button" :class="{ active: webReading.autoPage }" @click="setWebReading('autoPage', !webReading.autoPage)">
            自动续章{{ webReading.autoPage ? '开' : '关' }}
          </button>
          <button
            v-for="level in [1, 2, 3, 4, 5]"
            :key="level"
            type="button"
            :class="{ active: webReading.autoSpeed === level }"
            @click="setWebReading('autoSpeed', level)"
          >{{ level }}</button>
        </div>
        <p class="web-panel-hint">← → 翻页 · Alt＋↑↓ 换章 · A 自动滚动 · T 目录 · F 搜索 · B 书签 · M 锁工具条 · Esc 退出</p>
      </div>

      <!-- AI 面板：说清就地可用什么，跨章 AI 给「下载本书」的入口 -->
      <div v-if="webAiPanelOpen" class="web-reading-panel web-ai-guide" role="dialog" aria-label="这本书的 AI">
        <strong>这本书的 AI</strong>
        <p class="web-guide-line">就地可用：选中正文后浮出的工具条里有<strong>翻译</strong>与<strong>解释这段</strong>，只处理你选中的文字，不需要书库。</p>
        <p class="web-guide-line">跨章 AI（前情提要、人物与伏笔记忆、带依据问答、读完一章自动整理）要能回头重读已读章节，正文得留在本机。网页阅读模式刻意不存正文，所以这里给的是入口，不做半成品。</p>
        <div class="web-panel-row">
          <template v-if="webBookDownloadedId">
            <span>已下载到书库</span>
            <button type="button" class="primary" @click="openDownloadedBook">去书库读这本</button>
          </template>
          <template v-else-if="downloadProgress?.status === 'running' && downloadProgress.bookId">
            <span>正在下载 {{ downloadProgress.done }} / {{ downloadProgress.total }} 章</span>
            <button type="button" @click="showProgress = true">看进度</button>
          </template>
          <template v-else>
            <span>{{ webBookDownloadChecked ? '这本书还没下载到书库' : '未确认下载状态' }}</span>
            <button
              type="button"
              class="primary"
              :disabled="previewing || downloading"
              :loading="previewing || downloading"
              @click="downloadFromReadingMode"
            >下载本书</button>
          </template>
        </div>
        <p class="web-panel-hint">下载完在书库里打开，就是与本地阅读器同一套 AI；网页阅读模式继续当「不落地也能读」的那一面。</p>
      </div>

      <div
        ref="readingViewport"
        class="web-reading-viewport"
        @scroll.passive="onReadingScroll"
        @wheel="onReadingWheel"
        @mouseup="onReadingMouseup"
        @touchstart.passive="stopAutoScroll"
      >
        <article class="web-reading-article">
          <h1>{{ readingPage.title }}</h1>
          <p
            v-for="(paragraph, i) in readingParagraphs"
            :key="i"
            :data-p="i"
            :class="{ focused: focusedParagraph(i), speaking: ttsSpeaking && ttsSpokenPara === i }"
          ><template v-for="(seg, j) in readingParagraphSegments(i)" :key="j"><mark v-if="seg.hit" class="web-hit">{{ seg.text }}</mark><mark v-else-if="seg.hl" class="web-hl">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></p>
          <div class="web-reading-end">
            <span>{{ autoScrolling ? '自动滚动中…' : '本章完' }}</span>
            <button v-if="canNextChapter" type="button" :disabled="readingBusy" @click="changeChapter('next')">
              {{ readingChapter?.next?.title ? `下一章 · ${readingChapter.next.title}` : '下一章' }}
            </button>
            <span v-else>已经是最后一章</span>
          </div>
        </article>
      </div>

      <!-- 选区工具条：复制 / 划线 / 备注 / 翻译 / 解释 -->
      <div
        v-if="selPopup"
        class="web-sel-popup"
        :style="{ left: selPopup.x + 'px', top: selPopup.y + 'px' }"
      >
        <button type="button" @click="copySelectedText">复制</button>
        <button type="button" @click="addWebHighlight">划线</button>
        <button type="button" @click="openWebNoteEditor">备注</button>
        <button type="button" @click="askWebAi('translate')">翻译</button>
        <button type="button" @click="askWebAi('explain')">解释这段</button>
      </div>

      <div v-if="noteEditorOpen" class="web-note-editor" :style="{ left: (selPopup?.x ?? 0) + 'px', top: (selPopup?.y ?? 0) + 'px' }">
        <strong>添加备注</strong>
        <div class="web-note-excerpt">{{ selPopup?.excerpt }}</div>
        <textarea v-model="noteEditorDraft" rows="3" placeholder="写下对这段文字的备注…"></textarea>
        <div class="web-note-actions">
          <button type="button" @click="closeSelectionTools()">取消</button>
          <button type="button" class="primary" :disabled="!noteEditorDraft.trim()" @click="saveWebNote">保存</button>
        </div>
      </div>

      <!-- AI 结果（翻译 / 解释）：只在网页阅读模式内使用，不落盘 -->
      <div v-if="webAiTitle" class="web-ai-panel" role="dialog" aria-label="AI 结果">
        <div class="web-ai-head">
          <strong>{{ webAiTitle }}</strong>
          <button type="button" @click="stopWebAi(); webAiTitle = ''; webAiResult = ''">关闭</button>
        </div>
        <div class="web-ai-body">{{ webAiResult || (webAiLoading ? '正在生成…' : '') }}</div>
        <div v-if="webAiResult && !webAiLoading" class="web-ai-actions">
          <button type="button" @click="saveWebAiAsNote">存回备注</button>
        </div>
      </div>

      <!-- 书内搜索：只在当前章正文里找 -->
      <div v-if="inBookFindOpen" class="web-find-bar" role="dialog" aria-label="书内搜索">
        <input v-model="inBookFindQuery" class="web-find-input" placeholder="在本章正文里查找" @keydown.enter.prevent="jumpInBookFind(1)" />
        <span class="web-find-count">{{ inBookFindHits.length ? `${inBookFindIndex + 1}/${inBookFindHits.length}` : '无命中' }}</span>
        <button type="button" :disabled="!inBookFindHits.length" @click="jumpInBookFind(-1)">上一个</button>
        <button type="button" :disabled="!inBookFindHits.length" @click="jumpInBookFind(1)">下一个</button>
        <button type="button" @click="closeInBookFind">关闭</button>
      </div>

      <!-- 标记抽屉：划线 / 书签 / 备注 -->
      <aside v-if="marksOpen" class="web-marks-drawer" role="dialog" aria-label="本章标记">
        <div class="web-marks-head">
          <strong>本章标记</strong>
          <button type="button" @click="marksOpen = false">关闭</button>
        </div>
        <div v-if="!webSortedMarks.length" class="web-marks-empty">还没有划线和备注。选中正文即可划线或写备注。</div>
        <ul v-else class="web-marks-list">
          <li v-for="item in webSortedMarks" :key="item.id" class="web-mark-row">
            <button type="button" class="web-mark-main" @click="jumpToWebMark(item)">
              <span class="web-mark-icon">{{ item.kind === 'bookmark' ? '书签' : '划线' }}</span>
              <span class="web-mark-excerpt">{{ item.excerpt || '（本章位置）' }}</span>
            </button>
            <p v-if="item.note" class="web-mark-note">
              <span v-if="item.noteSource === 'ai'" class="web-mark-source">AI 解释</span>{{ item.note }}
            </p>
            <div class="web-mark-actions">
              <button type="button" @click="markNoteEditingId = item.id; markNoteDraft = item.note || ''">编辑备注</button>
              <button type="button" @click="removeWebMark(item)">删除</button>
            </div>
            <div v-if="markNoteEditingId === item.id" class="web-mark-note-edit">
              <textarea v-model="markNoteDraft" rows="2" placeholder="写下备注…"></textarea>
              <button type="button" @click="saveMarkNote(item)">保存备注</button>
            </div>
          </li>
        </ul>
      </aside>

      <footer
        v-show="readingToolsVisible || readingToolsLocked"
        class="web-reading-chrome bottom"
        @mouseenter="clearReadingHideTimer"
      >
        <button type="button" :disabled="readingBusy || !canPrevChapter" @click="changeChapter('previous')">上一章</button>
        <button type="button" class="web-reading-progress" :title="readingProgressLabel" @click="openCatalog">{{ readingProgressLabel }}</button>
        <button type="button" :disabled="readingBusy || !canNextChapter" @click="changeChapter('next')">下一章</button>
      </footer>
    </div>

    <n-drawer v-model:show="showPreview" placement="bottom" :height="430">
      <n-drawer-content title="下载前预览" closable>
        <div v-if="downloadPreview" class="dl-progress">
          <strong>{{ downloadPreview.bookTitle || '未识别书名' }}</strong>
          <div>作者：{{ downloadPreview.author || '未识别' }} · 目录 {{ downloadPreview.chapterCount }} 章</div>
          <div>前几章：{{ downloadPreview.chapterTitles.join('、') }}</div>
          <strong>样本：{{ downloadPreview.sampleTitle }}</strong>
          <p v-if="downloadPreview.sampleError" role="alert">样本提取失败：{{ downloadPreview.sampleError }}</p>
          <div v-else class="download-preview-sample">{{ downloadPreview.sampleBody || '没有可预览的正文' }}</div>
          <n-button type="primary" :loading="downloading" @click="confirmDownload">确认下载这本书</n-button>
        </div>
      </n-drawer-content>
    </n-drawer>

    <!-- Download progress drawer -->
    <n-drawer v-model:show="showProgress" placement="bottom" :height="240">
      <n-drawer-content title="下载进度" closable>
        <div v-if="downloadProgress" class="dl-progress">
          <div class="dl-title">{{ downloadProgress.title }}</div>
          <n-progress
            type="line"
            :percentage="downloadProgress.total > 0 ? Math.round((downloadProgress.done + downloadProgress.failed) / downloadProgress.total * 100) : 0"
            :status="downloadProgress.status === 'error' ? 'error' : downloadProgress.status === 'done' ? 'success' : 'default'"
          />
          <div class="dl-stats">
            <span>已下 {{ downloadProgress.done }} / {{ downloadProgress.total }} 章</span>
            <n-tag v-if="downloadProgress.failed > 0" size="small" type="warning">
              {{ downloadProgress.failed }} 失败
            </n-tag>
            <n-tag v-if="downloadProgress.status === 'done'" size="small" type="success">完成</n-tag>
            <n-tag v-if="downloadProgress.status === 'error'" size="small" type="error">有失败</n-tag>
            <n-tag v-if="downloadProgress.status === 'cancelled'" size="small" type="warning">已取消</n-tag>
          </div>
          <div v-if="downloadProgress.currentTitle" class="dl-current">
            正在下载：{{ downloadProgress.currentTitle }}
          </div>
          <div v-if="downloadProgress.lastError" class="dl-error">
            错误：{{ downloadProgress.lastError }}
          </div>
          <div v-if="progressEnded && downloadProgress.qualityIssueCount" class="dl-error">
            质量检查发现 {{ downloadProgress.qualityIssueCount }} 项疑似问题，可到书库核对。
          </div>
          <div v-if="progressEnded" class="dl-failed">
            <div class="dl-failed-title">失败章节</div>
            <ul v-if="failedChapterRows.length > 0" class="dl-failed-list">
              <li v-for="row in failedChapterRows" :key="row.chapterId">
                <span class="dl-failed-index">{{ row.index }}</span>
                <span class="dl-failed-name">{{ row.title }}</span>
                <span class="dl-failed-reason">{{ row.reason }}</span>
              </li>
            </ul>
            <div v-else class="dl-failed-empty">没有失败章节</div>
            <div v-if="failedChapterRows.length > 0" class="dl-retry-sample">
              <n-button
                size="small"
                secondary
                :loading="retryingFailed"
                :disabled="downloading || !downloadProgress?.bookId"
                @click="retryFailedChapters"
              >
                只补失败章
              </n-button>
            </div>
          </div>
          <div class="dl-actions">
            <n-button
              v-if="downloading"
              size="small"
              quaternary
              type="error"
              @click="cancelDownload"
            >
              取消下载
            </n-button>
            <n-button
              v-if="canOpenDownloadedBook"
              type="primary"
              size="small"
              @click="openThisBook"
            >
              打开这本书
            </n-button>
            <n-button size="small" secondary @click="showProgress = false">关闭</n-button>
          </div>
        </div>
        <div v-else class="dl-waiting">等待下载开始…</div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.browse-page {
  color: var(--text-primary);
  background: var(--app-bg);
}

.web-reading-controls, .web-find-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
  z-index: 2;
}

.web-reading-controls button, .web-find-row button {
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  padding: 6px 12px;
  cursor: pointer;
}

.web-reading-controls button:hover:not(:disabled), .web-find-row button:hover:not(:disabled) { background: var(--surface-2); color: var(--text-primary); }
.web-more { min-width: 0; margin-left: auto; }
.web-more[open] { flex: 1 0 100%; }
.web-more-content { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); padding-top: var(--space-2); }
.web-shortcut-hint { margin-left: var(--space-2); }
.web-more summary, .browser-more summary { list-style: none; border: 1px solid var(--border); border-radius: 999px; padding: 6px 12px; color: var(--text-secondary); background: var(--surface-1); font-size: 12px; cursor: pointer; }
.web-more summary::-webkit-details-marker, .browser-more summary::-webkit-details-marker { display: none; }
.web-more summary:hover, .browser-more summary:hover { border-color: var(--hover-line); color: var(--focus); }
.web-more summary:focus-visible, .browser-more summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.web-reading-controls button:disabled { opacity: 0.45; cursor: default; }
.web-shortcut-hint { color: var(--text-muted); font-size: 12px; }
.web-find-row input { min-width: 160px; flex: 1; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--input-bg); color: var(--text-primary); }
.web-find-row span { min-width: 70px; text-align: center; }
/* 阅读模式是沉浸层：正文自己滚，工具条浮在上面，不占正文高度。 */
.web-reading-stage { position: relative; flex: 1; min-height: 0; overflow: hidden; background: var(--web-outer); color: var(--web-ink); }
.web-reading-viewport {
  position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden;
  background: var(--web-outer); scrollbar-width: none; overscroll-behavior: contain;
}
.web-reading-viewport::-webkit-scrollbar { width: 0; height: 0; }
.web-reading-chrome {
  position: absolute; left: 0; right: 0; z-index: 4;
  display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 14px;
  color: var(--web-ink); background: color-mix(in srgb, var(--web-paper) 94%, transparent);
  backdrop-filter: blur(6px); transition: opacity 160ms ease, transform 160ms ease;
}
.web-reading-chrome.top { top: 0; border-bottom: 1px solid color-mix(in srgb, var(--web-ink) 12%, transparent); }
.web-reading-chrome.bottom { bottom: 0; justify-content: center; border-top: 1px solid color-mix(in srgb, var(--web-ink) 12%, transparent); }
.web-reading-stage.tools-hidden .web-reading-chrome { opacity: 0; pointer-events: none; }
.web-reading-stage.tools-hidden .web-reading-chrome.top { transform: translateY(-100%); }
.web-reading-stage.tools-hidden .web-reading-chrome.bottom { transform: translateY(100%); }
.web-reading-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.web-chrome-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.web-reading-chrome button, .web-reading-panel button, .catalog-head button {
  border: 0; border-radius: 999px; background: transparent; color: inherit;
  padding: 6px 10px; font-size: 13px; cursor: pointer;
}
.web-reading-chrome button:hover:not(:disabled), .web-reading-panel button:hover, .catalog-head button:hover { background: color-mix(in srgb, var(--web-ink) 10%, transparent); }
.web-reading-chrome button.active, .web-reading-panel button.active { background: color-mix(in srgb, var(--web-ink) 18%, transparent); font-weight: 600; }
.web-reading-chrome button:disabled { opacity: 0.4; cursor: default; }
.web-reading-progress { font-variant-numeric: tabular-nums; }
.web-reading-panel {
  position: absolute; z-index: 5; top: 52px; right: 14px; display: grid; gap: 8px;
  width: min(460px, calc(100% - 28px)); padding: 14px;
  border-radius: 14px; background: var(--web-paper); color: var(--web-ink); box-shadow: var(--shadow-card);
}
.web-panel-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.web-panel-row span { width: 36px; font-size: 12px; opacity: 0.7; }
.web-panel-hint { margin: 0; font-size: 12px; opacity: 0.6; }
/* AI 面板：文字说明 + 一个主行动，排版沿用 .web-reading-panel 的浮层样式 */
.web-ai-guide { width: min(460px, calc(100% - 28px)); }
.web-guide-line { margin: 0; font-size: 13px; line-height: 1.7; opacity: 0.85; }
.web-panel-row button.primary { background: color-mix(in srgb, var(--web-ink) 26%, transparent); font-weight: 600; }
.web-panel-row button:disabled { opacity: 0.45; cursor: default; }

/* 章节目录：从右侧滑出，当前章高亮并自动滚到可见处 */
.web-reading-catalog {
  position: absolute; z-index: 5; top: 0; bottom: 0; right: 0; width: min(360px, 86%);
  display: flex; flex-direction: column; background: var(--web-paper); color: var(--web-ink);
  box-shadow: -8px 0 24px rgb(0 0 0 / 14%);
}
.catalog-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-bottom: 1px solid color-mix(in srgb, var(--web-ink) 12%, transparent); }
.catalog-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-list { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 6px 0; list-style: none; }
.catalog-item { display: block; width: 100%; text-align: left; padding: 8px 14px; border: 0; background: transparent; color: inherit; font-size: 13px; cursor: pointer; }
.catalog-item:hover { background: color-mix(in srgb, var(--web-ink) 8%, transparent); }
.catalog-item.current { background: color-mix(in srgb, var(--web-ink) 15%, transparent); font-weight: 600; }
.catalog-empty { padding: 16px 14px; font-size: 13px; opacity: 0.75; }

.web-reading-article {
  box-sizing: border-box; width: min(100%, var(--web-width)); margin: 0 auto;
  min-height: 100%; padding: 56px clamp(28px, 6vw, 72px) 72px;
  background: var(--web-paper); color: var(--web-ink);
  font: var(--web-size)/var(--web-line) var(--web-font); white-space: pre-wrap; overflow-wrap: anywhere;
}
.web-reading-article h1 { font-size: 1.35em; font-weight: 600; line-height: 1.5; text-align: center; margin: 0.6em 0 1.6em; }
.web-reading-article p { margin: 0 0 var(--web-spacing); text-indent: var(--web-indent); }
.web-reading-article p.focused { background: color-mix(in srgb, var(--web-ink) 7%, transparent); border-radius: 4px; }
.web-reading-article p.speaking { background: color-mix(in srgb, var(--web-ink) 13%, transparent); border-radius: 4px; }
.web-reading-end { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 32px; padding-top: 18px; font-size: 13px; opacity: 0.8; border-top: 1px solid color-mix(in srgb, var(--web-ink) 14%, transparent); }
.web-reading-end button { border: 0; border-radius: 999px; padding: 6px 14px; background: color-mix(in srgb, var(--web-ink) 12%, transparent); color: inherit; font-size: 13px; cursor: pointer; }

/* 书内搜索命中与划线：与本地阅读器同观感 */
.web-reading-article mark.web-hit { background: color-mix(in srgb, #ffb300 55%, transparent); color: inherit; border-radius: 3px; padding: 0 1px; }
.web-reading-article mark.web-hl { background: color-mix(in srgb, #ffd078 60%, transparent); color: inherit; border-radius: 3px; padding: 0 1px; }

/* 选区工具条：贴选区浮出，工具条本体在正文层之上 */
.web-sel-popup {
  position: fixed; z-index: 20; display: flex; flex-wrap: wrap; gap: 4px;
  width: min(320px, calc(100vw - 16px)); padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--web-ink) 18%, transparent);
  border-radius: 12px; background: var(--web-paper); color: var(--web-ink);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
}
.web-sel-popup button, .web-note-actions button, .web-ai-actions button, .web-mark-actions button, .web-mark-note-edit button, .web-find-bar button, .web-marks-head button, .web-ai-head button {
  border: 0; border-radius: 8px; padding: 5px 10px; background: color-mix(in srgb, var(--web-ink) 10%, transparent);
  color: inherit; font: inherit; font-size: 13px; cursor: pointer;
}
.web-sel-popup button:hover, .web-note-actions button:hover, .web-ai-actions button:hover, .web-mark-actions button:hover, .web-find-bar button:hover, .web-marks-head button:hover, .web-ai-head button:hover { background: color-mix(in srgb, var(--web-ink) 18%, transparent); }
.web-note-actions button.primary { background: color-mix(in srgb, var(--web-ink) 26%, transparent); font-weight: 600; }
.web-sel-popup button:disabled, .web-note-actions button:disabled, .web-find-bar button:disabled { opacity: 0.45; cursor: default; }

.web-note-editor {
  position: fixed; z-index: 21; width: min(340px, calc(100vw - 16px));
  display: flex; flex-direction: column; gap: 8px; padding: 14px;
  border: 1px solid color-mix(in srgb, var(--web-ink) 18%, transparent);
  border-radius: 12px; background: var(--web-paper); color: var(--web-ink);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.22);
}
.web-note-editor textarea, .web-mark-note-edit textarea { width: 100%; resize: vertical; padding: 8px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--web-ink) 20%, transparent); background: color-mix(in srgb, var(--web-ink) 4%, transparent); color: inherit; font: inherit; font-size: 13px; }
.web-note-excerpt { max-height: 72px; overflow: auto; padding: 8px; border-radius: 8px; background: color-mix(in srgb, var(--web-ink) 7%, transparent); font-size: 12px; line-height: 1.5; opacity: 0.85; }
.web-note-actions { display: flex; justify-content: flex-end; gap: 6px; }

.web-ai-panel {
  position: absolute; z-index: 22; right: 14px; bottom: 64px; width: min(420px, calc(100% - 28px));
  max-height: 50vh; display: flex; flex-direction: column; gap: 8px; padding: 14px;
  border: 1px solid color-mix(in srgb, var(--web-ink) 18%, transparent);
  border-radius: 14px; background: var(--web-paper); color: var(--web-ink);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
}
.web-ai-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.web-ai-body { overflow: auto; white-space: pre-wrap; font-size: 14px; line-height: 1.7; }
.web-ai-actions { display: flex; justify-content: flex-end; }

.web-find-bar {
  position: absolute; z-index: 22; top: 52px; right: 14px; display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--web-ink) 18%, transparent);
  border-radius: 12px; background: var(--web-paper); color: var(--web-ink);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.web-find-input { width: 180px; padding: 6px 8px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--web-ink) 20%, transparent); background: color-mix(in srgb, var(--web-ink) 4%, transparent); color: inherit; font: inherit; font-size: 13px; }
.web-find-count { font-size: 12px; opacity: 0.7; font-variant-numeric: tabular-nums; }

.web-marks-drawer {
  position: absolute; z-index: 22; top: 0; bottom: 0; right: 0; width: min(360px, 86%);
  display: flex; flex-direction: column; gap: 10px; padding: 16px;
  background: var(--web-paper); color: var(--web-ink);
  border-left: 1px solid color-mix(in srgb, var(--web-ink) 14%, transparent);
  box-shadow: -8px 0 28px rgba(0, 0, 0, 0.16); overflow-y: auto;
}
.web-marks-head { display: flex; align-items: center; justify-content: space-between; }
.web-marks-empty { font-size: 13px; opacity: 0.7; line-height: 1.6; }
.web-marks-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.web-mark-row { border: 1px solid color-mix(in srgb, var(--web-ink) 14%, transparent); border-radius: 10px; padding: 8px 10px; }
.web-mark-main { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.web-mark-icon { flex: 0 0 auto; font-size: 11px; opacity: 0.7; }
.web-mark-excerpt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.web-mark-note { margin: 6px 0 0; font-size: 12px; line-height: 1.6; opacity: 0.85; }
.web-mark-source { display: inline-block; margin-right: 4px; padding: 0 4px; border: 1px solid currentColor; border-radius: 3px; font-size: 10px; opacity: 0.7; }
.web-mark-actions { display: flex; gap: 6px; margin-top: 6px; }
.web-mark-note-edit { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }

.browse-toolbar {
  position: relative;
  z-index: 2;
  height: auto;
  display: block;
  padding: 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
}

.browser-nav-row,
.browser-action-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.browser-nav-row {
  min-height: 60px;
}

.browser-action-row {
  min-height: 48px;
  justify-content: space-between;
  border-top: 1px solid var(--border);
  background: var(--surface-1);
}

.browser-nav-row input {
  min-width: 120px;
  height: 40px;
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 var(--space-3);
  color: var(--text-primary);
  background: var(--input-bg);
  font: inherit;
  font-size: 14px;
  transition: border-color var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing), box-shadow var(--motion-duration) var(--motion-easing);
}

.browser-nav-row input::placeholder {
  color: var(--text-muted);
}

.browser-nav-row input:hover {
  border-color: var(--hover-line);
  background: var(--input-bg);
}

.browser-nav-row input:focus {
  border-color: var(--focus);
  background: var(--input-bg);
  box-shadow: var(--input-ring);
}

.browser-nav-row input:focus:not(:focus-visible) {
  outline: none;
}

.browser-icon-button {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 999px;
  color: var(--text-primary);
  background: var(--chip-bg);
  cursor: pointer;
  transition: border-color var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing), color var(--motion-duration) var(--motion-easing);
}

.browser-icon-button:hover:not(:disabled) {
  border-color: var(--hover-line);
  background: var(--chip-hover-bg);
}

.browser-icon-button:active:not(:disabled) {
  border-color: var(--focus);
  background: var(--surface-3);
}

.browser-icon-button:focus-visible,
.browser-open-button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.browser-icon-button:disabled {
  color: var(--disabled);
  border-color: var(--border);
  background: var(--chip-bg);
  opacity: 1;
  cursor: default;
}

.browser-icon-button svg,
.site-status svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.browser-open-button {
  height: 40px;
  flex: 0 0 auto;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0 var(--space-3);
  color: var(--on-accent);
  background: var(--focus);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
  transition: background var(--motion-duration) var(--motion-easing);
}

.browser-open-button:hover:not(:disabled) {
  filter: brightness(1.08);
}

.browser-open-button:active:not(:disabled) {
  filter: brightness(0.94);
}

.browser-open-button:disabled {
  color: var(--on-accent);
  background: var(--disabled);
  cursor: default;
}

.site-status {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: 12px;
}

.site-status.inactive {
  color: var(--text-muted);
}

.site-status span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.browser-more { min-width: 0; }
.browser-more[open] { flex: 1 0 100%; }
.browser-more-content { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); padding-top: var(--space-2); }

.dl-progress {
  padding: var(--space-2) 0;
  color: var(--text-primary);
}

.dl-waiting {
  color: var(--text-secondary);
  text-align: center;
  padding: var(--space-6);
}

.dl-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: var(--space-2);
}

.dl-stats {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: var(--space-2);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.dl-current {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: var(--space-1);
}

.dl-error {
  font-size: 12px;
  color: var(--error);
  margin-top: var(--space-1);
}

.dl-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.dl-failed {
  margin-top: var(--space-2);
  color: var(--text-primary);
  font-size: 12px;
}

.dl-failed-title {
  font-weight: 600;
  margin-bottom: var(--space-1);
}

.dl-failed-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 72px;
  overflow: auto;
}

.dl-failed-list li {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  padding: 2px 0;
}

.dl-failed-index {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.dl-failed-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-failed-reason {
  flex: 0 1 auto;
  margin-left: auto;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-failed-empty {
  color: var(--text-muted);
}
.download-preview-sample {
  white-space: pre-wrap;
  max-height: 120px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--line);
}

.dl-retry-sample {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  color: var(--text-muted);
}

@media (max-width: 900px) {
  .browser-action-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .browser-actions {
    justify-content: flex-start;
  }
}

@media (max-width: 560px) {
  .browser-nav-row,
  .browser-action-row {
    padding: var(--space-2);
  }

  .browser-nav-row {
    flex-wrap: wrap;
  }

  .browser-nav-row input {
    order: 1;
    flex-basis: calc(100% - 72px);
  }

  .browser-open-button {
    order: 2;
  }
}

@media (prefers-reduced-motion: reduce) {
  .browser-icon-button,
  .browser-open-button,
  .browser-nav-row input,
  .browse-page :deep(.n-button) {
    transition: none;
  }
}
</style>
