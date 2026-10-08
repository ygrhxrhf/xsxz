<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick, computed } from 'vue'
import { NButton, NDrawer, NDrawerContent, NEmpty, NInput, NList, NListItem, NPopconfirm, NRadioButton, NRadioGroup, NSlider, NSpace, NSwitch, NTabPane, NTabs, NTag, useMessage } from 'naive-ui'
import { DEFAULT_READER_PREFS, FAIL_CODE_ZH } from '@shared/types'
import type {
  AiBookUsage,
  AiBudgetEstimate,
  AiCitation,
  AiEvidenceChatMessage,
  AiMaterialCoverage,
  AiMemoryBase,
  AiMemoryCharacter,
  AiMemoryFile,
  AiRequestStage,
  AiUsage,
  Book,
  ChapterMeta,
  DownloadProgress,
  ReaderContentWidth,
  ReaderFocusMode,
  ReaderFontFamily,
  ReaderReadingMode,
  ReaderParagraphSpacing,
  ReaderPrefs,
  ReadingProgress,
  TtsPosition,
  ReaderTheme,
} from '@shared/types'
import {
  approximateBookRatio,
  chapterScrollRatio,
  failAdvice,
  filterCatalogChapters,
  formatCharacterCard,
  readerProgressLabel,
  readerScrollBehavior,
  remainingChapterCount,
  isParagraphInFocus,
  paragraphIndexAtViewportCenter,
  resolveFocusAnchor,
  resolveImmersiveKey,
  resolveReaderKey,
  scrollTopFromRatio,
  shouldAutoHideReaderTools,
  wheelPageDirection,
  selectionPopupPosition,
  catalogChapterBadge,
} from './readerHelpers'
import type { ReaderImmersiveMode } from './readerHelpers'
import {
  adjacentVisualPage,
  scrollTopForVisualPage,
  visualPageCount,
  visualPageIndex,
  visualPageLabel,
} from './readerPager'
import { clampTtsRate, splitIntoParagraphs, useTts } from './useTts'
import { ttsBodyHash, validTtsPosition } from './ttsPosition'
import { decorateText, relocateRange } from '@shared/paragraphSearch'
import type { Annotation, BookSearchHit } from '@shared/types'
import { libraryCoverSrc, libraryCoverText } from './libraryCard'
import AiBudgetConfirm from '../components/AiBudgetConfirm.vue'
import { aiSaveRecoveryActive, runAiSaveRecovery } from '../aiSaveRecoveryLock'
import { locateMemorySourceParagraph } from './memorySourceLocator'
import { normalizeEvidenceChatHistory } from './aiEvidenceUi'
import { enqueueCompletedChapter, finishOrganizedChapter, normalizeOrganizeQueue, pauseOrganizeQueue, resumeOrganizeQueue } from './aiOrganizeQueue'
import { displayAiServiceOrigin } from './aiAssistantTransparency'
import {
  assistantKindForJob,
  clearRetriedAssistantSaveToken,
  currentAssistantStage as resolveAssistantStage,
  removeAssistantStage,
  updateAssistantSaveToken,
} from './aiAssistantStatus'
import { createChapterPrefetch } from './readerPrefetch'
import { createReaderProgressWriter } from './readerProgressWriter'
import type { CapturedProgressWrite } from './readerProgressWriter'

const props = defineProps<{ bookId?: string }>()
const emit = defineEmits<{
  (e: 'back'): void
  (e: 'go-browse', url?: string): void
  (e: 'go-settings'): void
}>()
const message = useMessage()

const book = ref<Book | null>(null)
const downloadProgress = ref<DownloadProgress | null>(null)
const chapters = ref<ChapterMeta[]>([])
const currentChapter = ref<ChapterMeta | null>(null)
const chapterPrefetch = createChapterPrefetch()
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
const focusMode = ref<ReaderFocusMode>(DEFAULT_READER_PREFS.focusMode)
const readingMode = ref<ReaderReadingMode>(DEFAULT_READER_PREFS.readingMode)
const viewportCenterPara = ref(-1)
// AI state
const aiLoading = ref(false)
const cleanRunning = ref(false)
const aiResult = ref('')
const aiResultTitle = ref('')
const showAiResult = ref(false)
const cleanBudget = ref<AiBudgetEstimate | null>(null)
const cleanBudgetMessage = ref('')
const showCleanBudgetConfirm = ref(false)
const lastCleanBudget = ref<AiBudgetEstimate | null>(null)
const showAiAssistant = ref(false)
const aiAssistantTab = ref<'recap' | 'memory' | 'qa'>('recap')
const aiServiceOrigin = ref('')
const aiAssistantTaskLabel = computed(() => ({ recap: '前情', memory: '记忆', qa: '问答' })[aiAssistantTab.value])
const assistantBudgets = ref<Partial<Record<'recap' | 'memory' | 'qa', AiBudgetEstimate>>>({})
const currentAssistantBudget = computed(() => assistantBudgets.value[aiAssistantTab.value] ?? null)
const recapText = ref('')
const recapJobId = ref('')
const recapJobKind = ref<'chapter' | 'story' | ''>('')
const recapStopping = ref(false)
const recapStarting = ref(false)
const recapLength = ref<'short' | 'standard' | 'detailed'>('standard')
const memoryData = ref<AiMemoryFile | null>(null)
const memorySourceJumping = ref(false)
const memoryJobId = ref('')
const memoryJobKind = ref<'update' | 'rebuild' | 'fromSource' | ''>('')
const memoryStarting = ref(false)
const memoryStopping = ref(false)
const memoryLoading = computed(() => memoryStarting.value || Boolean(memoryJobId.value))
const assistantStages = ref<Record<string, AiRequestStage>>({})
const lastAssistantUsage = ref<AiUsage | null>(null)
const assistantCompleted = ref(false)
const lastAssistantTruncated = ref(false)
const assistantSaveState = ref<{ token: string; kind: 'recap' | 'memory' | 'qa' | '' }>({ token: '', kind: '' })
const assistantSaveRetrying = aiSaveRecoveryActive
const chapterSummaryBudget = ref<AiBudgetEstimate | null>(null)
const chapterSummaryBudgetMessage = ref('')
const showChapterSummaryBudgetConfirm = ref(false)
const memoryBudget = ref<AiBudgetEstimate | null>(null)
const memoryBudgetMessage = ref('')
const showMemoryBudgetConfirm = ref(false)
const memoryBudgetRequest = ref<{ kind: 'update' | 'rebuild' | 'fromSource'; fromChapterId?: string } | null>(null)
const recapBudgetConfirmKind = ref<'chapter' | 'story'>('chapter')
const recapLoading = computed(() => Boolean(recapJobId.value))
const translateJobId = ref('')
const translateLoading = computed(() => Boolean(translateJobId.value))
const chatMessages = ref<AiEvidenceChatMessage[]>([])
const chatInput = ref('')
const chatLoading = ref(false)
const chatStarting = ref(false)
const chatJobId = ref('')
const chatAssistantIndex = ref(-1)
type ReadingAiMode = 'manual' | 'ask' | 'auto'
const readingAiMode = ref<ReadingAiMode>('manual')
const completedChapterQueue = ref<string[]>([])
const organizeQueuePaused = ref(false)
const queueBudget = ref<AiBudgetEstimate | null>(null)
const queueBudgetMessage = ref('')
const queueBudgetApproved = ref(false)
const materialCoverage = ref<AiMaterialCoverage | null>(null)
const bookUsage = ref<AiBookUsage | null>(null)
const aliasDrafts = ref<Record<string, string>>({})
const summaryDrafts = ref<Record<string, string>>({})
const correctingAliasId = ref('')
const correctingSummaryId = ref('')
const organizingChapterId = ref('')
const organizingJobId = ref('')
const organizingStage = ref<'summary' | 'memory' | ''>('')
const organizingBusy = ref(false)
const completedChapterTitle = computed(() => book.value?.chapters.find((chapter) => chapter.id === completedChapterQueue.value[0])?.title ?? '')
const assistantBusy = computed(() => organizingBusy.value || recapStarting.value || recapLoading.value || memoryLoading.value || chatStarting.value || chatLoading.value)
const assistantJobIds = computed(() => ({
  recap: recapJobId.value,
  memory: memoryJobId.value,
  qa: chatJobId.value,
}))
const currentAssistantStage = computed(() => resolveAssistantStage(
  assistantStages.value,
  aiAssistantTab.value,
  assistantJobIds.value,
))
const assistantStageText = computed(() => {
  const labels: Partial<Record<AiRequestStage, string>> = {
    preparing: '正在准备已读材料…',
    rewriting: '正在改写检索问题…',
    searching: '正在检索本地已读内容…',
    requesting: '正在请求模型服务…',
    saving: '正在保存到本地书库…',
  }
  return currentAssistantStage.value ? labels[currentAssistantStage.value] ?? '' : ''
})
const catalogQuery = ref('')
const scrollRatioView = ref(0)
const visualPageIndexView = ref(0)
const visualPageCountView = ref(1)
const retryingChapter = ref(false)

// 沉浸工具层
const immersiveMode = ref<ReaderImmersiveMode>('normal')
const toolsVisible = ref(true)
const temporaryToolReveal = ref(false)
const pointerInToolbar = ref(false)
const activeToolPanel = ref<'tts' | 'ai' | 'shortcuts' | null>(null)
const activeBottomPanel = ref<'catalog' | 'progress' | 'background' | 'font' | null>(null)
const libraryPath = ref('')
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
const ttsSource = ref<'system' | 'online'>('system')
const ttsVoiceURI = ref('')
const ttsVoices = ref<SpeechSynthesisVoice[]>([])
const ttsSavedPosition = ref<TtsPosition | null>(null)
let ttsPositionWrite: Promise<unknown> = Promise.resolve()
function refreshTtsVoices() { ttsVoices.value = window.speechSynthesis?.getVoices?.() ?? [] }
function saveTtsParagraph(index: number) {
  if (!book.value || !currentChapter.value || index < 0) return
  const bookId = book.value.id
  const position: TtsPosition = { chapterId: currentChapter.value.id, paragraphIndex: index,
    bodyHash: ttsBodyHash(chapterBody.value), updatedAt: new Date().toISOString() }
  ttsSavedPosition.value = position
  ttsPositionWrite = ttsPositionWrite.then(() => window.api.tts?.setPosition?.(bookId, position)).catch(() => {
    message.warning('听书位置保存失败')
  })
}
const paras = computed(() => splitIntoParagraphs(chapterBody.value))
const renderedCount = ref(120)
let renderGeneration = 0
let renderTimer: ReturnType<typeof setTimeout> | null = null

function scheduleParagraphChunks(generation: number) {
  if (renderTimer) clearTimeout(renderTimer)
  if (renderedCount.value >= paras.value.length) return
  renderTimer = setTimeout(() => {
    if (generation !== renderGeneration) return
    renderedCount.value = Math.min(paras.value.length, renderedCount.value + 120)
    scheduleParagraphChunks(generation)
  }, 16)
}

watch(chapterBody, () => {
  renderGeneration++
  renderedCount.value = Math.min(120, paras.value.length)
  scheduleParagraphChunks(renderGeneration)
}, { flush: 'sync' })

async function waitForParagraph(index: number, generation = renderGeneration): Promise<boolean> {
  while (generation === renderGeneration && renderedCount.value <= index && index < paras.value.length) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  return generation === renderGeneration
}
const {
  supported: ttsSupported,
  speaking: ttsSpeaking,
  paused: ttsPaused,
  spokenPara,
  error: ttsError,
  sleepMinutes: ttsSleepMinutes,
  start: ttsStart,
  pause: ttsPause,
  resume: ttsResume,
  stop: ttsStop,
  retry: ttsRetry,
  next: ttsNext,
  previous: ttsPrevious,
  setSleepMinutes: setTtsSleepMinutes,
  updateRate: updateTtsRate,
} = useTts({
  paragraphs: () => paras.value,
  rate: () => ttsRate.value,
  autoNext: () => ttsAutoNext.value,
  onChapterEnd: () => continueTtsChapter(),
  source: () => ttsSource.value,
  voiceURI: () => ttsVoiceURI.value,
  synthesize: (requestId, text) => window.api.tts.synthesize(requestId, text),
  cancelSynthesis: (requestId) => { void window.api.tts.cancel(requestId) },
  onParagraphStart: saveTtsParagraph,
})

async function continueTtsChapter() {
  const next = followingChapter.value
  if (!next) { message.info('已听完本书'); ttsStop(); return }
  try {
    await openChapter(next, 0, undefined, true)
    if (!chapterReady.value) { message.warning('下一章尚不可读，已停止听书'); ttsStop(); return }
    ttsStart(0, true)
  } catch {
    message.error('下一章加载失败，已停止听书')
    ttsStop()
  }
}

function ttsStartCurrent() { if (chapterReady.value) ttsStart(Math.max(0, viewportCenterPara.value)) }
function ttsStartBeginning() { if (chapterReady.value) ttsStart(0) }
async function ttsContinueSaved() {
  const position = ttsSavedPosition.value
  if (!book.value || !position) { ttsStartCurrent(); return }
  const chapter = chapters.value.find((item) => item.id === position.chapterId)
  if (!chapter || chapter.status !== 'ready') { message.warning('上次听书章节不可用，已从当前位置播放'); ttsStartCurrent(); return }
  if (currentChapter.value?.id !== chapter.id) {
    const savedChapter = await window.api.library.readChapter(book.value.id, chapter.id).catch(() => null)
    if (!savedChapter?.chapter || savedChapter.chapter.status !== 'ready' || !validTtsPosition(position, chapter.id, savedChapter.chapter.body)) {
      message.warning('上次听书位置已失效，已从当前位置播放')
      ttsStartCurrent()
      return
    }
    await openChapter(chapter)
  }
  if (!chapterReady.value || !validTtsPosition(position, chapter.id, chapterBody.value)) {
    message.warning('上次听书位置已失效，已从当前位置播放')
    ttsStartCurrent()
    return
  }
  ttsStart(position.paragraphIndex)
}

