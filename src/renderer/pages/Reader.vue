<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick, computed } from 'vue'
import { NButton, NDrawer, NDrawerContent, NList, NListItem, NSlider, NSwitch, NTag, NInput, NSpace, NPopconfirm, useMessage } from 'naive-ui'
import { DEFAULT_READER_PREFS, FAIL_CODE_ZH } from '@shared/types'
import type {
  AiChatMessage,
  Book,
  ChapterMeta,
  ReaderContentWidth,
  ReaderFontFamily,
  ReaderParagraphSpacing,
  ReaderPrefs,
  ReaderTheme,
} from '@shared/types'
import {
  approximateBookRatio,
  chapterScrollRatio,
  failAdvice,
  filterCatalogChapters,
  formatCharacterCard,
  readerProgressLabel,
  remainingChapterCount,
  resolveImmersiveKey,
  resolveReaderKey,
  scrollTopFromRatio,
  shouldAutoHideReaderTools,
} from './readerHelpers'
import type { ReaderImmersiveMode } from './readerHelpers'
import { clampTtsRate, splitIntoParagraphs, useTts } from './useTts'
import { decorateText, relocateRange } from '@shared/paragraphSearch'
import type { Annotation, BookSearchHit } from '@shared/types'

const props = defineProps<{ bookId?: string }>()
const emit = defineEmits<{
  (e: 'back'): void
  (e: 'go-browse', url?: string): void
}>()
const message = useMessage()

const book = ref<Book | null>(null)
const chapters = ref<ChapterMeta[]>([])
const currentChapter = ref<ChapterMeta | null>(null)
const chapterBody = ref('')
const chapterError = ref('')
const hasBodyRaw = ref(false)
const chapterLoading = ref(false)
const contentRef = ref<HTMLElement | null>(null)
const showDrawer = ref(false)
const catalogItemRefs = new Map<string, HTMLElement>()

// Reader prefs (from settings)
const fontSize = ref(DEFAULT_READER_PREFS.fontSize)
const lineHeight = ref(DEFAULT_READER_PREFS.lineHeight)
const theme = ref<ReaderTheme>(DEFAULT_READER_PREFS.theme)
const fontFamily = ref<ReaderFontFamily>(DEFAULT_READER_PREFS.fontFamily)
const contentWidth = ref<ReaderContentWidth>(DEFAULT_READER_PREFS.contentWidth)
const paragraphSpacing = ref<ReaderParagraphSpacing>(DEFAULT_READER_PREFS.paragraphSpacing)
const paragraphIndent = ref(DEFAULT_READER_PREFS.paragraphIndent)
const nightMode = computed({
  get: () => theme.value === 'night',
  set: (enabled: boolean) => { theme.value = enabled ? 'night' : 'paper' },
})

// AI state
const aiLoading = ref(false)
const aiResult = ref('')
const aiResultTitle = ref('')
const showAiResult = ref(false)
const showChat = ref(false)
const showRecap = ref(false)
const recapText = ref('')
const recapJobId = ref('')
const recapJobKind = ref<'chapter' | 'story' | ''>('')
const recapStopping = ref(false)
const recapLoading = computed(() => Boolean(recapJobId.value))
const translateJobId = ref('')
const translateLoading = computed(() => Boolean(translateJobId.value))
const chatMessages = ref<AiChatMessage[]>([])
const chatInput = ref('')
const chatLoading = ref(false)
const chatJobId = ref('')
const chatAssistantIndex = ref(-1)
const catalogQuery = ref('')
const scrollRatioView = ref(0)
const retryingChapter = ref(false)

// 沉浸工具层
const immersiveMode = ref<ReaderImmersiveMode>('normal')
const toolsVisible = ref(true)
const temporaryToolReveal = ref(false)
const pointerInToolbar = ref(false)
const activeToolPanel = ref<'tts' | 'ai' | 'appearance' | null>(null)
let lastToolActivityAt = Date.now()
let toolHideTimer: ReturnType<typeof setTimeout> | null = null

const prefsReady = ref(false)
let prefsSaveTimer: ReturnType<typeof setTimeout> | null = null
let pendingReaderPrefs: ReaderPrefs | null = null
let prefsSaveChain: Promise<void> = Promise.resolve()
let prefsFailureNotified = false

// TTS 朗读
const ttsRate = ref(1)
const ttsAutoNext = ref(true)
const paras = computed(() => splitIntoParagraphs(chapterBody.value))
const {
  supported: ttsSupported,
  speaking: ttsSpeaking,
  paused: ttsPaused,
  spokenPara,
  start: ttsStart,
  pause: ttsPause,
  resume: ttsResume,
  stop: ttsStop,
} = useTts({
  paragraphs: () => paras.value,
  rate: () => ttsRate.value,
  autoNext: () => ttsAutoNext.value,
  onChapterEnd: () => nextChapter(),
})

function readerScrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

watch(spokenPara, (i) => {
  if (i < 0 || !contentRef.value) return
  const el = contentRef.value.querySelector(`[data-p="${i}"]`)
  el?.scrollIntoView({ block: 'center', behavior: readerScrollBehavior() })
})

// 本书内全文搜索
const showSearch = ref(false)
const searchQuery = ref('')
const searching = ref(false)
const searchHits = ref<BookSearchHit[]>([])
let pendingScrollPara = -1

// 书签 / 划线笔记
const annotations = ref<Annotation[]>([])
const lostHighlightIds = ref<Set<string>>(new Set())
const showMarks = ref(false)
const selPopupX = ref(0)
const selPopupY = ref(0)
const showSelPopup = ref(false)
const selectedExcerpt = ref('')
const selectedRange = ref<{ start: number; end: number; text: string } | null>(null)
const showDirectNote = ref(false)
const directNoteDraft = ref('')
const restoringChat = ref(false)
const editingNoteId = ref('')
const noteDraft = ref('')

/** 规范化正文（段落用 \n\n 连接）——笔记坐标的空间 */
const normalizedBody = computed(() => paras.value.join('\n\n'))
const paraNormStarts = computed(() => {
  const starts: number[] = []
  let offset = 0
  for (const p of paras.value) {
    starts.push(offset)
    offset += p.length + 2
  }
  return starts
})

const currentHighlightRanges = computed(() => {
  const cid = currentChapter.value?.id
  if (!cid) return []
  return annotations.value.filter(
    (a) => a.chapterId === cid && a.kind === 'highlight' && !lostHighlightIds.value.has(a.id),
  )
})

/** 当前章各段的渲染切片：叠加搜索命中与划线 */
const renderedParas = computed(() => {
  const q = searchQuery.value.trim()
  const searchingNow = showSearch.value && !!q
  const starts = paraNormStarts.value
  return paras.value.map((text, i) => {
    const base = starts[i] ?? 0
    const localHl =
      searchingNow && q
        ? []
        : currentHighlightRanges.value.map((a) => ({ start: a.start - base, end: a.end - base }))
    return decorateText(text, searchingNow ? q : '', localHl)
  })
})

async function reloadAnnotations() {
  if (!book.value) return
  const res = await window.api.annotations.list(book.value.id)
  if (res.ok) annotations.value = res.items
}

/** 章节打开后校正本章划线：偏移漂移时按摘录重定位，找不到则标记丢失 */
function resolveCurrentAnnotations() {
  const cid = currentChapter.value?.id
  if (!cid || !book.value) return
  const body = normalizedBody.value
  for (const a of annotations.value) {
    if (a.chapterId !== cid || a.kind !== 'highlight') continue
    const fixed = relocateRange(body, a.start, a.end, a.excerpt)
    if (!fixed) {
      lostHighlightIds.value.add(a.id)
      continue
    }
    if (lostHighlightIds.value.has(a.id)) lostHighlightIds.value = new Set([...lostHighlightIds.value].filter((x) => x !== a.id))
    if (fixed.start !== a.start || fixed.end !== a.end) {
      void window.api.annotations.update(book.value.id, a.id, { start: fixed.start, end: fixed.end })
      a.start = fixed.start
      a.end = fixed.end
    }
  }
}

/** 把渲染层选区换算成规范化正文里的字符区间 */
function selectionOffsets(): { start: number; end: number; text: string } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !contentRef.value) return null
  const range = sel.getRangeAt(0)
  const locateEl = (node: Node): Element | null => {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
    return el?.closest('[data-p]') ?? null
  }
  const startP = locateEl(range.startContainer)
  const endP = locateEl(range.endContainer)
  if (!startP || !endP) return null

  const localOffsetIn = (p: Element, container: Node, off: number): number | null => {
    let acc = 0
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const n = walker.currentNode
      if (n === container) return acc + off
      acc += n.textContent?.length ?? 0
    }
    return null
  }
  const l0 = localOffsetIn(startP, range.startContainer, range.startOffset)
  const l1 = localOffsetIn(endP, range.endContainer, range.endOffset)
  if (l0 === null || l1 === null) return null

  const i0 = Number(startP.getAttribute('data-p'))
  const i1 = Number(endP.getAttribute('data-p'))
  const starts = paraNormStarts.value
  const start = (starts[i0] ?? 0) + l0
  const end = (starts[i1] ?? 0) + l1
  if (end <= start) return null
  const text = normalizedBody.value.slice(start, end)
  if (!text.trim()) return null
  return { start, end, text }
}