watch(spokenPara, (i) => {
  if (i < 0 || !contentRef.value) return
  void waitForParagraph(i).then((ready) => {
    if (!ready) return
    contentRef.value?.querySelector(`[data-p="${i}"]`)?.scrollIntoView({
      block: 'center',
      behavior: readerScrollBehavior(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true),
    })
  })
})

// 本书内全文搜索
const showSearch = ref(false)
const searchQuery = ref('')
const searchHighlightCenter = ref(0)
const searching = ref(false)
const searchHits = ref<BookSearchHit[]>([])
let pendingScrollPara = -1

// 书签 / 划线笔记
const annotations = ref<Annotation[]>([])
const lostHighlightIds = ref<Set<string>>(new Set())
const showMarks = ref(false)
const selPopupX = ref(0)
const selPopupY = ref(0)
const lastSelRect = ref({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 })
function applySelPopupPosition(popup: { width: number; height: number }) {
  const pos = selectionPopupPosition({
    range: lastSelRect.value,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    popup,
  })
  selPopupX.value = pos.x
  selPopupY.value = pos.y
}
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
const plainDecoratedParas = computed(() => paras.value.map((text) => decorateText(text, '', [])))
const renderedParas = computed(() => {
  const q = searchQuery.value.trim()
  const searchingNow = showSearch.value && !!q
  const highlights = currentHighlightRanges.value
  if (!searchingNow && highlights.length === 0) return plainDecoratedParas.value
  const starts = paraNormStarts.value
  const large = paras.value.length > 2000
  return paras.value.map((text, i) => {
    if (searchingNow && large && Math.abs(i - searchHighlightCenter.value) > 80) {
      return plainDecoratedParas.value[i]!
    }
    const base = starts[i] ?? 0
    const localHl =
      searchingNow && q
        ? []
        : highlights.map((a) => ({ start: a.start - base, end: a.end - base }))
    return decorateText(text, searchingNow ? q : '', localHl)
  })
})
const visibleParas = computed(() => renderedParas.value.slice(0, renderedCount.value))

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