function onContentMouseup(e: MouseEvent) {
  void e
  // 等选区稳定后再取
  setTimeout(() => {
    const sel = selectionOffsets()
    if (!sel) {
      showSelPopup.value = false
      selectedExcerpt.value = ''
      selectedRange.value = null
      return
    }
    selectedRange.value = sel
    selectedExcerpt.value = sel.text.trim()
    selPopupX.value = Math.max(8, Math.min(window.innerWidth - 360, e.clientX - 120))
    selPopupY.value = Math.min(window.innerHeight - 60, e.clientY + 12)
    showSelPopup.value = true
  }, 0)
}

function closeSelectionTools(clearBrowserSelection = true) {
  showSelPopup.value = false
  showDirectNote.value = false
  directNoteDraft.value = ''
  selectedExcerpt.value = ''
  selectedRange.value = null
  if (clearBrowserSelection) window.getSelection()?.removeAllRanges()
}

async function copySelectedText() {
  const excerpt = selectedExcerpt.value
  if (!excerpt) return
  try {
    await navigator.clipboard.writeText(excerpt)
    message.success('已复制')
    closeSelectionTools()
  } catch {
    message.error('复制失败，请重试')
  }
}

function openDirectNote() {
  if (!selectedRange.value) return
  showSelPopup.value = false
  showDirectNote.value = true
  directNoteDraft.value = ''
}

async function saveDirectNote() {
  const selection = selectedRange.value
  const note = directNoteDraft.value.trim()
  if (!selection || !note || !book.value || !currentChapter.value) return
  const res = await window.api.annotations.add({
    bookId: book.value.id,
    chapterId: currentChapter.value.id,
    kind: 'highlight',
    start: selection.start,
    end: selection.end,
    excerpt: selection.text,
    note,
  })
  if (res.ok) {
    annotations.value.push(res.item)
    message.success('备注已保存')
    closeSelectionTools()
  } else {
    message.error(res.message || '保存失败')
  }
}

async function addHighlight() {
  const sel = selectedRange.value ?? selectionOffsets()
  showSelPopup.value = false
  if (!sel || !book.value || !currentChapter.value) return
  const res = await window.api.annotations.add({
    bookId: book.value.id,
    chapterId: currentChapter.value.id,
    kind: 'highlight',
    start: sel.start,
    end: sel.end,
    excerpt: sel.text,
  })
  if (res.ok) {
    annotations.value.push(res.item)
    message.success('已划线')
  } else {
    message.error(res.message || '划线失败')
  }
  closeSelectionTools()
}

async function askSelectedText() {
  const excerpt = selectedExcerpt.value || getSelectedText()
  showSelPopup.value = false
  if (!excerpt) {
    message.warning('请先在正文中选中要提问的文字')
    return
  }
  if (excerpt.length > 2000) {
    message.warning('选中过长，请缩短后再问')
    return
  }
  if (chatLoading.value) {
    message.warning('请先停止当前生成')
    return
  }
  if (!book.value) return
  restoringChat.value = true
  showChat.value = true
  const history = await window.api.ai.getChat(book.value.id)
  if (history.ok) chatMessages.value = history.messages
  restoringChat.value = false
  chatInput.value = `这段话是什么意思？结合剧情解释一下。\n\n「${excerpt}」`
  closeSelectionTools()
  await sendChat()
}

const chapterBookmark = computed(
  () =>
    annotations.value.find(
      (a) => a.kind === 'bookmark' && a.chapterId === currentChapter.value?.id,
    ) ?? null,
)

async function toggleBookmark() {
  if (!book.value || !currentChapter.value) return
  const existing = chapterBookmark.value
  if (existing) {
    const res = await window.api.annotations.remove(book.value.id, existing.id)
    if (res.ok) {
      annotations.value = annotations.value.filter((a) => a.id !== existing.id)
      message.info('已移除书签')
    } else {
      message.error(res.message || '移除失败')
    }
    return
  }
  const res = await window.api.annotations.add({
    bookId: book.value.id,
    chapterId: currentChapter.value.id,
    kind: 'bookmark',
    start: 0,
    end: 0,
    excerpt: '',
  })
  if (res.ok) {
    annotations.value.push(res.item)
    message.success('已加书签')
  } else {
    message.error(res.message || '加书签失败')
  }
}

const sortedMarks = computed(() => {
  const order = new Map(chapters.value.map((c, i) => [c.id, i]))
  return [...annotations.value].sort(
    (a, b) => (order.get(a.chapterId) ?? 1e9) - (order.get(b.chapterId) ?? 1e9) || a.start - b.start,
  )
})

async function jumpToAnnotation(a: Annotation) {
  if (!book.value) return
  const ch = chapters.value.find((c) => c.id === a.chapterId)
  if (!ch) return
  if (a.kind === 'highlight') {
    const i = paraNormStarts.value.findIndex((s, idx) => s <= a.start && a.start < s + (paras.value[idx]?.length ?? 0) + 2)
    pendingScrollPara = i >= 0 ? i : 0
  } else {
    pendingScrollPara = -1
  }
  await openChapter(ch, a.kind === 'highlight' ? 0 : 0)
  if (pendingScrollPara === -1) scrollToRatio(0)
}

async function saveNote(a: Annotation) {
  if (!book.value) return
  const res = await window.api.annotations.update(book.value.id, a.id, { note: noteDraft.value })
  if (res.ok) {
    a.note = res.item.note
    message.success('备注已保存')
  } else {
    message.error(res.message || '保存失败')
  }
  editingNoteId.value = ''
}

function deleteConfirmText(annotation: Annotation): string {
  if (annotation.kind === 'bookmark') return '删除这条书签？删除后无法恢复。'
  if (annotation.note) return '删除这条划线与备注？删除后无法恢复。'
  return '删除这条划线？删除后无法恢复。'
}

async function deleteAnnotation(a: Annotation) {
  if (!book.value) return
  const res = await window.api.annotations.remove(book.value.id, a.id)
  if (res.ok) {
    annotations.value = annotations.value.filter((x) => x.id !== a.id)
  } else {
    message.error(res.message || '删除失败')
  }
}

function openSearch() {
  showSearch.value = true
}

async function runSearch() {
  if (!book.value || !searchQuery.value.trim()) return
  searching.value = true
  try {
    const res = await window.api.library.searchInBook(book.value.id, searchQuery.value)
    if (res.ok) {
      searchHits.value = res.hits
      if (!res.hits.length) message.info('本书内没有找到这段文字')
    } else {
      message.error(res.message || '搜索失败')
    }
  } finally {
    searching.value = false
  }
}

async function jumpToHit(hit: BookSearchHit) {
  if (!book.value) return
  const ch = chapters.value.find((c) => c.id === hit.chapterId)
  if (!ch) return
  pendingScrollPara = hit.paraIndex
  await openChapter(ch, 0)
}

function scrollToPendingPara() {
  if (pendingScrollPara < 0 || !contentRef.value) return
  const i = pendingScrollPara
  pendingScrollPara = -1
  void nextTick(() => {
    contentRef.value?.querySelector(`[data-p="${i}"]`)?.scrollIntoView({ block: 'center' })
  })
}

// Keyboard shortcuts
const FONT_MIN = 12
const FONT_MAX = 36

function anyDrawerOpen() {
  return (
    showDrawer.value ||
    showAiResult.value ||
    showChat.value ||
    showSearch.value ||
    showMarks.value ||
    showRecap.value ||
    activeToolPanel.value !== null
  )
}

function selectionOpen() {
  return showSelPopup.value || showDirectNote.value || Boolean(selectedExcerpt.value)
}

function clearToolHideTimer() {
  if (!toolHideTimer) return
  clearTimeout(toolHideTimer)
  toolHideTimer = null
}

function scheduleToolHide() {
  clearToolHideTimer()
  if (anyDrawerOpen() || selectionOpen() || pointerInToolbar.value) {
    toolsVisible.value = true
    return
  }
  const elapsed = Date.now() - lastToolActivityAt
  toolHideTimer = setTimeout(() => {
    const idleMs = Date.now() - lastToolActivityAt
    if (
      shouldAutoHideReaderTools({
        idleMs,
        overlayOpen: anyDrawerOpen(),
        selectionOpen: selectionOpen(),
        pointerInToolbar: pointerInToolbar.value,
      })
    ) {
      toolsVisible.value = false
      temporaryToolReveal.value = false
    } else {
      scheduleToolHide()
    }
  }, Math.max(0, 3000 - elapsed))
}

function revealTools(temporary = false) {
  toolsVisible.value = true
  temporaryToolReveal.value = temporary
  lastToolActivityAt = Date.now()
  scheduleToolHide()
}

function onReaderPointerMove(e: MouseEvent) {
  if (immersiveMode.value === 'locked') {
    if (e.clientY <= 64) revealTools(true)
    return
  }
  revealTools(false)
}

function onToolbarEnter() {
  pointerInToolbar.value = true
  revealTools(immersiveMode.value === 'locked')
}

function onToolbarLeave() {
  pointerInToolbar.value = false
  if (immersiveMode.value === 'locked' && temporaryToolReveal.value && !anyDrawerOpen() && !selectionOpen()) {
    toolsVisible.value = false
    temporaryToolReveal.value = false
    return
  }
  lastToolActivityAt = Date.now()
  scheduleToolHide()
}

function toggleToolPanel(panel: 'tts' | 'ai' | 'appearance') {
  activeToolPanel.value = activeToolPanel.value === panel ? null : panel
  revealTools(immersiveMode.value === 'locked')
}

function toggleImmersiveLock() {
  const result = resolveImmersiveKey('m', immersiveMode.value)
  if (!result) return
  immersiveMode.value = result.mode
  toolsVisible.value = result.toolsVisible
  temporaryToolReveal.value = result.temporaryReveal
  lastToolActivityAt = Date.now()
  scheduleToolHide()
}

function closeTopReaderOverlay() {
  if (showAiResult.value) showAiResult.value = false
  else if (showChat.value) showChat.value = false
  else if (showRecap.value) showRecap.value = false
  else if (showSearch.value) showSearch.value = false
  else if (showMarks.value) showMarks.value = false
  else if (showDrawer.value) showDrawer.value = false
  else if (activeToolPanel.value) activeToolPanel.value = null
}

function toggleTtsFromShortcut() {
  activeToolPanel.value = 'tts'
  revealTools(immersiveMode.value === 'locked')
  if (!ttsSupported.value) return
  if (!ttsSpeaking.value) ttsStart(0)
  else if (ttsPaused.value) ttsResume()
  else ttsPause()
}

function onReaderResize() {
  if (selectionOpen()) closeSelectionTools()
}

function pageByScreen(direction: 1 | -1) {
  const el = contentRef.value
  if (!el) return
  el.scrollBy({ top: direction * el.clientHeight * 0.9, behavior: readerScrollBehavior() })
}

function setFontSize(next: number) {
  fontSize.value = Math.max(FONT_MIN, Math.min(FONT_MAX, next))
}

function onReaderKeydown(e: KeyboardEvent) {
  if (!book.value) return
  const target = e.target as HTMLElement | null
  const isTextEntry = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT' || Boolean(target?.isContentEditable)
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
    if (isTextEntry) return
    e.preventDefault()
    openSearch()
    revealTools(immersiveMode.value === 'locked')
    return
  }
  if (e.key === 'Escape' && selectionOpen()) {
    e.preventDefault()
    closeSelectionTools()
    revealTools(immersiveMode.value === 'locked')
    return
  }
  if (!isTextEntry && !(e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'm' || e.key === 'Alt' || (e.key === 'Escape' && !anyDrawerOpen()))) {
    const result = resolveImmersiveKey(e.key, immersiveMode.value)
    if (result) {
      e.preventDefault()
      immersiveMode.value = result.mode
      toolsVisible.value = result.toolsVisible
      temporaryToolReveal.value = result.temporaryReveal
      lastToolActivityAt = Date.now()
      scheduleToolHide()
      return
    }
  }
  const action = resolveReaderKey({
    key: e.key,
    targetTag: target?.tagName ?? null,
    isContentEditable: Boolean(target?.isContentEditable),
    anyDrawerOpen: anyDrawerOpen(),
    ctrlOrMeta: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
  })
  if (!action) return
  switch (action) {
    case 'prev-chapter':
      prevChapter()
      break
    case 'next-chapter':
      nextChapter()
      break
    case 'page-down':
      e.preventDefault()
      pageByScreen(1)
      break
    case 'page-up':
      e.preventDefault()
      pageByScreen(-1)
      break
    case 'font-larger':
      setFontSize(fontSize.value + 1)
      break
    case 'font-smaller':
      setFontSize(fontSize.value - 1)
      break
    case 'open-catalog':
      showDrawer.value = true
      revealTools(immersiveMode.value === 'locked')
      break
    case 'open-appearance':
      activeToolPanel.value = 'appearance'
      revealTools(immersiveMode.value === 'locked')
      break
    case 'toggle-tts':
      toggleTtsFromShortcut()
      break
    case 'close-drawer':
      closeTopReaderOverlay()
      revealTools(immersiveMode.value === 'locked')
      break
  }
}

// Debounced scroll save
let scrollTimer: ReturnType<typeof setTimeout> | null = null
let unsubDownload: (() => void) | null = null
let unsubAiChunk: (() => void) | null = null
let unsubAiDone: (() => void) | null = null

const nightClass = computed(() => (nightMode.value ? 'night' : ''))
const themeTokens: Record<ReaderTheme, { paper: string; text: string; outer: string }> = {
  paper: { paper: '#F7F3E8', text: '#2F2A24', outer: '#E9E3D7' },
  sepia: { paper: '#F3E2B8', text: '#3A2F22', outer: '#E6D2A4' },
  gray: { paper: '#E5E7E6', text: '#252A2D', outer: '#D6D9D8' },
  night: { paper: '#1B1D20', text: '#D8D2C7', outer: '#111316' },
}
const fontStacks: Record<ReaderFontFamily, string> = {
  serif: '"STSong", "Songti SC", "SimSun", serif',
  system: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  mono: '"Cascadia Mono", "Consolas", monospace',
}
const widthValues: Record<ReaderContentWidth, string> = { narrow: '32em', medium: '38em', wide: '46em' }
const spacingValues: Record<ReaderParagraphSpacing, string> = { compact: '0.2em', normal: '0.45em', relaxed: '0.8em' }
const readerThemeStyle = computed(() => ({
  '--reader-paper': themeTokens[theme.value].paper,
  '--reader-paper-text': themeTokens[theme.value].text,
  '--reader-outer': themeTokens[theme.value].outer,
}))
const contentStyle = computed(() => ({
  fontSize: fontSize.value + 'px',
  lineHeight: lineHeight.value,
  fontFamily: fontStacks[fontFamily.value],
  width: `min(100%, ${widthValues[contentWidth.value]})`,
  maxWidth: widthValues[contentWidth.value],
  flexBasis: widthValues[contentWidth.value],
  '--paragraph-spacing': spacingValues[paragraphSpacing.value],
  '--paragraph-indent': paragraphIndent.value ? '2em' : '0',
}))
const chapterReady = computed(() => Boolean(currentChapter.value && currentChapter.value.status === 'ready' && chapterBody.value))
const canRetryChapter = computed(() => {
  const ch = currentChapter.value
  if (!book.value || !ch) return false
  if (book.value.importType !== 'download') return false
  return ch.status === 'failed' || ch.status === 'empty' || ch.status === 'pending'
})
const filteredCatalog = computed(() => filterCatalogChapters(chapters.value, catalogQuery.value))
const currentChapterIndex = computed(() => chapters.value.findIndex((chapter) => chapter.id === currentChapter.value?.id))
const previousChapter = computed(() => currentChapterIndex.value > 0 ? chapters.value[currentChapterIndex.value - 1] : null)
const followingChapter = computed(() => currentChapterIndex.value >= 0 && currentChapterIndex.value < chapters.value.length - 1 ? chapters.value[currentChapterIndex.value + 1] : null)
const bookProgressRatio = computed(() => approximateBookRatio(chapters.value, currentChapter.value?.id, scrollRatioView.value))
const chapterPercent = computed(() => Math.round(scrollRatioView.value * 100))
const bookPercent = computed(() => Math.round(bookProgressRatio.value * 100))
const remainingChapters = computed(() => remainingChapterCount(chapters.value, currentChapter.value?.id))
const bookProgressDetail = computed(() => `全书 ${bookPercent.value}% · 本章 ${chapterPercent.value}% · 还剩 ${remainingChapters.value} 章`)
const progressSummary = computed(() =>
  readerProgressLabel(chapters.value, currentChapter.value?.id, scrollRatioView.value),
)
const chapterFailHint = computed(() => failAdvice(currentChapter.value?.failCode))

async function loadBook(bookId: string) {
  const previousChapterId = currentChapter.value?.id
  saveProgress()
  const res = await window.api.library.get(bookId)
  if (res.book) {
    book.value = res.book
    chapters.value = res.book.chapters
    currentChapter.value = null
    lostHighlightIds.value = new Set()
    await reloadAnnotations()
    if (previousChapterId) {
      const retained = chapters.value.find((chapter) => chapter.id === previousChapterId)
      if (retained) {
        await openChapter(retained, scrollRatioView.value)
        return
      }
      if (chapters.value.length > 0) message.info('原章节已不存在，已打开第一章。')
    }
    if (res.book.progress) {
      const ch = chapters.value.find((c) => c.id === res.book!.progress!.chapterId)
      if (ch) {
        await openChapter(ch, res.book.progress.scrollRatio)
        return
      }
    }
    if (chapters.value.length > 0) await openChapter(chapters.value[0], 0)
  }
}