function onContentMouseup(_e: MouseEvent) {
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
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null
    const rect = range?.getBoundingClientRect()
    lastSelRect.value = rect
      ? { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height }
      : { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }
    applySelPopupPosition({ width: 360, height: 88 })
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
  applySelPopupPosition({ width: 340, height: 220 })
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

async function askSelectedText(kind: 'explain' | 'person' | 'backstory' = 'explain') {
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
  aiAssistantTab.value = 'qa'
  showAiAssistant.value = true
  try {
    const history = await window.api.ai.getChat(book.value.id)
    if (history.ok) chatMessages.value = normalizeEvidenceChatHistory(history.messages)
    else message.warning(history.message)
  } catch {
    message.warning('读取本地问答记录失败，将继续发送当前问题')
  } finally {
    restoringChat.value = false
  }
  const question = kind === 'person'
    ? '这段话提到的人物是谁？只根据已读内容说明其身份、别名和与当前情节的关系。'
    : kind === 'backstory'
      ? '这件事之前发生了什么？按已读时间线简要追溯相关事件。'
      : '这段话是什么意思？结合已读剧情解释一下。'
  chatInput.value = `${question}\n\n「${excerpt}」`
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
  searchHighlightCenter.value = Math.max(0, viewportCenterPara.value)
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
  searchHighlightCenter.value = hit.paraIndex
  await openChapter(ch, 0)
}

function scrollToPendingPara() {
  if (pendingScrollPara < 0 || !contentRef.value) return
  const i = pendingScrollPara
  pendingScrollPara = -1
  const generation = renderGeneration
  void waitForParagraph(i, generation).then(async (ready) => {
    if (!ready) return
    await nextTick()
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
    showAiAssistant.value ||
    showSearch.value ||
    showMarks.value ||
    activeToolPanel.value !== null ||
    activeBottomPanel.value !== null
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
  const focusedTool = document.activeElement?.closest('.reader-toolbar, .reader-bottombar')
  if (anyDrawerOpen() || selectionOpen() || pointerInToolbar.value || focusedTool) {
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
        pointerInToolbar: pointerInToolbar.value || Boolean(document.activeElement?.closest('.reader-toolbar, .reader-bottombar')),
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

function onReaderFocusIn() {
  revealTools(immersiveMode.value === 'locked')
}

function toggleToolPanel(panel: 'tts' | 'ai' | 'shortcuts') {
  activeToolPanel.value = activeToolPanel.value === panel ? null : panel
  if (activeToolPanel.value) activeBottomPanel.value = null
  revealTools(immersiveMode.value === 'locked')
}

function toggleBottomPanel(panel: 'catalog' | 'progress' | 'background' | 'font') {
  activeBottomPanel.value = activeBottomPanel.value === panel ? null : panel
  if (activeBottomPanel.value) {
    activeToolPanel.value = null
    if (panel === 'catalog') showDrawer.value = true
  } else if (panel === 'catalog') {
    showDrawer.value = false
  }
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
  else if (showAiAssistant.value) showAiAssistant.value = false
  else if (showSearch.value) showSearch.value = false
  else if (showMarks.value) showMarks.value = false
  else if (showDrawer.value) showDrawer.value = false
  else if (activeBottomPanel.value) activeBottomPanel.value = null
  else if (activeToolPanel.value) activeToolPanel.value = null
}

function toggleTtsFromShortcut() {
  activeToolPanel.value = 'tts'
  revealTools(immersiveMode.value === 'locked')
  if (!ttsSupported) return
  if (!ttsSpeaking.value) void ttsContinueSaved()
  else if (ttsPaused.value && ttsError.value) ttsRetry()
  else if (ttsPaused.value) ttsResume()
  else ttsPause()
}

function startTtsFromParagraph(index: number) {
  if (!chapterReady.value || !ttsSupported || !paras.value[index]) return
  closeSelectionTools()
  ttsStart(index)
  revealTools(immersiveMode.value === 'locked')
}

function syncVisualPage() {
  const el = contentRef.value
  if (!el) {
    visualPageIndexView.value = 0
    visualPageCountView.value = 1
    return
  }
  visualPageCountView.value = visualPageCount(el.scrollHeight, el.clientHeight)
  visualPageIndexView.value = visualPageIndex(el.scrollTop, el.scrollHeight, el.clientHeight)
}

function snapToVisualPage() {
  const el = contentRef.value
  if (!el || readingMode.value !== 'screen') return
  const index = visualPageIndex(el.scrollTop, el.scrollHeight, el.clientHeight)
  el.scrollTop = scrollTopForVisualPage(index, el.scrollHeight, el.clientHeight)
  syncVisualPage()
}

function onReaderResize() {
  if (selectionOpen()) closeSelectionTools()
  snapToVisualPage()
}

function pageByScreen(direction: 1 | -1) {
  const el = contentRef.value
  if (!el) return
  const behavior = readerScrollBehavior(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true)
  if (readingMode.value === 'screen') {
    const count = visualPageCount(el.scrollHeight, el.clientHeight)
    const current = visualPageIndex(el.scrollTop, el.scrollHeight, el.clientHeight)
    const next = adjacentVisualPage(current, direction, count)
    el.scrollTo({ top: scrollTopForVisualPage(next, el.scrollHeight, el.clientHeight), behavior })
    return
  }
  el.scrollBy({
    top: direction * el.clientHeight * 0.9,
    behavior,
  })
}

function onContentWheel(e: WheelEvent) {
  if (readingMode.value !== 'screen') return
  if (e.ctrlKey || e.metaKey) return
  const dir = wheelPageDirection(e.deltaY)
  if (!dir) return
  e.preventDefault()
  pageByScreen(dir)
}

function setFontSize(next: number) {
  fontSize.value = Math.max(FONT_MIN, Math.min(FONT_MAX, next))
}

function onReaderKeydown(e: KeyboardEvent) {
  if (!book.value) return
  const target = e.target as HTMLElement | null
  const isTextEntry = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT' || Boolean(target?.isContentEditable)
  // 让原生按钮保留 Enter / Space 激活语义，避免阅读器翻屏快捷键抢走段落起读等可聚焦控件。
  if (target?.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return
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
      toggleBottomPanel('catalog')
      break
    case 'open-appearance':
      toggleBottomPanel('font')
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

// Debounced scroll save：只经读者进度状态机排期和落盘
const readerProgress = createReaderProgressWriter(captureProgressWrite)
let unsubDownload: (() => void) | null = null

function cancelReaderDownload() {
  void window.api.download.cancel()
}
let unsubAiChunk: (() => void) | null = null
let unsubAiStage: (() => void) | null = null
let unsubAiBudget: (() => void) | null = null
let unsubAiDone: (() => void) | null = null

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
function catalogBadge(ch: { id: string; status: typeof chapters.value[number]['status']; failCode?: typeof chapters.value[number]['failCode'] }) {
  return catalogChapterBadge({
    status: ch.status,
    chapterId: ch.id,
    currentChapterId: currentChapter.value?.id,
    progressChapterId: book.value?.progress?.chapterId,
    chapters: chapters.value,
  })
}
const currentChapterIndex = computed(() => chapters.value.findIndex((chapter) => chapter.id === currentChapter.value?.id))
const previousChapter = computed(() => currentChapterIndex.value > 0 ? chapters.value[currentChapterIndex.value - 1] : null)
const followingChapter = computed(() => currentChapterIndex.value >= 0 && currentChapterIndex.value < chapters.value.length - 1 ? chapters.value[currentChapterIndex.value + 1] : null)
const bookProgressRatio = computed(() => approximateBookRatio(chapters.value, currentChapter.value?.id, scrollRatioView.value))
const chapterPercent = computed(() => Math.round(scrollRatioView.value * 100))
const bookPercent = computed(() => Math.round(bookProgressRatio.value * 100))
const remainingChapters = computed(() => remainingChapterCount(chapters.value, currentChapter.value?.id))
const bookProgressDetail = computed(() => `全书约 ${bookPercent.value}% · 本章 ${chapterPercent.value}% · 还剩 ${remainingChapters.value} 章`)
const progressSummary = computed(() =>
  readerProgressLabel(chapters.value, currentChapter.value?.id, scrollRatioView.value),
)
const chapterFailHint = computed(() => failAdvice(currentChapter.value?.failCode))
const spineCoverSrc = computed(() =>
  book.value ? libraryCoverSrc(libraryPath.value, book.value.id, book.value.coverPath) : null,
)
const spineInitial = computed(() => libraryCoverText(book.value?.title || ''))

async function loadBook(bookId: string) {
  assistantBudgets.value = {}
  ttsStop()
  ttsSavedPosition.value = null
  if (book.value && book.value.id !== bookId) {
    if (organizingJobId.value) void window.api.ai.cancel(organizingJobId.value)
    if (memoryJobId.value === organizingJobId.value) {
      memoryJobId.value = ''
      memoryJobKind.value = ''
    }
    completedChapterQueue.value = []
    organizingJobId.value = ''
    organizingChapterId.value = ''
    organizingStage.value = ''
    organizingBusy.value = false
    queueBudget.value = null
    queueBudgetMessage.value = ''
    queueBudgetApproved.value = false
  }
  chapterPrefetch.onBookChange(bookId)
  const previousChapterId = currentChapter.value?.id
  void readerProgress.writeNow()
  const res = await window.api.library.get(bookId)
  if (res.book) {
    book.value = res.book
    ttsSavedPosition.value = await (window.api.tts?.getPosition?.(bookId) ?? Promise.resolve(null)).catch(() => null)
    const savedMode = localStorage.getItem(`spbf:reading-ai:${bookId}`)
    readingAiMode.value = savedMode === 'ask' || savedMode === 'auto' ? savedMode : 'manual'
    try {
      const savedQueue: unknown = JSON.parse(localStorage.getItem(`spbf:reading-ai-queue:${bookId}`) ?? '[]')
      const cutoff = res.book.chapters.findIndex((chapter) => chapter.id === res.book?.progress?.chapterId)
      organizeQueuePaused.value = localStorage.getItem(`spbf:reading-ai-paused:${bookId}`) === '1'
      completedChapterQueue.value = readingAiMode.value !== 'manual'
        ? normalizeOrganizeQueue(savedQueue)
          .filter((id) => res.book!.chapters.some((chapter, position) => chapter.id === id && chapter.status === 'ready' && position <= cutoff))
        : []
    } catch { completedChapterQueue.value = [] }
    if (readingAiMode.value === 'auto' && !organizeQueuePaused.value && completedChapterQueue.value.length) {
      setTimeout(() => void organizeNextCompletedChapter(), 0)
    }
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
        await openChapter(ch, res.book.progress.scrollRatio, res.book.progress)
        return
      }
    }
    if (chapters.value.length > 0) await openChapter(chapters.value[0], 0)
  }
}

async function openChapter(ch: ChapterMeta, scrollRatio = 0, progress?: ReadingProgress, continueListening = false) {
  if (!book.value) return
  const openingBookId = book.value.id
  const finishedChapterId = currentChapter.value?.id !== ch.id && currentChapter.value?.status === 'ready' && contentRef.value &&
    currentChapterRatio(contentRef.value) >= 0.9 ? currentChapter.value.id : ''
  chapterPrefetch.beginNavigation()
  closeSelectionTools()
  ttsStop(continueListening)
  const progressSave = currentChapter.value && currentChapter.value.id !== ch.id
    ? readerProgress.writeNow().then((outcome) => {
      if (outcome !== 'failed') return true
      message.warning('阅读进度保存失败，已跳过本章自动整理')
      return false
    })
    : Promise.resolve(true)
  chapterLoading.value = true
  try {
    const cached = chapterPrefetch.get(book.value.id, ch.id)
    const res = cached
      ? { chapter: cached }
      : await window.api.library.readChapter(book.value.id, ch.id)
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
      if (activeBottomPanel.value === 'catalog') activeBottomPanel.value = null
      scrollRatioView.value = scrollRatio
      resolveCurrentAnnotations()
      await nextTick()
      if (pendingScrollPara >= 0) {
        scrollToPendingPara()
      } else if (progress && scrollRatio < 0.999 && scrollToParagraphAnchor(progress)) {
        // Anchor restore is scheduled after layout; old books use the ratio below.
      } else {
        scrollToRatio(scrollRatio)
      }
      chapterPrefetch.scheduleNeighbors({
        bookId: book.value.id,
        previous: previousChapter.value,
        following: followingChapter.value,
        readChapter: (bookId, chapterId) => window.api.library.readChapter(bookId, chapterId),
      })
      if (finishedChapterId) void progressSave.then((saved) => {
        if (saved && book.value?.id === openingBookId) queueCompletedChapter(finishedChapterId)
      })
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

function paragraphTextNodes(paragraph: Element): Text[] {
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('button')) nodes.push(node as Text)
  }
  return nodes
}

function textPoint(nodes: Text[], offset: number): { node: Text; offset: number } | null {
  let left = offset
  for (const node of nodes) {
    if (left <= node.length) return { node, offset: left }
    left -= node.length
  }
  const last = nodes.at(-1)
  return last ? { node: last, offset: last.length } : null
}

function paragraphAnchor(): Pick<ReadingProgress, 'paragraphIndex' | 'paragraphOffset'> | null {
  const pane = contentRef.value
  if (!pane) return null
  const top = pane.getBoundingClientRect().top + 4
  const paragraphs = pane.querySelectorAll<HTMLElement>('[data-p]')
  let low = 0
  let high = paragraphs.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (paragraphs[middle]!.getBoundingClientRect().bottom > top) high = middle
    else low = middle + 1
  }
  const visible = paragraphs[low]
  if (!visible) return null
  const index = Number(visible.dataset.p)
  if (!Number.isInteger(index)) return null
  const nodes = paragraphTextNodes(visible)
  const total = nodes.reduce((sum, node) => sum + node.length, 0)
  if (!total || visible.getBoundingClientRect().top >= top) return { paragraphIndex: index, paragraphOffset: 0 }
  low = 0
  high = total - 1
  const range = document.createRange()
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const point = textPoint(nodes, middle)
    if (!point) break
    range.setStart(point.node, Math.min(point.offset, point.node.length - 1))
    range.setEnd(point.node, Math.min(point.offset + 1, point.node.length))
    if (range.getBoundingClientRect().bottom > top) high = middle
    else low = middle + 1
  }
  return { paragraphIndex: index, paragraphOffset: low }
}

function scrollToParagraphAnchor(progress: ReadingProgress): boolean {
  const pane = contentRef.value
  const index = progress.paragraphIndex
  const offset = progress.paragraphOffset
  if (!pane || !Number.isInteger(index) || !Number.isInteger(offset) || index! < 0 || offset! < 0) return false
  if (index! >= paras.value.length || offset! > (paras.value[index!]?.length ?? 0)) return false
  const generation = renderGeneration
  void waitForParagraph(index!, generation).then((ready) => {
    if (!ready) return
    requestAnimationFrame(() => {
    const paragraph = pane.querySelector<HTMLElement>(`[data-p="${index}"]`)
    if (!paragraph) { scrollToRatio(progress.scrollRatio); return }
    const nodes = paragraphTextNodes(paragraph)
    const point = textPoint(nodes, offset!)
    if (!point) { scrollToRatio(progress.scrollRatio); return }
    const range = document.createRange()
    range.setStart(point.node, point.offset)
    range.setEnd(point.node, Math.min(point.offset + 1, point.node.length))
    const targetTop = range.getBoundingClientRect().top
    pane.scrollTop += targetTop - pane.getBoundingClientRect().top - 4
    syncVisualPage()
    })
  })
  return true
}

function scrollToRatio(ratio: number) {
  const el = contentRef.value
  if (!el) return
  const generation = renderGeneration
  void waitForParagraph(paras.value.length - 1, generation).then((ready) => {
    if (!ready) return
    requestAnimationFrame(() => {
    let top = scrollTopFromRatio(ratio, el.scrollHeight, el.clientHeight)
    if (readingMode.value === 'screen') {
      top = scrollTopForVisualPage(
        visualPageIndex(top, el.scrollHeight, el.clientHeight),
        el.scrollHeight,
        el.clientHeight,
      )
    }
    el.scrollTop = top
    syncVisualPage()
    })
  })
}

/** 排期那一刻就把书、章、位置锁死，写盘排队到什么时候都不会串到别的章。 */
function captureProgressWrite(): CapturedProgressWrite | null {
  const target = book.value
  const chapter = currentChapter.value
  const el = contentRef.value
  if (!target || !chapter || !el) return null
  const scrollRatio = currentChapterRatio(el)
  const anchor = paragraphAnchor()
  const progress: ReadingProgress = {
    chapterId: chapter.id,
    scrollRatio,
    ...(anchor && scrollRatio < 0.999 ? anchor : {}),
    updatedAt: new Date().toISOString(),
  }
  return async () => {
    target.progress = progress
    const res = await window.api.library.setProgress(target.id, progress)
    if (res && res.ok === false) throw new Error(res.message || '阅读进度写入失败')
  }
}

function currentChapterRatio(el: HTMLElement): number {
  const visibleRatio = chapterScrollRatio(el.scrollTop, el.scrollHeight, el.clientHeight)
  return renderedCount.value < paras.value.length && paras.value.length > 0
    ? visibleRatio * renderedCount.value / paras.value.length
    : visibleRatio
}

function updateViewportFocusAnchor() {
  const el = contentRef.value
  if (!el) {
    viewportCenterPara.value = -1
    return
  }
  const nodes = el.querySelectorAll<HTMLElement>('[data-p]')
  const viewportCenter = el.scrollTop + el.clientHeight / 2
  let low = 0
  let high = nodes.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const node = nodes[middle]!
    if (node.offsetTop + node.offsetHeight / 2 < viewportCenter) low = middle + 1
    else high = middle
  }
  viewportCenterPara.value = nodes.length ? Math.min(low, nodes.length - 1) : -1
}

function onScroll() {
  if (selectionOpen()) closeSelectionTools()
  const el = contentRef.value
  if (el) scrollRatioView.value = currentChapterRatio(el)
  readerProgress.schedule()
  updateViewportFocusAnchor()
  if (showSearch.value && paras.value.length > 2000 &&
      Math.abs(viewportCenterPara.value - searchHighlightCenter.value) > 100) {
    searchHighlightCenter.value = viewportCenterPara.value
  }
  syncVisualPage()
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
    focusMode: focusMode.value,
    readingMode: readingMode.value,
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

/** 关窗口不会走 Vue 卸载：退出前把还在节流里的进度和阅读偏好立刻写出去。 */
function flushPendingReaderWrites() {
  void flushReaderPrefsSave()
  void readerProgress.writeNow()
}

function restoreDefaultReaderPrefs() {
  fontSize.value = DEFAULT_READER_PREFS.fontSize
  lineHeight.value = DEFAULT_READER_PREFS.lineHeight
  theme.value = DEFAULT_READER_PREFS.theme
  fontFamily.value = DEFAULT_READER_PREFS.fontFamily
  contentWidth.value = DEFAULT_READER_PREFS.contentWidth
  paragraphSpacing.value = DEFAULT_READER_PREFS.paragraphSpacing
  paragraphIndent.value = DEFAULT_READER_PREFS.paragraphIndent
  focusMode.value = DEFAULT_READER_PREFS.focusMode
  readingMode.value = DEFAULT_READER_PREFS.readingMode
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
  focusMode.value = s.reader.focusMode
  readingMode.value = s.reader.readingMode
  ttsRate.value = clampTtsRate(s.tts?.rate ?? 1)
  ttsAutoNext.value = s.tts?.autoNextChapter ?? true
  ttsSource.value = s.tts?.source === 'online' ? 'online' : 'system'
  ttsVoiceURI.value = s.tts?.systemVoiceURI ?? ''
  recapLength.value = s.ai?.recapLength ?? 'standard'
  aiServiceOrigin.value = displayAiServiceOrigin(s.baseUrl)
  libraryPath.value = s.libraryPath
}

// AI actions
async function runCleanBody(confirmOverBudget: boolean) {
  if (!book.value || !currentChapter.value) return
  if (!confirmOverBudget) lastCleanBudget.value = null
  aiLoading.value = true
  cleanRunning.value = true
  aiResultTitle.value = '清正文'
  try {
    const res = await window.api.ai.clean(book.value.id, currentChapter.value.id, confirmOverBudget)
    if (res.ok) {
      aiResult.value = res.result.cleaned
      lastCleanBudget.value = res.budget
      showAiResult.value = true
      void loadAssistantMaterial()
      return
    }
    if ('confirmationRequired' in res && res.confirmationRequired) {
      cleanBudget.value = res.budget
      cleanBudgetMessage.value = res.message
      showCleanBudgetConfirm.value = true
      return
    }
    if (res.stopped) {
      message.info('已停止生成')
      return
    }
    message.error(res.message || '清正文失败')
  } finally {
    aiLoading.value = false
    cleanRunning.value = false
  }
}

async function aiCleanBody() {
  await runCleanBody(false)
}

async function confirmOverBudgetClean() {
  showCleanBudgetConfirm.value = false
  await runCleanBody(true)
}

function cancelOverBudgetClean() {
  showCleanBudgetConfirm.value = false
  cleanBudget.value = null
}

async function stopCleanBody() {
  await window.api.ai.cancel()
}

async function applyCleanedBody() {
  if (!book.value || !currentChapter.value || !aiResult.value) return
  await window.api.library.updateChapterBody(book.value.id, currentChapter.value.id, aiResult.value)
  chapterPrefetch.invalidate(book.value.id, currentChapter.value.id)
  chapterBody.value = aiResult.value
  hasBodyRaw.value = true
  showAiResult.value = false
  message.success('已应用到正文')
}

async function restoreCleanedBody() {
  if (!book.value || !currentChapter.value) return
  const res = await window.api.library.updateChapterBody(book.value.id, currentChapter.value.id, '', true)
  chapterPrefetch.invalidate(book.value.id, currentChapter.value.id)
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

function isStructuredMemory(value: unknown): value is AiMemoryFile {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AiMemoryFile>
  return candidate.version === 1 &&
    Array.isArray(candidate.characters) && Array.isArray(candidate.relations) &&
    Array.isArray(candidate.foreshadows) && Array.isArray(candidate.events)
}

async function loadStoredMemory() {
  if (!book.value) return
  const result = await window.api.ai.getMemory(book.value.id)
  if (!result.ok) {
    message.warning(result.message)
    return
  }
  memoryData.value = isStructuredMemory(result.memory) ? result.memory : null
  for (const character of memoryData.value?.characters ?? []) {
    if (!(character.id in aliasDrafts.value)) aliasDrafts.value[character.id] = character.aliases.join('、')
  }
  for (const item of [
    ...(memoryData.value?.characters ?? []), ...(memoryData.value?.relations ?? []),
    ...(memoryData.value?.foreshadows ?? []), ...(memoryData.value?.events ?? []),
  ]) {
    if (!(item.id in summaryDrafts.value)) summaryDrafts.value[item.id] = item.summary
  }
}

async function loadAssistantMaterial() {
  if (!book.value) return
  const [coverage, usage] = await Promise.all([
    window.api.ai.getMaterialCoverage(book.value.id),
    window.api.ai.getUsage(book.value.id),
  ])
  if (coverage.ok) materialCoverage.value = coverage.coverage
  if (usage.ok) bookUsage.value = usage.usage
}

function queueCompletedChapter(chapterId: string) {
  if (!book.value || readingAiMode.value === 'manual') return
  const next = enqueueCompletedChapter({
    chapters: completedChapterQueue.value,
    paused: organizeQueuePaused.value,
  }, chapterId, organizingChapterId.value)
  if (next.chapters === completedChapterQueue.value) return
  completedChapterQueue.value = next.chapters
  persistCompletedQueue()
  if (readingAiMode.value === 'ask') message.info('这一章已读完，可在 AI 助手中整理摘要和小说记忆')
  if (readingAiMode.value === 'auto' && !organizeQueuePaused.value) void organizeNextCompletedChapter()
}

function pauseCompletedQueue() {
  organizeQueuePaused.value = pauseOrganizeQueue({ chapters: completedChapterQueue.value, paused: organizeQueuePaused.value }).paused
  if (book.value) localStorage.setItem(`spbf:reading-ai-paused:${book.value.id}`, '1')
}

function resumeCompletedQueue() {
  if (queueBudget.value) {
    showAiAssistant.value = true
    message.warning('请先确认本次整理的发送预算')
    return
  }
  organizeQueuePaused.value = resumeOrganizeQueue({ chapters: completedChapterQueue.value, paused: organizeQueuePaused.value }).paused
  if (book.value) localStorage.removeItem(`spbf:reading-ai-paused:${book.value.id}`)
  if (readingAiMode.value === 'auto') void organizeNextCompletedChapter()
}

function persistCompletedQueue() {
  if (book.value) localStorage.setItem(`spbf:reading-ai-queue:${book.value.id}`, JSON.stringify(completedChapterQueue.value))
}

function setReadingAiMode(mode: ReadingAiMode) {
  readingAiMode.value = mode
  if (book.value) localStorage.setItem(`spbf:reading-ai:${book.value.id}`, mode)
  if (mode === 'manual') {
    completedChapterQueue.value = []
    queueBudget.value = null
    queueBudgetApproved.value = false
    persistCompletedQueue()
  }
  if (mode === 'auto') void organizeNextCompletedChapter()
}

async function organizeNextCompletedChapter() {
  if (!book.value || organizeQueuePaused.value || queueBudget.value || !completedChapterQueue.value.length || organizingBusy.value || assistantBusy.value || assistantSaveRetrying.value) return
  const bookId = book.value.id
  const chapterId = completedChapterQueue.value[0]!
  organizingBusy.value = true
  organizingChapterId.value = chapterId
  try {
    const stored = await window.api.ai.getSummaries(bookId)
    if (!stored.ok) throw new Error(stored.message)
    if (!stored.summaries.byChapter[chapterId]) {
      const started = await window.api.ai.summarizeChapter(bookId, chapterId, queueBudgetApproved.value)
      queueBudgetApproved.value = false
      if (!started.ok) {
        if ('confirmationRequired' in started && started.confirmationRequired) {
          queueBudget.value = started.budget
          queueBudgetMessage.value = started.message
          organizeQueuePaused.value = true
          persistQueuePaused()
          message.warning('整理队列已暂停，请确认发送预算')
        } else message.warning(started.message)
        return
      }
      organizingJobId.value = started.jobId
      organizingStage.value = 'summary'
      return
    }
    await organizeMemoryAfterSummary()
  } catch (error) {
    message.warning(error instanceof Error ? error.message : '整理已读章节失败')
  } finally {
    if (!organizingJobId.value) {
      organizingBusy.value = false
      organizingChapterId.value = ''
    }
  }
}

async function organizeMemoryAfterSummary() {
  if (!book.value || !organizingChapterId.value) return
  const started = await window.api.ai.updateMemory(book.value.id, organizingChapterId.value, queueBudgetApproved.value)
  queueBudgetApproved.value = false
  if (!started.ok) {
    if ('confirmationRequired' in started && started.confirmationRequired) {
      queueBudget.value = started.budget
      queueBudgetMessage.value = started.message
      organizeQueuePaused.value = true
      persistQueuePaused()
      message.warning('整理队列已暂停，请确认发送预算')
    } else message.warning(started.message)
    return
  }
  organizingJobId.value = started.jobId
  organizingStage.value = 'memory'
  memoryJobId.value = started.jobId
  memoryJobKind.value = 'update'
}

function finishOrganizingChapter(success: boolean) {
  const chapterId = organizingChapterId.value
  organizingJobId.value = ''
  organizingStage.value = ''
  organizingBusy.value = false
  organizingChapterId.value = ''
  queueBudgetApproved.value = false
  if (success && completedChapterQueue.value[0] === chapterId) {
    completedChapterQueue.value = finishOrganizedChapter({
      chapters: completedChapterQueue.value,
      paused: organizeQueuePaused.value,
    }, chapterId).chapters
    persistCompletedQueue()
  }
  if (success && readingAiMode.value === 'auto' && !organizeQueuePaused.value) setTimeout(() => void organizeNextCompletedChapter(), 0)
}

function persistQueuePaused() {
  if (book.value) localStorage.setItem(`spbf:reading-ai-paused:${book.value.id}`, '1')
}

async function confirmQueueBudget() {
  queueBudget.value = null
  queueBudgetApproved.value = true
  organizeQueuePaused.value = false
  if (book.value) localStorage.removeItem(`spbf:reading-ai-paused:${book.value.id}`)
  if (organizingChapterId.value && organizingStage.value === 'summary' && !organizingJobId.value) {
    await organizeMemoryAfterSummary()
    if (!organizingJobId.value && !queueBudget.value) finishOrganizingChapter(false)
  } else {
    void organizeNextCompletedChapter()
  }
}

function stopOrganizing() {
  if (organizingJobId.value) void window.api.ai.cancel(organizingJobId.value)
}

async function openAiAssistant(tab: 'recap' | 'memory' | 'qa' = 'recap') {
  if (!book.value) return
  aiAssistantTab.value = tab
  showAiAssistant.value = true
  await Promise.allSettled([
    recapLoading.value ? Promise.resolve() : loadStoredRecap(),
    loadStoredMemory(),
    loadAssistantMaterial(),
    chatLoading.value || restoringChat.value
      ? Promise.resolve()
      : window.api.ai.getChat(book.value.id).then((res) => { if (res.ok) chatMessages.value = normalizeEvidenceChatHistory(res.messages) }),
  ])
}

async function startMemoryJob(kind: 'update' | 'rebuild', confirmOverBudget = false) {
  if (!book.value?.progress?.chapterId || assistantBusy.value || assistantSaveRetrying.value) return
  memoryStarting.value = true
  try {
    const start = kind === 'update' ? window.api.ai.updateMemory : window.api.ai.rebuildMemory
    const result = await start(book.value.id, book.value.progress.chapterId, confirmOverBudget)
    if (!result.ok) {
      if ('confirmationRequired' in result && result.confirmationRequired) {
        memoryBudget.value = result.budget
        memoryBudgetMessage.value = result.message
        memoryBudgetRequest.value = { kind }
        showMemoryBudgetConfirm.value = true
        return
      }
      message.warning(result.message)
      return
    }
    memoryJobId.value = result.jobId
    memoryJobKind.value = kind
  } catch {
    message.error('无法启动小说记忆任务')
  } finally {
    memoryStarting.value = false
  }
}

async function stopMemoryJob() {
  if (!memoryJobId.value || memoryStopping.value) return
  memoryStopping.value = true
  try {
    await window.api.ai.cancel(memoryJobId.value)
  } catch {
    memoryStopping.value = false
    message.error('停止小说记忆任务失败')
  }
}

async function jumpToMemorySource(source: AiCitation) {
  if (!book.value || memorySourceJumping.value) return
  memorySourceJumping.value = true
  try {
    const chapter = chapters.value.find((item) => item.id === source.chapterId)
    if (!chapter) {
      message.warning('来源章节不存在')
      return
    }
    const result = await window.api.library.readChapter(book.value.id, source.chapterId)
    if (!result.chapter || result.chapter.status !== 'ready' || !result.chapter.body) {
      message.warning('来源章节正文不可用')
      return
    }
    const location = locateMemorySourceParagraph(
      splitIntoParagraphs(result.chapter.body),
      source.paragraphIndex,
      source.excerpt,
    )
    pendingScrollPara = location.paragraphIndex
    showAiAssistant.value = false
    try {
      await openChapter(chapter, 0)
    } finally {
      pendingScrollPara = -1
    }
    if (location.mode === 'fallback') {
      message.warning('原段落已变化，已跳到该章开头。')
    }
  } catch {
    pendingScrollPara = -1
    message.error('无法打开来源章节')
  } finally {
    memorySourceJumping.value = false
  }
}

function earliestMemorySource(item: AiMemoryBase): string | null {
  if (!book.value) return null
  const positions = new Map(book.value.chapters.map((chapter, index) => [chapter.id, index]))
  return [...item.sources]
    .filter((source) => positions.has(source.chapterId))
    .sort((a, b) => positions.get(a.chapterId)! - positions.get(b.chapterId)!)[0]?.chapterId ?? null
}

async function rebuildMemoryFromSource(item: AiMemoryBase, confirmOverBudget = false, savedFromChapterId?: string) {
  if (!book.value?.progress?.chapterId || assistantBusy.value || assistantSaveRetrying.value) return
  const fromChapterId = savedFromChapterId ?? earliestMemorySource(item)
  if (!fromChapterId) {
    message.warning('来源章节不存在，无法从此处重建')
    return
  }
  memoryStarting.value = true
  try {
    const result = await window.api.ai.rebuildMemoryFrom(book.value.id, fromChapterId, book.value.progress.chapterId, confirmOverBudget)
    if (!result.ok) {
      if ('confirmationRequired' in result && result.confirmationRequired) {
        memoryBudget.value = result.budget
        memoryBudgetMessage.value = result.message
        memoryBudgetRequest.value = { kind: 'fromSource', fromChapterId }
        showMemoryBudgetConfirm.value = true
        return
      }
      message.warning(result.message)
      return
    }
    memoryJobId.value = result.jobId
    memoryJobKind.value = 'fromSource'
    message.info('正在从来源章节重新分析已读记忆')
  } catch {
    message.error('无法启动来源章节重建')
  } finally {
    memoryStarting.value = false
  }
}

async function confirmMemoryBudget() {
  showMemoryBudgetConfirm.value = false
  const request = memoryBudgetRequest.value
  memoryBudgetRequest.value = null
  if (!request) return
  if (request.kind === 'fromSource') {
    if (!book.value?.progress?.chapterId || !request.fromChapterId) return
    memoryStarting.value = true
    try {
      const result = await window.api.ai.rebuildMemoryFrom(book.value.id, request.fromChapterId, book.value.progress.chapterId, true)
      if (result.ok) {
        memoryJobId.value = result.jobId
        memoryJobKind.value = 'fromSource'
      } else message.warning(result.message)
    } finally {
      memoryStarting.value = false
    }
  } else await startMemoryJob(request.kind, true)
}

async function saveCharacterAliases(item: AiMemoryCharacter) {
  if (!book.value || correctingAliasId.value || assistantBusy.value) return
  correctingAliasId.value = item.id
  const aliases = (aliasDrafts.value[item.id] ?? '').split(/[、,，]/).map((alias) => alias.trim()).filter(Boolean)
  try {
    const result = await window.api.ai.correctCharacterAliases(book.value.id, item.id, aliases)
    if (!result.ok) {
      message.warning(result.message)
      return
    }
    item.aliases = result.character.aliases
    item.userEditedAliases = true
    aliasDrafts.value[item.id] = result.character.aliases.join('、')
    message.success('别名已保存；需要重新分析时可从来源章节重建')
  } catch {
    message.error('无法保存人物别名')
  } finally {
    correctingAliasId.value = ''
  }
}

async function saveMemorySummary(kind: 'character' | 'relation' | 'foreshadow' | 'event', item: AiMemoryBase) {
  if (!book.value || correctingSummaryId.value || assistantBusy.value || assistantSaveRetrying.value) return
  correctingSummaryId.value = item.id
  try {
    const result = await window.api.ai.correctMemorySummary(book.value.id, kind, item.id, summaryDrafts.value[item.id] ?? '')
    if (!result.ok) {
      message.warning(result.message)
      return
    }
    item.summary = result.item.summary
    item.accuracy = result.item.accuracy
    item.userEditedSummary = true
    summaryDrafts.value[item.id] = result.item.summary
    message.success('记忆说明已保存；需要重新分析时可从来源章节重建')
  } catch {
    message.error('无法保存记忆修正')
  } finally {
    correctingSummaryId.value = ''
  }
}

async function markMemoryItem(kind: 'character' | 'relation' | 'foreshadow' | 'event', item: AiMemoryBase) {
  if (!book.value || item.accuracy !== 'normal' || assistantSaveRetrying.value) return
  const result = await window.api.ai.markMemoryInaccurate(book.value.id, kind, item.id)
  if (!result.ok) {
    message.warning(result.message)
    return
  }
  item.accuracy = result.item.accuracy
  message.success('已标记，可从来源章节重新分析此条记忆')
}

async function retryAssistantSave() {
  const token = assistantSaveState.value.token
  if (!token || assistantSaveRetrying.value || assistantBusy.value) return
  try {
    await runAiSaveRecovery(async () => {
      const result = await window.api.ai.retrySave(token)
      if (result.ok) {
        assistantSaveState.value = clearRetriedAssistantSaveToken(assistantSaveState.value, token)
        message.success('结果已保存')
      } else {
        message.error(result.message)
      }
    })
  } catch {
    message.error('重试保存失败')
  }
}

async function setRecapLength(value: 'short' | 'standard' | 'detailed') {
  const previous = recapLength.value
  recapLength.value = value
  try {
    await window.api.settings.set({ ai: { recapLength: value } })
  } catch {
    recapLength.value = previous
    message.error('前情长度保存失败，已恢复原设置')
  }
}

async function startRecap(kind: 'chapter' | 'story', confirmOverBudget = false) {
  if (!book.value || !currentChapter.value || assistantBusy.value || assistantSaveRetrying.value) return
  if (kind === 'story' || !confirmOverBudget) chapterSummaryBudget.value = null
  const uptoChapterId = kind === 'chapter' ? currentChapter.value.id : book.value.progress?.chapterId
  if (!uptoChapterId) {
    recapText.value = '还没有阅读进度，打开阅读器读几章再来。'
    return
  }
  recapStarting.value = true
  try {
    const res = kind === 'chapter'
      ? await window.api.ai.summarizeChapter(book.value.id, uptoChapterId, confirmOverBudget)
      : await window.api.ai.storySoFar(book.value.id, uptoChapterId, confirmOverBudget)
    if (!res.ok) {
      if ('confirmationRequired' in res && res.confirmationRequired) {
        recapBudgetConfirmKind.value = kind
        chapterSummaryBudget.value = res.budget
        chapterSummaryBudgetMessage.value = res.message
        showChapterSummaryBudgetConfirm.value = true
        return
      }
      message.error(res.message)
      return
    }
    recapStopping.value = false
    recapJobId.value = res.jobId
    recapJobKind.value = kind
    recapText.value = ''
    aiAssistantTab.value = 'recap'
    showAiAssistant.value = true
  } catch {
    message.error('无法启动前情任务')
  } finally {
    recapStarting.value = false
  }
}

async function confirmOverBudgetChapterSummary() {
  showChapterSummaryBudgetConfirm.value = false
  await startRecap(recapBudgetConfirmKind.value, true)
}

function cancelOverBudgetChapterSummary() {
  showChapterSummaryBudgetConfirm.value = false
  chapterSummaryBudget.value = null
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
  const res = await window.api.ai.translateStream(text, book.value?.id)
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

async function sendChat() {
  if (!book.value || !currentChapter.value || !chatInput.value.trim()) return
  if (assistantBusy.value || assistantSaveRetrying.value) {
    message.warning('请先停止当前生成')
    return
  }
  const userMsg = chatInput.value.trim()
  chatMessages.value.push({ role: 'user', content: userMsg })
  chatInput.value = ''
  chatStarting.value = true
  try {
    const res = await window.api.ai.chatStream(book.value.id, currentChapter.value.id, chatMessages.value)
    if (!res.ok) {
      chatMessages.value.push({ role: 'assistant', content: `错误：${res.message}` })
      return
    }
    chatJobId.value = res.jobId
    chatLoading.value = true
    chatMessages.value.push({ role: 'assistant', content: '' })
    chatAssistantIndex.value = chatMessages.value.length - 1
  } catch {
    chatMessages.value.push({ role: 'assistant', content: '错误：无法启动问答任务' })
  } finally {
    chatStarting.value = false
  }
}

function stopChat() {
  if (chatJobId.value) void window.api.ai.cancel(chatJobId.value)
}

async function clearChat() {
  if (!book.value || chatLoading.value || assistantSaveRetrying.value) return
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
  [fontSize, lineHeight, theme, fontFamily, contentWidth, paragraphSpacing, paragraphIndent, focusMode, readingMode],
  () => {
    if (!prefsReady.value) return
    scheduleReaderPrefsSave()
    void nextTick(() => snapToVisualPage())
  },
)

watch([ttsRate, ttsAutoNext, ttsSource, ttsVoiceURI], () => {
  if (!prefsReady.value) return
  void window.api.settings.set({
    tts: { rate: clampTtsRate(ttsRate.value), autoNextChapter: ttsAutoNext.value,
      source: ttsSource.value, systemVoiceURI: ttsVoiceURI.value },
  })
})
watch(ttsRate, () => updateTtsRate())
watch(ttsSource, () => { if (ttsSpeaking.value) ttsStop() })

watch(() => props.bookId, (id) => { if (id) loadBook(id) })
watch([renderedParas, chapterBody], () => {
  void nextTick(() => updateViewportFocusAnchor())
})
watch(renderedCount, (count) => {
  if (count === paras.value.length && contentRef.value) {
    scrollRatioView.value = currentChapterRatio(contentRef.value)
  }
})
watch(showDrawer, (open) => { if (open) void scrollCatalogToCurrent() })
watch(
  [showDrawer, showAiResult, showAiAssistant, showSearch, showMarks, showSelPopup, activeToolPanel, activeBottomPanel],
  () => {
    if (anyDrawerOpen() || selectionOpen()) toolsVisible.value = true
    lastToolActivityAt = Date.now()
    scheduleToolHide()
  },
)

onMounted(async () => {
  refreshTtsVoices()
  if ('speechSynthesis' in window) window.speechSynthesis.addEventListener?.('voiceschanged', refreshTtsVoices)
  window.addEventListener('keydown', onReaderKeydown)
  window.addEventListener('resize', onReaderResize)
  window.addEventListener('beforeunload', flushPendingReaderWrites)
  unsubAiChunk = window.api.ai.onChunk(({ jobId, delta }) => {
    if (jobId === recapJobId.value) recapText.value += delta
    if (jobId === translateJobId.value) aiResult.value += delta
    if (jobId === chatJobId.value && chatAssistantIndex.value >= 0) {
      const assistant = chatMessages.value[chatAssistantIndex.value]
      if (assistant) assistant.content += delta
    }
  })
  unsubAiStage = window.api.ai.onStage((event) => {
    assistantStages.value = { ...assistantStages.value, [event.jobId]: event.stage }
    if (event.jobId === chatJobId.value && event.citations?.length && chatAssistantIndex.value >= 0) {
      const assistant = chatMessages.value[chatAssistantIndex.value]
      if (assistant) {
        assistant.citations = event.citations
        if (event.uptoChapterId) assistant.uptoChapterId = event.uptoChapterId
      }
    }
  })
  unsubAiBudget = window.api.ai.onBudget(({ task, budget }) => {
    assistantBudgets.value = { ...assistantBudgets.value, [task]: budget }
  })
  unsubAiDone = window.api.ai.onDone((event) => {
    if (readingAiMode.value === 'auto' && !organizeQueuePaused.value && completedChapterQueue.value.length) {
      setTimeout(() => void organizeNextCompletedChapter(), 0)
    }
    if (event.ok && event.usage) void loadAssistantMaterial()
    const assistantKind = assistantKindForJob(event.jobId, assistantJobIds.value)
    if (assistantKind) {
      assistantCompleted.value = true
      lastAssistantUsage.value = event.ok ? event.usage ?? null : null
      lastAssistantTruncated.value = event.ok ? event.truncated === true : false
      assistantSaveState.value = updateAssistantSaveToken(assistantSaveState.value, assistantKind, event)
    }
    assistantStages.value = removeAssistantStage(assistantStages.value, event.jobId)
    if (event.jobId === organizingJobId.value && organizingStage.value === 'summary') {
      if (event.ok && !event.stopped && !event.saveToken) {
        organizingJobId.value = ''
        void organizeMemoryAfterSummary().then(() => {
          if (!organizingJobId.value && !queueBudget.value) finishOrganizingChapter(false)
        }).catch(() => finishOrganizingChapter(false))
      } else {
        message.warning(event.ok && event.saveToken ? '摘要未保存，请在 AI 助手中处理后重试' : event.ok ? '整理已停止' : event.message)
        finishOrganizingChapter(false)
      }
      return
    }
    if (event.jobId === translateJobId.value) {
      translateJobId.value = ''
      aiResult.value = event.ok ? event.text : `错误：${event.message}`
      return
    }
    if (event.jobId === chatJobId.value) {
      const assistantIndex = chatAssistantIndex.value
      const assistant = chatMessages.value[assistantIndex]
      if (event.ok) {
        if (assistant) {
          assistant.content = event.text
          assistant.citations = event.citations
          assistant.uptoChapterId = event.uptoChapterId
          assistant.stopped = event.stopped === true
        }
        if (!event.text && assistantIndex >= 0) chatMessages.value.splice(assistantIndex, 1)
      } else if (assistant) {
        assistant.content = `错误：${event.message}`
      }
      chatJobId.value = ''
      chatAssistantIndex.value = -1
      chatLoading.value = false
      return
    }
    if (event.jobId === memoryJobId.value) {
      const wasOrganizing = event.jobId === organizingJobId.value && organizingStage.value === 'memory'
      const kind = memoryJobKind.value
      const stopped = event.ok ? event.stopped === true : event.message === '已停止生成'
      memoryJobId.value = ''
      memoryJobKind.value = ''
      memoryStopping.value = false
      if (stopped) {
        message.info('更新已停止，原有记忆未改变。')
      } else if (event.ok && event.memoryUpdate) {
        memoryData.value = event.memoryUpdate.memory
        for (const character of memoryData.value.characters) aliasDrafts.value[character.id] = character.aliases.join('、')
        for (const item of [
          ...memoryData.value.characters, ...memoryData.value.relations,
          ...memoryData.value.foreshadows, ...memoryData.value.events,
        ]) summaryDrafts.value[item.id] = item.summary
        message.success(kind === 'rebuild'
          ? '小说记忆已重建'
          : kind === 'fromSource' ? '来源章节以后的记忆已重新分析'
          : `本次处理 ${event.memoryUpdate.processedChapters} 章，新增或更新 ${event.memoryUpdate.changedItems} 条记忆。`)
      } else if (!event.ok) {
        message.error(event.message)
      }
      if (wasOrganizing) {
        if (event.ok && !stopped && !event.saveToken && (event.memoryUpdate?.remainingChapters ?? 0) > 0) {
          organizingJobId.value = ''
          setTimeout(() => void organizeMemoryAfterSummary().then(() => {
            if (!organizingJobId.value) finishOrganizingChapter(false)
          }).catch(() => finishOrganizingChapter(false)), 0)
        } else finishOrganizingChapter(event.ok && !stopped && !event.saveToken)
      }
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
    downloadProgress.value = p
    if (p.status === 'done' || p.status === 'error' || p.status === 'cancelled') {
      void loadBook(book.value.id)
    }
  })
})

onUnmounted(() => {
  if ('speechSynthesis' in window) window.speechSynthesis.removeEventListener?.('voiceschanged', refreshTtsVoices)
  window.removeEventListener('keydown', onReaderKeydown)
  window.removeEventListener('resize', onReaderResize)
  window.removeEventListener('beforeunload', flushPendingReaderWrites)
  chapterPrefetch.dispose()
  ttsStop()
  if (renderTimer) clearTimeout(renderTimer)
  renderGeneration++
  clearToolHideTimer()
  void flushReaderPrefsSave()
  unsubDownload?.()
  unsubAiChunk?.()
  unsubAiStage?.()
  unsubAiBudget?.()
  unsubAiDone?.()
  void readerProgress.writeNow()
})
</script>

<template>
  <div :class="['reader-wrap', { 'immersive-locked': immersiveMode === 'locked' }]" :style="readerThemeStyle" @mousemove="onReaderPointerMove" @focusin="onReaderFocusIn">
    <!-- No book selected -->
    <div v-if="!book" class="page placeholder">
      <h2>阅读</h2>
      <p>从书库打开一本书后在这里阅读。</p>
      <n-button @click="emit('back')">返回书库</n-button>
    </div>

    <!-- Reader -->
    <template v-else>
      <div
        class="reader-toolbar"
        :class="{ 'reader-tools-hidden': !toolsVisible }"
        :aria-hidden="!toolsVisible"
        :inert="!toolsVisible"
        @mouseenter="onToolbarEnter"
        @mouseleave="onToolbarLeave"
      >
        <div class="reader-book-title" :title="book.title">{{ book.title }}</div>
        <button class="tool-button tool-text" type="button" title="书架" aria-label="书架" @click="emit('back')">书架</button>
        <button class="tool-button" title="搜索" aria-label="搜索" @click="openSearch"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg></button>
        <button class="tool-button" title="标记" aria-label="标记" @click="showMarks = true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z"/></svg></button>
        <button class="tool-button" title="朗读" aria-label="朗读" @click="toggleToolPanel('tts')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h4l5 4V6L9 10zM18 9a5 5 0 0 1 0 6"/></svg></button>
        <button class="tool-button" title="AI" aria-label="AI" @click="toggleToolPanel('ai')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 9.8 8.8 4 11l5.8 2.2L12 19l2.2-5.8L20 11l-5.8-2.2z"/></svg></button>
        <span class="toolbar-gap" aria-hidden="true"></span>
        <template v-if="downloadProgress?.status === 'running' && downloadProgress.bookId === book.id">
          <span class="tool-button tool-text" role="status">已下 {{ downloadProgress.done }} / {{ downloadProgress.total }} 章</span>
          <button class="tool-button tool-text" type="button" @click="cancelReaderDownload">取消</button>
        </template>
        <button class="tool-button tool-text" type="button" title="设置" aria-label="设置" @click="emit('go-settings')">设置</button>
        <button class="tool-button tool-text" type="button" title="浏览" aria-label="浏览" @click="emit('go-browse')">浏览</button>
        <button class="tool-button tool-button-offstage" title="快捷键说明" aria-label="快捷键说明" @click="toggleToolPanel('shortcuts')"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="2"/><path d="M7 10h1M10 10h1M13 10h1M16 10h1M7 14h7M16 14h1"/></svg></button>
        <button class="tool-button" :title="immersiveMode === 'locked' ? '退出沉浸模式' : '沉浸模式'" :aria-label="immersiveMode === 'locked' ? '退出沉浸模式' : '沉浸模式'" @click="toggleImmersiveLock"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg></button>

        <div v-if="activeToolPanel" class="tool-panel" @click.stop>
          <template v-if="activeToolPanel === 'tts'">
            <strong>听书</strong>
            <n-space vertical :size="6" v-if="ttsSupported">
              <n-space :size="6" v-if="!ttsSpeaking">
                <n-button v-if="ttsSavedPosition" size="tiny" type="primary" @click="ttsContinueSaved">继续上次听书</n-button>
                <n-button size="tiny" :disabled="!chapterReady" @click="ttsStartCurrent">从当前位置播放</n-button>
                <n-button size="tiny" :disabled="!chapterReady" @click="ttsStartBeginning">从本章开头播放</n-button>
              </n-space>
              <n-space :size="6" v-else>
                <n-button size="tiny" @click="ttsPrevious">上一段</n-button>
                <n-button v-if="ttsPaused && ttsError" size="tiny" type="primary" @click="ttsRetry">重试</n-button>
                <n-button v-else-if="ttsPaused" size="tiny" type="primary" @click="ttsResume">继续</n-button>
                <n-button v-else size="tiny" @click="ttsPause">暂停</n-button>
                <n-button size="tiny" @click="ttsNext">下一段</n-button>
                <n-button size="tiny" @click="ttsStop()">停止</n-button>
              </n-space>
              <div v-if="ttsError" class="control-label" role="alert">{{ ttsError }}。{{ ttsSource === 'online' ? '可重试或切换系统语音。' : '可重试或更换系统音色。' }}</div>
              <div v-if="ttsSpeaking && spokenPara >= 0" class="control-label" role="status">本章第 {{ spokenPara + 1 }} / {{ paras.length }} 段</div>
              <progress v-if="ttsSpeaking && spokenPara >= 0" :value="spokenPara + 1" :max="paras.length" :aria-label="`本章听书进度 ${spokenPara + 1} / ${paras.length} 段`" style="width:100%"></progress>
              <div class="control-label">语音来源</div>
              <select v-model="ttsSource" aria-label="语音来源"><option value="system">系统语音</option><option value="online">在线语音</option></select>
              <template v-if="ttsSource === 'system'">
                <div class="control-label">系统音色</div>
                <select v-model="ttsVoiceURI" aria-label="系统音色"><option value="">系统默认</option><option v-for="voice in ttsVoices" :key="voice.voiceURI" :value="voice.voiceURI">{{ voice.name }}（{{ voice.lang }}）</option></select>
              </template>
              <div v-else class="control-label">在线模型、音色和密钥在设置页配置。<n-button size="tiny" text @click="emit('go-settings')">去设置</n-button></div>
              <div class="control-label">语速 {{ ttsRate.toFixed(1) }}x</div><n-slider v-model:value="ttsRate" :min="0.5" :max="2" :step="0.1" />
              <div class="control-label">{{ ttsSource === 'system' ? '系统语速从下一语音片段生效' : '在线音频立即调整播放速度' }}</div>
              <div class="control-label"><n-switch v-model:value="ttsAutoNext" /> 自动下一章</div>
              <label class="control-label">定时停止
                <select :value="ttsSleepMinutes" aria-label="定时停止" @change="setTtsSleepMinutes(Number(($event.target as HTMLSelectElement).value))">
                  <option :value="0">关闭</option><option :value="10">10 分钟</option><option :value="20">20 分钟</option><option :value="30">30 分钟</option><option :value="60">60 分钟</option>
                </select>
              </label>
            </n-space>
            <div v-else class="control-label">当前环境不支持朗读</div>
          </template>
          <template v-else-if="activeToolPanel === 'shortcuts'">
            <strong>快捷键</strong>
            <dl class="shortcut-list">
              <div><dt>← / →</dt><dd>上一章 / 下一章</dd></div>
              <div><dt>Space / Shift+Space，J / K</dt><dd>下一屏 / 上一屏</dd></div>
              <div><dt>T / A / R</dt><dd>目录 / 外观 / 朗读</dd></div>
              <div><dt>M / Alt / Esc</dt><dd>沉浸模式 / 临时唤回 / 关闭面板</dd></div>
              <div><dt>Ctrl+F，+ / -</dt><dd>本书搜索 / 调整字号</dd></div>
            </dl>
          </template>
          <template v-else>
            <strong>AI</strong>
            <n-space vertical :size="6"><n-button size="tiny" block :disabled="!chapterReady" :loading="cleanRunning" @click="aiCleanBody">清正文</n-button><n-button v-if="cleanRunning" size="tiny" block type="warning" @click="stopCleanBody">停止清正文</n-button><n-button v-if="hasBodyRaw" size="tiny" block @click="restoreCleanedBody">撤销清正文</n-button><n-button size="tiny" block @click="openAiAssistant('recap')">AI 助手</n-button><n-button size="tiny" block :disabled="!chapterReady" :loading="aiLoading" @click="aiCharacterCard">人物卡</n-button><n-button size="tiny" block :disabled="!chapterReady" @click="openAiAssistant('qa')">聊书</n-button></n-space>
          </template>
        </div>
      </div>

      <div class="reader-stage">
        <button class="reader-spine" type="button" :title="book.title" aria-label="返回书库" @click="emit('back')">
          <img v-if="spineCoverSrc" class="reader-spine-cover" :src="spineCoverSrc" alt="" />
          <span v-else class="reader-spine-initial">{{ spineInitial }}</span>
        </button>
        <div class="reader-body">
        <button class="chapter-hotzone left" :disabled="!previousChapter" :title="previousChapter ? `上一章：${previousChapter.title}` : '已经是第一章'" aria-label="上一章" @click="prevChapter"><span>‹</span></button>
        <div class="reader-content reader-pane" :class="{ 'large-chapter': paras.length > 2000 }" :style="contentStyle" ref="contentRef" @scroll="onScroll" @mouseup="onContentMouseup" @wheel="onContentWheel">
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
              v-for="(segs, i) in visibleParas"
              :key="i"
              :data-p="i"
              :class="['para', { 'para-speaking': i === spokenPara, 'para-unfocused': focusMode !== 'off' && resolveFocusAnchor({ spokenPara: spokenPara, viewportCenterPara }) >= 0 && !isParagraphInFocus({ mode: focusMode, anchorIndex: resolveFocusAnchor({ spokenPara: spokenPara, viewportCenterPara }), paragraphIndex: i, paragraphCount: renderedParas.length }) }]"
            ><template v-for="(s, j) in segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" class="hl-mark">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template><button v-if="ttsSupported && chapterReady" type="button" class="para-tts-start" :aria-label="`从第 ${i + 1} 段开始朗读`" title="从此段开始朗读" @mouseup.stop @click.stop="startTtsFromParagraph(i)">从此段朗读</button></p>
            <div v-if="renderedCount < paras.length" class="loading-hint" role="status">正在排版：{{ renderedCount }} / {{ paras.length }} 段</div>
            <button v-else-if="chapterReady && followingChapter" class="chapter-end-card" @click="nextChapter">下一章：{{ followingChapter.title }}</button>
            <div v-else-if="chapterReady && currentChapterIndex === chapters.length - 1" class="chapter-end-card finished">
              <strong>已读完《{{ book.title }}》</strong>
              <n-button size="small" @click="emit('back')">返回书库</n-button>
            </div>
            <div v-if="readingMode === 'screen'" class="reader-page-indicator">{{ visualPageLabel(visualPageIndexView, visualPageCountView) }}</div>
          </template>
        </div>
        <button class="chapter-hotzone right" :disabled="!followingChapter" :title="followingChapter ? `下一章：${followingChapter.title}` : '已经是最后一章'" aria-label="下一章" @click="nextChapter"><span>›</span></button>
        </div>
      </div>

      <div class="reader-bottombar" :class="{ 'reader-tools-hidden': !toolsVisible }" :aria-hidden="!toolsVisible" :inert="!toolsVisible" @mouseenter="onToolbarEnter" @mouseleave="onToolbarLeave">
        <button class="bottom-button" type="button" aria-label="目录" :class="{ active: activeBottomPanel === 'catalog' || showDrawer }" @click="toggleBottomPanel('catalog')">目录</button>
        <button class="bottom-button" type="button" aria-label="进度" :class="{ active: activeBottomPanel === 'progress' }" @click="toggleBottomPanel('progress')">进度</button>
        <button class="bottom-button" type="button" aria-label="背景" :class="{ active: activeBottomPanel === 'background' }" @click="toggleBottomPanel('background')">背景</button>
        <button class="bottom-button" type="button" aria-label="字体" :class="{ active: activeBottomPanel === 'font' }" @click="toggleBottomPanel('font')">字体</button>
        <div v-if="activeBottomPanel && activeBottomPanel !== 'catalog'" class="bottom-panel" @click.stop>
          <template v-if="activeBottomPanel === 'progress'">
            <strong>进度</strong>
            <div class="control-label">{{ bookProgressDetail }}</div>
            <div class="control-label">全书约 {{ bookPercent }}%（按章节估算）</div>
            <div class="reader-progress-row panel" aria-hidden="true"><div class="reader-progress-fill book" :style="{ width: `${bookPercent}%` }"></div></div>
            <div class="control-label">本章 {{ chapterPercent }}%</div>
            <div class="reader-progress-row panel" aria-hidden="true"><div class="reader-progress-fill chapter" :style="{ width: `${chapterPercent}%` }"></div></div>
          </template>
          <template v-else-if="activeBottomPanel === 'background'">
            <strong>背景</strong>
            <div class="option-grid four"><button v-for="item in [{v:'paper',l:'纸白'},{v:'sepia',l:'暖黄'},{v:'gray',l:'柔灰'},{v:'night',l:'夜间'}]" :key="item.v" :class="{ active: theme === item.v }" @click="theme = item.v as ReaderTheme">{{ item.l }}</button></div>
          </template>
          <template v-else>
            <strong>字体</strong>
            <div class="control-label">字体</div>
            <div class="option-grid"><button v-for="item in [{v:'serif',l:'宋体阅读'},{v:'system',l:'系统黑体'},{v:'mono',l:'等宽'}]" :key="item.v" :class="{ active: fontFamily === item.v }" @click="fontFamily = item.v as ReaderFontFamily">{{ item.l }}</button></div>
            <div class="control-label">字号 {{ fontSize }}</div><n-slider v-model:value="fontSize" :min="12" :max="36" :step="1" />
            <div class="control-label">行距 {{ lineHeight.toFixed(1) }}</div><n-slider v-model:value="lineHeight" :min="1.2" :max="3" :step="0.1" />
            <div class="control-label">列宽</div>
            <div class="option-grid"><button v-for="item in [{v:'narrow',l:'窄'},{v:'medium',l:'中'},{v:'wide',l:'宽'}]" :key="item.v" :class="{ active: contentWidth === item.v }" @click="contentWidth = item.v as ReaderContentWidth">{{ item.l }}</button></div>
            <div class="control-label">段间距</div>
            <div class="option-grid"><button v-for="item in [{v:'compact',l:'紧凑'},{v:'normal',l:'标准'},{v:'relaxed',l:'宽松'}]" :key="item.v" :class="{ active: paragraphSpacing === item.v }" @click="paragraphSpacing = item.v as ReaderParagraphSpacing">{{ item.l }}</button></div>
            <div class="control-label"><n-switch v-model:value="paragraphIndent" /> 首行缩进</div>
            <div class="control-label">行焦点</div>
            <div class="option-grid four">
              <button v-for="item in [{v:'off',l:'关'},{v:'one',l:'1 段'},{v:'three',l:'3 段'},{v:'five',l:'5 段'}]" :key="item.v" :class="{ active: focusMode === item.v }" @click="focusMode = item.v as ReaderFocusMode">{{ item.l }}</button>
            </div>
            <div class="control-label">阅读方式</div>
            <div class="option-grid">
              <button v-for="item in [{v:'scroll',l:'连续滚动'},{v:'screen',l:'屏幕翻页'}]" :key="item.v" :class="{ active: readingMode === item.v }" @click="readingMode = item.v as ReaderReadingMode">{{ item.l }}</button>
            </div>
            <n-button size="small" @click="restoreDefaultReaderPrefs">恢复默认</n-button>
          </template>
        </div>
      </div>

      <div class="reader-progress-track" :title="bookProgressDetail" :aria-label="bookProgressDetail">
        <div class="reader-progress-row" aria-hidden="true">
          <div class="reader-progress-fill book" :style="{ width: `${bookPercent}%` }"></div>
        </div>
        <div class="reader-progress-row" aria-hidden="true">
          <div class="reader-progress-fill chapter" :style="{ width: `${chapterPercent}%` }"></div>
        </div>
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
                <n-tag v-if="catalogBadge(ch) === 'failed'" size="tiny" type="error">{{ ch.failCode ? FAIL_CODE_ZH[ch.failCode] : '失败' }}</n-tag>
                <n-tag v-else-if="catalogBadge(ch) === 'pending'" size="tiny">未下</n-tag>
                <n-tag v-else-if="catalogBadge(ch) === 'empty'" size="tiny" type="warning">空</n-tag>
                <n-tag v-else-if="catalogBadge(ch) === 'current'" size="tiny" type="info">当前</n-tag>
                <n-tag v-else-if="catalogBadge(ch) === 'read'" size="tiny">已读</n-tag>
              </div>
            </n-list-item>
          </n-list>
        </n-drawer-content>
      </n-drawer>

      <!-- AI result drawer -->
      <n-drawer v-model:show="showAiResult" placement="right" :width="420">
        <n-drawer-content :title="aiResultTitle" closable>
          <div v-if="aiResultTitle === '清正文' && lastCleanBudget" class="ai-budget-status">
            预计发送：{{ lastCleanBudget.chapterCount }} 章 / {{ lastCleanBudget.paragraphCount }} 段，约
            {{ lastCleanBudget.sentCharacters }} 字 / {{ lastCleanBudget.estimatedTokens }} tokens（估算）
          </div>
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

      <ai-budget-confirm
        :show="showCleanBudgetConfirm"
        :budget="cleanBudget"
        :message="cleanBudgetMessage"
        :loading="cleanRunning"
        @confirm="confirmOverBudgetClean"
        @cancel="cancelOverBudgetClean"
      />
      <ai-budget-confirm
        :show="showChapterSummaryBudgetConfirm"
        :budget="chapterSummaryBudget"
        :message="chapterSummaryBudgetMessage"
        @confirm="confirmOverBudgetChapterSummary"
        @cancel="cancelOverBudgetChapterSummary"
      />
      <ai-budget-confirm
        :show="showMemoryBudgetConfirm"
        :budget="memoryBudget"
        :message="memoryBudgetMessage"
        @confirm="confirmMemoryBudget"
        @cancel="showMemoryBudgetConfirm = false; memoryBudgetRequest = null"
      />

      <n-drawer v-model:show="showAiAssistant" placement="right" :width="420">
        <n-drawer-content title="AI 助手" closable>
          <div class="ai-assistant-heading">
            <strong>{{ book?.title }}</strong>
            <span>模型服务：{{ aiServiceOrigin || '未配置' }}</span>
            <span>当前任务：{{ aiAssistantTaskLabel }}</span>
            <span>{{ book?.progress?.chapterId ? `已读截止：${book.chapters.find((chapter) => chapter.id === book?.progress?.chapterId)?.title || '未知章节'}` : '还没有阅读进度，先阅读一章再使用已读内容分析。' }}</span>
            <span>仅包含当前阅读进度以内的内容，不发送未读章节。</span>
          </div>
          <div v-if="currentAssistantBudget" class="ai-budget-status">
            <strong>本次发送范围</strong>
            <div>预计发送：{{ currentAssistantBudget.chapterCount }} 章 / {{ currentAssistantBudget.paragraphCount }} 段，约 {{ currentAssistantBudget.sentCharacters }} 字 / {{ currentAssistantBudget.estimatedTokens }} tokens（估算）</div>
            <div>{{ currentAssistantBudget.range }}</div>
          </div>
          <div v-if="assistantStageText" class="ai-assistant-status">{{ assistantStageText }}</div>
          <div v-if="assistantCompleted" class="ai-assistant-status">
            <template v-if="lastAssistantUsage && (lastAssistantUsage.inputTokens !== undefined || lastAssistantUsage.outputTokens !== undefined)">
              最近一次：输入 {{ lastAssistantUsage.inputTokens ?? 0 }} / 输出 {{ lastAssistantUsage.outputTokens ?? 0 }} tokens
              <span v-if="lastAssistantUsage.cacheHitTokens !== undefined"> · 缓存命中 {{ lastAssistantUsage.cacheHitTokens }} tokens</span>
            </template>
            <template v-else>服务未返回 token 用量。</template>
            <div class="subtle">实际费用以模型服务商的计费规则为准。</div>
          </div>
          <n-tag v-if="lastAssistantTruncated" type="warning">回答可能因输出上限而截断。</n-tag>
          <div v-if="assistantSaveState.token" class="ai-save-warning">
            结果已生成，但未能保存到书库。
            <n-button size="small" :loading="assistantSaveRetrying" :disabled="assistantBusy" @click="retryAssistantSave">重试保存</n-button>
          </div>
          <div class="ai-budget-status">
            <strong>读完一章后整理</strong>
            <n-radio-group :value="readingAiMode" size="small" @update:value="setReadingAiMode">
              <n-radio-button value="manual">手动</n-radio-button>
              <n-radio-button value="ask">提醒我</n-radio-button>
              <n-radio-button value="auto">自动</n-radio-button>
            </n-radio-group>
            <div class="subtle">离开已读超过 90% 的章节时触发；自动模式会调用模型并消耗你的 API 额度。</div>
            <div v-if="completedChapterQueue.length">待整理 {{ completedChapterQueue.length }} 章：{{ completedChapterTitle }}{{ organizeQueuePaused ? '（已暂停）' : '' }}</div>
            <n-button v-if="completedChapterQueue.length && !organizeQueuePaused" size="small" @click="pauseCompletedQueue">暂停队列</n-button>
            <n-button v-if="organizeQueuePaused" size="small" type="primary" @click="resumeCompletedQueue">继续队列</n-button>
            <div v-if="queueBudget" class="ai-budget-status">
              {{ queueBudgetMessage }}
              <div>预计 {{ queueBudget.estimatedTokens }} tokens，{{ queueBudget.chapterCount }} 章。</div>
              <n-button size="small" type="primary" @click="confirmQueueBudget">确认预算并继续</n-button>
            </div>
            <n-button v-if="completedChapterQueue.length && !organizingBusy" size="small" :disabled="assistantBusy || organizeQueuePaused" @click="organizeNextCompletedChapter">整理下一章</n-button>
            <div v-if="bookUsage" class="subtle">本书累计 {{ bookUsage.calls }} 次模型调用，服务已报告输入 {{ bookUsage.inputTokens }} / 输出 {{ bookUsage.outputTokens }} tokens；未报告的用量不计入 token 总数。不计算金额。</div>
            <div v-if="currentAssistantBudget && currentAssistantBudget.sentCharacters > 20000" class="subtle">本次预计 {{ currentAssistantBudget.sentCharacters }} 字，接近 30000 字单次预算。</div>
            <div v-if="organizingBusy">正在整理：{{ organizingStage === 'memory' ? '更新小说记忆' : '生成章节摘要' }}
              <n-button v-if="organizingJobId" size="tiny" type="warning" @click="stopOrganizing">停止</n-button>
            </div>
          </div>
          <n-tabs v-model:value="aiAssistantTab" type="line" animated>
            <n-tab-pane name="recap" tab="前情">
              <div v-if="chapterSummaryBudget" class="ai-budget-status">
                预计发送：{{ chapterSummaryBudget.chapterCount }} 章 / {{ chapterSummaryBudget.paragraphCount }} 段，约
                {{ chapterSummaryBudget.sentCharacters }} 字 / {{ chapterSummaryBudget.estimatedTokens }} tokens（估算）
              </div>
              <n-radio-group :value="recapLength" size="small" @update:value="setRecapLength">
                <n-radio-button value="short">简短 · 约 200 字</n-radio-button>
                <n-radio-button value="standard">标准 · 约 500 字</n-radio-button>
                <n-radio-button value="detailed">详细 · 约 1000 字</n-radio-button>
              </n-radio-group>
              <p class="subtle">前情只根据已经生成的本章摘要和小说记忆整理。</p>
              <div v-if="materialCoverage" class="ai-budget-status">
                材料覆盖到：{{ materialCoverage.uptoChapterTitle }}（{{ materialCoverage.summarizedChapters }}/{{ materialCoverage.readyChapters }} 章已有摘要）
                <div v-if="materialCoverage.missing.length">缺摘要：{{ materialCoverage.missing.slice(0, 8).map((chapter) => chapter.title).join('、') }}<span v-if="materialCoverage.missing.length > 8"> 等 {{ materialCoverage.missing.length }} 章</span></div>
                <div v-else>已读范围内的就绪章节都已有摘要。</div>
              </div>
              <div class="ai-result">{{ recapText || '还没有前情提要。' }}</div>
              <n-space>
                <n-button :disabled="!book?.progress?.chapterId || assistantBusy || assistantSaveRetrying" type="primary" @click="startRecap('story')">刷新前情</n-button>
                <n-button :disabled="!chapterReady || assistantBusy || assistantSaveRetrying" @click="startRecap('chapter')">生成本章摘要</n-button>
              </n-space>
            </n-tab-pane>
            <n-tab-pane name="memory" tab="记忆">
              <n-space vertical>
                <n-space>
                  <n-button type="primary" :disabled="!book?.progress?.chapterId || assistantBusy || assistantSaveRetrying" @click="startMemoryJob('update')">更新记忆</n-button>
                  <n-popconfirm
                    positive-text="继续重建"
                    negative-text="取消"
                    @positive-click="startMemoryJob('rebuild')"
                  >
                    全部重建会删除现有 AI 记忆，并重新分析第一章到当前已读章节。旧记忆会在新结果完整保存后替换。确定继续吗？
                    <template #trigger><n-button :disabled="!book?.progress?.chapterId || assistantBusy || assistantSaveRetrying">全部重建</n-button></template>
                  </n-popconfirm>
                  <n-button v-if="memoryJobId" type="warning" :disabled="memoryStopping" @click="stopMemoryJob">{{ memoryStopping ? '正在停止…' : '停止生成' }}</n-button>
                </n-space>
                <div v-if="memoryData?.uptoChapterId" class="subtle">
                  已更新到：{{ book?.chapters.find((chapter) => chapter.id === memoryData?.uptoChapterId)?.title || memoryData.uptoChapterId }}
                </div>
                <div v-if="materialCoverage" class="subtle">
                  摘要覆盖到 {{ materialCoverage.uptoChapterTitle }}，缺 {{ materialCoverage.missing.length }} 章摘要。
                </div>
                <n-empty
                  v-if="!memoryData || !(memoryData.characters.length + memoryData.relations.length + memoryData.foreshadows.length + memoryData.events.length)"
                  description="还没有人物与剧情记忆。"
                >
                  <template #extra>更新记忆后，可按人物、关系、伏笔和关键事件查看已读剧情。</template>
                </n-empty>
                <template v-else>
                  <section v-if="memoryData.characters.length" class="memory-section">
                    <h3>人物</h3>
                    <details v-for="item in memoryData.characters" :key="item.id" class="memory-item" :open="item.accuracy === 'normal'">
                      <summary><strong>{{ item.name }}</strong><span v-if="item.accuracy !== 'normal'" class="memory-accuracy-tag">{{ item.accuracy === 'review' ? '待复核' : '存疑' }}</span></summary>
                      <p>{{ item.role }} · {{ item.status }}</p><p v-if="item.aliases.length">别名：{{ item.aliases.join('、') }}<span v-if="item.userEditedAliases">（用户修正）</span></p><p>{{ item.summary }}<span v-if="item.userEditedSummary">（用户修正）</span></p>
                      <n-input :value="aliasDrafts[item.id] ?? item.aliases.join('、')" size="small" placeholder="纠正别名，用顿号分隔" @update:value="(value: string) => { aliasDrafts[item.id] = value }" />
                      <n-button size="tiny" :loading="correctingAliasId === item.id" :disabled="assistantBusy" @click="saveCharacterAliases(item)">保存别名</n-button>
                      <n-input v-model:value="summaryDrafts[item.id]" type="textarea" :rows="2" placeholder="修正这条记忆的说明" />
                      <n-button size="tiny" :loading="correctingSummaryId === item.id" :disabled="assistantBusy" @click="saveMemorySummary('character', item)">保存说明</n-button>
                      <n-button size="tiny" :disabled="assistantBusy" @click="rebuildMemoryFromSource(item)">从来源章重建</n-button>
                      <button v-for="source in item.sources" :key="source.id" class="memory-source" type="button" :disabled="memorySourceJumping" @click="jumpToMemorySource(source)">{{ source.chapterTitle }} · 第 {{ source.paragraphIndex + 1 }} 段：{{ source.excerpt }} · 查看原文</button>
                      <n-button v-if="item.accuracy === 'normal'" text type="warning" :disabled="assistantSaveRetrying" @click="markMemoryItem('character', item)">标记不准确</n-button>
                    </details>
                  </section>
                  <section v-if="memoryData.relations.length" class="memory-section">
                    <h3>关系</h3>
                    <details v-for="item in memoryData.relations" :key="item.id" class="memory-item" :open="item.accuracy === 'normal'">
                      <summary><strong>{{ item.from }} — {{ item.to }}：{{ item.relation }}</strong><span v-if="item.accuracy !== 'normal'" class="memory-accuracy-tag">{{ item.accuracy === 'review' ? '待复核' : '存疑' }}</span></summary>
                      <p>{{ item.status }} · {{ item.summary }}<span v-if="item.userEditedSummary">（用户修正）</span></p>
                      <n-input v-model:value="summaryDrafts[item.id]" type="textarea" :rows="2" placeholder="修正这条记忆的说明" />
                      <n-button size="tiny" :loading="correctingSummaryId === item.id" :disabled="assistantBusy" @click="saveMemorySummary('relation', item)">保存说明</n-button>
                      <n-button size="tiny" :disabled="assistantBusy" @click="rebuildMemoryFromSource(item)">从来源章重建</n-button>
                      <button v-for="source in item.sources" :key="source.id" class="memory-source" type="button" :disabled="memorySourceJumping" @click="jumpToMemorySource(source)">{{ source.chapterTitle }} · 第 {{ source.paragraphIndex + 1 }} 段：{{ source.excerpt }} · 查看原文</button>
                      <n-button v-if="item.accuracy === 'normal'" text type="warning" :disabled="assistantSaveRetrying" @click="markMemoryItem('relation', item)">标记不准确</n-button>
                    </details>
                  </section>
                  <section v-if="memoryData.foreshadows.length" class="memory-section">
                    <h3>伏笔</h3>
                    <details v-for="item in memoryData.foreshadows" :key="item.id" class="memory-item" :open="item.accuracy === 'normal'">
                      <summary><strong>{{ item.desc }}</strong><span v-if="item.accuracy !== 'normal'" class="memory-accuracy-tag">{{ item.accuracy === 'review' ? '待复核' : '存疑' }}</span></summary>
                      <p>{{ item.status }} · {{ item.summary }}<span v-if="item.userEditedSummary">（用户修正）</span></p>
                      <n-input v-model:value="summaryDrafts[item.id]" type="textarea" :rows="2" placeholder="修正这条记忆的说明" />
                      <n-button size="tiny" :loading="correctingSummaryId === item.id" :disabled="assistantBusy" @click="saveMemorySummary('foreshadow', item)">保存说明</n-button>
                      <n-button size="tiny" :disabled="assistantBusy" @click="rebuildMemoryFromSource(item)">从来源章重建</n-button>
                      <button v-for="source in item.sources" :key="source.id" class="memory-source" type="button" :disabled="memorySourceJumping" @click="jumpToMemorySource(source)">{{ source.chapterTitle }} · 第 {{ source.paragraphIndex + 1 }} 段：{{ source.excerpt }} · 查看原文</button>
                      <n-button v-if="item.accuracy === 'normal'" text type="warning" :disabled="assistantSaveRetrying" @click="markMemoryItem('foreshadow', item)">标记不准确</n-button>
                    </details>
                  </section>
                  <section v-if="memoryData.events.length" class="memory-section">
                    <h3>关键事件</h3>
                    <details v-for="item in memoryData.events" :key="item.id" class="memory-item" :open="item.accuracy === 'normal'">
                      <summary><strong>{{ item.title }}</strong><span v-if="item.accuracy !== 'normal'" class="memory-accuracy-tag">{{ item.accuracy === 'review' ? '待复核' : '存疑' }}</span></summary>
                      <p v-if="item.participants.length">参与者：{{ item.participants.join('、') }}</p><p>{{ item.result }} · {{ item.summary }}<span v-if="item.userEditedSummary">（用户修正）</span></p>
                      <n-input v-model:value="summaryDrafts[item.id]" type="textarea" :rows="2" placeholder="修正这条记忆的说明" />
                      <n-button size="tiny" :loading="correctingSummaryId === item.id" :disabled="assistantBusy" @click="saveMemorySummary('event', item)">保存说明</n-button>
                      <n-button size="tiny" :disabled="assistantBusy" @click="rebuildMemoryFromSource(item)">从来源章重建</n-button>
                      <button v-for="source in item.sources" :key="source.id" class="memory-source" type="button" :disabled="memorySourceJumping" @click="jumpToMemorySource(source)">{{ source.chapterTitle }} · 第 {{ source.paragraphIndex + 1 }} 段：{{ source.excerpt }} · 查看原文</button>
                      <n-button v-if="item.accuracy === 'normal'" text type="warning" :disabled="assistantSaveRetrying" @click="markMemoryItem('event', item)">标记不准确</n-button>
                    </details>
                  </section>
                </template>
              </n-space>
            </n-tab-pane>
            <n-tab-pane name="qa" tab="问答">
              <div class="chat-messages">
                <div v-for="(msg, i) in chatMessages" :key="i" :class="['chat-msg', msg.role]">
                  <div class="chat-bubble">{{ msg.content }}</div>
                  <template v-if="msg.role === 'assistant'">
                    <n-tag v-if="msg.stopped" size="small" type="warning">已停止，以下为停止前生成的部分回答。</n-tag>
                    <div v-if="msg.citations?.length" class="chat-evidence">
                      <strong>依据</strong>
                      <button v-for="citation in msg.citations" :key="citation.id" class="memory-source" type="button" :disabled="memorySourceJumping" @click="jumpToMemorySource(citation)">{{ citation.chapterTitle }} · 第 {{ citation.paragraphIndex + 1 }} 段：{{ citation.excerpt }} · 查看原文</button>
                    </div>
                    <div v-else-if="msg.citations === undefined && !msg.content.startsWith('错误：')" class="chat-legacy">旧版回答，无来源</div>
                  </template>
                </div>
                <div v-if="chatMessages.length === 0 && !chatLoading" class="chat-empty">
                  可询问已读内容，回答会附上可回到原文的依据。
                </div>
              </div>
              <div class="chat-input-row">
                <n-popconfirm positive-text="确定" negative-text="取消" @positive-click="clearChat">
                  确定清空这本书的全部 AI 问答记录吗？此操作无法撤销。
                  <template #trigger>
                    <n-button :disabled="chatLoading || assistantSaveRetrying || chatMessages.length === 0">清空聊天</n-button>
                  </template>
                </n-popconfirm>
                <n-input v-model:value="chatInput" type="textarea" :rows="2" placeholder="询问已经读过的剧情、人物、关系或伏笔…" :disabled="assistantBusy || assistantSaveRetrying" @keydown.stop @keyup.ctrl.enter="sendChat" />
                <n-button v-if="chatLoading" type="warning" @click="stopChat">停止生成</n-button>
                <n-button v-else type="primary" :disabled="!chatInput.trim() || assistantBusy || assistantSaveRetrying" @click="sendChat">发送问题</n-button>
              </div>
            </n-tab-pane>
          </n-tabs>
          <template #footer>
            <n-button v-if="recapLoading && aiAssistantTab === 'recap'" type="warning" @click="stopRecap">停止生成</n-button>
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
        <n-button size="tiny" @click="askSelectedText('explain')">问 AI · 解释这段</n-button>
        <n-button size="tiny" @click="askSelectedText('person')">这个人物是谁</n-button>
        <n-button size="tiny" @click="askSelectedText('backstory')">这件事之前发生了什么</n-button>
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
  /* 工具区跟随应用外观，正文纸色由阅读偏好独立控制。 */
  --r-bar-bg: var(--bar-bg);
  --r-line: var(--line);
  --r-muted: var(--muted);
  --r-surface: var(--surface-2);
  --r-hover: var(--hover);
  --r-focus: var(--focus);
  --r-panel-bg: var(--surface-2);
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: transparent;
  color: var(--text);
  transition: background var(--motion-duration) var(--motion-easing), color var(--motion-duration) var(--motion-easing);
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

.para-unfocused { opacity: 0.4; }

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
  flex-wrap: wrap;
  width: min(360px, calc(100vw - 16px));
  gap: 6px;
  background: var(--popover-bg);
  border: 1px solid var(--r-line);
  border-radius: var(--radius-overlay);
  padding: 6px 8px;
  box-shadow: var(--shadow-overlay), var(--popover-ring);
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
  border-radius: var(--radius-overlay);
  background: var(--popover-bg);
  box-shadow: var(--shadow-overlay);
}
.direct-note-excerpt {
  max-height: 72px;
  overflow: auto;
  padding: 8px;
  border-radius: 6px;
  background: var(--surface-2);
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
  border: 1px solid var(--r-line);
  border-radius: var(--radius-control);
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

.ai-budget-status {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--panel-soft, rgba(127, 127, 127, 0.1));
  font-size: 12px;
  line-height: 1.6;
}

.ai-result {
  white-space: pre-wrap;
  line-height: 1.8;
  font-size: 14px;
  padding: 0 4px;
}

.ai-assistant-heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  color: var(--r-muted);
}

.ai-assistant-status,
.ai-save-warning {
  margin-bottom: 8px;
  padding: 8px;
  border-radius: 8px;
  background: var(--r-panel-bg);
  color: var(--r-muted);
  font-size: 12px;
}

.ai-save-warning {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.memory-section h3 {
  margin: 12px 0 6px;
}

.memory-item {
  padding: 10px;
  margin-bottom: 8px;
  border: 1px solid var(--r-line);
  border-radius: 8px;
}

.memory-item summary {
  cursor: pointer;
}

.memory-item summary:focus-visible {
  outline: 2px solid var(--active-chapter);
  outline-offset: 2px;
}

.memory-accuracy-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--warning-surface);
  color: var(--warning);
  font-size: 12px;
  font-weight: 500;
}

.memory-item p {
  margin: 6px 0;
  white-space: pre-wrap;
}

.memory-source {
  display: block;
  width: 100%;
  margin: 6px 0;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--r-muted);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  white-space: pre-wrap;
  cursor: pointer;
}
.memory-source:hover { background: var(--surface-3); }
.memory-source:focus-visible { outline: 2px solid var(--active-chapter); outline-offset: 2px; }

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
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 6px;
}

.chat-evidence {
  width: 85%;
  padding: 8px 10px;
  border-left: 2px solid var(--active-chapter);
  color: var(--r-muted);
  font-size: 12px;
}

.chat-legacy {
  color: var(--r-muted);
  font-size: 12px;
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
  position: relative;
  z-index: 30;
  flex: 0 0 auto;
  width: 100%;
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--r-line);
  border-radius: var(--radius-card);
  background: color-mix(in srgb, var(--r-bar-bg) 94%, var(--r-surface));
  opacity: 1;
  pointer-events: auto;
}
.reader-toolbar.reader-tools-hidden,
.reader-bottombar.reader-tools-hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}
.reader-toolbar,
.reader-bottombar {
  transition: opacity .2s ease, visibility .2s ease;
}
.toolbar-gap { flex: 1 1 auto; min-width: 8px; }
.tool-button.tool-text { width: auto; flex-basis: auto; padding: 0 10px; font: inherit; font-size: 13px; }
.tool-button-offstage {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.tool-button {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.tool-button:hover { background: var(--r-hover); }
.tool-button:focus-visible { outline: 2px solid var(--r-focus); outline-offset: 2px; }
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
  border-radius: var(--radius-overlay);
  background: var(--popover-bg);
  box-shadow: var(--shadow-overlay);
}

.reader-stage { flex: 1 1 auto; min-height: 0; display: flex; background: var(--reader-outer); }
.reader-spine {
  flex: 0 0 52px; width: 52px; align-self: stretch; margin: 0; padding: 16px 6px;
  border: 0; border-right: 1px solid var(--r-line);
  background: color-mix(in srgb, var(--r-bar-bg) 88%, var(--reader-outer));
  color: var(--reader-paper-text); cursor: pointer;
}
.reader-spine:hover { background: var(--r-hover); }
.reader-spine:focus-visible { outline: 2px solid var(--r-focus); outline-offset: -3px; }
.reader-spine-cover { display: block; width: 40px; height: 56px; object-fit: cover; border-radius: 2px; }
.reader-spine-initial {
  display: grid; width: 40px; height: 56px; place-items: center; border-radius: 2px;
  background: color-mix(in srgb, var(--reader-paper-text) 10%, var(--reader-paper));
  font-size: 18px; line-height: 1;
}
.reader-body {
  position: relative; flex: 1 1 auto; min-width: 0;
  padding: 28px clamp(48px, 5vw, 72px) 20px; justify-content: center; overflow: hidden;
  background: var(--reader-outer);
}
.reader-bottombar {
  position: relative; z-index: 28; flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
  gap: 8px; min-height: 48px; padding: 6px 12px; border-top: 1px solid var(--r-line);
  background: color-mix(in srgb, var(--r-bar-bg) 94%, var(--r-surface));
}
.bottom-button {
  min-width: 64px; min-height: 32px; padding: 4px 12px; border: 0; border-radius: var(--radius-control);
  background: transparent; color: inherit; font: inherit; font-size: 14px; cursor: pointer;
}
.bottom-button:hover, .bottom-button.active { background: var(--r-hover); }
.bottom-button:focus-visible { outline: 2px solid var(--r-focus); outline-offset: 2px; }
.bottom-panel {
  position: absolute; left: 50%; bottom: calc(100% + 8px); width: min(420px, calc(100% - 24px));
  max-height: min(420px, 60vh); transform: translateX(-50%); overflow-y: auto; display: flex;
  flex-direction: column; gap: 8px; padding: 14px; border: 1px solid var(--r-line);
  border-radius: var(--radius-overlay); background: var(--popover-bg); box-shadow: var(--shadow-overlay);
}
.reader-progress-row.panel { height: 6px; overflow: hidden; background: var(--r-surface); }

.reader-content {
  position: relative;
  min-height: 0;
  width: min(100%, 38em);
  max-width: 38em;
  flex: 0 1 38em;
  padding: 64px clamp(24px, 5vw, 56px) 100px;
  border-radius: var(--radius-control) var(--radius-control) 0 0;
  box-shadow: 0 2px 18px rgba(0, 0, 0, .08);
}
.reader-page-indicator {
  position: absolute;
  right: 16px;
  bottom: 12px;
  pointer-events: none;
  color: var(--r-muted);
  font-size: 12px;
}

.reader-progress-track {
  position: absolute;
  z-index: 25;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  height: 4px;
  background: var(--r-surface);
  pointer-events: none;
}
.reader-progress-row { height: 2px; }
.reader-progress-fill {
  height: 100%;
  background: var(--active-chapter);
  transition: width .12s linear;
}
.reader-progress-fill.chapter { opacity: .55; }

.reader-wrap.immersive-locked .reader-progress-track { opacity: 1; }
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
.chapter-hotzone:not(:disabled):hover, .chapter-hotzone:not(:disabled):focus-visible { opacity: 1; background: var(--r-hover); }
.chapter-hotzone:disabled { cursor: default; }
.chapter-hotzone span { font-size: 36px; line-height: 1; }
.chapter-hotzone:focus-visible { outline: 2px solid var(--r-focus); outline-offset: -3px; }

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
.para { position: relative; text-indent: var(--paragraph-indent, 2em); margin-bottom: var(--paragraph-spacing, .45em); }
.large-chapter .para { content-visibility: auto; contain-intrinsic-size: auto 4em; }
.para-tts-start {
  position: absolute;
  top: 0;
  right: 0;
  padding: 2px 6px;
  border: 1px solid var(--r-line);
  border-radius: var(--radius-control);
  background: var(--r-surface);
  color: var(--r-muted);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0;
  cursor: pointer;
  transition: opacity var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing);
}
.para:hover .para-tts-start, .para-tts-start:focus-visible { opacity: 1; }
.para-tts-start:hover { background: var(--r-hover); }
.para-tts-start:focus-visible { outline: 2px solid var(--r-focus); outline-offset: 2px; }
.shortcut-list { display: grid; gap: 8px; margin: 0; }
.shortcut-list div { display: grid; gap: 2px; }
.shortcut-list dt { color: var(--text); font-weight: 600; }
.shortcut-list dd { margin: 0; color: var(--r-muted); font-size: 12px; }

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
.option-grid button.active { border-color: var(--active-chapter); background: var(--r-hover); }
.option-grid button:focus-visible { outline: 2px solid var(--r-focus); outline-offset: 1px; }

@media (prefers-reduced-motion: reduce) {
  .reader-wrap, .reader-wrap *, .reader-toolbar, .reader-bottombar, .reader-progress-fill { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}

:deep(button:focus-visible), :deep(.n-button:focus-visible), :deep(.n-input:focus-within) {
  outline: 2px solid var(--active-chapter);
  outline-offset: 2px;
}
</style>