async function openChapter(ch: ChapterMeta, scrollRatio = 0) {
  if (!book.value) return
  closeSelectionTools()
  ttsStop()
  if (currentChapter.value && currentChapter.value.id !== ch.id) saveProgress()
  chapterLoading.value = true
  try {
    const res = await window.api.library.readChapter(book.value.id, ch.id)
    if (res.chapter) {
      currentChapter.value = { ...ch, status: res.chapter.status, failCode: res.chapter.failCode }
      chapterBody.value = res.chapter.body || ''
      hasBodyRaw.value = Boolean(res.chapter.bodyRaw) && res.chapter.bodyRaw !== res.chapter.body
      const failText = res.chapter.failCode ? FAIL_CODE_ZH[res.chapter.failCode] : ''
      if (res.chapter.status !== 'ready' || !res.chapter.body) {
        chapterError.value = failText || (res.chapter.status === 'pending' ? '这一章还没下载' : '这一章没有正文')
      } else {
        chapterError.value = ''
      }
      showDrawer.value = false
      scrollRatioView.value = scrollRatio
      resolveCurrentAnnotations()
      await nextTick()
      if (pendingScrollPara >= 0) {
        scrollToPendingPara()
      } else {
        scrollToRatio(scrollRatio)
      }
    } else {
      currentChapter.value = ch
      chapterBody.value = ''
      hasBodyRaw.value = false
      chapterError.value = res.message || '无法打开这一章'
    }
  } finally {
    chapterLoading.value = false
  }
}

function scrollToRatio(ratio: number) {
  const el = contentRef.value
  if (!el) return
  requestAnimationFrame(() => {
    el.scrollTop = scrollTopFromRatio(ratio, el.scrollHeight, el.clientHeight)
  })
}

function saveProgress() {
  if (!book.value || !currentChapter.value || !contentRef.value) return
  const el = contentRef.value
  const scrollRatio = chapterScrollRatio(el.scrollTop, el.scrollHeight, el.clientHeight)
  void window.api.library.setProgress(book.value.id, {
    chapterId: currentChapter.value.id,
    scrollRatio,
    updatedAt: new Date().toISOString(),
  })
}

function onScroll() {
  if (selectionOpen()) closeSelectionTools()
  const el = contentRef.value
  if (el) scrollRatioView.value = chapterScrollRatio(el.scrollTop, el.scrollHeight, el.clientHeight)
  if (scrollTimer) clearTimeout(scrollTimer)
  scrollTimer = setTimeout(saveProgress, 1000)
}

function goBrowseForChapter() {
  const url = currentChapter.value?.url || book.value?.sourceUrl
  emit('go-browse', url)
}

async function retryThisChapter() {
  if (!book.value) return
  retryingChapter.value = true
  try {
    const res = await window.api.download.retryFailed(book.value.id)
    if (!res.ok) {
      message.error(res.message || '重试失败')
      return
    }
    message.info('已开始重试失败章')
  } finally {
    retryingChapter.value = false
  }
}

function prevChapter() {
  if (!currentChapter.value) return
  const i = chapters.value.findIndex((c) => c.id === currentChapter.value!.id)
  if (i > 0) openChapter(chapters.value[i - 1], 1)
}

function nextChapter() {
  if (!currentChapter.value) return
  const i = chapters.value.findIndex((c) => c.id === currentChapter.value!.id)
  if (i < chapters.value.length - 1) openChapter(chapters.value[i + 1], 0)
}

function goToChapterId(chId: string) {
  const ch = chapters.value.find((c) => c.id === chId)
  if (ch) openChapter(ch, 0)
}

function setCatalogItemRef(chapterId: string, element: unknown) {
  if (element instanceof HTMLElement) catalogItemRefs.set(chapterId, element)
  else catalogItemRefs.delete(chapterId)
}

async function scrollCatalogToCurrent() {
  await nextTick()
  const id = currentChapter.value?.id
  if (id) catalogItemRefs.get(id)?.scrollIntoView({ block: 'center' })
}

function currentReaderPrefs(): ReaderPrefs {
  return {
    fontSize: fontSize.value,
    lineHeight: lineHeight.value,
    theme: theme.value,
    fontFamily: fontFamily.value,
    contentWidth: contentWidth.value,
    paragraphSpacing: paragraphSpacing.value,
    paragraphIndent: paragraphIndent.value,
  }
}

async function saveReaderPrefsSnapshot(snapshot: ReaderPrefs) {
  try {
    await window.api.settings.set({ reader: snapshot })
    prefsFailureNotified = false
  } catch {
    if (!prefsFailureNotified) {
      prefsFailureNotified = true
      message.error('阅读设置保存失败，重启后可能无法保留。')
    }
  }
}

function flushReaderPrefsSave() {
  if (prefsSaveTimer) {
    clearTimeout(prefsSaveTimer)
    prefsSaveTimer = null
  }
  const snapshot = pendingReaderPrefs
  pendingReaderPrefs = null
  if (!snapshot) return prefsSaveChain
  prefsSaveChain = prefsSaveChain.then(() => saveReaderPrefsSnapshot(snapshot))
  return prefsSaveChain
}

function scheduleReaderPrefsSave() {
  pendingReaderPrefs = currentReaderPrefs()
  if (prefsSaveTimer) clearTimeout(prefsSaveTimer)
  prefsSaveTimer = setTimeout(() => { void flushReaderPrefsSave() }, 300)
}

function restoreDefaultReaderPrefs() {
  fontSize.value = DEFAULT_READER_PREFS.fontSize
  lineHeight.value = DEFAULT_READER_PREFS.lineHeight
  theme.value = DEFAULT_READER_PREFS.theme
  fontFamily.value = DEFAULT_READER_PREFS.fontFamily
  contentWidth.value = DEFAULT_READER_PREFS.contentWidth
  paragraphSpacing.value = DEFAULT_READER_PREFS.paragraphSpacing
  paragraphIndent.value = DEFAULT_READER_PREFS.paragraphIndent
  message.success('已恢复默认阅读设置')
}

async function loadPrefs() {
  const s = await window.api.settings.get()
  fontSize.value = s.reader.fontSize
  lineHeight.value = s.reader.lineHeight
  theme.value = s.reader.theme
  fontFamily.value = s.reader.fontFamily
  contentWidth.value = s.reader.contentWidth
  paragraphSpacing.value = s.reader.paragraphSpacing
  paragraphIndent.value = s.reader.paragraphIndent
  ttsRate.value = clampTtsRate(s.tts?.rate ?? 1)
  ttsAutoNext.value = s.tts?.autoNextChapter ?? true
}

// AI actions
async function aiCleanBody() {
  if (!book.value || !currentChapter.value) return
  aiLoading.value = true
  aiResultTitle.value = '清正文'
  try {
    const res = await window.api.ai.clean(book.value.id, currentChapter.value.id)
    if (res.ok && res.result) {
      aiResult.value = res.result.cleaned
      showAiResult.value = true
    } else {
      message.error(res.message || '清正文失败')
    }
  } finally {
    aiLoading.value = false
  }
}

async function applyCleanedBody() {
  if (!book.value || !currentChapter.value || !aiResult.value) return
  await window.api.library.updateChapterBody(book.value.id, currentChapter.value.id, aiResult.value)
  chapterBody.value = aiResult.value
  hasBodyRaw.value = true
  showAiResult.value = false
  message.success('已应用到正文')
}

async function restoreCleanedBody() {
  if (!book.value || !currentChapter.value) return
  const res = await window.api.library.updateChapterBody(book.value.id, currentChapter.value.id, '', true)
  if (res && 'ok' in res && res.ok === false) {
    message.error((res as { message?: string }).message || '撤销失败')
    return
  }
  const ch = await window.api.library.readChapter(book.value.id, currentChapter.value.id)
  if (ch.chapter) {
    chapterBody.value = ch.chapter.body
    hasBodyRaw.value = false
  }
}

async function aiSummarize() {
  if (!book.value || !currentChapter.value) return
  aiLoading.value = true
  aiResultTitle.value = '前情摘要'
  try {
    const res = await window.api.ai.summarize(book.value.id, currentChapter.value.id)
    if (res.ok) {
      aiResult.value = res.text
      showAiResult.value = true
    } else {
      message.error(res.message || '摘要失败')
    }
  } finally {
    aiLoading.value = false
  }
}

async function loadStoredRecap() {
  if (!book.value) return
  if (!book.value.progress?.chapterId) {
    recapText.value = '还没有阅读进度，打开阅读器读几章再来。'
    return
  }
  const res = await window.api.ai.getSummaries(book.value.id)
  recapText.value = res.ok ? (res.summaries.storySoFar?.text || '还没有前情提要。请先「生成本章摘要」，再点「刷新看到这里」。') : res.message
}

async function openRecap() {
  if (!book.value) return
  showRecap.value = true
  if (!recapLoading.value) await loadStoredRecap()
}

async function startRecap(kind: 'chapter' | 'story') {
  if (!book.value || !currentChapter.value) return
  const uptoChapterId = kind === 'chapter' ? currentChapter.value.id : book.value.progress?.chapterId
  if (!uptoChapterId) {
    recapText.value = '还没有阅读进度，打开阅读器读几章再来。'
    return
  }
  const res = kind === 'chapter'
    ? await window.api.ai.summarizeChapter(book.value.id, uptoChapterId)
    : await window.api.ai.storySoFar(book.value.id, uptoChapterId)
  if (!res.ok) {
    message.error(res.message)
    return
  }
  recapStopping.value = false
  recapJobId.value = res.jobId
  recapJobKind.value = kind
  recapText.value = ''
  showRecap.value = true
}

function stopRecap() {
  if (!recapJobId.value) return
  recapStopping.value = true
  void window.api.ai.cancel(recapJobId.value)
}

function getSelectedText(): string {
  const sel = window.getSelection()
  return sel ? sel.toString().trim() : ''
}

async function translateSelectedText() {
  const text = selectedExcerpt.value || getSelectedText()
  showSelPopup.value = false
  if (!text) {
    message.warning('请先在正文中选中要翻译的文字')
    return
  }
  if (text.length > 2000) {
    message.warning('选中过长，请缩短后再问')
    return
  }
  if (translateJobId.value) {
    showAiResult.value = true
    message.warning('请先停止当前生成')
    return
  }
  const res = await window.api.ai.translateStream(text)
  if (!res.ok) {
    message.error(res.message)
    return
  }
  translateJobId.value = res.jobId
  aiResultTitle.value = '翻译'
  aiResult.value = ''
  showAiResult.value = true
  closeSelectionTools()
}

function stopTranslate() {
  if (translateJobId.value) void window.api.ai.cancel(translateJobId.value)
}

function askSuggested(question: string) {
  if (chatLoading.value) {
    message.warning('请先停止当前生成')
    return
  }
  chatInput.value = question
  void sendChat()
}

async function sendChat() {
  if (!book.value || !currentChapter.value || !chatInput.value.trim()) return
  if (chatLoading.value) {
    message.warning('请先停止当前生成')
    return
  }
  const userMsg = chatInput.value.trim()
  chatMessages.value.push({ role: 'user', content: userMsg })
  chatInput.value = ''
  const res = await window.api.ai.chatStream(book.value.id, currentChapter.value.id, chatMessages.value)
  if (!res.ok) {
    chatMessages.value.push({ role: 'assistant', content: `错误：${res.message}` })
    return
  }
  chatJobId.value = res.jobId
  chatLoading.value = true
  chatMessages.value.push({ role: 'assistant', content: '' })
  chatAssistantIndex.value = chatMessages.value.length - 1
}

function stopChat() {
  if (chatJobId.value) void window.api.ai.cancel(chatJobId.value)
}

async function clearChat() {
  if (!book.value || chatLoading.value) return
  const res = await window.api.ai.clearChat(book.value.id)
  if (res.ok) {
    chatMessages.value = []
    chatInput.value = ''
  } else {
    message.error(res.message)
  }
}

async function aiCharacterCard() {
  if (!book.value || !currentChapter.value) return
  aiLoading.value = true
  aiResultTitle.value = '人物卡'
  try {
    const res = await window.api.ai.characterCard(book.value.id, currentChapter.value.id)
    if (res.ok) {
      aiResult.value = formatCharacterCard(res.card, (chapterId) => {
        const ch = chapters.value.find((c) => c.id === chapterId)
        const idx = chapters.value.findIndex((c) => c.id === chapterId)
        return idx >= 0 ? `第 ${ch?.index ?? idx + 1} 章 ${ch?.title ?? ''}` : chapterId
      })
    } else {
      // 没配 Key 等失败时，展示上次保存的人物卡
      const stored = await window.api.ai.getCharacterCard(book.value.id)
      if (stored.ok && stored.card) {
        message.warning(`${res.message}；以下为上次生成的人物卡`)
        aiResult.value = formatCharacterCard(stored.card, (chapterId) => {
          const ch = chapters.value.find((c) => c.id === chapterId)
          const idx = chapters.value.findIndex((c) => c.id === chapterId)
          return idx >= 0 ? `第 ${ch?.index ?? idx + 1} 章 ${ch?.title ?? ''}` : chapterId
        })
      } else {
        message.error(res.message || '生成人物卡失败')
        return
      }
    }
    showAiResult.value = true
  } finally {
    aiLoading.value = false
  }
}

watch(
  [fontSize, lineHeight, theme, fontFamily, contentWidth, paragraphSpacing, paragraphIndent],
  () => {
    if (!prefsReady.value) return
    scheduleReaderPrefsSave()
  },
)

watch([ttsRate, ttsAutoNext], () => {
  if (!prefsReady.value) return
  void window.api.settings.set({
    tts: { rate: clampTtsRate(ttsRate.value), autoNextChapter: ttsAutoNext.value },
  })
})

watch(() => props.bookId, (id) => { if (id) loadBook(id) })
watch(showChat, async (open) => {
  if (!open || !book.value || chatLoading.value || restoringChat.value) return
  const res = await window.api.ai.getChat(book.value.id)
  if (res.ok) chatMessages.value = res.messages
})
watch(showDrawer, (open) => { if (open) void scrollCatalogToCurrent() })
watch(
  [showDrawer, showAiResult, showChat, showSearch, showMarks, showRecap, showSelPopup, activeToolPanel],
  () => {
    if (anyDrawerOpen() || selectionOpen()) toolsVisible.value = true
    lastToolActivityAt = Date.now()
    scheduleToolHide()
  },
)

onMounted(async () => {
  window.addEventListener('keydown', onReaderKeydown)
  window.addEventListener('resize', onReaderResize)
  unsubAiChunk = window.api.ai.onChunk(({ jobId, delta }) => {
    if (jobId === recapJobId.value) recapText.value += delta
    if (jobId === translateJobId.value) aiResult.value += delta
    if (jobId === chatJobId.value && chatAssistantIndex.value >= 0) {
      const assistant = chatMessages.value[chatAssistantIndex.value]
      if (assistant) assistant.content += delta
    }
  })
  unsubAiDone = window.api.ai.onDone((event) => {
    if (event.jobId === translateJobId.value) {
      translateJobId.value = ''
      aiResult.value = event.ok ? event.text : `错误：${event.message}`
      return
    }
    if (event.jobId === chatJobId.value) {
      const assistantIndex = chatAssistantIndex.value
      const assistant = chatMessages.value[assistantIndex]
      if (event.ok) {
        if (assistant) assistant.content = event.text
        if (!event.text && assistantIndex >= 0) chatMessages.value.splice(assistantIndex, 1)
      } else if (assistant) {
        assistant.content = `错误：${event.message}`
      }
      chatJobId.value = ''
      chatAssistantIndex.value = -1
      chatLoading.value = false
      return
    }
    if (event.jobId !== recapJobId.value) return
    const kind = recapJobKind.value
    const stopped = recapStopping.value
    recapJobId.value = ''
    recapJobKind.value = ''
    recapStopping.value = false
    if (stopped) {
      void loadStoredRecap()
      return
    }
    if (event.ok) {
      if (kind === 'chapter') {
        message.success('本章摘要已保存')
        void loadStoredRecap()
      } else {
        recapText.value = event.text
      }
    } else {
      recapText.value = `错误：${event.message}`
    }
  })
  await loadPrefs()
  prefsReady.value = true
  lastToolActivityAt = Date.now()
  scheduleToolHide()
  if (props.bookId) await loadBook(props.bookId)
  unsubDownload = window.api.download.onProgress((p) => {
    if (!book.value || p.bookId !== book.value.id) return
    if (p.status === 'done' || p.status === 'error' || p.status === 'cancelled') {
      void loadBook(book.value.id)
    }
  })
})

onUnmounted(() => {
  window.removeEventListener('keydown', onReaderKeydown)
  window.removeEventListener('resize', onReaderResize)
  ttsStop()
  if (scrollTimer) clearTimeout(scrollTimer)
  clearToolHideTimer()
  void flushReaderPrefsSave()
  unsubDownload?.()
  unsubAiChunk?.()
  unsubAiDone?.()
  saveProgress()
})
</script>

<template>
  <div :class="['reader-wrap', nightClass, { 'immersive-locked': immersiveMode === 'locked' }]" :style="readerThemeStyle" @mousemove="onReaderPointerMove">
    <!-- No book selected -->
    <div v-if="!book" class="page placeholder">
      <h2>阅读</h2>
      <p>从书库打开一本书后在这里阅读。</p>
      <n-button @click="emit('back')">返回书库</n-button>
    </div>

    <!-- Reader -->
    <template v-else>
      <div
        :class="['reader-toolbar', { visible: toolsVisible }]"
        @mouseenter="onToolbarEnter"
        @mouseleave="onToolbarLeave"
      >
        <button class="tool-button" title="返回书库" aria-label="返回书库" @click="emit('back')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6M9 12h10"/></svg></button>
        <button class="tool-button" title="目录" aria-label="目录" @click="showDrawer = true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
        <div class="reader-book-title" :title="`${book.title} · ${currentChapter?.title || ''}`">《{{ book.title }}》· {{ currentChapter?.title }}</div>
        <button class="tool-button" title="搜索" aria-label="搜索" @click="openSearch"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg></button>
        <button class="tool-button" title="标记" aria-label="标记" @click="showMarks = true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z"/></svg></button>
        <button class="tool-button" title="朗读" aria-label="朗读" @click="toggleToolPanel('tts')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h4l5 4V6L9 10zM18 9a5 5 0 0 1 0 6"/></svg></button>
        <button class="tool-button" title="AI" aria-label="AI" @click="toggleToolPanel('ai')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 9.8 8.8 4 11l5.8 2.2L12 19l2.2-5.8L20 11l-5.8-2.2z"/></svg></button>
        <button class="tool-button" title="外观" aria-label="外观" @click="toggleToolPanel('appearance')"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z"/></svg></button>
        <button class="tool-button" :title="immersiveMode === 'locked' ? '退出沉浸模式' : '沉浸模式'" :aria-label="immersiveMode === 'locked' ? '退出沉浸模式' : '沉浸模式'" @click="toggleImmersiveLock"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg></button>

        <div v-if="activeToolPanel" class="tool-panel" @click.stop>
          <template v-if="activeToolPanel === 'appearance'">
            <strong>阅读外观</strong>
            <div class="control-label">主题</div>
            <div class="option-grid four"><button v-for="item in [{v:'paper',l:'纸白'},{v:'sepia',l:'暖黄'},{v:'gray',l:'柔灰'},{v:'night',l:'夜间'}]" :key="item.v" :class="{ active: theme === item.v }" @click="theme = item.v as ReaderTheme">{{ item.l }}</button></div>
            <div class="control-label">字体</div>
            <div class="option-grid"><button v-for="item in [{v:'serif',l:'宋体阅读'},{v:'system',l:'系统黑体'},{v:'mono',l:'等宽'}]" :key="item.v" :class="{ active: fontFamily === item.v }" @click="fontFamily = item.v as ReaderFontFamily">{{ item.l }}</button></div>
            <div class="control-label">字号 {{ fontSize }}</div><n-slider v-model:value="fontSize" :min="12" :max="36" :step="1" />
            <div class="control-label">行距 {{ lineHeight.toFixed(1) }}</div><n-slider v-model:value="lineHeight" :min="1.2" :max="3" :step="0.1" />
            <div class="control-label">列宽</div>
            <div class="option-grid"><button v-for="item in [{v:'narrow',l:'窄'},{v:'medium',l:'中'},{v:'wide',l:'宽'}]" :key="item.v" :class="{ active: contentWidth === item.v }" @click="contentWidth = item.v as ReaderContentWidth">{{ item.l }}</button></div>
            <div class="control-label">段间距</div>
            <div class="option-grid"><button v-for="item in [{v:'compact',l:'紧凑'},{v:'normal',l:'标准'},{v:'relaxed',l:'宽松'}]" :key="item.v" :class="{ active: paragraphSpacing === item.v }" @click="paragraphSpacing = item.v as ReaderParagraphSpacing">{{ item.l }}</button></div>
            <div class="control-label"><n-switch v-model:value="paragraphIndent" /> 首行缩进</div>
            <n-button size="small" @click="restoreDefaultReaderPrefs">恢复默认</n-button>
          </template>
          <template v-else-if="activeToolPanel === 'tts'">
            <strong>朗读</strong>
            <n-space vertical :size="6" v-if="ttsSupported">
              <n-space :size="6"><n-button v-if="!ttsSpeaking" size="tiny" :disabled="!chapterReady" @click="ttsStart(0)">播放</n-button><n-button v-else-if="ttsPaused" size="tiny" type="primary" @click="ttsResume">继续</n-button><n-button v-else size="tiny" @click="ttsPause">暂停</n-button><n-button v-if="ttsSpeaking" size="tiny" @click="ttsStop">停止</n-button></n-space>
              <div class="control-label">语速 {{ ttsRate.toFixed(1) }}x</div><n-slider v-model:value="ttsRate" :min="0.5" :max="2" :step="0.1" />
              <div class="control-label"><n-switch v-model:value="ttsAutoNext" /> 自动下一章</div>
            </n-space>
            <div v-else class="control-label">当前环境不支持朗读</div>
          </template>
          <template v-else>
            <strong>AI</strong>
            <n-space vertical :size="6"><n-button size="tiny" block :disabled="!chapterReady" :loading="aiLoading" @click="aiCleanBody">清正文</n-button><n-button v-if="hasBodyRaw" size="tiny" block @click="restoreCleanedBody">撤销清正文</n-button><n-button size="tiny" block @click="openRecap">看到这里</n-button><n-button size="tiny" block :disabled="!chapterReady" :loading="aiLoading" @click="aiCharacterCard">人物卡</n-button><n-button size="tiny" block :disabled="!chapterReady" @click="showChat = true">聊书</n-button></n-space>
          </template>
        </div>
      </div>

      <div class="reader-body">
        <button class="chapter-hotzone left" :disabled="!previousChapter" :title="previousChapter ? `上一章：${previousChapter.title}` : '已经是第一章'" aria-label="上一章" @click="prevChapter"><span>‹</span></button>
        <div class="reader-content reader-pane" :style="contentStyle" ref="contentRef" @scroll="onScroll" @mouseup="onContentMouseup">
          <div v-if="chapterLoading" class="loading-hint">正在打开章节…</div>
          <template v-else>
            <h3 class="ch-title">{{ currentChapter?.title }}</h3>
            <p v-if="chapterError" class="chapter-error">{{ chapterError }}</p>
            <p v-if="chapterFailHint" class="chapter-hint">{{ chapterFailHint }}</p>
            <n-space v-if="canRetryChapter || chapterError" justify="center" style="margin-bottom:16px">
              <n-button v-if="canRetryChapter" size="small" type="warning" :loading="retryingChapter" @click="retryThisChapter">
                重试失败章
              </n-button>
              <n-button v-if="currentChapter?.url || book.sourceUrl" size="small" @click="goBrowseForChapter">
                去浏览页
              </n-button>
            </n-space>
            <p
              v-for="(segs, i) in renderedParas"
              :key="i"
              :data-p="i"
              :class="['para', { 'para-speaking': i === spokenPara }]"
            ><template v-for="(s, j) in segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" class="hl-mark">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
            <button v-if="chapterReady && followingChapter" class="chapter-end-card" @click="nextChapter">下一章：{{ followingChapter.title }}</button>
            <div v-else-if="chapterReady && currentChapterIndex === chapters.length - 1" class="chapter-end-card finished">
              <strong>已读完《{{ book.title }}》</strong>
              <n-button size="small" @click="emit('back')">返回书库</n-button>
            </div>
          </template>
        </div>
        <button class="chapter-hotzone right" :disabled="!followingChapter" :title="followingChapter ? `下一章：${followingChapter.title}` : '已经是最后一章'" aria-label="下一章" @click="nextChapter"><span>›</span></button>
      </div>

      <div class="reader-progress-track" :title="bookProgressDetail" :aria-label="bookProgressDetail">
        <div class="reader-progress-fill" :style="{ width: `${bookPercent}%` }"></div>
      </div>

      <!-- Chapter drawer -->
      <n-drawer v-model:show="showDrawer" placement="left" :width="320">
        <n-drawer-content title="目录">
          <n-input v-model:value="catalogQuery" clearable placeholder="过滤目录" style="margin-bottom:12px" />
          <n-list hoverable clickable>
            <n-list-item
              v-for="ch in filteredCatalog"
              :key="ch.id"
              @click="goToChapterId(ch.id)"
            >
              <div :ref="(element) => setCatalogItemRef(ch.id, element)" :class="['ch-item', { active: ch.id === currentChapter?.id }]">
                <span>{{ ch.title }}</span>
                <n-tag v-if="ch.status === 'failed'" size="tiny" type="error">{{ ch.failCode ? FAIL_CODE_ZH[ch.failCode] : '失败' }}</n-tag>
                <n-tag v-else-if="ch.status === 'pending'" size="tiny">未下</n-tag>
                <n-tag v-else-if="ch.status === 'empty'" size="tiny" type="warning">空</n-tag>
              </div>
            </n-list-item>
          </n-list>
        </n-drawer-content>
      </n-drawer>

      <!-- AI result drawer -->
      <n-drawer v-model:show="showAiResult" placement="right" :width="420">
        <n-drawer-content :title="aiResultTitle" closable>
          <div class="ai-result">{{ aiResult }}</div>
          <template #footer>
            <n-space v-if="aiResultTitle === '清正文'">
              <n-button type="primary" size="small" @click="applyCleanedBody">应用到正文</n-button>
              <n-button size="small" @click="showAiResult = false">取消</n-button>
            </n-space>
            <n-button v-else-if="aiResultTitle === '翻译' && translateLoading" type="warning" @click="stopTranslate">停止</n-button>
          </template>
        </n-drawer-content>
      </n-drawer>

      <n-drawer v-model:show="showRecap" placement="right" :width="420">
        <n-drawer-content title="看到这里" closable>
          <div class="ai-result">{{ recapText }}</div>
          <template #footer>
            <n-space>
              <n-button v-if="recapLoading" type="warning" @click="stopRecap">停止</n-button>
              <template v-else>
                <n-button :disabled="!book?.progress?.chapterId" type="primary" @click="startRecap('story')">刷新看到这里</n-button>
                <n-button :disabled="!chapterReady" @click="startRecap('chapter')">生成本章摘要</n-button>
              </template>
            </n-space>
          </template>
        </n-drawer-content>
      </n-drawer>

      <!-- Chat drawer -->
      <n-drawer v-model:show="showChat" placement="right" :width="420">
        <n-drawer-content title="聊书" closable>
          <div class="chat-messages">
            <div v-for="(msg, i) in chatMessages" :key="i" :class="['chat-msg', msg.role]">
              <div class="chat-bubble">{{ msg.content }}</div>
            </div>
            <div v-if="chatMessages.length === 0 && !chatLoading" class="chat-empty">
              <n-space>
                <n-button size="tiny" @click="askSuggested('这章讲了什么？')">这章讲了什么？</n-button>
                <n-button size="tiny" @click="askSuggested('主角现在什么状态？')">主角现在什么状态？</n-button>
                <n-button size="tiny" @click="askSuggested('有哪些未收的伏笔？')">有哪些未收的伏笔？</n-button>
              </n-space>
            </div>
          </div>
          <template #footer>
            <div class="chat-input-row">
              <n-popconfirm
                positive-text="确定"
                negative-text="取消"
                @positive-click="clearChat"
              >
                清空后无法恢复，确定清空？
                <template #trigger>
                  <n-button :disabled="chatLoading || chatMessages.length === 0">清空对话</n-button>
                </template>
              </n-popconfirm>
              <n-input
                v-model:value="chatInput"
                placeholder="输入问题…"
                :disabled="chatLoading"
                @keyup.enter="sendChat"
              />
              <n-button v-if="chatLoading" type="warning" @click="stopChat">停止</n-button>
              <n-button v-else type="primary" :disabled="!chatInput.trim()" @click="sendChat">发送</n-button>
            </div>
          </template>
        </n-drawer-content>
      </n-drawer>

      <!-- Selection popup -->
      <div
        v-if="showSelPopup"
        class="sel-popup"
        :style="{ left: selPopupX + 'px', top: selPopupY + 'px' }"
      >
        <n-button size="tiny" @click="copySelectedText">复制</n-button>
        <n-button size="tiny" type="primary" @click="addHighlight">划线</n-button>
        <n-button size="tiny" @click="openDirectNote">备注</n-button>
        <n-button size="tiny" @click="translateSelectedText">翻译</n-button>
        <n-button size="tiny" @click="askSelectedText">问 AI</n-button>
      </div>

      <div v-if="showDirectNote" class="direct-note-editor" :style="{ left: selPopupX + 'px', top: selPopupY + 'px' }">
        <strong>添加备注</strong>
        <div class="direct-note-excerpt">{{ selectedExcerpt }}</div>
        <n-input v-model:value="directNoteDraft" type="textarea" :rows="3" placeholder="写下对这段文字的备注…" autofocus />
        <n-space justify="end">
          <n-button size="small" @click="closeSelectionTools()">取消</n-button>
          <n-button size="small" type="primary" :disabled="!directNoteDraft.trim()" @click="saveDirectNote">保存备注</n-button>
        </n-space>
      </div>

      <!-- Marks drawer -->
      <n-drawer v-model:show="showMarks" placement="left" :width="340">
        <n-drawer-content title="标记" closable>
          <n-popconfirm v-if="chapterBookmark" positive-text="删除" negative-text="取消" @positive-click="toggleBookmark">
            删除这条书签？删除后无法恢复。
            <template #trigger><n-button block type="warning" style="margin-bottom:12px">移除本章书签</n-button></template>
          </n-popconfirm>
          <n-button v-else block type="primary" :disabled="!currentChapter" style="margin-bottom:12px" @click="toggleBookmark">给本章加书签</n-button>
          <div v-if="!sortedMarks.length" class="control-label" style="text-align:center;padding:24px 0">
            还没有标记。选中正文可添加划线或备注。
          </div>
          <div v-else class="mark-list">
            <div v-for="a in sortedMarks" :key="a.id" class="mark-row">
              <div class="mark-main" @click="jumpToAnnotation(a)">
                <span class="mark-icon">{{ a.kind === 'bookmark' ? '🔖' : '🖍' }}</span>
                <span class="mark-chapter">{{ chapters.find((c) => c.id === a.chapterId)?.title || a.chapterId }}</span>
                <span v-if="lostHighlightIds.has(a.id)" class="mark-lost">（原文已变化）</span>
              </div>
              <div v-if="a.kind === 'highlight' && a.excerpt && !lostHighlightIds.has(a.id)" class="mark-excerpt" @click="jumpToAnnotation(a)">
                {{ a.excerpt }}
              </div>
              <div v-if="a.note && editingNoteId !== a.id" class="mark-note" @click="jumpToAnnotation(a)">备注：{{ a.note }}</div>
              <div class="mark-actions">
                <n-button size="tiny" quaternary @click.stop="editingNoteId = a.id; noteDraft = a.note ?? ''">备注</n-button>
                <n-popconfirm positive-text="删除" negative-text="取消" @positive-click="deleteAnnotation(a)">
                  {{ deleteConfirmText(a) }}
                  <template #trigger><n-button size="tiny" quaternary type="error" @click.stop>删除</n-button></template>
                </n-popconfirm>
              </div>
              <div v-if="editingNoteId === a.id" class="mark-note-edit">
                <n-input v-model:value="noteDraft" type="textarea" :rows="2" placeholder="写点备注…" />
                <n-space justify="end" style="margin-top:4px">
                  <n-button size="tiny" @click="editingNoteId = ''">取消</n-button>
                  <n-button size="tiny" type="primary" @click="saveNote(a)">保存</n-button>
                </n-space>
              </div>
            </div>
          </div>
        </n-drawer-content>
      </n-drawer>

      <!-- Search drawer -->
      <n-drawer v-model:show="showSearch" placement="right" :width="420">
        <n-drawer-content title="本书内搜索" closable>
          <div class="chat-input-row" style="margin-bottom:12px">
            <n-input
              v-model:value="searchQuery"
              placeholder="输入要找的文字…"
              clearable
              @keyup.enter="runSearch"
            />
            <n-button type="primary" :loading="searching" :disabled="!searchQuery.trim()" @click="runSearch">
              搜索
            </n-button>
          </div>
          <div v-if="!searchHits.length" class="control-label" style="text-align:center;padding:24px 0">
            还没有结果。搜索范围是本书已下载的章节。
          </div>
          <n-list v-else hoverable clickable>
            <n-list-item v-for="hit in searchHits" :key="hit.chapterId" @click="jumpToHit(hit)">
              <div class="hit-row">
                <span class="hit-title">{{ hit.chapterTitle }}</span>
                <n-tag size="tiny">{{ hit.count }} 处</n-tag>
              </div>
              <div class="hit-excerpt">{{ hit.excerpt }}</div>
            </n-list-item>
          </n-list>
        </n-drawer-content>
      </n-drawer>
    </template>
  </div>
</template>

<style scoped>
.reader-wrap {
  /* 局部变量：夜间模式只覆盖这三项，其余跟随全局皮肤 */
  --r-bar-bg: var(--bar-bg);
  --r-line: var(--line);
  --r-muted: var(--muted);
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: transparent;
  color: var(--text);
  transition: background .2s, color .2s;
}

.reader-wrap.night {
  --r-bar-bg: #100d08;
  --r-line: rgba(230, 213, 162, 0.13);
  --r-muted: #a8946b;
}

.reader-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  height: 44px;
  border-bottom: 1px solid var(--r-line);
  background: var(--r-bar-bg);
  flex-shrink: 0;
}

.reader-book-title {
  font-size: 14px;
  color: var(--r-muted);
  flex: 1;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 12px;
}

.reader-progress-label {
  font-size: 12px;
  color: var(--r-muted);
  margin-right: 8px;
  white-space: nowrap;
}

.chapter-hint {
  text-align: center;
  color: var(--warning-text);
  padding: 0 8px 12px;
  font-size: 13px;
}

.reader-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.reader-controls {
  width: 160px;
  padding: 16px;
  border-right: 1px solid var(--r-line);
  background: var(--r-bar-bg);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.control-label {
  font-size: 12px;
  color: var(--r-muted);
}

.key-hint {
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--r-line);
  line-height: 1.6;
}

.reader-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
  max-width: 800px;
  margin: 0 auto;
  background: var(--reader-paper);
  color: var(--reader-paper-text);
}

.reader-wrap.night .reader-content {
  background: #000000;
  color: #e6d5a2;
}

.ch-title {
  font-size: 1.3em;
  font-weight: 600;
  margin-bottom: 1em;
  text-align: center;
}

.ch-title::after {
  content: var(--title-ornament);
  display: block;
  margin-top: 10px;
  font-size: 0.7em;
  opacity: 0.55;
}

.para {
  text-indent: 2em;
  margin: 0 0 0.5em;
}

.para-speaking {
  background: var(--speaking-bg);
  border-radius: 4px;
}

:deep(mark.search-hit) {
  background: var(--hit-bg);
  color: var(--hit-text);
  border-radius: 3px;
  padding: 0 1px;
}

:deep(mark.hl-mark) {
  background: var(--hl-bg);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}

.sel-popup {
  position: fixed;
  z-index: 1000;
  display: flex;
  gap: 6px;
  background: var(--popover-bg);
  border: 1px solid var(--r-line, #372c52);
  border-radius: 10px;
  padding: 6px 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5), var(--popover-ring);
}

.direct-note-editor {
  position: fixed;
  z-index: 1001;
  width: min(340px, calc(100vw - 16px));
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--r-line);
  border-radius: 10px;
  background: var(--popover-bg);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .28);
}
.direct-note-excerpt {
  max-height: 72px;
  overflow: auto;
  padding: 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, .1);
  color: var(--r-muted);
  font-size: 12px;
  line-height: 1.5;
}

.mark-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mark-row {
  border: 1px solid var(--r-line, #372c52);
  border-radius: 10px;
  padding: 8px 10px;
}

.mark-main {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 13px;
}

.mark-icon {
  font-size: 12px;
}

.mark-chapter {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mark-lost {
  font-size: 11px;
  color: var(--danger);
}

.mark-excerpt {
  font-size: 12px;
  color: var(--r-muted);
  margin-top: 4px;
  line-height: 1.5;
  cursor: pointer;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.mark-note {
  font-size: 12px;
  color: var(--note-accent);
  margin-top: 4px;
  cursor: pointer;
}

.mark-note-edit {
  margin-top: 6px;
}

.mark-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.hit-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.hit-title {
  font-size: 13px;
  font-weight: 600;
}

.hit-excerpt {
  font-size: 12px;
  color: var(--r-muted);
  margin-top: 4px;
  line-height: 1.5;
}

.loading-hint {
  text-align: center;
  color: var(--r-muted);
  padding: 40px;
}

.chapter-error {
  text-align: center;
  color: var(--danger);
  padding: 16px 8px 24px;
}

.reader-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 8px 16px;
  border-top: 1px solid var(--r-line);
  background: var(--r-bar-bg);
  flex-shrink: 0;
}

.ch-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 14px;
}

.ch-item.active {
  color: var(--active-chapter);
  font-weight: 600;
}

.ai-result {
  white-space: pre-wrap;
  line-height: 1.8;
  font-size: 14px;
  padding: 0 4px;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chat-msg {
  display: flex;
  padding: 0 12px;
}

.chat-msg.user {
  justify-content: flex-end;
}

.chat-msg.assistant {
  justify-content: flex-start;
}

.chat-bubble {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 14px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.chat-msg.user .chat-bubble {
  background: var(--bubble-user-bg);
  color: var(--bubble-user-text);
  border-bottom-right-radius: 4px;
}

.chat-msg.assistant .chat-bubble {
  background: var(--bubble-ai-bg);
  border: 1px solid var(--bubble-ai-border);
  color: var(--bubble-ai-text);
  border-bottom-left-radius: 4px;
}

.chat-empty {
  text-align: center;
  color: var(--r-muted);
  padding: 40px 20px;
  font-size: 13px;
}

.chat-input-row {
  display: flex;
  gap: 8px;
}

.reader-toolbar {
  position: absolute;
  z-index: 30;
  top: 12px;
  left: 50%;
  width: min(920px, calc(100% - 32px));
  min-height: 48px;
  transform: translate(-50%, -10px);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: 1px solid var(--r-line);
  border-radius: 14px;
  background: color-mix(in srgb, var(--r-bar-bg) 94%, transparent);
  box-shadow: 0 8px 28px rgba(0, 0, 0, .16);
  opacity: 0;
  pointer-events: none;
  transition: opacity .2s ease, transform .2s ease;
}

.reader-toolbar.visible {
  opacity: 1;
  pointer-events: auto;
  transform: translate(-50%, 0);
}

.tool-button {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.tool-button:hover { background: rgba(127, 127, 127, .14); }
.tool-button:focus-visible { outline: 2px solid var(--active-chapter); outline-offset: 2px; }
.tool-button svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.reader-toolbar .reader-book-title { min-width: 0; }

.tool-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 48px;
  width: 280px;
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--r-line);
  border-radius: 12px;
  background: var(--popover-bg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .24);
}

.reader-body {
  position: relative;
  padding: 28px clamp(48px, 5vw, 72px) 20px;
  justify-content: center;
  overflow: hidden;
  background: var(--reader-outer);
}

.reader-content {
  width: min(100%, 38em);
  max-width: 38em;
  flex: 0 1 38em;
  padding: 64px clamp(24px, 5vw, 56px) 100px;
  border-radius: 6px 6px 0 0;
  box-shadow: 0 2px 18px rgba(0, 0, 0, .08);
}

.reader-progress-track {
  position: absolute;
  z-index: 25;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(127, 127, 127, .16);
  pointer-events: none;
}

.reader-progress-fill {
  height: 100%;
  background: var(--active-chapter);
  transition: width .12s linear;
}

.reader-wrap.immersive-locked .reader-progress-track { opacity: 1; }
.reader-wrap.night .reader-content { background: var(--reader-paper); color: var(--reader-paper-text); }

.chapter-hotzone {
  position: absolute;
  z-index: 18;
  top: 0;
  bottom: 3px;
  width: 48px;
  border: 0;
  background: transparent;
  color: var(--reader-paper-text);
  opacity: 0;
  cursor: pointer;
  transition: opacity .15s ease, background .15s ease;
}
.chapter-hotzone.left { left: 0; }
.chapter-hotzone.right { right: 0; }
.chapter-hotzone:not(:disabled):hover, .chapter-hotzone:not(:disabled):focus-visible { opacity: 1; background: rgba(127, 127, 127, .12); }
.chapter-hotzone:disabled { cursor: default; }
.chapter-hotzone span { font-size: 36px; line-height: 1; }
.chapter-hotzone:focus-visible { outline: 2px solid var(--active-chapter); outline-offset: -3px; }

.chapter-end-card {
  width: 100%;
  min-height: 72px;
  margin: 56px 0 8px;
  padding: 16px 20px;
  border: 1px solid color-mix(in srgb, var(--reader-paper-text) 20%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--reader-paper-text) 5%, transparent);
  color: inherit;
  text-align: center;
  cursor: pointer;
}
.chapter-end-card:hover { background: color-mix(in srgb, var(--reader-paper-text) 9%, transparent); }
.chapter-end-card:focus-visible { outline: 2px solid var(--active-chapter); outline-offset: 2px; }
.chapter-end-card.finished { display: flex; flex-direction: column; align-items: center; gap: 12px; cursor: default; }
.para { text-indent: var(--paragraph-indent, 2em); margin-bottom: var(--paragraph-spacing, .45em); }

.option-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; }
.option-grid.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.option-grid button {
  min-height: 30px;
  padding: 4px 5px;
  border: 1px solid var(--r-line);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
}
.option-grid button.active { border-color: var(--active-chapter); background: rgba(127, 127, 127, .14); }
.option-grid button:focus-visible { outline: 2px solid var(--active-chapter); outline-offset: 1px; }

@media (prefers-reduced-motion: reduce) {
  .reader-wrap, .reader-wrap *, .reader-toolbar, .reader-progress-fill { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}

:deep(button:focus-visible), :deep(.n-button:focus-visible), :deep(.n-input:focus-within) {
  outline: 2px solid var(--active-chapter);
  outline-offset: 2px;
}
</style>
