<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick, computed } from 'vue'
import { NButton, NConfigProvider, NDrawer, NDrawerContent, NEmpty, NInput, NList, NListItem, NPopconfirm, NRadioButton, NRadioGroup, NSlider, NSpace, NSwitch, NTabPane, NTabs, NTag, darkTheme, useMessage } from 'naive-ui'
import { DEFAULT_READER_PREFS, FAIL_CODE_ZH } from '@shared/types'
import { READER_THEME_COLORS } from '@shared/readerTheme'
import type {
  AiBookUsage,
  AiBudgetEstimate,
  AiBudgetEvent,
  AiChapterNote,
  AiCitation,
  AiEvidenceChatMessage,
  AiFollowCoverage,
  AiFollowMode,
  AiMaterialCoverage,
  AiMemoryBase,
  AiMemoryCharacter,
  AiMemoryFile,
  AiResumeCardView,
  AiTimelineView,
  AiUsage,
  Book,
  ChapterMeta,
  DownloadProgress,
  ReaderBookView,
  ReaderContentWidth,
  ReaderFocusMode,
  ReaderFontFamily,
  ReaderHandwritingFont,
  ReaderReadingMode,
  ReaderParagraphSpacing,
  ReaderPrefs,
  ReaderSheetColumns,
  ReadingProgress,
  TtsPosition,
  ReaderTheme,
} from '@shared/types'
import {
  approximateBookRatio,
  chapterScrollRatio,
  clampRatio,
  failAdvice,
  filterCatalogChapters,
  progressScrubLabel,
  progressScrubTarget,
  readerProgressLabel,
  readerScrollBehavior,
  remainingChapterCount,
  isParagraphInFocus,
  paragraphIndexAtViewportCenter,
  resolveFocusAnchor,
  resolveImmersiveKey,
  resolveReaderKey,
  scrollTopFromRatio,
  readerContentZone,
  readerTapCanPage,
  selectionPopupPosition,
  catalogChapterBadge,
  shouldResetReaderToolsOnEntry,
  isCurrentBookDownloading,
  shouldForceToolsForDownload,
  shouldRevealToolsForPreference,
  resolveDownloadToolsPolicy,
  progressAnchorBodyMatches,
} from './readerHelpers'
import type { ReaderDownloadSignal as DownloadSignal, ReaderImmersiveMode, ReaderDownloadToolsIntent } from './readerHelpers'
import { DEFAULT_PITCH_DEG, DEFAULT_TILT_DEG } from './realBookPitch'
import {
  adjacentVisualPage,
  estimateParagraphHeight,
  paragraphIndexForRatio,
  placeholderHeight,
  scrollTopForParagraphPage,
  scrollTopForVisualPage,
  snapScrollTopToParagraph,
  visualPageCount,
  visualPageIndex,
  visualPageLabel,
  windowBoundsFor,
} from './readerPager'
import type { ReaderParagraphSpan } from './readerPager'
import { clampTtsRate, splitIntoParagraphs, useTts } from './useTts'
import { ttsBodyHash, validTtsPosition } from './ttsPosition'
import { decorateText } from '@shared/paragraphSearch'
import { isSiteTailParagraph } from './readerTail'
import {
  buildRealBookWindow,
  mergedWindowParagraphs,
  type RealBookWindow,
  type RealBookWindowChapter,
} from './realBookWindow'
import RealBookStage from './RealBookStage.vue'
import type { RealBookAnchor } from './realBookPager'
import {
  detectWebGL,
  readRealBookRenderer,
  writeRealBookRenderer,
  type RealBookRenderer,
} from './realBookRenderer'
import {
  DEFAULT_REALBOOK_LOOK,
  readRealBookLook,
  writeRealBookLook,
  type RealBookLook,
} from './realBookLook'
import { DEFAULT_ZOOM, DESK_PALETTES, ENDPAPER_PALETTES, type RealBookDesk, type RealBookEndpaper } from './realBookWebGLModel'
import {
  decorateTextWithNotes,
  deriveRealBookNotes,
  type NoteTextMark,
  type NoteTextPart,
  type RealBookNote,
} from './realBookNotes'

/** 真实书籍舞台对外暴露的操作（由 defineExpose 决定）。 */
type RealBookStageHandle = {
  nextPage: () => void
  prevPage: () => void
  /** 纸面元素：分区（左右翻页 / 中区显隐工具）按它的横向位置算。 */
  paperEl?: HTMLElement | null
  goToAnchor: (anchor: RealBookAnchor | null) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
  /** 适应屏幕：整本书收进视口（参考站底栏的 fit-book / 0 键）。 */
  fitBook?: () => void
  resetPitch: () => void
  toggleOpen?: () => void
  currentPage: number
  pageCount: number
  readEnd: () => { paragraphIndex: number; characterOffset: number } | null
}
import { useReaderMarks } from './readerMarks'
import { useReaderSelection } from './readerSelection'
import { useReaderAssistant } from './readerAssistant'
import { selectionRangeOffsets } from './selectionOffsets'
import type { Annotation, BookSearchHit } from '@shared/types'
import AiBudgetConfirm from '../components/AiBudgetConfirm.vue'
import ReaderMindmap from '../components/ReaderMindmap.vue'
import MemoryGraph from '../components/MemoryGraph.vue'
import { buildMemoryGraph, sliceMemoryGraph } from './memoryGraph'
import BookMapPage from './BookMapPage.vue'
import AtlasDock from './atlas/AtlasDock.vue'
import { aiSaveRecoveryActive, runAiSaveRecovery } from '../aiSaveRecoveryLock'
import { locateMemorySourceParagraph } from './memorySourceLocator'
import { normalizeEvidenceChatHistory } from './aiEvidenceUi'
import { claimCitationLines, evidenceVerificationLabel } from './readerChatMessage'
import { displayAiServiceOrigin } from './aiAssistantTransparency'
import {
  assistantKindForJob,
  type AssistantJobKind,
  type AssistantPanelTab,
  type AssistantSaveTokenState,
  type AssistantStageState,
  clearRetriedAssistantSaveToken,
  currentAssistantStage as resolveAssistantStage,
  describeAssistantStage,
  removeAssistantStage,
  updateAssistantSaveToken,
} from './aiAssistantStatus'
import { createChapterPrefetch } from './readerPrefetch'
import { createReaderProgressWriter } from './readerProgressWriter'
import type { CapturedProgressWrite } from './readerProgressWriter'
import { autoScrollSpeedPx, createAutoScroll } from './readingAutoScroll'
import { buildMindmapTree, type MindmapAnchor } from './readerMindmap'

const props = defineProps<{ bookId?: string; appSkin?: string }>()
const emit = defineEmits<{
  (e: 'back'): void
  (e: 'go-browse', url?: string): void
  (e: 'go-settings'): void
}>()
const message = useMessage()

const book = ref<Book | null>(null)
const downloadProgress = ref<DownloadProgress | null>(null)
// 下载 running 期间用户自己点过中区（收起或展开）：自动逻辑不再跟他抢，结束后按他的选择收场。
const downloadToolsIntent = ref<ReaderDownloadToolsIntent>('untouched')
const chapters = ref<ChapterMeta[]>([])
const bookChapterChars = ref<Record<string, number>>({})
const currentChapterChars = computed(() => Math.max(0, bookChapterChars.value[currentChapter.value?.id ?? ''] ?? 0))
const bookTotalChars = computed(() => Object.values(bookChapterChars.value).reduce((sum, chars) => sum + chars, 0))
const currentChapter = ref<ChapterMeta | null>(null)
const chapterPrefetch = createChapterPrefetch()
const chapterBody = ref('')
const chapterError = ref('')
const hasBodyRaw = ref(false)
const chapterLoading = ref(false)
// 导航代次：每次换书/换章递增。await 回来后若代次已变，说明这次加载已被更新的导航取代，
// 必须丢弃结果，否则慢的旧响应会覆盖新章/新书（快速连点下一章、快速连开两本书）。
let navEpoch = 0
const contentRef = ref<HTMLElement | null>(null)
const legacyReadProposal = ref<ReadingProgress | null>(null)
const resumeCardView = ref<AiResumeCardView | null>(null)
const resumeCardLoading = ref(false)
const resumeCardWarning = ref('')
const showDrawer = ref(false)
/** 书中地图抽屉；两种阅读模式共用同一份入口与内容。 */
const showMap = ref(false)
/** 章节抽屉的两个视图：目录（章节列表）与导图（本章结构）。 */
const drawerTab = ref<'catalog' | 'mindmap'>('catalog')
const catalogItemRefs = new Map<string, HTMLElement>()

// Reader prefs (from settings)
const fontSize = ref(DEFAULT_READER_PREFS.fontSize)
const lineHeight = ref(DEFAULT_READER_PREFS.lineHeight)
const theme = ref<ReaderTheme>(DEFAULT_READER_PREFS.theme)
// 应用皮肤切到深色时，没自己选过阅读主题（还停在默认「纸白」）的书跟着进夜间；
// 显式选过其它主题的不动。切回浅色也不回退（夜间正文在浅色界面同样可读），
// 只有用户自己在「外观」里改主题才覆盖。App 那边同时把持久化落到 settings。
watch(() => props.appSkin, (s) => {
  if (s === 'dark' && theme.value === 'paper') theme.value = 'night'
})
const fontFamily = ref<ReaderFontFamily>(DEFAULT_READER_PREFS.fontFamily)
/** 真实书籍的书页字体；参考站默认霞鹜文楷，与经典模式的正文字体分开存。 */
const bookFontFamily = ref<ReaderFontFamily>(DEFAULT_READER_PREFS.bookFontFamily ?? 'wenkai')
const contentWidth = ref<ReaderContentWidth>(DEFAULT_READER_PREFS.contentWidth)
const paragraphSpacing = ref<ReaderParagraphSpacing>(DEFAULT_READER_PREFS.paragraphSpacing)
const paragraphIndent = ref(DEFAULT_READER_PREFS.paragraphIndent)
const focusMode = ref<ReaderFocusMode>(DEFAULT_READER_PREFS.focusMode)
const readingMode = ref<ReaderReadingMode>(DEFAULT_READER_PREFS.readingMode)
// 阅读界面与批注手写体偏好已持久化；真实书籍渲染层是 M2 的独立组件，数据层与经典模式共用。
const bookView = ref<ReaderBookView>(DEFAULT_READER_PREFS.bookView ?? 'classic')
/** 真实书籍的底栏由 Reader 自己画（参考图的图标条），舞台内悬浮条让位。 */
const isRealBook = computed(() => bookView.value === 'realbook')
/** 渲染层偏好：WebGL 复刻；没有 WebGL 的机器和测试环境自动留在 CSS 3D。 */
const webglSupported = detectWebGL()
const storedRenderer = readRealBookRenderer()
// 支持 WebGL 时默认走复刻层；用户显式选过 CSS 3D 才回退，无 WebGL 的机器/测试环境保持 CSS。
const realBookRenderer = ref<RealBookRenderer>(webglSupported && storedRenderer !== 'css' ? 'webgl' : 'css')
const realBookLook = ref<RealBookLook>(readRealBookLook())
const realBookOpen = ref(true)
/** 真实书籍底栏显示的缩放倍率：真源在舞台内，靠 update:zoom 同步上来。 */
const realBookZoom = ref(realBookRenderer.value === 'webgl' ? DEFAULT_ZOOM : 1)
const realBookDeskOptions = Object.entries(DESK_PALETTES).map(([id, palette]) => ({ id: id as RealBookDesk, ...palette }))
const realBookEndpaperOptions = Object.entries(ENDPAPER_PALETTES).map(([id, palette]) => ({ id: id as RealBookEndpaper, ...palette }))
const realBookPitchPresets = [
  { value: 1, label: '平视' },
  { value: DEFAULT_TILT_DEG, label: '默认' },
  { value: 52, label: '斜视' },
]
const sheetColumns = ref<ReaderSheetColumns>(DEFAULT_READER_PREFS.sheetColumns ?? 'double')
/** 分页渲染层：书页模式与真实书籍共用同一套页表舞台，分支点集中在这一个判据上。 */
const pagedView = computed(() => bookView.value === 'sheet' || bookView.value === 'realbook')
const handwritingFont = ref<ReaderHandwritingFont>(DEFAULT_READER_PREFS.handwritingFont ?? 'none')
const handwritingNoteClass = computed(() => `handwriting-${handwritingFont.value}`)
const showInlineNotes = ref(DEFAULT_READER_PREFS.showInlineNotes ?? true)
const autoScrollSpeed = ref(DEFAULT_READER_PREFS.autoScrollSpeed ?? 3)
const autoNextChapter = ref(DEFAULT_READER_PREFS.autoNextChapter === true)
const dim = ref(DEFAULT_READER_PREFS.dim ?? 0)
// 渲染层整段净化（字体面板「净化」）接持久偏好 hideSiteTail，缺字段按缺省 true。
const hideSiteTail = ref(DEFAULT_READER_PREFS.hideSiteTail ?? true)
// 「工具一直显示」是持久偏好 hideReaderChrome 的反义：hideReaderChrome=false 才常显。
const hideReaderChrome = ref(DEFAULT_READER_PREFS.hideReaderChrome ?? true)
const alwaysShowTools = computed({
  get: () => hideReaderChrome.value === false,
  set: (value: boolean) => { hideReaderChrome.value = value !== true },
})
// 「本章显示原文」只是内存态，换章/重开书即恢复净化，绝不落盘。
const showRawThisChapter = ref(false)
const viewportCenterPara = ref(-1)
// AI state
const aiLoading = ref(false)
const cleanRunning = ref(false)
const aiResult = ref('')
const aiResultTitle = ref('')
const cleanBudget = ref<AiBudgetEstimate | null>(null)
const cleanBudgetMessage = ref('')
const showCleanBudgetConfirm = ref(false)
const lastCleanBudget = ref<AiBudgetEstimate | null>(null)
const catalogQuery = ref('')
const scrollRatioView = ref(0)
const visualPageIndexView = ref(0)
const visualPageCountView = ref(1)
const retryingChapter = ref(false)

// 沉浸工具层
const immersiveMode = ref<ReaderImmersiveMode>('normal')
const toolsVisible = ref(false)
const chapterFadeIn = ref(false)
const temporaryToolReveal = ref(false)
const pointerInToolbar = ref(false)
const activeToolPanel = ref<'tts' | 'ai' | 'shortcuts' | null>(null)
const activeBottomPanel = ref<'catalog' | 'progress' | 'background' | 'font' | 'more' | null>(null)

/**
 * 目录 / 标记抽屉与参考站左侧面板一致：暗底奶油白字。
 * 关键是不能只在真实书籍里给 darkTheme：下面那组 theme-overrides 是无条件生效的，
 * 经典模式下 theme 为 undefined 时抽屉照样被刷成近黑底，可文字还是浅色主题那套深灰，
 * 目录里除了当前章几乎整片看不清。所以抽屉恒用暗色主题。
 */
const realBookDrawerTheme = computed(() => darkTheme)
const realBookDrawerThemeOverrides = {
  common: {
    bodyColor: 'rgba(24, 28, 25, 0.96)',
    cardColor: 'rgba(24, 28, 25, 0.96)',
    modalColor: 'rgba(24, 28, 25, 0.96)',
    popoverColor: 'rgba(24, 28, 25, 0.96)',
    inputColor: 'rgba(244, 235, 211, 0.06)',
    actionColor: 'rgba(244, 235, 211, 0.06)',
    hoverColor: 'rgba(244, 235, 211, 0.08)',
    textColorBase: '#f4ebd3',
    textColor1: 'rgba(244, 235, 211, 0.92)',
    textColor2: 'rgba(244, 235, 211, 0.78)',
    textColor3: 'rgba(244, 235, 211, 0.56)',
    borderColor: 'rgba(244, 235, 211, 0.16)',
    dividerColor: 'rgba(244, 235, 211, 0.12)',
    primaryColor: '#f2d887',
    primaryColorHover: '#f6e3a8',
    primaryColorPressed: '#e6c96f',
    primaryColorSuppl: '#f2d887',
    closeIconColor: 'rgba(244, 235, 211, 0.6)',
    closeIconColorHover: 'rgba(244, 235, 211, 0.9)',
    closeIconColorPressed: 'rgba(244, 235, 211, 0.9)',
  },
}
/**
 * 真实书籍底栏收起后只剩底边那根小横条（iPhone 的 Home 指示条读法）：
 * 不交互时把整条图标带收走，书桌照完整露出来；点横条或点书页中区再展开。
 * 面板 / 目录抽屉开着时必须保持展开，否则它们会挂在一个看不见的栏上。
 */
const realBookBarCollapsed = computed(() =>
  isRealBook.value && !toolsVisible.value && !activeBottomPanel.value && !showDrawer.value)
let lastToolActivityAt = Date.now()
let toolHideTimer: ReturnType<typeof setTimeout> | null = null
// 阅读页用 v-show 常驻挂载：靠根元素的真实尺寸判断「是不是又回到这一页」。
const readerRootRef = ref<HTMLElement | null>(null)
// 上一次观测到的「本页是否在屏幕上」：null 表示还没观测过。
let readerOnScreen: boolean | null = null
let readerVisibilityObserver: ResizeObserver | null = null

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
  const previous = ttsSavedPosition.value
  const position: TtsPosition = { chapterId: currentChapter.value.id, paragraphIndex: index,
    bodyHash: ttsBodyHash(chapterBody.value), updatedAt: new Date().toISOString() }
  ttsSavedPosition.value = position
  ttsPositionWrite = ttsPositionWrite.then(() => window.api.tts?.setPosition?.(bookId, position)).catch(() => {
    // 落盘失败就把乐观更新退回去，否则面板会一直显示一个其实没保存的续播位置。
    if (ttsSavedPosition.value === position) ttsSavedPosition.value = previous
    message.warning('听书位置保存失败')
  })
}
const paras = computed(() => splitIntoParagraphs(chapterBody.value))
/**
 * 本章是否正在显示原文：只有「本章显示原文」打开、且总开关开着时才算。
 * 这是内存态，换章 / 重开书都不会带过去。
 */
const tailPurgeOffForChapter = computed(() => !hideSiteTail.value || showRawThisChapter.value)
/** 净化判断只跟正文与两个开关有关，按段缓存，滚动时不重复跑规则。 */
const tailHiddenFlags = computed(() => {
  const list = paras.value
  if (tailPurgeOffForChapter.value) return list.map(() => false)
  return list.map((text) => isSiteTailParagraph(text))
})
/** 要渲染的段落「原始下标」：过滤只减元素，下标仍是原文下标。 */
const visibleParaIndexes = computed(() => {
  const flags = tailHiddenFlags.value
  const out: number[] = []
  for (let i = 0; i < flags.length; i += 1) if (!flags[i]) out.push(i)
  return out
})
const renderedCount = ref(120)
/** 窗口化渲染的下界（含）。小章节恒为 0，行为与窗口化之前完全一致。 */
const renderWindowStart = ref(0)
/** 大章节判定：超过这个段数就不再一次性全量排版，改用窗口 + 首尾占位。 */
const LARGE_CHAPTER_PARAS = 2000
const isLargeChapter = computed(() => paras.value.length > LARGE_CHAPTER_PARAS)
/** 一次渲染的窗口段数：约 30 屏，够正常阅读期间不抖动，又不会一次塞进上千节点。 */
const WINDOW_SIZE = 240
/** 视口中心离窗口边缘不足这么多段就先迁移窗口：余量约 3 屏，光标爬行追不上。 */
const WINDOW_MARGIN = 30
/** 已渲染段的平均段高（px）；0 表示还没测到，占位先用字号估算。 */
const avgParaHeight = ref(0)
/** 没测到实测段高时的估算：字号 × 行高 × 2.5 行（中文正文常见 2~3 行）。 */
const fallbackParaHeight = computed(() => {
  const size = Number(fontSize.value) || 18
  const height = Number(lineHeight.value) || 1.8
  return Math.max(24, size * height * 2.5)
})
const effectiveParaHeight = computed(() =>
  avgParaHeight.value > 0 ? avgParaHeight.value : fallbackParaHeight.value,
)
let renderGeneration = 0
let renderTimer: ReturnType<typeof setTimeout> | null = null
/** 上一次量段高时的窗口签名，避免同一窗口重复强制布局。 */
let measuredWindowKey = ''

/** visibleParaIndexes 里严格小于 index 的条数（列表升序，二分）。 */
function visibleCountBefore(index: number): number {
  const list = visibleParaIndexes.value
  let low = 0
  let high = list.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (list[middle]! < index) low = middle + 1
    else high = middle
  }
  return low
}

/** 章标题与首段之间的占位：窗口已离开章首时撑出被跳过的段高。 */
const topGapHeight = computed(() => {
  if (!isLargeChapter.value || renderWindowStart.value <= 0) return 0
  return placeholderHeight(visibleCountBefore(renderWindowStart.value), effectiveParaHeight.value)
})

/** 末尾占位：窗口还没到章末时撑出剩余段高，滚动条长度始终按整章算。 */
const bottomGapHeight = computed(() => {
  if (!isLargeChapter.value) return 0
  const total = paras.value.length
  if (total <= 0 || renderedCount.value >= total) return 0
  const shown = visibleParaIndexes.value.length - visibleCountBefore(renderedCount.value)
  return placeholderHeight(shown, effectiveParaHeight.value)
})

function scheduleParagraphChunks(generation: number) {
  if (renderTimer) clearTimeout(renderTimer)
  // 大章节走窗口化：整章节点永不落地，后台爬升只会白烧一次全量重排。
  if (isLargeChapter.value) return
  if (renderedCount.value >= paras.value.length) return
  renderTimer = setTimeout(() => {
    if (generation !== renderGeneration) return
    renderedCount.value = Math.min(paras.value.length, renderedCount.value + 120)
    scheduleParagraphChunks(generation)
  }, 16)
}

watch(chapterBody, () => {
  renderGeneration++
  renderWindowStart.value = 0
  avgParaHeight.value = 0
  measuredWindowKey = ''
  renderedCount.value = Math.min(120, paras.value.length)
  scheduleParagraphChunks(renderGeneration)
}, { flush: 'sync' })

/** 从已渲染段量出平均段高，给首尾占位一个贴合当前字号的估计。 */
function refreshAvgParaHeight() {
  const el = contentRef.value
  if (!isLargeChapter.value || !el) return
  const key = `${renderWindowStart.value}:${renderedCount.value}`
  if (key === measuredWindowKey) return
  const spans = collectParagraphSpans(el)
  measuredWindowKey = key
  if (spans.length < 8) return
  const avg = estimateParagraphHeight(spans, fallbackParaHeight.value)
  if (avg > 0 && Math.abs(avg - avgParaHeight.value) >= 0.5) avgParaHeight.value = avg
}

/** 视口中心落在哪一段、段内偏移多少；中心落在占位间隙里返回 null。 */
function paragraphSpotAtViewportCenter(el: HTMLElement): { index: number; offset: number } | null {
  const centerY = el.getBoundingClientRect().top + el.clientHeight / 2
  const nodes = el.querySelectorAll<HTMLElement>('.para[data-p]')
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    if (rect.top <= centerY && rect.bottom >= centerY) {
      const index = Number(node.dataset.p)
      if (!Number.isSafeInteger(index) || index < 0) return null
      return { index, offset: centerY - rect.top }
    }
  }
  return null
}

/**
 * 把渲染窗口挪到 target 附近，并把原来视口中心那一段钉回视口中心。
 * 占位高度是估算值，不做这一步的话每次迁窗都会让正文向上/向下漂一截。
 *
 * 落进占位间隙（spot=null）时同样不能放弃：迁窗后目标段真实 DOM 已就位，
 * 必须按它的真实几何补偿，否则视口中心会停在两段之间的空白里（滚动后段空白）。
 */
function recenterWindowTo(target: number) {
  const pane = contentRef.value
  const total = paras.value.length
  if (!pane || !isLargeChapter.value || total <= 0) return
  const bounds = windowBoundsFor(target, total, WINDOW_SIZE)
  if (bounds.start === renderWindowStart.value && bounds.end === renderedCount.value) return
  // 迁窗前先记下「视口中心段」与「目标段」：前者钉回中心，后者用于 spot=null 时兜底补偿。
  const spot = paragraphSpotAtViewportCenter(pane)
  const anchorIndex = spot ? spot.index : target
  renderWindowStart.value = bounds.start
  renderedCount.value = bounds.end
  void nextTick(() => {
    const el = contentRef.value
    if (!el) return
    const centerY = el.getBoundingClientRect().top + el.clientHeight / 2
    const anchor = el.querySelector<HTMLElement>(`.para[data-p="${anchorIndex}"]`)
    if (!anchor) return
    const anchorTop = anchor.getBoundingClientRect().top
    // 视口中心原来在那段内的段内偏移；中心落进占位间隙时把它视为段中点（对齐到真实段）。
    const anchorOffset = spot ? spot.offset : anchor.offsetHeight / 2
    const shift = anchorTop + anchorOffset - centerY
    // 迁窗本身就是一次大位移（target 到 bounds 中心的差通常 <= WINDOW_SIZE/2 段），
    // 但极端情况下（比例估算偏差大）补偿量可能到几千 px：超过 1800px（约一整窗）说明
    // 估算与真实几何严重脱节，再补偿只会触发「迁窗→scroll→再迁窗」的风暴，直接放弃。
    if (!Number.isFinite(shift) || Math.abs(shift) >= 1800) return
    el.scrollTop += shift
    syncVisualPage()
    refreshAvgParaHeight()
  })
}

/** 滚动跟窗：视口中心快撞到窗口边缘（或落进占位间隙）时迁窗。 */
function followRenderWindow() {
  if (!isLargeChapter.value) return
  const el = contentRef.value
  if (!el) return
  const total = paras.value.length
  if (total <= 0) return
  if (renderedCount.value - renderWindowStart.value >= total) return
  const spot = paragraphSpotAtViewportCenter(el)
  // 落进占位间隙（拖滚动条跳到未渲染区）：按滚动比例估算目标段，一次跳到位。
  const center = spot
    ? spot.index
    : paragraphIndexForRatio(chapterScrollRatio(el.scrollTop, el.scrollHeight, el.clientHeight), total)
  if (spot && center >= renderWindowStart.value + WINDOW_MARGIN && center < renderedCount.value - WINDOW_MARGIN) return
  recenterWindowTo(center)
}

/**
 * 等到第 index 段真的进了 DOM。
 * 大章节直接把窗口迁到这段再 flush（毫秒级），小章节照旧等后台分批爬到这里。
 */
async function waitForParagraph(index: number, generation = renderGeneration): Promise<boolean> {
  if (generation !== renderGeneration) return false
  const total = paras.value.length
  if (index < 0 || index >= total) return true
  if (isLargeChapter.value) {
    const start = renderWindowStart.value
    const end = renderedCount.value
    if (index < start || index >= end) {
      const bounds = windowBoundsFor(index, total, WINDOW_SIZE)
      renderWindowStart.value = bounds.start
      renderedCount.value = bounds.end
    }
    await nextTick()
    return generation === renderGeneration
  }
  while (generation === renderGeneration && renderedCount.value <= index && index < total) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  await nextTick()
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

/** 本机是否要求减少动效：翻页/跳转的滚动行为统一走这里。 */
function hereScrollBehavior(): ScrollBehavior {
  return readerScrollBehavior(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true)
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

// 书签 / 划线笔记：整块逻辑搬到了 readerMarks.ts，这里只接线（名字保持原样，模板与调用点都不用改）
const marks = useReaderMarks({
  bookId: () => book.value?.id,
  currentChapterId: () => currentChapter.value?.id,
  normalizedBody: () => normalizedBody.value,
  chapterOrder: () => new Map(chapters.value.map((chapter, index) => [chapter.id, index])),
  memoryCharacters: () => memoryData.value?.characters ?? [],
  notify: (kind, text) => {
    if (kind === 'error') message.error(text)
    else if (kind === 'info') message.info(text)
    else message.success(text)
  },
  onAnnotationAdded: (annotation) => {
    if (!annotation.note) return
    showInlineNotes.value = true
    // 分页书台/书页要跳到卡片所在页；经典模式滚到被批注段落即可。
    if (pagedView.value) revealRealBookNote(annotation.id)
    else {
      const paragraph = paraNormStarts.value.findIndex((start, index) =>
        start <= annotation.start && annotation.start < start + (paras.value[index]?.length ?? 0) + 2)
      if (paragraph >= 0) void waitForParagraph(paragraph).then(() => scrollToParagraphOffset(paragraph, 0, 0))
    }
  },
})
const {
  annotations,
  lostHighlightIds,
  showMarks,
  editingNoteId,
  noteDraft,
  currentHighlightRanges,
  chapterBookmark,
  sortedMarks,
  markGroups,
  markColors,
  setColor,
  wordbookHighlights,
  wordbookTerms,
  wordbookTrimmed,
  wordbookPeople,
  reload: reloadAnnotations,
  resolveCurrentChapter: resolveCurrentAnnotations,
  toggleBookmark,
  saveNoteText,
  saveNote,
  remove: deleteAnnotation,
  deleteConfirmText,
} = marks
const restoringChat = ref(false)

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

/** 当前章的段落批注：只取有 note、未丢失、锚在本章的划线。 */
const realBookInlineNotes = computed(() => deriveRealBookNotes(
  annotations.value,
  currentChapter.value?.id ?? '',
  lostHighlightIds.value,
  paraNormStarts.value,
))
/** 经典模式按段落下标分组：卡片插在该段下面，不参与正文分段与选区坐标。 */
const classicInlineNotes = computed(() => {
  if (bookView.value !== 'classic' || !showInlineNotes.value) return new Map<number, RealBookNote[]>()
  const groups = new Map<number, RealBookNote[]>()
  for (const note of realBookInlineNotes.value) {
    const list = groups.get(note.paragraph)
    if (list) list.push(note)
    else groups.set(note.paragraph, [note])
  }
  return groups
})
/** 段内「注」标记：与卡片共用同一个开关；关闭后正文回到纯划线。 */
const inlineNoteMarks = computed(() => {
  const groups = new Map<number, NoteTextMark[]>()
  if (!showInlineNotes.value) return groups
  for (const note of realBookInlineNotes.value) {
    const list = groups.get(note.paragraph)
    if (list) list.push({ id: note.id, offset: note.offset })
    else groups.set(note.paragraph, [{ id: note.id, offset: note.offset }])
  }
  return groups
})

/** 新写/编辑批注后让舞台跳到卡片所在页；token 递增用于强制重查。 */
const inlineNoteRevealId = ref('')
const inlineNoteRevealToken = ref(0)
function revealRealBookNote(id: string) {
  if (!id) return
  showInlineNotes.value = true
  inlineNoteRevealId.value = id
  inlineNoteRevealToken.value += 1
}

/**
 * 页内批注编辑浮层：固定定位在 3D 舞台外。
 * 浮层不能放进书页：俯仰/翻页把输入框和点击区域一起做透视变形，编辑几乎无法命中。
 */
interface InlineNoteEditorState {
  id: string
  left: number
  top: number
}
const inlineNoteEditor = ref<InlineNoteEditorState | null>(null)
const inlineNoteDraft = ref('')
const inlineNoteTagsDraft = ref('')
const inlineNoteSaving = ref(false)
const inlineNoteDeleteArmed = ref(false)
const inlineNoteError = ref('')
const inlineNoteExcerpt = computed(() => {
  const id = inlineNoteEditor.value?.id
  return id ? annotations.value.find((item) => item.id === id)?.excerpt ?? '' : ''
})

function openInlineNoteEditor(id: string) {
  const annotation = annotations.value.find((item) => item.id === id)
  if (!annotation?.note) return
  // 卡片可能同时出现在左右页或翻动页；取第一个可见实例的几何作为浮层落点。
  const card = document.querySelector<HTMLElement>(`.real-book-note[data-note-id="${id}"]`)
  const width = Math.min(360, Math.max(240, window.innerWidth - 24))
  let left = Math.max(12, (window.innerWidth - width) / 2)
  let top = Math.max(12, (window.innerHeight - 260) / 2)
  if (card) {
    const rect = card.getBoundingClientRect()
    left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12))
    top = rect.bottom + 8
    if (top > window.innerHeight - 260) top = Math.max(12, rect.top - 250)
  }
  inlineNoteDraft.value = annotation.note
  inlineNoteTagsDraft.value = annotation.tags?.join(' ') ?? ''
  inlineNoteError.value = ''
  inlineNoteDeleteArmed.value = false
  inlineNoteEditor.value = { id, left, top }
}

function closeInlineNoteEditor() {
  if (inlineNoteSaving.value) return
  inlineNoteEditor.value = null
  inlineNoteDraft.value = ''
  inlineNoteTagsDraft.value = ''
  inlineNoteDeleteArmed.value = false
  inlineNoteError.value = ''
}

async function saveInlineNote() {
  const editor = inlineNoteEditor.value
  if (!editor || inlineNoteSaving.value) return
  const annotation = annotations.value.find((item) => item.id === editor.id)
  if (!annotation) {
    closeInlineNoteEditor()
    return
  }
  const text = inlineNoteDraft.value.trim()
  // 空内容不能保存：删除必须是读者显式动作，避免误清空后批注无声消失。
  if (!text) {
    inlineNoteError.value = '批注不能为空；要移除请点「删除」。'
    return
  }
  inlineNoteSaving.value = true
  try {
    const tags = inlineNoteTagsDraft.value.split(/[\s,，]+/).map((tag) => tag.replace(/^#+/, '')).filter(Boolean)
    const saved = await saveNoteText(annotation, text, tags)
    if (!saved) {
      inlineNoteError.value = '批注保存失败，请重试。'
      return
    }
    inlineNoteEditor.value = null
    inlineNoteDraft.value = ''
    inlineNoteTagsDraft.value = ''
    inlineNoteDeleteArmed.value = false
    inlineNoteError.value = ''
    revealRealBookNote(annotation.id)
  } finally {
    inlineNoteSaving.value = false
  }
}

async function deleteInlineNote() {
  const editor = inlineNoteEditor.value
  if (!editor || inlineNoteSaving.value) return
  if (!inlineNoteDeleteArmed.value) {
    inlineNoteDeleteArmed.value = true
    return
  }
  const annotation = annotations.value.find((item) => item.id === editor.id)
  if (!annotation) {
    closeInlineNoteEditor()
    return
  }
  inlineNoteSaving.value = true
  try {
    await deleteAnnotation(annotation)
    if (annotations.value.some((item) => item.id === editor.id)) {
      inlineNoteDeleteArmed.value = false
      inlineNoteError.value = '删除失败，请重试。'
      return
    }
    inlineNoteEditor.value = null
    inlineNoteDraft.value = ''
    inlineNoteTagsDraft.value = ''
    inlineNoteDeleteArmed.value = false
    inlineNoteError.value = ''
  } finally {
    inlineNoteSaving.value = false
  }
}

// 选区工具条：状态与动作在 readerSelection.ts，这里只接线（名字保持原样，模板不用改）。
// 落点有讲究：必须在 paragraphStarts/normalizedBody 之后（实参不能 TDZ），
// 又在引用选区状态的那些 watch 之前（watch 源是立即求值的）。
const selection = useReaderSelection({
  paragraphStarts: () => paraNormStarts.value,
  normalizedBody: () => normalizedBody.value,
  // 真实书籍模式下正文不在滚动容器里，但选区照样有效：判据是「有没有正文可读」。
  hasContent: () => Boolean(contentRef.value) || pagedView.value,
  // 俯仰后选区矩形会随透视偏移，几何不可信 → 工具条改贴视口底部居中。
  fixedAnchor: () => realBookPitch.value > 0,
  message,
  marks,
})
const {
  selPopupX,
  selPopupY,
  lastSelRect,
  applySelPopupPosition,
  showSelPopup,
  selectedExcerpt,
  selectedRange,
  showDirectNote,
  directNoteDraft,
  selectionOffsets,
  onContentMouseup,
  presentSelectionRange,
  closeSelectionTools,
  copySelectedText,
  openDirectNote,
  saveDirectNote,
  addHighlight,
  SELECTION_ACTIONS,
  pinnedActions,
  isPinned,
  togglePinned,
} = selection

/** 工具栏与菜单的图标：一条 path 数据就能画出来的线性图标，免得模板里堆大段 SVG。 */
const SEL_ACTION_ICON: Record<import('./readerSelection').SelectionActionId, string> = {
  ask: 'M12 4.5c-4.2 0-7.5 2.6-7.5 6.1 0 2.2 1.2 4 3.2 5.1l-.6 3.3 3.3-1.6c.5.1 1.1.1 1.6.1 4.2 0 7.5-2.6 7.5-6.1S16.2 4.5 12 4.5Z',
  copy: 'M9 9h10v10H9z M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5',
  highlight: 'm14.5 4.5 5 5L10 19H5v-5Z M13 6l5 5',
  note: 'M5 4h14v13l-4 3H5Z M8.5 9h7M8.5 12.5h4',
  read: 'M4 10v4a1 1 0 0 0 1 1h2.5l3.6 3V6L7.5 9H5a1 1 0 0 0-1 1Z M15.5 9.2a4 4 0 0 1 0 5.6M18 6.8a7.4 7.4 0 0 1 0 10.4',
  explainWord: 'M6 4h9l3 3v13H6z M9 9h6M9 12.5h6M9 16h3.5',
  'explain-text': 'M12 4.5c-4.2 0-7.5 2.6-7.5 6.1 0 2.2 1.2 4 3.2 5.1l-.6 3.3 3.3-1.6c.5.1 1.1.1 1.6.1 4.2 0 7.5-2.6 7.5-6.1S16.2 4.5 12 4.5Z',
  translate: 'M4 6h9M8.5 4v2c0 4-1.6 7.2-4.5 9M6 9.5c0 2.6 2 5.1 5 6.2 M13 20l4-9 4 9M14.6 17h4.8',
  who: 'M12 5.2a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6Z M5.5 20c0-3.4 2.9-5.6 6.5-5.6s6.5 2.2 6.5 5.6',
  backstory: 'M4 12a8 8 0 1 0 2.6-5.9 M4 4.5V10h5.5',
  chat: 'M3.5 7.5a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8l-4.5 3.5Z',
}

/** 需要品牌色标记的 AI 动作；文档类动作保持单色。 */
const SEL_AI_ACTIONS = new Set<import('./readerSelection').SelectionActionId>([
  'ask', 'explainWord', 'explain-text', 'translate', 'who', 'backstory', 'chat',
])

/** 工具栏只渲染钉住的动作，顺序按钉住顺序（就是用户点图钉的先后）。 */
const pinnedBarActions = computed(() => {
  const byId = new Map(SELECTION_ACTIONS.map((action) => [action.id, action]))
  return pinnedActions.value.map((id) => byId.get(id)).filter((action): action is (typeof SELECTION_ACTIONS)[number] => Boolean(action))
})

/** 菜单里从第几项开始插分隔线：文稿类在前，AI 类在后。 */
const SEL_MENU_DIVIDER_AT = 5

/**
 * 划词菜单底部的模型选择器。
 * 真源是 Settings.model（与设置页同一个字段），这里只做快捷切换，
 * 提示词、端点、Key 仍由设置页负责。
 */
const showModelMenu = ref(false)
const aiModelValue = ref('')
const aiModelOptions = ref<Array<{ label: string; value: string }>>([])
const aiModelLabel = computed(() => aiModelValue.value || '未配置模型')

async function loadAiModelOptions() {
  try {
    const current = await window.api.settings.get()
    aiModelValue.value = current.model || ''
    // 内置候选 + 当前已配置的模型（自定义端点可能用任何名字，也必须能选到）。
    const builtin = ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner']
    const values = [...new Set([...builtin, current.model].filter((value): value is string => Boolean(value)))]
    aiModelOptions.value = values.map((value) => ({ value, label: value }))
  } catch {
    aiModelOptions.value = []
  }
}

async function applyAiModel(value: string) {
  showModelMenu.value = false
  if (value === aiModelValue.value) return
  const previous = aiModelValue.value
  aiModelValue.value = value
  try {
    const saved = await window.api.settings.set({ model: value })
    aiModelValue.value = saved.model || value
    message.success(`已切换到 ${aiModelValue.value}`)
  } catch {
    aiModelValue.value = previous
    message.error('切换模型失败，已恢复原模型')
  }
}

function onTogglePin(id: import('./readerSelection').SelectionActionId) {
  if (!togglePinned(id)) {
    message.warning('至少保留一个工具栏按钮；可以先把别的项钉上再取消这一项')
  }
}

/** 菜单与工具栏共用同一个入口：点图钉只切钉住，点项体才执行动作。 */
function runSelectionAction(id: import('./readerSelection').SelectionActionId) {
  showSelMenu.value = false
  switch (id) {
    case 'ask': openInlineAsk(); return
    case 'copy': copySelectedText(); return
    case 'highlight': void addHighlight(); return
    case 'note': openDirectNote(); return
    case 'read': readSelectionAloud(); return
    case 'explainWord': void explainSelection('word'); return
    case 'explain-text': void askSelectedText('explain'); return
    case 'translate': void translateSelectedText(); return
    case 'who': void askSelectedText('person'); return
    case 'backstory': void askSelectedText('backstory'); return
    case 'chat': void askSelectionInAgent(); return
  }
}

/**
 * 划词工具栏默认是紧凑图标条（复制/翻译/朗读/更多/关闭），点「⋯」才展开竖向菜单。
 * 菜单向下挂在工具条下沿，容器底边不够时翻到上方，避免被窗口裁掉。
 */
const showSelMenu = ref(false)
const SEL_MENU_HEIGHT = 372
const SEL_MENU_WIDTH = 268

/**
 * 划词行内问答卡的尺寸与位置：挂在所选文字下方，下方放不下就翻到上方。
 * 卡片比工具条宽，所以要按自己的尺寸单独算，不能复用它那套 191×30。
 */
const INLINE_ASK_SIZE = { width: 380, height: 260 }

const inlineAskStyle = computed(() => {
  const { width, height } = INLINE_ASK_SIZE
  const gap = 8
  const margin = 8
  const rect = selection.lastSelRect?.value ?? { top: 0, bottom: 0, left: 0, width: 0 }
  const below = rect.bottom + gap + height + margin <= window.innerHeight
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - gap - height)
  const centered = rect.left + rect.width / 2 - width / 2
  const left = Math.min(Math.max(margin, centered), Math.max(margin, window.innerWidth - width - margin))
  return { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, width: `${width}px` }
})

async function copyInlineAnswer() {
  const text = inlineAsk.answer.value
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    message.success('已复制回答')
  } catch {
    message.error('复制失败，请重试')
  }
}

function stopInlineAsk() {
  if (inlineAsk.jobId.value) void window.api.ai.cancel(inlineAsk.jobId.value)
}

const selMenuStyle = computed(() => {
  const gap = 6
  const below = selPopupY.value + gap
  const roomBelow = window.innerHeight - below
  const top = roomBelow >= SEL_MENU_HEIGHT ? below : Math.max(8, selPopupY.value - SEL_MENU_HEIGHT - gap)
  const left = Math.min(selPopupX.value, Math.max(8, window.innerWidth - SEL_MENU_WIDTH - 8))
  return { left: `${left}px`, top: `${top}px` }
})

watch(showSelPopup, (open) => {
  if (!open) {
    showSelMenu.value = false
    showModelMenu.value = false
    return
  }
  // 只在工具条真正出现时读一次设置，不在每次渲染时读盘。
  void loadAiModelOptions()
})

// 菜单展开时它可能盖住工具条，所以把模型选择器也一并刷新。
watch(showSelMenu, (open) => { if (open) void loadAiModelOptions() })

/** 当前章各段的渲染切片：叠加搜索命中与划线 */
const plainDecoratedParas = computed(() => paras.value.map((text) => decorateText(text, '', [])))
// 只算「已渲染」的那一段窗口：分批渲染下可见段最多 renderedCount 段，
// 对整章（可能上万段）做 map 会在每次滚动/标记变更时白算大半个章节。
// 净化只从这一段原始下标前缀里挑出要显示的段，下标本身保持原文坐标。
const renderedParas = computed(() => {
  const count = Math.min(renderedCount.value, paras.value.length)
  const start = renderWindowStart.value
  const q = searchQuery.value.trim()
  const searchingNow = showSearch.value && !!q
  const highlights = currentHighlightRanges.value
  const noteMarks = inlineNoteMarks.value
  const indexes = visibleParaIndexes.value.filter((index) => index >= start && index < count)
  if (!searchingNow && highlights.length === 0 && noteMarks.size === 0) {
    return indexes.map((index) => ({ index, segs: plainDecoratedParas.value[index]! }))
  }
  const starts = paraNormStarts.value
  const large = paras.value.length > 2000
  const out: Array<{ index: number; segs: NoteTextPart[] }> = []
  for (const i of indexes) {
    const text = paras.value[i]!
    if (searchingNow && large && Math.abs(i - searchHighlightCenter.value) > 80) {
      out.push({ index: i, segs: plainDecoratedParas.value[i]! })
      continue
    }
    const base = starts[i] ?? 0
    const localHl =
      searchingNow && q
        ? []
        : highlights.map((a) => ({ start: a.start - base, end: a.end - base, color: a.color }))
    out.push({
      index: i,
      segs: decorateTextWithNotes(text, searchingNow ? q : '', localHl, noteMarks.get(i) ?? []),
    })
  }
  return out
})
const visibleParas = computed(() => renderedParas.value)

// 真实书籍渲染层（bookView === 'realbook'）：与经典模式共用数据，渲染层完全分开。
const realBookStageRef = ref<RealBookStageHandle | null>(null)
/** 书页 / 真实书籍的宿主容器：舞台还没挂上时，纸面分区退回按它算。 */
const realBookHostRef = ref<HTMLElement | null>(null)
/** 真实书籍的当前位置：段落锚点，与经典模式同一套坐标。 */
const realBookAnchor = ref<RealBookAnchor | null>(null)
/**
 * 待落位的锚点（恢复请求）。
 *
 * 与 realBookAnchor 分开是必须的：舞台翻页后会把当前锚点回报上来，若把它当恢复请求
 * 回传给舞台，就会形成「回报 → 落位 → 回报」的递归更新。恢复请求只在换章/切换模式时产生。
 */
const realBookRestoreAnchor = ref<RealBookAnchor | null>(null)
/** 真实书籍的当前页码（0-based）；换算成比例用于旧进度回退。 */
const realBookPage = ref(0)
const realBookPageCount = ref(1)
/**
 * M3.3 俯仰角：会话内视觉状态，不进入 ReaderPrefs、不写进度。
 * 初值是默认俯仰角而不是平放：书台一进来就要看得出纸垛厚度和落地投影。
 */
// WebGL 复刻使用参考站的默认 25°；CSS 3D 回退保持原来的 18°。
const realBookPitch = ref(realBookRenderer.value === 'webgl' ? DEFAULT_TILT_DEG : DEFAULT_PITCH_DEG)
/** 换章/重进递增：页表重排后据此重新落位。 */
const realBookRestoreToken = ref(0)
/** 经典 → 真实书籍切换时待恢复的位置（段落锚点）。 */
const classicAnchorSnapshot = ref<RealBookAnchor | null>(null)
/** 从标记抽屉跳转到某条划线时，真实书籍要落的锚点。 */
const pendingRealBookAnchor = ref<RealBookAnchor | null>(null)

const realBookVisibleParas = computed(() => visibleParaIndexes.value)
const realBookParagraphTexts = computed(() => realBookVisibleParas.value.map((index) => paras.value[index] ?? ''))

// —— 真实书籍「整本连排」：把包含当前章的一段连续已下载章合成一本物理书，翻页跨章不停顿 ——
const REALBOOK_CONT_KEY = 'spore:reader-realbook-continuous:v1'
const realBookContinuous = ref(localStorage.getItem(REALBOOK_CONT_KEY) !== '0')
function setRealBookContinuous(on: boolean): void {
  realBookContinuous.value = on
  try {
    localStorage.setItem(REALBOOK_CONT_KEY, on ? '1' : '0')
  } catch {
    /* 忽略存储失败 */
  }
}

/** 窗口内各章的段落输入：正文 + 过滤站点尾巴后的可见段落（段落号相对该章自身正文）。 */
interface ChapterParaInput {
  body: string
  paragraphs: string[]
  paragraphIndexes: number[]
}
const realBookWindowInputs = ref<Map<string, ChapterParaInput>>(new Map())
/** 连排窗口：含当前章的最大连续 ready 段（页数封顶、前向优先）。组成不变则不换引用，避免书页重排。 */
const realBookWindow = ref<RealBookWindow | null>(null)
let realBookWindowKey = ''
let realBookWindowBookId = ''

/** 与单章路径同源：切段 + 过滤尾巴，段落号相对该章正文。 */
function paraInputForBody(body: string): ChapterParaInput {
  const list = splitIntoParagraphs(body)
  const visible: number[] = []
  for (let i = 0; i < list.length; i += 1) {
    if (!isSiteTailParagraph(list[i])) visible.push(i)
  }
  return { body, paragraphs: visible.map((i) => list[i] ?? ''), paragraphIndexes: visible }
}

const isWebGLRealBook = computed(
() => isRealBook.value && realBookRenderer.value === 'webgl',
)
/** 连排生效：WebGL 真实书籍 + 开关开 + 窗口 ≥2 章（单章窗口等价旧路径，不动）。 */
const realBookContinuousActive = computed(
  () =>
    isWebGLRealBook.value &&
    realBookContinuous.value &&
    !!realBookWindow.value &&
    realBookWindow.value.length > 1,
)
const mergedRealBook = computed(() =>
  realBookContinuousActive.value && realBookWindow.value ? mergedWindowParagraphs(realBookWindow.value) : null,
)
const effectiveRealBookParagraphs = computed<string[]>(() =>
  mergedRealBook.value ? mergedRealBook.value.paragraphs : realBookParagraphTexts.value,
)
const effectiveRealBookParagraphIndexes = computed<number[]>(() =>
  mergedRealBook.value ? mergedRealBook.value.paragraphIndexes : realBookVisibleParas.value,
)
const effectiveRealBookWindowChapters = computed<RealBookWindowChapter[]>(() =>
  realBookContinuousActive.value && realBookWindow.value ? realBookWindow.value.chapters : [],
)

/** 取齐窗口候选章正文（已下载，readChapter 快）并装配连排窗口。 */
async function loadRealBookWindow(): Promise<void> {
  if (!isWebGLRealBook.value || !book.value || !currentChapter.value) {
    if (!isWebGLRealBook.value) {
      realBookWindow.value = null
      realBookWindowKey = ''
    }
    return
  }
  const bookId = book.value.id
  if (bookId !== realBookWindowBookId) {
    realBookWindowBookId = bookId
    realBookWindowInputs.value = new Map()
    realBookWindow.value = null
    realBookWindowKey = ''
  }
  const catalog = chapters.value
  const current = currentChapter.value
  // 当前章正文已在 chapterBody 里，先播种。
  realBookWindowInputs.value.set(current.id, paraInputForBody(chapterBody.value))
  // 候选：当前章前后各 30 章里的 ready 章；buildRealBookWindow 再按连续 ready 收住边界。
  const idx = catalog.findIndex((c) => c.id === current.id)
  const candidates = catalog.slice(Math.max(0, idx - 30), Math.min(catalog.length, idx + 31)).filter((c) => c.status === 'ready')
  await Promise.all(
    candidates
      .filter((c) => c.status === 'ready' && !realBookWindowInputs.value.has(c.id))
      .map(async (c) => {
        const { chapter } = await window.api.library.readChapter(bookId, c.id)
        if (chapter && chapter.status === 'ready' && chapter.body) {
          realBookWindowInputs.value.set(c.id, paraInputForBody(chapter.body))
        }
      }),
  )
  const window_ = buildRealBookWindow(catalog, current, (meta) => {
    const input = realBookWindowInputs.value.get(meta.id)
    return input
      ? { paragraphs: input.paragraphs, paragraphIndexes: input.paragraphIndexes }
      : { paragraphs: [], paragraphIndexes: [] }
  }, {
    maxParagraphs: 2600,
    bodyAvailable: (meta) => meta.id === current.id || realBookWindowInputs.value.has(meta.id),
  })
  const key = bookId + '|' + (window_ ? window_.chapters.map((c) => c.meta.id).join(',') : '')
  if (key !== realBookWindowKey) {
    realBookWindow.value = window_
    realBookWindowKey = key
  }
}

/** 连排：当前摊开页所属章变了就路由 currentChapter/chapterBody（进度/TTS/划线/批注都跟它走）。 */
function onRealBookAnchorUpdate(anchor: RealBookAnchor | null): void {
  realBookAnchor.value = anchor
  if (!anchor || !realBookContinuousActive.value) return
  const targetId = anchor.chapterId
  if (!targetId || targetId === currentChapter.value?.id) return
  const target = chapters.value.find((c) => c.id === targetId)
  if (!target) return
  currentChapter.value = target
  const input = realBookWindowInputs.value.get(target.id)
  if (input) chapterBody.value = input.body
}

watch(
  () => [isWebGLRealBook.value, book.value?.id, currentChapter.value?.id, chapters.value],
  () => {
    void loadRealBookWindow()
  },
)
watch(realBookContinuous, (on) => {
  if (on) void loadRealBookWindow()
  else {
    realBookWindow.value = null
    realBookWindowKey = ''
  }
})
/** 划线在真实书籍里的落位：段落下标 + 段内局部偏移（与经典模式同一坐标系换算而来）。 */
const realBookHighlightSpans = computed(() => {
  const starts = paraNormStarts.value
  return currentHighlightRanges.value.map((a) => {
    const index = paragraphIndexOf(a.start)
    const base = starts[index] ?? 0
    return {
      index,
      start: Math.max(0, a.start - base),
      end: Math.max(0, a.end - base),
      color: a.color,
    }
  })
})

/** 规范化正文偏移 → 段落下标。 */
function paragraphIndexOf(offset: number): number {
  const starts = paraNormStarts.value
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    if (starts[i]! <= offset) return i
  }
  return 0
}

/** 经典模式当前视口顶的锚点（切到真实书籍时用作落位）。 */
function classicViewportAnchor(): RealBookAnchor | null {
  const anchor = paragraphAnchor()
  if (!anchor) return null
  return { paragraph: anchor.paragraphIndex, offset: anchor.paragraphOffset }
}

/**
 * 真实书籍当前页在全书比例里的位置（0..1）。
 *
 * 不能拿「当前页 / 已排出的页数」：页表是惰性排的，刚打开一本书时只排到当前位置
 * 附近，读到第 4 页就报 4/6 = 67%，书厚会整摞翻到左边、进度条也一上来就过半。
 * 按当前锚点在正文里的段落下标折算，比例与已排出多少页无关，翻页时才连续推进。
 */
function realBookRatio(): number {
  const lists = realBookVisibleParas.value
  const total = lists.length
  if (total <= 1) return realBookPage.value > 0 ? 1 : 0
  const paragraph = realBookAnchor.value?.paragraph ?? 0
  const index = lists.indexOf(paragraph)
  if (index < 0) return 0
  return Math.min(1, Math.max(0, index / (total - 1)))
}

/**
 * 分页渲染层没有滚动事件，进度面板与百分比只能跟着页码走。
 *
 * 用 computed 而不在翻页事件里回写 scrollRatioView：翻页途中改这个响应式值会让舞台
 * 提前重渲染，把锚点的上报打断，进度就会写成一个没有段落的空位置。
 */
const positionRatio = computed(() => (pagedView.value ? realBookRatio() : scrollRatioView.value))

watch(bookView, (view, previous) => {
  const wasPaged = previous === 'sheet' || previous === 'realbook'
  if (view === 'sheet' || view === 'realbook') {
    // 切进分页渲染层：从经典模式过来先记下当前落点；书页 ↔ 真实书籍之间沿用舞台自己的锚点。
    realBookRestoreAnchor.value = wasPaged ? realBookAnchor.value : classicViewportAnchor()
    classicAnchorSnapshot.value = realBookRestoreAnchor.value
    realBookRestoreToken.value += 1
    stopAutoScroll()
    return
  }
  // 切回来：用分页页码比例落回经典模式，误差不超过一页。
  const ratio = realBookRatio()
  void nextTick(() => {
    if (!contentRef.value) return
    scrollToRatio(ratio)
  })
})

watch(realBookRenderer, (value) => {
  writeRealBookRenderer(value)
  realBookOpen.value = true
  realBookZoom.value = value === 'webgl' ? DEFAULT_ZOOM : 1
  if (value === 'webgl' && Math.abs(realBookPitch.value - DEFAULT_PITCH_DEG) < 0.5) {
    realBookPitch.value = DEFAULT_TILT_DEG
  }
})

watch(realBookLook, (value) => {
  writeRealBookLook(value)
}, { deep: true })

/** 把渲染层选区换算成规范化正文里的字符区间 */

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
  // closeSelectionTools() 会清空 selectedRange，必须先取好区间，回答才能存回原文。
  const target = selectedRange.value ?? selectionOffsets()
  closeSelectionTools()
  await sendChat()
  selectionNoteTarget.value = target && chatJobId.value && chatAssistantIndex.value >= 0
    ? { messageIndex: chatAssistantIndex.value, start: target.start, end: target.end, text: target.text }
    : null
}

/** 把「解释这段」的回答存回读者选中的那个区间，出处标 ai，读者随后可以改写或删掉。 */
async function saveAnswerAsSelectionNote(reply: AiEvidenceChatMessage) {
  const target = selectionNoteTarget.value
  const note = reply.content.trim()
  if (!target || !book.value || !currentChapter.value) return
  if (!note || note.startsWith('错误：')) {
    message.warning('这条回答还不能保存为批注')
    return
  }
  selectionNoteSaving.value = true
  try {
    const saved = await marks.addNote(target, note, {
      source: 'ai',
      successText: '解释已存为这段的批注',
      failureText: '保存批注失败',
    })
    if (saved) selectionNoteTarget.value = null
  } finally {
    selectionNoteSaving.value = false
  }
}

/** 只有「这次提问来自选区」的那条回答才给存回出口，且必须已经生成结束。 */
function canSaveSelectionNote(reply: AiEvidenceChatMessage, index: number): boolean {
  if (chatLoading.value || selectionNoteTarget.value?.messageIndex !== index) return false
  const note = reply.content.trim()
  return note.length > 0 && !note.startsWith('错误：')
}

/**
 * 生词本是纯视图：读者划过的词句（含他自己的批注）加上记忆里已核实的人物，
 * 全部来自已有数据，不另建存储、不加 IPC，删不掉也改不坏原始标记。
 */
const normalizedMemoryQuery = computed(() => memoryQuery.value.trim().toLocaleLowerCase())
function memoryMatches(parts: Array<string | undefined>): boolean {
  const query = normalizedMemoryQuery.value
  return !query || parts.some((part) => part?.toLocaleLowerCase().includes(query))
}
const visibleMemoryCharacters = computed(() => (memoryData.value?.characters ?? []).filter((item) => memoryMatches([
  item.name, item.aliases.join(' '), item.role, item.status, item.summary,
])))
const visibleMemoryRelations = computed(() => (memoryData.value?.relations ?? []).filter((item) => memoryMatches([
  item.from, item.to, item.relation, item.status, item.summary,
])))
const visibleMemoryForeshadows = computed(() => (memoryData.value?.foreshadows ?? []).filter((item) => memoryMatches([
  item.desc, item.status, item.summary,
])))
const visibleMemoryEvents = computed(() => (memoryData.value?.events ?? []).filter((item) => memoryMatches([
  item.title, item.participants.join(' '), item.result, item.summary,
])))
const visibleMemoryCount = computed(() => visibleMemoryCharacters.value.length
  + visibleMemoryRelations.value.length
  + visibleMemoryForeshadows.value.length
  + visibleMemoryEvents.value.length)
/**
 * 关系图切片上限：默认停在「当前读到的章」。
 *
 * 不默认全量的理由：全量图里有一半关系是读者还没读到的地方才成立的，
 * 对小说读者来说那就是剧透。滑块只在当前章以内取值，读者也不能往前拉。
 */
const memoryGraphUpto = ref(1)
/**
 * 当前章在 book.chapters 里的 index（滑块上界与默认值）。
 *
 * 用 find 找而不是拿 chapters 的下标：章节表不保证按 index 排序（补章、重导都会打乱），
 * 下标当章节号会在那些书上直接错位，连带把切片切错。
 */
const memoryGraphCurrentIndex = computed(() => {
  const current = currentChapter.value
  if (!current) return 1
  const found = book.value?.chapters?.find((chapter) => chapter.id === current.id)
  return found?.index ?? current.index
})
/**
 * 关系图折叠标题上的数字和图里真正画出来的规模保持一致（都经过 24 人 / 80 条上限截断，
 * 以及当前的进度切片），否则读者会以为图漏了人；没有关系时返回 0/0，由 v-if 决定整块不渲染。
 */
const memoryGraphCounts = computed(() => {
  if (!memoryData.value?.relations?.length) return { people: 0, edges: 0 }
  const graph = buildMemoryGraph(memoryData.value)
  // 标题跟着画面走：别出现「20 人」的标题配 3 个点的图。
  const shown = sliceMemoryGraph(graph, book.value?.chapters, memoryGraphUpto.value)
  return { people: shown.nodes.length, edges: shown.edges.length }
})

async function jumpToAnnotation(a: Annotation) {
  if (!book.value) return
  const ch = chapters.value.find((c) => c.id === a.chapterId)
  if (!ch) return
  if (a.kind === 'highlight') {
    const i = paraNormStarts.value.findIndex((s, idx) => s <= a.start && a.start < s + (paras.value[idx]?.length ?? 0) + 2)
    pendingScrollPara = i >= 0 ? i : 0
    if (pagedView.value) {
      // 分页渲染层按锚点落位：段落下标 + 段内偏移，与经典模式同一坐标系。
      const base = paraNormStarts.value[pendingScrollPara] ?? 0
      pendingRealBookAnchor.value = { paragraph: pendingScrollPara, offset: Math.max(0, a.start - base) }
    }
  } else {
    pendingScrollPara = -1
    pendingRealBookAnchor.value = null
  }
  await openChapter(ch, a.kind === 'highlight' ? 0 : 0)
  if (pendingScrollPara === -1) scrollToRatio(0)
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
    showMap.value ||
    showAiAssistant.value ||
    showSearch.value ||
    showMarks.value ||
    Boolean(inlineNoteEditor.value) ||
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
  // 点按显隐由正文中区决定，不再按空闲秒数把工具收回去。
  // 面板、选区、工具栏焦点仍阻止误收。下载 running 只挡 Esc，不在这里扩大。
}

/**
 * 进入阅读页时把工具层收回默认态：正文和左侧书脊优先。
 * 例外：当前书正在下载，正文没被点过也得让「已下 x / y 章」和「取消」看得见。
 * 进页面算新的一次进入，上一次下载期留下的显隐意图在这里作废。
 */
function collapseToolsForEntry() {
  toolsVisible.value = false
  temporaryToolReveal.value = false
  pointerInToolbar.value = false
  lastToolActivityAt = Date.now()
  clearToolHideTimer()
  downloadToolsIntent.value = 'untouched'
  revealToolsForDownload()
  // 下载 running 优先；没在下载时才按「工具一直显示」偏好把顶栏留在屏幕上。
  revealToolsForPreference()
}

/** 当前下载状态里顶栏关心的两个字段，供纯函数判定。 */
function currentDownloadSignal(): { status: string; bookId: string } | null {
  const p = downloadProgress.value
  if (!p) return null
  return { status: p.status, bookId: p.bookId }
}

/** 下载 running 期间自动露出顶栏；这不是「禁止收起」，用户点中区照样能收。 */
function revealToolsForDownload() {
  if (!shouldForceToolsForDownload(downloadProgress.value, book.value?.id)) return
  if (downloadToolsIntent.value === 'collapsed') return
  toolsVisible.value = true
  temporaryToolReveal.value = false
  lastToolActivityAt = Date.now()
  clearToolHideTimer()
}

/** 偏好「工具一直显示」打开时，进页面与下载结束都按偏好把顶栏留在屏幕上。 */
function revealToolsForPreference() {
  if (!shouldRevealToolsForPreference(hideReaderChrome.value)) return
  toolsVisible.value = true
  temporaryToolReveal.value = false
  lastToolActivityAt = Date.now()
  clearToolHideTimer()
}

/**
 * 下载状态变化时同步顶栏：
 * 开始 running → 自动露出；由 running 变结束 → 用户没表态过就回到收起。
 * 判定集中在 resolveDownloadToolsPolicy，这里只落状态。
 */
function applyDownloadToolsPolicy(previous: DownloadSignal | null, next: DownloadSignal | null) {
  const decision = resolveDownloadToolsPolicy({
    previous,
    next,
    currentBookId: book.value?.id,
    intent: downloadToolsIntent.value,
  })
  downloadToolsIntent.value = decision.intent
  if (decision.visible === true) {
    toolsVisible.value = true
    temporaryToolReveal.value = false
    lastToolActivityAt = Date.now()
    clearToolHideTimer()
  } else if (decision.visible === false) {
    collapseToolsForEntry()
  }
}

/**
 * 本页离开又回来（书库点书卡、从其他页返回）时工具默认收起。
 * 首次观测只登记，常驻可见期间不打断正在阅读的人。
 * 只动工具层，不动阅读位置、沉浸模式和面板状态。
 */
function applyReaderOnScreen(isOnScreen: boolean) {
  const wasOnScreen = readerOnScreen
  readerOnScreen = isOnScreen
  if (shouldResetReaderToolsOnEntry(wasOnScreen, isOnScreen)) collapseToolsForEntry()
}

function startReaderVisibilityWatch() {
  const el = readerRootRef.value
  if (!el || readerVisibilityObserver || typeof ResizeObserver === 'undefined') return
  // v-show 切到 display:none 时尺寸归零，切回来时恢复：这是「重入本页」的真实信号。
  readerVisibilityObserver = new ResizeObserver((entries) => {
    const rect = entries[entries.length - 1]?.contentRect
    const onScreen = rect ? rect.width > 0 && rect.height > 0 : el.clientWidth > 0 || el.clientHeight > 0
    applyReaderOnScreen(onScreen)
  })
  readerVisibilityObserver.observe(el)
}

function stopReaderVisibilityWatch() {
  readerVisibilityObserver?.disconnect()
  readerVisibilityObserver = null
  readerOnScreen = null
}

function revealTools(temporary = false) {
  toolsVisible.value = true
  temporaryToolReveal.value = temporary
  lastToolActivityAt = Date.now()
  scheduleToolHide()
}

/** 只用于 Esc 与进页面自动露出：下载 running 时不收顶栏。点按中区不受这条限制。 */
function downloadKeepsTools(): boolean {
  return isCurrentBookDownloading(downloadProgress.value, book.value?.id)
}

/**
 * 关掉底栏的面板 / 目录抽屉，不再经过 toggleBottomPanel——那个入口会顺手把
 * 工具层重新露出来，收起底栏时反而把它顶回展开态。
 */
function closeBottomPanel() {
  if (activeBottomPanel.value === 'catalog') showDrawer.value = false
  activeBottomPanel.value = null
}

/** 从底边横条展开底栏：横条本身随即卸载，键盘焦点要跟着落进底栏第一个按钮。 */
function revealReaderToolsFromDock() {
  toggleReaderTools()
  void nextTick(() => {
    const bar = readerRootRef.value?.querySelector<HTMLElement>('.reader-bottombar')
    bar?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  })
}

function toggleReaderTools() {
  const downloading = isCurrentBookDownloading(downloadProgress.value, book.value?.id)
  if (toolsVisible.value) {
    toolsVisible.value = false
    temporaryToolReveal.value = false
    clearToolHideTimer()
    // 面板是底栏的子浮层：底栏要收进横条，面板不能跟着一起消失在半空。
    closeBottomPanel()
    // 手动收起也算表过态：下载 running 期间不再被自动逻辑顶回来。
    if (downloading) downloadToolsIntent.value = 'collapsed'
    return
  }
  revealTools(immersiveMode.value === 'locked')
  if (downloading) downloadToolsIntent.value = 'revealed'
}

/**
 * 全屏开关：底栏的全屏按钮走浏览器 Fullscreen API。
 * Electron 窗口支持时直接进/出全屏；不支持（或权限被拒）时静默失败，
 * 按钮状态由 fullscreenchange 事件回写，不会卡在「已全屏」。
 */
const isFullscreen = ref(false)
function syncFullscreenState() {
  isFullscreen.value = document.fullscreenElement != null
}
async function toggleReaderFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch {
    // 环境不支持全屏：按钮不生效，不弹错。
  }
}

/** 点正文三分区：中区只显隐工具，左右翻屏。选区条仍由 onContentMouseup 自己出。 */
function onContentZoneMouseup(e: MouseEvent) {
  onContentMouseup(e)
  if (!book.value || e.button !== 0) return
  const el = contentRef.value
  if (!el) return
  const zone = readerContentZone({
    clientX: e.clientX,
    contentLeft: el.getBoundingClientRect().left,
    contentWidth: el.clientWidth,
    target: e.target,
    selectionCollapsed: window.getSelection()?.isCollapsed !== false,
  })
  if (!zone) return
  if (zone === 'center') {
    toggleReaderTools()
    return
  }
  // 章首 / 章末停住：点按只在本章内翻屏，不换章（换章走章末的「下一章」卡片与 ←/→ 快捷键）。
  if (!readerTapCanPage({
    zone,
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  })) return
  pageByScreen(zone === 'left' ? -1 : 1)
}

/**
 * 书页 / 真实书籍：纸面也分三区——左右区翻页，中区显隐工具条。
 * 纸面宽度与经典模式不同（书台是整个舞台，书页是那张纸），所以按舞台给的纸面元素分区。
 * 点按钮或用于选字的那一下不算，否则选完词工具条会自己闪出来。
 */
function onPagedZoneMouseup(e: MouseEvent) {
  if (!book.value || e.button !== 0) return
  if (window.getSelection()?.isCollapsed === false) return
  const target = e.target as HTMLElement | null
  if (target?.closest('button, a, input, textarea, select, label, [contenteditable="true"], [role="button"]')) return
  const paper = realBookStageRef.value?.paperEl ?? realBookHostRef.value
  if (!paper) return
  const rect = paper.getBoundingClientRect()
  const width = rect.width || paper.clientWidth
  // 纸面还没量出宽度（首帧、窗口刚打开）时不分区：按中区处理，只显隐工具，
  // 不能因为量不到宽度就把点击丢掉——那样点纸面什么反应都没有。
  const zone = width > 0
    ? readerContentZone({
      clientX: e.clientX,
      contentLeft: rect.left,
      contentWidth: width,
      target: e.target,
      selectionCollapsed: true,
    })
    : 'center'
  if (!zone) return
  if (zone === 'center') {
    toggleReaderTools()
    return
  }
  pageByScreen(zone === 'left' ? -1 : 1)
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

function toggleBottomPanel(panel: 'catalog' | 'progress' | 'background' | 'font' | 'more') {
  const next = activeBottomPanel.value === panel ? null : panel
  if (next) {
    activeBottomPanel.value = next
    activeToolPanel.value = null
    if (panel === 'catalog') showDrawer.value = true
  } else {
    closeBottomPanel()
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
  if (inlineNoteEditor.value) closeInlineNoteEditor()
  else if (showMap.value) showMap.value = false
  else if (showAiAssistant.value) showAiAssistant.value = false
  else if (showSearch.value) showSearch.value = false
  else if (showMarks.value) showMarks.value = false
  else if (showDrawer.value) showDrawer.value = false
  else if (activeBottomPanel.value) activeBottomPanel.value = null
  else if (activeToolPanel.value) activeToolPanel.value = null
}

/**
 * 浮层打开时的 Esc 兜底：焦点落在抽屉里的按钮/输入框时，Naive UI 的焦点陷阱会在容器层
 * 吃掉气泡阶段的事件，`onReaderKeydown` 里的 `close-drawer` 就轮不到执行。
 * 捕获阶段先关一次，并阻止冒泡，避免同一次 Esc 被处理两遍。
 * 输入法组合期间（isComposing）不接管，否则会抢走取消候选词的 Esc。
 */
function onOverlayEscapeCapture(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
  if (!anyDrawerOpen()) return
  e.preventDefault()
  e.stopPropagation()
  closeTopReaderOverlay()
  revealTools(immersiveMode.value === 'locked')
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

/**
 * 划词工具栏的「朗读」：从选区所在的那一段开始读。
 * 选区不跨段时就是该段；找不到对应段就退回当前正在读的段，不静默无反应。
 */
function readSelectionAloud() {
  if (!ttsSupported) {
    message.warning('当前环境不支持朗读')
    return
  }
  const range = selectedRange.value ?? selectionOffsets()
  const excerpt = selectedExcerpt.value || getSelectedText()
  let index = -1
  if (range) {
    let cursor = 0
    for (let i = 0; i < paras.value.length; i += 1) {
      const start = cursor
      const end = start + paras.value[i]!.length
      if (range.start >= start && range.start <= end) { index = i; break }
      cursor = end + 2
    }
  }
  if (index < 0 && excerpt) {
    const probe = excerpt.trim().slice(0, 30)
    if (probe) index = paras.value.findIndex((paragraph) => paragraph.includes(probe))
  }
  startTtsFromParagraph(Math.max(0, index))
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
  const spans = collectParagraphSpans(el)
  let targetTop: number
  if (spans.length) {
    // 回吸也落段落边界：停在半段时收到该段段首；超长段保持原地，不硬拽回很远的段首。
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
    targetTop = Math.max(0, Math.min(snapScrollTopToParagraph(spans, el.scrollTop, 2, el.clientHeight), maxTop))
  } else {
    const index = visualPageIndex(el.scrollTop, el.scrollHeight, el.clientHeight)
    targetTop = scrollTopForVisualPage(index, el.scrollHeight, el.clientHeight)
  }
  // 已经对齐就别再滚：省掉一次无意义的平滑滚动，也避免它触发 scroll 事件再回吸。
  if (Math.abs(el.scrollTop - targetTop) < 1) return

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
  // 抑制这段时间内的自动回吸，否则 smooth 滚动的中间帧会被当成"用户停在半页"。
  suppressSnapUntil = Date.now() + (reduceMotion ? 200 : 520)
  el.scrollTo({
    top: targetTop,
    behavior: reduceMotion ? 'auto' : 'smooth',
  })
  syncVisualPage()
}

function onReaderResize() {
  if (selectionOpen()) closeSelectionTools()
  snapToVisualPage()
}

/** 量出每个段落相对正文内容顶的纵向范围，供段落对齐翻页使用。 */
function collectParagraphSpans(el: HTMLElement): ReaderParagraphSpan[] {
  const paneTop = el.getBoundingClientRect().top
  const nodes = el.querySelectorAll<HTMLElement>('.para[data-p]')
  const spans: ReaderParagraphSpan[] = []
  nodes.forEach((node) => {
    const rect = node.getBoundingClientRect()
    if (rect.height <= 0) return
    const top = rect.top - paneTop + el.scrollTop
    spans.push({ top, bottom: top + rect.height })
  })
  return spans
}

/**
 * 「下一页」翻到章末时接管：确实没有下一页了才换章。
 * 大章节还有段落没排完就先不跳，避免在半截正文处换章。
 */
function continueToNextChapter(): boolean {
  if (!followingChapter.value) return false
  if (renderedCount.value < paras.value.length) return false
  nextChapter()
  return true
}

function pageByScreen(direction: 1 | -1) {
  // 分页渲染层没有滚动容器：翻一页就是舞台翻一页（书页版式按整张纸翻）。
  // 舞台自己知道本章还有没有下一页：没有就发出「下一章」，由父组件换章。
  if (pagedView.value) {
    const stage = realBookStageRef.value
    if (!stage) return
    if (direction < 0) {
      stage.prevPage()
      return
    }
    stage.nextPage()
    return
  }
  const el = contentRef.value
  if (!el) return
  const behavior = readerScrollBehavior(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true)
  if (readingMode.value === 'screen') {
    const spans = collectParagraphSpans(el)
    if (spans.length) {
      // 段落对齐：被屏底切断的段落下一屏从段首开始，超长段只前进一屏。
      const target = scrollTopForParagraphPage({
        paragraphs: spans,
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        direction,
      })
      // 抑制回吸：翻页本身就是在对齐，别让防抖回吸再插一脚。
      suppressSnapUntil = Date.now() + (behavior === 'auto' ? 200 : 520)
      if (Math.abs(el.scrollTop - target) < 1) {
        // 这一屏已经是章末：再翻就是下一章。
        if (direction > 0 && continueToNextChapter()) return
        syncVisualPage()
        return
      }
      el.scrollTo({ top: target, behavior })
      syncVisualPage()
      return
    }
    // 还没量出段落（空章 / 正在排版）：退回整页对齐，不越界。
    const count = visualPageCount(el.scrollHeight, el.clientHeight)
    const current = visualPageIndex(el.scrollTop, el.scrollHeight, el.clientHeight)
    const next = adjacentVisualPage(current, direction, count)
    // 已到末页且没有可去的下一屏：整章的最后一页，翻过去就是下一章。
    if (next === current && direction > 0 && continueToNextChapter()) return
    suppressSnapUntil = Date.now() + (behavior === 'auto' ? 200 : 520)
    el.scrollTo({ top: scrollTopForVisualPage(next, el.scrollHeight, el.clientHeight), behavior })
    return
  }
  // 连续滚动：不吸附、不拦截滚轮，只按一屏净高度的一小截前进，留出行间重叠。
  // 已经贴底（差 2px 容差内）时「下一页」就是下一章，别在原地空转。
  if (direction > 0 && el.scrollHeight - el.clientHeight - el.scrollTop <= 2 && continueToNextChapter()) return
  el.scrollBy({
    top: direction * el.clientHeight * 0.9,
    behavior,
  })
}



// ---------------------------------------------------------------------------
// 自动滚屏（本地阅读器）
// 复用阅读模式那套纯计算（readingAutoScroll.ts），推进节奏由 rAF 驱动。
// ---------------------------------------------------------------------------
const autoScrolling = ref(false)
let autoScrollRaf: number | null = null
let autoScrollLastAt = 0
const autoScroll = createAutoScroll(
  {
    scrollTop: () => contentRef.value?.scrollTop ?? 0,
    scrollHeight: () => contentRef.value?.scrollHeight ?? 0,
    viewportHeight: () => contentRef.value?.clientHeight ?? 0,
    setScrollTop: (value) => {
      const el = contentRef.value
      if (el) el.scrollTop = value
    },
    onTick: () => { syncVisualPage() },
    onReachEnd: () => {
      // 到底：开了「自动续章」且还有下一章就接上，否则停下（避免无声空转）。
      if (!autoNextChapter.value || !followingChapter.value) return false
      // 章末还有分批渲染没排完：先等排版，别在半截正文处跳章。
      if (renderedCount.value < paras.value.length) return false
      void openChapter(followingChapter.value, 0, undefined, false, true)
      return true
    },
  },
  { speedPx: () => autoScrollSpeedPx(autoScrollSpeed.value) },
)

function autoScrollStep(timestamp: number) {
  if (!autoScrolling.value) return
  const elapsed = autoScrollLastAt ? timestamp - autoScrollLastAt : 16
  autoScrollLastAt = timestamp
  if (!autoScroll.tick(elapsed)) {
    autoScrolling.value = false
    autoScrollLastAt = 0
    return
  }
  readerProgress.schedule()
  autoScrollRaf = requestAnimationFrame(autoScrollStep)
}

function startAutoScroll() {
  if (autoScrolling.value || !chapterReady.value) return
  autoScrolling.value = true
  autoScrollLastAt = 0
  autoScroll.start()
  autoScrollRaf = requestAnimationFrame(autoScrollStep)
}

function stopAutoScroll() {
  if (!autoScrolling.value && autoScrollRaf == null) return
  autoScrolling.value = false
  autoScroll.stop()
  if (autoScrollRaf != null) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = null }
  autoScrollLastAt = 0
}

function toggleAutoScroll() {
  if (autoScrolling.value) {
    stopAutoScroll()
    message.info('已暂停自动滚屏')
    return
  }
  startAutoScroll()
  if (autoScrolling.value) message.info(`自动滚屏中（速度 ${autoScrollSpeed.value}）`)
  else message.warning('当前章节还不能自动滚屏')
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
  if (e.key === 'Escape' && !isTextEntry && !(e.ctrlKey || e.metaKey) && !anyDrawerOpen() && !selectionOpen()) {
    if (toolsVisible.value && !downloadKeepsTools()) {
      e.preventDefault()
      toolsVisible.value = false
      temporaryToolReveal.value = false
      clearToolHideTimer()
    }
    return
  }
  if (!isTextEntry && !(e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'm' || e.key === 'Alt')) {
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
  // WebGL 真实书籍借用参考站的 T：循环 平视/默认/斜视。CSS 3D 与经典模式仍保留 T=目录。
  if (
    !isTextEntry
    && !(e.ctrlKey || e.metaKey)
    && !e.shiftKey
    && isRealBook.value
    && realBookRenderer.value === 'webgl'
    && e.key.toLowerCase() === 't'
    && !anyDrawerOpen()
  ) {
    e.preventDefault()
    const values = realBookPitchPresets.map((preset) => preset.value)
    const nearest = values.findIndex((value) => Math.abs(value - realBookPitch.value) < 0.6)
    realBookPitch.value = values[nearest >= 0 ? (nearest + 1) % values.length : 0]!
    return
  }
  // 参考站的 fit-book：0 把整本书收进视口。复原回到的是 90% 的默认构图，
  // 比整书略推近——两者是不同的动作，别把 0 做成第二个复原。
  if (!isTextEntry && !(e.ctrlKey || e.metaKey) && !e.shiftKey && isRealBook.value && e.key === '0' && !anyDrawerOpen()) {
    e.preventDefault()
    realBookStageRef.value?.fitBook?.()
    return
  }
  const action = resolveReaderKey({
    key: e.key,
    targetTag: target?.tagName ?? null,
    isContentEditable: Boolean(target?.isContentEditable),
    anyDrawerOpen: anyDrawerOpen(),
    ctrlOrMeta: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    // 分页渲染层（书页 / 真实书籍）里左右键翻页：那里没有滚动条，
    // 按换章会直接跳过整章，读者根本没法一页一页读。
    paged: pagedView.value,
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
    case 'scroll-top':
      e.preventDefault()
      contentRef.value?.scrollTo({ top: 0, behavior: hereScrollBehavior() })
      break
    case 'scroll-bottom':
      e.preventDefault()
      contentRef.value?.scrollTo({ top: contentRef.value.scrollHeight, behavior: hereScrollBehavior() })
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
    case 'open-assistant':
      void openAiAssistant('recap')
      break
    case 'open-note':
      void openAiAssistant('notes')
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

// 纸色真源在 @shared/readerTheme：与网页阅读模式共用，避免同一主题两处渲染出不同颜色。
// 外圈画布跟随阅读主题（不再绑 --app-bg）：夜间纸面配浅色应用外观时，亮外圈会把整块深色阅读区
// 包在一条亮边里，既刺眼又破坏沉浸——主题自带 outer 就是为了解决这个。
const fontStacks: Record<ReaderFontFamily, string> = {
  serif: '"STSong", "Songti SC", "SimSun", serif',
  system: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  mono: '"Cascadia Mono", "Consolas", monospace',
  wenkai: '"LXGW WenKai Screen", "LXGW WenKai", "STSong", "Songti SC", "SimSun", serif',
}
/**
 * 真实书籍的页面排印：参考站是 22px / 行距 1.5 的 640×920 版心。
 * 阅读偏好仍是 18px / 1.8 的经典模式默认值，这里按比例换算，
 * 用户调字号/行距时书页仍跟着变，只是落在参考站的尺度上。
 */
const realBookFontSize = computed(() => Math.max(12, Math.min(40, Math.round(fontSize.value * (22 / 18)))))
const realBookLineHeight = computed(() => Math.max(1.2, Math.round(lineHeight.value * (1.5 / 1.8) * 100) / 100))
const realBookFontFamilyStack = computed(() => fontStacks[bookFontFamily.value])
const widthValues: Record<ReaderContentWidth, string> = { narrow: '32em', medium: '38em', wide: '46em' }
const spacingValues: Record<ReaderParagraphSpacing, string> = { compact: '0.2em', normal: '0.45em', relaxed: '0.8em' }
/** 段间距的数值形式（em）：真实书籍分页要按像素算段间距，不能用 CSS 字符串。 */
const spacingEmValues: Record<ReaderParagraphSpacing, number> = { compact: 0.2, normal: 0.45, relaxed: 0.8 }
const readerThemeStyle = computed(() => ({
  '--reader-paper': READER_THEME_COLORS[theme.value].paper,
  '--reader-paper-text': READER_THEME_COLORS[theme.value].text,
  '--reader-outer': READER_THEME_COLORS[theme.value].outer,
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
/**
 * 章节导图的数据源：与正文同一套原始段落下标，节点跳转不需要任何坐标换算。
 *
 * 超长章只展开到段落层——句组层会让 SVG 一次落下上万节点；经典模式的窗口化
 * 早就按同一个阈值退让，导图沿用同一判据。
 */
const chapterMindmap = computed(() => {
  if (!chapterReady.value) return null
  const indexes = visibleParaIndexes.value
  return buildMindmapTree(
    currentChapter.value?.title ?? '',
    indexes.map((index) => paras.value[index] ?? ''),
    indexes,
    { expandedThroughLevel: isLargeChapter.value ? 1 : 2 },
  )
})
const canRetryChapter = computed(() => {
  const ch = currentChapter.value
  if (!book.value || !ch) return false
  if (book.value.importType !== 'download') return false
  return ch.status === 'failed' || ch.status === 'empty' || ch.status === 'pending'
})
const filteredCatalog = computed(() => filterCatalogChapters(chapters.value, catalogQuery.value))
function catalogBadge(ch: { id: string; status: typeof chapters.value[number]['status']; failCode?: typeof chapters.value[number]['failCode']; unlockedBy?: string }) {
  return catalogChapterBadge({
    status: ch.status,
    chapterId: ch.id,
    currentChapterId: currentChapter.value?.id,
    progressChapterId: book.value?.progress?.chapterId,
    chapters: chapters.value,
    unlockedBy: ch.unlockedBy,
  })
}
const currentChapterIndex = computed(() => chapters.value.findIndex((chapter) => chapter.id === currentChapter.value?.id))
const previousChapter = computed(() => currentChapterIndex.value > 0 ? chapters.value[currentChapterIndex.value - 1] : null)
const followingChapter = computed(() => currentChapterIndex.value >= 0 && currentChapterIndex.value < chapters.value.length - 1 ? chapters.value[currentChapterIndex.value + 1] : null)
const weightedBookProgress = computed(() => {
  const entries = chapters.value.map((chapter) => ({
    id: chapter.id,
    chars: Math.max(0, bookChapterChars.value[chapter.id] ?? 0),
  }))
  const total = entries.reduce((sum, entry) => sum + entry.chars, 0)
  const index = Math.max(0, currentChapterIndex.value)
  if (total <= 0) return approximateBookRatio(chapters.value, currentChapter.value?.id, positionRatio.value)
  const before = entries.slice(0, index).reduce((sum, entry) => sum + entry.chars, 0)
  const current = entries[index]?.chars ?? 0
  return Math.max(0, Math.min(1, (before + current * positionRatio.value) / total))
})
const bookProgressRatio = computed(() => weightedBookProgress.value)
const chapterPercent = computed(() => Math.round(positionRatio.value * 100))
const bookPercent = computed(() => Math.round(bookProgressRatio.value * 100))
const remainingChapters = computed(() => remainingChapterCount(chapters.value, currentChapter.value?.id))
const bookProgressDetail = computed(() => `全书约 ${bookPercent.value}% · 本章 ${chapterPercent.value}% · 还剩 ${remainingChapters.value} 章`)
const progressSummary = computed(() =>
  readerProgressLabel(chapters.value, currentChapter.value?.id, positionRatio.value),
)
const chapterFailHint = computed(() => failAdvice(currentChapter.value?.failCode))
async function loadBook(bookId: string) {
  assistantBudgets.value = {}
  // 换书也是一次「进入阅读页」：新书不能沿用上一本展开着的工具层。
  if (book.value?.id !== bookId) collapseToolsForEntry()
  // 重开书不继承「本章显示原文」：只看净化开关。
  showRawThisChapter.value = false
  const epoch = ++navEpoch
  ttsStop()
  ttsSavedPosition.value = null
  if (book.value && book.value.id !== bookId) {
    stopFollowPolling()
    follow.value = null
    materialCoverage.value = null
    showFollowBudgetConfirm.value = false
    followBudget.value = null
    chapterNoteJobId.value = ''
    chapterNotes.value = []
    currentChapterNote.value = null
    chapterNoteText.value = ''
    chapterNoteDraft.value = ''
    noteOverwritePrompt.value = ''
    notesBudget.value = null
    showNotesBudgetConfirm.value = false
  }
  chapterPrefetch.onBookChange(bookId)
  const previousBookId = book.value?.id
  if (previousBookId !== bookId) bookChapterChars.value = {}
  // 只有同一本书才沿用「当前章」：换书时两本书都有 c0001，
  // 沿用会让新书从第一章开始读，把这本书自己的阅读进度跳过去。
  const previousChapterId = previousBookId === bookId ? currentChapter.value?.id : undefined
  void readerProgress.writeNow()
  const res = await window.api.library.get(bookId)
  if (epoch !== navEpoch) return
  if (res.book) {
    book.value = res.book
    // 这本书正在下载：进阅读页就直接露出顶栏，不必等用户点正文。
    revealToolsForDownload()
    const frontierResult = await window.api.library.getReadFrontier?.(bookId)
    if (epoch !== navEpoch) return
    legacyReadProposal.value = frontierResult?.ok ? frontierResult.frontier.legacyProposal : null
    void loadResumeCard()
    ttsSavedPosition.value = await (window.api.tts?.getPosition?.(bookId) ?? Promise.resolve(null)).catch(() => null)
    if (epoch !== navEpoch) return
    // 追剧状态是主进程的真源：开书就拉一次，界面才知道该显示哪种模式、排了几章。
    void loadAssistantMaterial()
    chapters.value = res.book.chapters
    const stats = await window.api.library.readBookStats?.(bookId).catch(() => null)
    if (epoch !== navEpoch) return
    bookChapterChars.value = Object.fromEntries((stats?.stats ?? []).map((item) => [item.chapterId, Math.max(0, item.chars)]))
    currentChapter.value = null
    lostHighlightIds.value = new Set()
    await reloadAnnotations()
    if (epoch !== navEpoch) return
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
        const resumeRatio = res.book.progress.scrollRatio ?? 0
        const resumeIndex = chapters.value.findIndex((c) => c.id === ch.id)
        await openChapter(ch, resumeRatio, res.book.progress)
        // openChapter 内部会自增 navEpoch，不能用外层 epoch 判断（那样永远早退）；
        // 改判「是否仍落在续读这一章」：被别的导航顶掉时 currentChapter 已不是 ch，就不提示。
        if (currentChapter.value?.id !== ch.id) return
        // 续读不再是静默跳转：只有确实跳到了上次的非起点位置才提示，刚开书从头读不打扰。
        if (resumeIndex > 0 || resumeRatio > 0.02) {
          message.info(`已回到上次读到：第 ${resumeIndex + 1} 章 · ${ch.title}`)
        }
        return
      }
    }
    if (chapters.value.length > 0) await openChapter(chapters.value[0], 0)
  }
}

async function openChapter(ch: ChapterMeta, scrollRatio = 0, progress?: ReadingProgress, continueListening = false, continueScrolling = false) {
  if (!book.value) return
  // 手动翻章/跳章时停掉自动滚屏（避免"我明明换章了它还在滚"）；自动续章传 continueScrolling=true 才保留。
  if (!continueScrolling) stopAutoScroll()
  const epoch = ++navEpoch
  const openingBookId = book.value.id
  // 「这一章读完了」只有渲染层判得出来（主进程拿不到滚动位置），判出来就把实测比率交给主进程排队。
  const finishedRatio = currentChapter.value && currentChapter.value.id !== ch.id &&
    currentChapter.value.status === 'ready' && contentRef.value
    ? currentChapterRatio(contentRef.value)
    : 0
  const finishedChapter = currentChapter.value && finishedRatio >= 0.999
    ? { bookId: openingBookId, chapterId: currentChapter.value.id, ratio: finishedRatio }
    : null
  chapterPrefetch.beginNavigation()
  closeSelectionTools()
  ttsStop(continueListening)
  // 「本章显示原文」只活在当前章内存里：任何一次 openChapter（换章、续章、重开书）都回到净化状态。
  showRawThisChapter.value = false
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
    // 这次加载已被更新的导航取代：丢弃结果，别用旧章覆盖新章。
    if (epoch !== navEpoch) return
    if (res.chapter) {
      currentChapter.value = { ...ch, status: res.chapter.status, failCode: res.chapter.failCode }
      chapterBody.value = res.chapter.body || ''
      hasBodyRaw.value = Boolean(res.chapter.bodyRaw) && res.chapter.bodyRaw !== res.chapter.body
      
      // Trigger fade-in animation by toggling class
      chapterFadeIn.value = false
      requestAnimationFrame(() => {
        chapterFadeIn.value = true
      })
      
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
      if (pagedView.value) {
        // 分页渲染层的恢复走页表：先把锚点交给舞台，页表重排后自行落位。
        realBookRestoreAnchor.value = pendingRealBookAnchor.value
          ?? (progress && progress.paragraphIndex !== undefined
? { paragraph: progress.paragraphIndex, offset: progress.paragraphOffset ?? 0, chapterId: progress.chapterId }
            : classicAnchorSnapshot.value)
        pendingRealBookAnchor.value = null
        realBookRestoreToken.value += 1
      } else if (pendingScrollPara >= 0) {
        scrollToPendingPara()
      } else if (progress && scrollRatio < 0.999 && scrollToParagraphAnchor(progress)) {
        // Anchor restore is scheduled after layout; old books use the ratio below.
      } else {
        scrollToRatio(scrollRatio)
      }
      chapterPrefetch.scheduleNeighbors({
        bookId: book.value.id,
        currentChapterId: ch.id,
        previous: previousChapter.value,
        following: followingChapter.value,
        readChapter: (bookId, chapterId) => window.api.library.readChapter(bookId, chapterId),
      })
      if (finishedChapter) void progressSave.then((saved) => {
        if (saved && book.value?.id === openingBookId) void reportFinishedChapter(finishedChapter)
      })
    } else {
      currentChapter.value = ch
      chapterBody.value = ''
      hasBodyRaw.value = false
      chapterError.value = res.message || '无法打开这一章'
    }
  } finally {
    // 只有最新一次导航才能关掉加载态；被取代的旧调用不能把新章的 loading 提前关掉。
    if (epoch === navEpoch) chapterLoading.value = false
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
    // 空文本节点（元素间空白 / 按钮前后缩进）没有可视字符：不能当锚点，
    // 否则建出空 range，getBoundingClientRect() 返回全零矩形，恢复会把 scrollTop 钳回章首。
    if (node.length === 0) continue
    if (left <= node.length) return { node, offset: left }
    left -= node.length
  }
  const last = nodes.filter((n) => n.length > 0).at(-1)
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

/** 已读上界取视窗底部；排期时固定坐标，不能在换章后重读 DOM。 */
function visibleReadEnd(): { paragraphIndex: number; characterOffset: number } | null {
  const pane = contentRef.value
  if (!pane || !chapterReady.value) return null
  const paragraphs = pane.querySelectorAll<HTMLElement>('[data-p]')
  if (!paragraphs.length) return null
  if (renderedCount.value === paras.value.length && pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) {
    const finalIndex = paras.value.length - 1
    if (finalIndex >= 0) return { paragraphIndex: finalIndex, characterOffset: paras.value[finalIndex]!.length }
  }
  const bottom = pane.getBoundingClientRect().bottom - 4
  let visible: HTMLElement | null = null
  for (const paragraph of paragraphs) {
    if (paragraph.getBoundingClientRect().top < bottom) visible = paragraph
    else break
  }
  if (!visible) return null
  const index = Number(visible.dataset.p)
  if (!Number.isSafeInteger(index) || index < 0 || index >= paras.value.length) return null
  const nodes = paragraphTextNodes(visible)
  const total = nodes.reduce((sum, node) => sum + node.length, 0)
  if (!total) return null
  if (visible.getBoundingClientRect().bottom <= bottom) return { paragraphIndex: index, characterOffset: Math.min(total, paras.value[index]!.length) }
  let low = 0
  let high = total
  const range = document.createRange()
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const point = textPoint(nodes, middle - 1)
    if (!point) break
    range.setStart(point.node, point.offset)
    range.setEnd(point.node, Math.min(point.offset + 1, point.node.length))
    if (range.getBoundingClientRect().bottom <= bottom) low = middle
    else high = middle - 1
  }
  return { paragraphIndex: index, characterOffset: Math.min(low, paras.value[index]!.length) }
}

/**
 * 把「段落下标 + 段内偏移」对准视口顶部。
 *
 * 导图跳转与进度恢复共用这一条落点路径：先等目标段进 DOM（大章节会先迁渲染窗口），
 * 再用 Range 找到段内字符的精确位置；目标段落不到时退回比例落点。
 */
function scrollToParagraphOffset(index: number, offset: number, fallbackRatio: number): void {
  const pane = contentRef.value
  if (!pane) return
  const generation = renderGeneration
  void waitForParagraph(index, generation).then((ready) => {
    if (!ready) return
    requestAnimationFrame(() => {
      const paragraph = pane.querySelector<HTMLElement>(`[data-p="${index}"]`)
      if (!paragraph) { scrollToRatio(fallbackRatio); return }
      const nodes = paragraphTextNodes(paragraph)
      const point = textPoint(nodes, offset)
      if (!point) { scrollToRatio(fallbackRatio); return }
      const range = document.createRange()
      range.setStart(point.node, point.offset)
      range.setEnd(point.node, Math.min(point.offset + 1, point.node.length))
      const targetTop = range.getBoundingClientRect().top
      pane.scrollTop += targetTop - pane.getBoundingClientRect().top - 4
      syncVisualPage()
    })
  })
}

function scrollToParagraphAnchor(progress: ReadingProgress): boolean {
  const pane = contentRef.value
  const index = progress.paragraphIndex
  const offset = progress.paragraphOffset
  if (!pane || !Number.isInteger(index) || !Number.isInteger(offset) || index! < 0 || offset! < 0) return false
  if (index! >= paras.value.length || offset! > (paras.value[index!]?.length ?? 0)) return false
  // 正文指纹校验：这一章正文被清理 / 重新下载过，旧锚点段是另一段内容，不能按它恢复。
  // 旧书没有 bodyHash 字段（null）跳过校验，保持锚点恢复兼容（回退 scrollRatio 会丢段内精度）。
  if (!progressAnchorBodyMatches(progress.bodyHash, chapterBody.value)) return false
  scrollToParagraphOffset(index!, offset!, progress.scrollRatio)
  return true
}

/**
 * 文本锚点跳转：经典模式滚到节点锚点，真实书籍落到同一锚点所在的真实页。
 * 导图节点与 AI 抽取的地名共用这条路径——两者都只带原始段落下标与段内偏移。
 */
function jumpToTextAnchor(anchor: MindmapAnchor): void {
  showDrawer.value = false
  showMap.value = false
  if (pagedView.value) {
    const target: RealBookAnchor = { paragraph: anchor.paragraphIndex, offset: anchor.paragraphOffset }
    // 书台已挂载就翻到那一页；切模式途中还没挂载时登记恢复请求，页表就绪后再落位。
    if (realBookStageRef.value) realBookStageRef.value.goToAnchor(target)
    else realBookRestoreAnchor.value = target
    return
  }
  scrollToParagraphOffset(anchor.paragraphIndex, anchor.paragraphOffset, 0)
}

function scrollToRatio(ratio: number) {
  const el = contentRef.value
  if (!el) return
  const generation = renderGeneration
  // 大章节：占位让 scrollHeight ≈ 整章高，比例直接映射到目标段，迁窗后真实落点。
  if (isLargeChapter.value) {
    const total = paras.value.length
    if (total <= 0) return
    const target = paragraphIndexForRatio(ratio, total)
    void waitForParagraph(target, generation).then((ready) => {
      if (!ready) return
      const pane = contentRef.value
      if (!pane) return
      const node = pane.querySelector<HTMLElement>(`.para[data-p="${target}"]`)
      if (node) {
        // 精确落点：目标段贴近视口顶部（留一点上留白），滚动条在两端自然钳制。
        pane.scrollTop = Math.max(0, node.offsetTop - 8)
        syncVisualPage()
        refreshAvgParaHeight()
        return
      }
      const top = scrollTopFromRatio(ratio, pane.scrollHeight, pane.clientHeight)
      pane.scrollTop = top
      syncVisualPage()
    })
    return
  }
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

/** 真实书籍下的选区：书台不是滚动容器，但段落仍带 data-p，选区坐标照旧能算。 */
function onRealBookMouseup(e: MouseEvent) {
  onContentMouseup(e)
}

/**
 * WebGL 跨页选择：翻页后原生选区已经不在了，书台给的是
 * 「段落原始下标 + 段内偏移」，这里换算成规范化正文坐标再抬工具条。
 */
function onRealBookSelectRange(range: {
  startParagraph: number
  startOffset: number
  endParagraph: number
  endOffset: number
  x: number
  y: number
}): void {
  const starts = paraNormStarts.value
  const start = (starts[range.startParagraph] ?? 0) + range.startOffset
  const end = (starts[range.endParagraph] ?? 0) + range.endOffset
  if (end <= start) return
  presentSelectionRange({ start, end }, { x: range.x, y: range.y })
}

/** 真实书籍翻页落定：更新页码并排期写进度（滚动进度在经典模式由 onScroll 排期）。 */
function onRealBookPage(page: number) {
  realBookPage.value = page
  readerProgress.schedule()
}

/** 排期那一刻就把书、章、位置锁死，写盘排队到什么时候都不会串到别的章。 */
function captureProgressWrite(): CapturedProgressWrite | null {
  const target = book.value
  const chapter = currentChapter.value
  if (!target || !chapter) return null
  // 两种渲染层给位置的方式不同，但落盘只有这一条路径。
  const snapshot = pagedView.value
    ? realBookProgressSnapshot()
    : classicProgressSnapshot()
  if (!snapshot) return null
  const { progress, readEnd } = snapshot
  return async () => {
    target.progress = progress
    const res = await window.api.library.setProgress(target.id, progress)
    if (res && res.ok === false) throw new Error(res.message || '阅读进度写入失败')
    if (readEnd) {
      const marked = await window.api.library.markReadFrontier?.(target.id, chapter.id, readEnd.paragraphIndex, readEnd.characterOffset)
      if (marked && !marked.ok) throw new Error(marked.message)
    }
  }
}

interface ProgressSnapshot {
  progress: ReadingProgress
  readEnd: { paragraphIndex: number; characterOffset: number } | null
}

/** 经典模式的位置：滚动比例 + 视口顶锚点。 */
function classicProgressSnapshot(): ProgressSnapshot | null {
  const el = contentRef.value
  const chapter = currentChapter.value
  if (!el || !chapter) return null
  const scrollRatio = currentChapterRatio(el)
  const anchor = paragraphAnchor()
  const readEnd = visibleReadEnd()
  return {
    progress: {
      chapterId: chapter.id,
      scrollRatio,
      ...(anchor && scrollRatio < 0.999 ? anchor : {}),
      // 正文指纹：恢复端靠它判断这一章正文有没有被清理 / 重新下载过（与 TTS 位置同源）。
      bodyHash: ttsBodyHash(chapterBody.value),
      updatedAt: new Date().toISOString(),
    },
    readEnd,
  }
}

/**
 * 真实书籍的位置：位置真源仍是段落锚点，只是坐标来自页表而不是滚动容器。
 * 页码只换算成比例（给旧进度/全书百分比用），锚点才是恢复精度的依据。
 */
function realBookProgressSnapshot(): ProgressSnapshot | null {
  const chapter = currentChapter.value
  if (!chapter) return null
  const stage = realBookStageRef.value
  // 页表还没落位（首次渲染、窗口还没量出尺寸）时舞台不会报锚点：此时首屏就是章首，
  // 写 (0,0) 比让进度退化成只剩比例更可靠；非首屏则不猜，宁可只写比例。
  const anchor = realBookAnchor.value ?? (realBookPage.value <= 0 ? { paragraph: 0, offset: 0 } : null)
  const readEnd = stage?.readEnd() ?? null
  const scrollRatio = realBookRatio()
  return {
    progress: {
      chapterId: chapter.id,
      scrollRatio,
      ...(anchor && scrollRatio < 0.999 ? { paragraphIndex: anchor.paragraph, paragraphOffset: anchor.offset } : {}),
      bodyHash: ttsBodyHash(chapterBody.value),
      updatedAt: new Date().toISOString(),
    },
    readEnd,
  }
}

async function confirmLegacyFrontier() {
  if (!book.value) return
  const result = await window.api.library.confirmLegacyReadRange(book.value.id)
  if (result.ok) { legacyReadProposal.value = null; message.success('旧进度已纳入已读范围') }
  else message.error(result.message)
}

function currentChapterRatio(el: HTMLElement): number {
  const visibleRatio = chapterScrollRatio(el.scrollTop, el.scrollHeight, el.clientHeight)
  // 大章节占位把 scrollHeight 撑成整章高，直接按可视比例；小章节照旧换算。
  if (isLargeChapter.value) return visibleRatio
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
  // 净化后 DOM 序号不等于段落下标：一律回读 data-p，保持「原始段落坐标」。
  const node = nodes[Math.min(low, nodes.length - 1)]
  const index = node ? Number(node.dataset.p) : Number.NaN
  viewportCenterPara.value = Number.isSafeInteger(index) && index >= 0 ? index : -1
}

function onScroll() {
  if (selectionOpen()) closeSelectionTools()
  const el = contentRef.value
  // 轻活：每次 scroll 都跟，成本低（只读 scrollTop/Height）。
  if (el) scrollRatioView.value = currentChapterRatio(el)
  readerProgress.schedule()
  syncVisualPage()
  schedulePageSnap()
  maybeContinueToNextChapter(el)
  // 重活（querySelectorAll + 强制布局二分）合并到每帧一次，别在每个 scroll 事件里同步跑。
  scheduleScrollHeavyWork()
}

let scrollHeavyRaf: number | null = null
function scheduleScrollHeavyWork() {
  if (scrollHeavyRaf != null) return
  scrollHeavyRaf = requestAnimationFrame(() => {
    scrollHeavyRaf = null
    updateViewportFocusAnchor()
    // 大章节：视口快出窗（或落进占位间隙）就迁窗，保证滚动到任何位置都有内容。
    followRenderWindow()
    if (showSearch.value && paras.value.length > 2000 &&
        Math.abs(viewportCenterPara.value - searchHighlightCenter.value) > 100) {
      searchHighlightCenter.value = viewportCenterPara.value
    }
  })
}

// 屏幕翻页模式：拖动滚动条 / 触控板惯性会让正文停在半页。滚动停下后回吸到最近整页。
// 用 rAF 检测"滚动是否已停"（帧对齐，比定时器更准），并用程序化滚动抑制避免互相打架。
let pageSnapRaf: number | null = null
let pageSnapLastScrollAt = 0
let suppressSnapUntil = 0
function schedulePageSnap() {
  if (readingMode.value !== 'screen') return
  if (Date.now() < suppressSnapUntil) return
  pageSnapLastScrollAt = performance.now()
  if (pageSnapRaf != null) return
  const settle = () => {
    pageSnapRaf = null
    if (readingMode.value !== 'screen' || Date.now() < suppressSnapUntil) return
    // 距最后一次滚动不足 ~140ms 说明还在滑，下一帧再看
    if (performance.now() - pageSnapLastScrollAt < 140) {
      pageSnapRaf = requestAnimationFrame(settle)
      return
    }
    snapToVisualPage()
  }
  pageSnapRaf = requestAnimationFrame(settle)
}

// 「滚到章末自动接下一章」：只在连续滚动模式下、开关打开、本章已排完、且确实贴底时触发。
// 屏幕翻页模式有自己的翻页与章末卡片，不在这里自动跳，避免和翻页手势打架。
// 用 continueGuard 防止加载期间滚动事件反复触发；用 epoch 判断这一章是否已被换掉。
let continueGuard = false
function maybeContinueToNextChapter(el: HTMLElement | null) {
  if (!el || readingMode.value !== 'scroll') return
  if (!autoNextChapter.value || autoScrolling.value || continueGuard) return
  if (!followingChapter.value) return
  if (renderedCount.value < paras.value.length) return
  // 贴底判定留 2px 容差（缩放/取整会让 scrollTop 差一点点到不了 max）
  if (el.scrollHeight - el.clientHeight - el.scrollTop > 2) return
  continueGuard = true
  const epoch = navEpoch
  void nextTick().then(() => {
    if (epoch !== navEpoch || !followingChapter.value) return
    return openChapter(followingChapter.value, 0, undefined, false, true)
  }).finally(() => { continueGuard = false })
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

/**
 * 底部进度条按章拖动。
 *
 * 拖动（pointerdown → pointermove）只更新浮标上的目标章名，不打开章节——中途每动一下就 openChapter
 * 会把正文刷成幻灯片，也把写盘状态机打乱。松手才 openChapter(ch, 0) 落在章首。
 */
const scrubRatio = ref<number | null>(null)
const scrubTarget = computed(() => {
  if (scrubRatio.value === null) return null
  return progressScrubTarget(chapters.value, scrubRatio.value)
})
const scrubLabel = computed(() => {
  const target = scrubTarget.value
  return target ? progressScrubLabel(target.chapter, target.index) : ''
})
const scrubOrdinal = computed(() => scrubTarget.value ? progressScrubLabel({ ...scrubTarget.value.chapter, title: '' }, scrubTarget.value.index) : '')
const scrubTitle = computed(() => scrubTarget.value?.chapter.title?.trim() || '')
const scrubbing = computed(() => scrubRatio.value !== null)
const scrubPercent = computed(() => Math.round((scrubRatio.value ?? 0) * 100))
const progressTrackRef = ref<HTMLElement | null>(null)
let scrubPointerId: number | null = null

function ratioFromPointer(clientX: number): number {
  const el = progressTrackRef.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  if (!(rect.width > 0)) return 0
  return clampRatio((clientX - rect.left) / rect.width)
}

/** 只有按在进度条本身上才算拖；点在浮标文字上也按进度条算。 */
function startProgressScrub(e: PointerEvent) {
  if (e.button !== 0) return
  if (!chapters.value.length) return
  revealTools(immersiveMode.value === 'locked')
  scrubPointerId = e.pointerId
  scrubRatio.value = ratioFromPointer(e.clientX)
  // 捕获指针：拖出进度条（甚至拖到窗口边缘）也要收到 pointermove / pointerup，
  // 不然松手事件落在正文上，会变成一次静默取消。
  try { (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId) } catch { /* 合成事件没有捕获 */ }
  e.preventDefault()
}

function moveProgressScrub(e: PointerEvent) {
  if (scrubRatio.value === null) return
  scrubRatio.value = ratioFromPointer(e.clientX)
  e.preventDefault()
}

function endProgressScrub(e: PointerEvent) {
  if (scrubRatio.value === null) return
  const target = scrubTarget.value
  scrubRatio.value = null
  const pointerId = scrubPointerId
  scrubPointerId = null
  if (pointerId !== null) {
    try { (e.currentTarget as HTMLElement | null)?.releasePointerCapture?.(pointerId) } catch { /* 已释放 */ }
  }
  if (e.type === 'pointercancel') {
    e.preventDefault()
    return
  }
  // 松手才真正换章：落点是章首（scrollRatio = 0），不是拖到的那个比例。
  // 失败/空/未下章照样打开，正文区的失败说明、重试、去浏览页入口由既有分支渲染。
  if (target) void openChapter(target.chapter, 0)
  e.preventDefault()
}

function cancelProgressScrub() {
  scrubRatio.value = null
  scrubPointerId = null
}

/**
 * 真实书籍底栏的进度滑条：与经典模式共用「按章跳转」的落点算法，
 * 但滑条更窄、只在真实书籍底栏里出现。拖动时只更新浮标百分比，
 * 松手才换章——中途每动一下就 openChapter 会把书台刷成幻灯片。
 */
const rbProgressRef = ref<HTMLElement | null>(null)
const rbScrub = ref<number | null>(null)
const rbPercent = computed(() => Math.round((rbScrub.value ?? bookProgressRatio.value) * 100))
let rbPointerId: number | null = null

function rbRatioFrom(clientX: number): number {
  const el = rbProgressRef.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  if (!(rect.width > 0)) return 0
  return clampRatio((clientX - rect.left) / rect.width)
}

function startRbScrub(e: PointerEvent) {
  if (e.button !== 0) return
  if (!chapters.value.length) return
  rbPointerId = e.pointerId
  rbScrub.value = rbRatioFrom(e.clientX)
  try { (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId) } catch { /* 合成事件没有捕获 */ }
  e.preventDefault()
}

function moveRbScrub(e: PointerEvent) {
  if (rbScrub.value === null) return
  rbScrub.value = rbRatioFrom(e.clientX)
  e.preventDefault()
}

function endRbScrub(e: PointerEvent) {
  if (rbScrub.value === null) return
  const ratio = rbScrub.value
  rbScrub.value = null
  const pointerId = rbPointerId
  rbPointerId = null
  if (pointerId !== null) {
    try { (e.currentTarget as HTMLElement | null)?.releasePointerCapture?.(pointerId) } catch { /* 已释放 */ }
  }
  if (e.type === 'pointercancel') {
    e.preventDefault()
    return
  }
  const target = progressScrubTarget(chapters.value, ratio)
  if (target) void openChapter(target.chapter, 0)
  e.preventDefault()
}

/** 键盘把焦点放在进度条上也能跳章：左右箭头按章移，Home/End 到首末章。 */
function onProgressTrackKeydown(e: KeyboardEvent) {
  if (!chapters.value.length) return
  const total = chapters.value.length
  const currentIndex = currentChapterIndex.value
  const base = currentIndex >= 0 ? currentIndex : 0
  let next = -1
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(total - 1, base + 1)
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, base - 1)
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = total - 1
  if (next < 0) return
  const ch = chapters.value[next]
  if (!ch) return
  e.preventDefault()
  e.stopPropagation()
  revealTools(immersiveMode.value === 'locked')
  void openChapter(ch, 0)
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
    bookFontFamily: bookFontFamily.value,
    contentWidth: contentWidth.value,
    paragraphSpacing: paragraphSpacing.value,
    paragraphIndent: paragraphIndent.value,
    focusMode: focusMode.value,
    readingMode: readingMode.value,
    bookView: bookView.value,
    sheetColumns: sheetColumns.value,
    handwritingFont: handwritingFont.value,
    showInlineNotes: showInlineNotes.value,
    autoScrollSpeed: autoScrollSpeed.value,
    autoNextChapter: autoNextChapter.value,
    dim: dim.value,
    hideSiteTail: hideSiteTail.value,
    hideReaderChrome: hideReaderChrome.value,
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
  bookFontFamily.value = DEFAULT_READER_PREFS.bookFontFamily ?? 'wenkai'
  contentWidth.value = DEFAULT_READER_PREFS.contentWidth
  paragraphSpacing.value = DEFAULT_READER_PREFS.paragraphSpacing
  paragraphIndent.value = DEFAULT_READER_PREFS.paragraphIndent
  focusMode.value = DEFAULT_READER_PREFS.focusMode
  readingMode.value = DEFAULT_READER_PREFS.readingMode
  bookView.value = DEFAULT_READER_PREFS.bookView ?? 'classic'
  sheetColumns.value = DEFAULT_READER_PREFS.sheetColumns ?? 'double'
  handwritingFont.value = DEFAULT_READER_PREFS.handwritingFont ?? 'none'
  showInlineNotes.value = DEFAULT_READER_PREFS.showInlineNotes ?? true
  autoScrollSpeed.value = DEFAULT_READER_PREFS.autoScrollSpeed ?? 3
  autoNextChapter.value = DEFAULT_READER_PREFS.autoNextChapter === true
  dim.value = DEFAULT_READER_PREFS.dim ?? 0
  // 净化与「工具一直显示」同样回到缺省（净化开、工具收起）；「本章显示原文」是临时态。
  hideSiteTail.value = DEFAULT_READER_PREFS.hideSiteTail ?? true
  hideReaderChrome.value = DEFAULT_READER_PREFS.hideReaderChrome ?? true
  showRawThisChapter.value = false
  // 顶栏只按两条露出规则重算：下载 running 优先，恢复默认不丢「已下 x / y 章」与「取消」。
  toolsVisible.value = false
  temporaryToolReveal.value = false
  clearToolHideTimer()
  revealToolsForDownload()
  revealToolsForPreference()
  message.success('已恢复默认阅读设置')
}

async function loadPrefs() {
  const s = await window.api.settings.get()
  fontSize.value = s.reader.fontSize
  lineHeight.value = s.reader.lineHeight
  theme.value = s.reader.theme
  fontFamily.value = s.reader.fontFamily
  bookFontFamily.value = s.reader.bookFontFamily ?? 'wenkai'
  contentWidth.value = s.reader.contentWidth
  paragraphSpacing.value = s.reader.paragraphSpacing
  paragraphIndent.value = s.reader.paragraphIndent
  focusMode.value = s.reader.focusMode
  readingMode.value = s.reader.readingMode
  bookView.value = s.reader.bookView ?? 'classic'
  sheetColumns.value = s.reader.sheetColumns ?? 'double'
  handwritingFont.value = s.reader.handwritingFont ?? 'none'
  showInlineNotes.value = s.reader.showInlineNotes ?? true
  autoScrollSpeed.value = s.reader.autoScrollSpeed ?? 3
  autoNextChapter.value = s.reader.autoNextChapter === true
  dim.value = s.reader.dim ?? 0
  // 旧设置文件缺这两项时按缺省 true（净化开、工具收起）。
  hideSiteTail.value = s.reader.hideSiteTail ?? DEFAULT_READER_PREFS.hideSiteTail ?? true
  hideReaderChrome.value = s.reader.hideReaderChrome ?? DEFAULT_READER_PREFS.hideReaderChrome ?? true
  ttsRate.value = clampTtsRate(s.tts?.rate ?? 1)
  ttsAutoNext.value = s.tts?.autoNextChapter ?? true
  ttsSource.value = s.tts?.source === 'online' ? 'online' : 'system'
  ttsVoiceURI.value = s.tts?.systemVoiceURI ?? ''
  recapLength.value = s.ai?.recapLength ?? 'standard'
  autoFollowEnabled.value = s.ai?.autoReadingFollow ?? false
  aiServiceOrigin.value = displayAiServiceOrigin(s.baseUrl)
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
      showAiOutput()
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
  showAiAssistant.value = false
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

/**
 * 侧栏宽度是纯界面偏好（不写 settings.json，不动主进程），拖宽后下次打开还是这个宽度。
 * 历史脏数据/隐私模式下 localStorage 读不出来一律回退默认值：宽度错了只是难看，不该拦住侧栏。
 */
const AI_DRAWER_WIDTH_DEFAULT = 420
const AI_DRAWER_WIDTH_MIN = 360
const AI_DRAWER_WIDTH_MAX = 720
const AI_DRAWER_WIDTH_KEY = 'spbf.aiDrawerWidth'
function clampAiDrawerWidth(width: number): number {
  return Math.min(AI_DRAWER_WIDTH_MAX, Math.max(AI_DRAWER_WIDTH_MIN, Math.round(width)))
}
function readStoredAiDrawerWidth(): number {
  try {
    const raw = localStorage.getItem(AI_DRAWER_WIDTH_KEY)
    const parsed = raw === null ? Number.NaN : Number.parseFloat(raw)
    return Number.isFinite(parsed) ? clampAiDrawerWidth(parsed) : AI_DRAWER_WIDTH_DEFAULT
  } catch {
    return AI_DRAWER_WIDTH_DEFAULT
  }
}
const aiDrawerWidth = ref(readStoredAiDrawerWidth())
function setAiDrawerWidth(width: number): void {
  // 拖动时 naive-ui 每帧都会回报一次宽度：先夹住再落库，避免把越界值写进下一次启动。
  const clamped = clampAiDrawerWidth(width)
  aiDrawerWidth.value = clamped
  try {
    localStorage.setItem(AI_DRAWER_WIDTH_KEY, String(clamped))
  } catch {
    /* 忽略存储失败：只影响下次的默认宽度 */
  }
}

/**
 * 从引用角标跳回原文后闪一下目标段落：同章内跳转页码可能没变，不闪读者不知道自己落在哪。
 * 真实书籍 WebGL 模式没有 [data-p] 段落元素，找不到就静默返回（允许不闪）。
 */
let paraFlashEl: HTMLElement | null = null
let paraFlashTimer: ReturnType<typeof setTimeout> | null = null
function flashParagraph(paragraphIndex: number): void {
  // 连续点两个角标时，上一个定时器要撤掉，否则它会把新段落的 class 一起抹掉。
  if (paraFlashTimer !== null) {
    clearTimeout(paraFlashTimer)
    paraFlashTimer = null
  }
  if (paraFlashEl) {
    paraFlashEl.classList.remove('para-flash')
    paraFlashEl = null
  }
  // 换章后的 DOM 要等这一轮渲染落地；下一帧仍找不到就是窗口外/无段落坐标，直接放弃。
  void nextTick(() => {
    const el = contentRef.value?.querySelector<HTMLElement>(`[data-p="${paragraphIndex}"]`)
    if (!el) return
    el.classList.add('para-flash')
    paraFlashEl = el
    paraFlashTimer = setTimeout(() => {
      el.classList.remove('para-flash')
      if (paraFlashEl === el) paraFlashEl = null
      paraFlashTimer = null
    }, 1200)
  })
}

// AI 助手面板：整块（状态 + 行为）在 readerAssistant.ts，这里只接线（名字保持原样，模板不用改）。
// 必须放在所有依赖声明之后（paras/chapters/contentRef/fontSize/readingMode/loadBook/openChapter…），
// 否则 setup 里会 TDZ；onMounted 里的回调是懒执行，放在它前面即可。
const assistant = useReaderAssistant({
  book,
  currentChapter,
  chapterBody,
  paras,
  chapters,
  contentRef,
  fontSize,
  readingMode,
  message,
  loadBook,
  openChapter,
  pendingScrollPara: { get: () => pendingScrollPara, set: (value) => { pendingScrollPara = value } },
  resumeCardView,
  resumeCardLoading,
  resumeCardWarning,
  showSelPopup,
  selectedExcerpt,
  selectedRange,
  selectionOffsets,
  restoringChat,
  aiResult,
  aiResultTitle,
  closeSelectionTools,
  flashParagraph,
})
const {
  showAiAssistant,
  aiAssistantTab,
  aiServiceOrigin,
  aiAssistantTaskLabel,
  assistantBudgets,
  currentAssistantBudget,
  recapText,
  recapJobId,
  recapJobKind,
  recapStopping,
  recapStarting,
  recapLength,
  memoryData,
  timelineData,
  memorySourceJumping,
  memoryJobId,
  memoryJobKind,
  memoryStarting,
  memoryStopping,
  memoryLoading,
  assistantStages,
  lastAssistantUsage,
  assistantCompleted,
  lastAssistantTruncated,
  assistantSaveState,
  assistantSaveRetrying,
  chapterSummaryBudget,
  chapterSummaryBudgetMessage,
  showChapterSummaryBudgetConfirm,
  memoryBudget,
  memoryBudgetMessage,
  showMemoryBudgetConfirm,
  memoryBudgetRequest,
  recapBudgetConfirmKind,
  chapterNotes,
  currentChapterNote,
  chapterNoteJobId,
  chapterNoteText,
  chapterNoteDraft,
  chapterNoteStarting,
  chapterNoteStopping,
  chapterNoteStopped,
  chapterNoteSaving,
  chapterNoteLoading,
  notesBudget,
  notesBudgetMessage,
  showNotesBudgetConfirm,
  noteOverwritePrompt,
  chapterNoteView,
  otherChapterNotes,
  recapLoading,
  translateJobId,
  translateLoading,
  chatMessages,
  chatMode,
  qaContextChips,
  qaContextActive,
  toggleQaContextChip,
  agentToolActivity,
  setAgentToolActivity,
  chatInput,
  chatLoading,
  chatStarting,
  chatJobId,
  chatAssistantIndex,
  selectionNoteTarget,
  selectionNoteSaving,
  follow,
  readingAiMode,
  materialCoverage,
  bookUsage,
  autoBudget,
  semanticState,
  sceneQuestion,
  sceneHits,
  sceneMessage,
  sceneSearching,
  aliasDrafts,
  summaryDrafts,
  memoryQuery,
  correctingAliasId,
  correctingSummaryId,
  pendingFollowMode,
  followBudget,
  followBudgetMessage,
  showFollowBudgetConfirm,
  autoFollowEnabled,
  FOLLOW_POLL_MS,
  FOLLOW_POLL_IDLE_MS,
  assistantBusyByKind,
  assistantSaveBusy,
  assistantJobIds,
  currentAssistantStage,
  assistantStageText,
  backgroundAiLabel,
  loadStoredRecap,
  isStructuredMemory,
  loadStoredMemory,
  loadTimeline,
  loadAssistantMaterial,
  loadResumeCard,
  generateResumeCard,
  refreshSemanticStatus,
  toggleSemanticIndex,
  searchScenes,
  askFromScene,
  reportFinishedChapter,
  applyFollow,
  startFollowPolling,
  stopFollowPolling,
  pollFollow,
  setReadingAiMode,
  confirmFollowBudget,
  cancelFollowBudget,
  runFollowNow,
  stopFollowAuto,
  showAiOutput,
  openAiAssistant,
  startMemoryJob,
  stopMemoryJob,
  jumpToMemorySource,
  earliestMemorySource,
  rebuildMemoryFromSource,
  confirmMemoryBudget,
  saveCharacterAliases,
  saveMemorySummary,
  markMemoryItem,
  retryAssistantSave,
  setRecapLength,
  startRecap,
  confirmOverBudgetChapterSummary,
  cancelOverBudgetChapterSummary,
  stopRecap,
  loadChapterNotes,
  startChapterNote,
  confirmNotesBudget,
  cancelNotesBudget,
  stopChapterNote,
  saveChapterNoteEdit,
  openChapterFromNote,
  getSelectedText,
  translateSelectedText,
  explainSelection,
  askSelectionInAgent,
  openInlineAsk,
  inlineAsk,
  stopTranslate,
  QUICK_READING_QUESTIONS,
  prepareQuickQuestion,
  sendChat,
  stopChat,
  clearChat,
  // 问答历史的就地修改（复制 / 重问 / 编辑 / 删一轮）：状态在 readerAssistant.ts，这里只接按钮。
  chatActionsDisabled,
  copyChatAnswer,
  reAskChatAnswer,
  editChatQuestion,
  deleteChatRound,
} = assistant

/**
 * 打开「聊书」后把抽屉滚到最底：抽屉内容比窗口高，输入框在对话末尾，
 * 不滚就得先往下翻半屏才找得到在哪里提问。
 */
async function pinChatToBottom() {
  await nextTick()
  // 真正会滚的是 .n-drawer-body-content-wrapper（body 自己是 overflow:hidden），
  // 不写死类名：往上找第一个真能滚的祖先。
  let el = document.querySelector('.chat-input-row')?.parentElement ?? null
  while (el && el !== document.body) {
    if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible') break
    el = el.parentElement
  }
  if (el && el !== document.body) el.scrollTop = el.scrollHeight
}
watch(showAiAssistant, (open) => { if (open) void pinChatToBottom() })
watch(aiAssistantTab, (tab) => { if (tab === 'qa' && showAiAssistant.value) void pinChatToBottom() })

watch(
  [fontSize, lineHeight, theme, fontFamily, bookFontFamily, contentWidth, paragraphSpacing, paragraphIndent, focusMode, readingMode, bookView, sheetColumns, handwritingFont, showInlineNotes, autoScrollSpeed, autoNextChapter, dim, hideSiteTail, hideReaderChrome],
  () => {
    if (!prefsReady.value) return
    scheduleReaderPrefsSave()
    avgParaHeight.value = 0
    measuredWindowKey = ''
    void nextTick(() => {
      refreshAvgParaHeight()
      snapToVisualPage()
    })
  },
)
// 打开「工具一直显示」立刻留住顶栏；关掉只记偏好，默认收起留给下一次进入与 Esc，
// 避免把用户此刻正开着的字体面板抢走。下载 running 的露出优先，不受这条影响。
watch(hideReaderChrome, (next, prev) => {
  if (prev === true && next === false) revealToolsForPreference()
})

watch([ttsRate, ttsAutoNext, ttsSource, ttsVoiceURI], () => {
  if (!prefsReady.value) return
  void window.api.settings.set({
    tts: { rate: clampTtsRate(ttsRate.value), autoNextChapter: ttsAutoNext.value,
      source: ttsSource.value, systemVoiceURI: ttsVoiceURI.value },
  })
})
watch(ttsRate, () => updateTtsRate())
watch(ttsSource, () => { if (ttsSpeaking.value) ttsStop() })

watch(() => props.bookId, (id) => { if (id) void loadBook(id) })
// 选区坐标只在当前章的规范化正文里有意义，换章后必须作废。
watch(() => currentChapter.value?.id, () => {
  selectionNoteTarget.value = null
  inlineNoteEditor.value = null
  // 换章（含换书、续读）就把关系图拉回新章的进度：
  // 否则上一本/上一章拖到的位置会带到新章，那正好会造成它本想避免的剧透。
  memoryGraphUpto.value = memoryGraphCurrentIndex.value
})
watch([aiAssistantTab, currentChapter], ([tab]) => {
  if (tab === 'notes') void loadChapterNotes()
  if (tab === 'memory') void loadTimeline()
})
watch([renderedParas, chapterBody], () => {
  void nextTick(() => {
    updateViewportFocusAnchor()
    refreshAvgParaHeight()
  })
})
watch(renderedCount, (count) => {
  if (count === paras.value.length && contentRef.value) {
    scrollRatioView.value = currentChapterRatio(contentRef.value)
  }
})
watch(showDrawer, (open) => { if (open && drawerTab.value === 'catalog') void scrollCatalogToCurrent() })
watch(drawerTab, (tab) => { if (tab === 'catalog' && showDrawer.value) void scrollCatalogToCurrent() })
watch(showAiAssistant, (open) => { if (open) void loadResumeCard() })
watch(
  [showDrawer, showMap, showAiAssistant, showSearch, showMarks, showSelPopup, inlineNoteEditor, activeToolPanel, activeBottomPanel],
  () => {
    if (anyDrawerOpen() || selectionOpen()) toolsVisible.value = true
    lastToolActivityAt = Date.now()
    scheduleToolHide()
  },
)

onMounted(async () => {
  refreshTtsVoices()
  startReaderVisibilityWatch()
  if ('speechSynthesis' in window) window.speechSynthesis.addEventListener?.('voiceschanged', refreshTtsVoices)
  window.addEventListener('keydown', onReaderKeydown)
  window.addEventListener('keydown', onOverlayEscapeCapture, true)
  window.addEventListener('resize', onReaderResize)
  window.addEventListener('beforeunload', flushPendingReaderWrites)
  document.addEventListener('fullscreenchange', syncFullscreenState)
  unsubAiChunk = window.api.ai.onChunk(({ jobId, delta }) => {
    if (jobId === recapJobId.value) recapText.value += delta
    if (jobId === chapterNoteJobId.value) chapterNoteText.value += delta
    if (jobId === translateJobId.value) aiResult.value += delta
    if (jobId === chatJobId.value && chatAssistantIndex.value >= 0) {
      const assistant = chatMessages.value[chatAssistantIndex.value]
      if (assistant) assistant.content += delta
    }
    // 划词行内卡片自己那一轮：只有它开着且 jobId 对得上时才追加。
    if (inlineAsk.open.value) inlineAsk.appendDelta(jobId, delta)
  })
  unsubAiStage = window.api.ai.onStage((event) => {
    const detail = event.detail?.trim()
    assistantStages.value = {
      ...assistantStages.value,
      [event.jobId]: { stage: event.stage, ...(detail ? { detail } : {}) },
    }
    if (event.jobId === chatJobId.value && event.citations?.length && chatAssistantIndex.value >= 0) {
      const assistant = chatMessages.value[chatAssistantIndex.value]
      if (assistant) {
        assistant.citations = event.citations
        if (event.uptoChapterId) assistant.uptoChapterId = event.uptoChapterId
      }
    }
    // 对话模式下 events.detail 是模型正在调的工具名（查目录/读原文/检索…）。
    if (event.jobId === chatJobId.value && chatMode.value === 'agent') {
      setAgentToolActivity(detail ?? '')
    }
  })
  unsubAiBudget = window.api.ai.onBudget(({ task, budget }) => {
    assistantBudgets.value = { ...assistantBudgets.value, [task]: budget }
  })
  unsubAiDone = window.api.ai.onDone((event) => {
    // 行内卡片先接手自己的终态：它和侧栏的 jobId 不同源，不该落进下面那些分支。
    if (inlineAsk.open.value && event.jobId === inlineAsk.jobId.value) {
      inlineAsk.finish(event)
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
    if (event.jobId === translateJobId.value) {
      translateJobId.value = ''
      aiResult.value = event.ok ? event.text : `错误：${event.message}`
      return
    }
    if (event.jobId === chapterNoteJobId.value) {
      chapterNoteJobId.value = ''
      const stopped = chapterNoteStopping.value || event.stopped === true
      chapterNoteStopping.value = false
      if (!event.ok) {
        chapterNoteStopped.value = false
        chapterNoteText.value = ''
        message.error(event.message)
        return
      }
      chapterNoteStopped.value = stopped && Boolean(event.text)
      if (stopped || event.saveToken) {
        chapterNoteText.value = event.text
        return
      }
      chapterNoteText.value = ''
      void loadChapterNotes()
      message.success('本章笔记已保存')
      return
    }
    if (event.jobId === chatJobId.value) {
      const assistantIndex = chatAssistantIndex.value
      const assistant = chatMessages.value[assistantIndex]
      if (event.ok) {
        if (assistant) {
          assistant.content = event.text
          assistant.citations = event.citations
          assistant.claims = event.claims
          // 可信度三件套一起落地：少了它们，界面会把一轮「删过结论」的回答当成普通回答展示。
          assistant.verification = event.verification
          assistant.droppedClaims = event.droppedClaims
          assistant.uptoChapterId = event.uptoChapterId
          assistant.stopped = event.stopped === true
        }
        if (!event.text && assistantIndex >= 0) chatMessages.value.splice(assistantIndex, 1)
      } else if (assistant) {
        assistant.content = `错误：${event.message}`
      }
      // 空 label 只收尾不加步：成功的收尾把还在跑的那步标成 done，失败必须传 error，
      // 否则一次没跑通的调用会在思考链里停在「进行中」，看起来像还在等。
      // 必须在清 chatAssistantIndex 之前调：它是靠下标找那条消息的，清完就找不到还在跑的那一步。
      setAgentToolActivity('', event.ok ? 'done' : 'error')
      chatJobId.value = ''
      chatAssistantIndex.value = -1
      chatLoading.value = false
      return
    }
    if (event.jobId === memoryJobId.value) {
      const kind = memoryJobKind.value
      const stopped = event.ok ? event.stopped === true : event.message === '已停止生成'
      memoryJobId.value = ''
      memoryJobKind.value = ''
      memoryStopping.value = false
      if (stopped) {
        message.info('更新已停止，原有记忆未改变。')
      } else if (event.ok && event.memoryUpdate) {
        memoryData.value = event.memoryUpdate.memory
        void loadTimeline()
        for (const character of memoryData.value.characters) aliasDrafts.value[character.id] = character.aliases.join('、')
        for (const item of [
          ...memoryData.value.characters, ...memoryData.value.relations,
          ...memoryData.value.foreshadows, ...memoryData.value.events,
        ]) summaryDrafts.value[item.id] = item.summary
        message.success(kind === 'rebuild'
          ? '小说记忆已重建'
          : kind === 'fromSource' ? '来源章节以后的记忆已重新分析'
          : `本次处理 ${event.memoryUpdate.processedChapters} 章，新增或更新 ${event.memoryUpdate.changedItems} 条记忆。`
            + (event.memoryUpdate.remainingChapters > 0
              ? `剩余 ${event.memoryUpdate.remainingChapters} 章未处理。`
              : ''))
      } else if (!event.ok) {
        message.error(event.message)
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
    // 本页常驻挂载：书还没选中时也要记住 running，等点开这本书就能立刻露出顶栏。
    const previous = currentDownloadSignal()
    downloadProgress.value = p
    applyDownloadToolsPolicy(previous, currentDownloadSignal())
    if (!book.value || p.bookId !== book.value.id) return
    if (p.status === 'done' || p.status === 'error' || p.status === 'cancelled') {
      void loadBook(book.value.id)
    }
  })
})

onUnmounted(() => {
  if ('speechSynthesis' in window) window.speechSynthesis.removeEventListener?.('voiceschanged', refreshTtsVoices)
  window.removeEventListener('keydown', onReaderKeydown)
  window.removeEventListener('keydown', onOverlayEscapeCapture, true)
  window.removeEventListener('resize', onReaderResize)
  window.removeEventListener('beforeunload', flushPendingReaderWrites)
  document.removeEventListener('fullscreenchange', syncFullscreenState)
  chapterPrefetch.dispose()
  stopReaderVisibilityWatch()
  stopFollowPolling()
  stopAutoScroll()
  ttsStop()
  if (renderTimer) clearTimeout(renderTimer)
  if (pageSnapRaf != null) { cancelAnimationFrame(pageSnapRaf); pageSnapRaf = null }
  if (scrollHeavyRaf != null) { cancelAnimationFrame(scrollHeavyRaf); scrollHeavyRaf = null }
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
  <div ref="readerRootRef" :class="['reader-wrap', { 'immersive-locked': immersiveMode === 'locked', 'drawer-open': showDrawer }]" :style="readerThemeStyle" @focusin="onReaderFocusIn">
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
        :class="{ 'reader-tools-hidden': !toolsVisible, 'reader-toolbar-realbook': isRealBook }"
        :aria-hidden="!toolsVisible"
        :inert="!toolsVisible"
        @mouseenter="onToolbarEnter"
        @mouseleave="onToolbarLeave"
      >
        <!-- 真实书籍走参考站的沉浸式 chrome：不摆应用顶栏，工具都收进底栏与书页。
             页码只留一条隐藏文本：视觉上不占位，E2E 与测试仍能读到当前位置。 -->
        <span v-if="isRealBook" class="real-book-page-label" aria-hidden="true">第 {{ realBookPage + 1 }} / {{ Math.max(1, realBookPageCount) }} 页</span>
        <template v-if="!isRealBook">
        <div class="reader-book-title" :title="book.title">{{ book.title }}</div>
        <button class="tool-button tool-text" type="button" title="书架" aria-label="书架" @click="emit('back')">书架</button>
        <button class="tool-button tool-icon-text" title="搜索" aria-label="搜索" @click="openSearch"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg><span>搜索</span></button>
        <button class="tool-button tool-icon-text" title="标记" aria-label="标记" @click="showMarks = true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z"/></svg><span>标记</span></button>
        <button class="tool-button tool-icon-text" title="书中地图" aria-label="书中地图" @click="showMap = true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg><span>地图</span></button>
        <button class="tool-button tool-icon-text" title="朗读" aria-label="朗读" @click="toggleToolPanel('tts')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h4l5 4V6L9 10zM18 9a5 5 0 0 1 0 6"/></svg><span>朗读</span></button>
        <button class="tool-button tool-icon-text" title="AI 助手" aria-label="AI" @click="toggleToolPanel('ai')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 9.8 8.8 4 11l5.8 2.2L12 19l2.2-5.8L20 11l-5.8-2.2z"/></svg><span>AI</span></button>
        <button v-if="isRealBook" class="tool-button bottom-button" type="button" title="字体" aria-label="字体" :class="{ active: activeBottomPanel === 'font' }" @click="toggleBottomPanel('font')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7V5h14v2M12 5v14M9 19h6"/></svg></button>
        <button v-if="isRealBook" class="tool-button bottom-button real-book-btn" type="button" title="平放" aria-label="平放" @click="realBookStageRef?.resetPitch()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/><path d="M7 12V8h10v4"/></svg></button>
        <button
          v-if="backgroundAiLabel"
          class="tool-button tool-text"
          type="button"
          role="status"
          :title="`${backgroundAiLabel}：点开看后台 AI 任务`"
          @click="toggleToolPanel('ai')"
        >{{ backgroundAiLabel }}</button>
        <span class="toolbar-gap" aria-hidden="true"></span>
        <template v-if="isCurrentBookDownloading(downloadProgress, book.id)">
          <span class="tool-button tool-text" role="status" data-reader-dl="progress">已下 {{ downloadProgress!.done }} / {{ downloadProgress!.total }} 章</span>
          <button class="tool-button tool-text" type="button" data-reader-dl="cancel" @click="cancelReaderDownload">取消</button>
        </template>
        <span class="toolbar-sep" aria-hidden="true"></span>
        <button class="tool-button tool-text" type="button" title="设置" aria-label="设置" @click="emit('go-settings')">设置</button>
        <button class="tool-button tool-text" type="button" title="浏览" aria-label="浏览" @click="emit('go-browse')">浏览</button>
        <button class="tool-button tool-button-offstage" title="快捷键说明" aria-label="快捷键说明" @click="toggleToolPanel('shortcuts')"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="2"/><path d="M7 10h1M10 10h1M13 10h1M16 10h1M7 14h7M16 14h1"/></svg></button>
        <button class="tool-button" :title="immersiveMode === 'locked' ? '退出沉浸模式' : '沉浸模式'" :aria-label="immersiveMode === 'locked' ? '退出沉浸模式' : '沉浸模式'" @click="toggleImmersiveLock"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg></button>

        </template>
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
              <div><dt>← / →</dt><dd>上一章 / 下一章（书页与真实书籍模式翻页）</dd></div>
              <div><dt>Space / Shift+Space，J / K</dt><dd>下一屏 / 上一屏</dd></div>
              <div><dt>T / A / R</dt><dd>目录 / 外观 / 朗读</dd></div>
              <div><dt>I / N</dt><dd>AI 助手 / 本章笔记</dd></div>
              <div><dt>M / Alt / Esc</dt><dd>沉浸模式 / 临时唤回 / 关闭面板</dd></div>
              <div><dt>Ctrl+F，+ / -</dt><dd>本书搜索 / 调整字号</dd></div>
            </dl>
          </template>
          <template v-else>
            <strong>AI</strong>
            <n-space vertical :size="6"><n-button size="tiny" block :disabled="!chapterReady" :loading="cleanRunning" @click="aiCleanBody">清正文</n-button><n-button v-if="cleanRunning" size="tiny" block type="warning" @click="stopCleanBody">停止清正文</n-button><n-button v-if="hasBodyRaw" size="tiny" block @click="restoreCleanedBody">撤销清正文</n-button><n-button size="tiny" block @click="openAiAssistant('recap')">AI 助手</n-button><n-button size="tiny" block :disabled="!chapterReady" @click="openAiAssistant('qa')">聊书</n-button></n-space>
          </template>
        </div>
      </div>

      <div class="reader-stage">
        <!-- 工具条收起时（沉浸 / 未唤回）整个 chrome 都不可见，
             新用户找不到回书库的出口：补一个不抢戏的浮动返回。工具条出现即隐藏。 -->
        <button
          v-if="!isRealBook && !toolsVisible"
          class="reader-float-back"
          type="button"
          title="返回书库"
          aria-label="返回书库"
          @click="emit('back')"
        ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg><span>书库</span></button>
        <!-- 左侧那片背景不该空着：给一张极淡的书名 / 章节牌，读到哪一眼可见。 -->
        <aside
          v-if="!isRealBook && !toolsVisible && book"
          class="reader-plate"
          aria-hidden="true"
        >
          <p class="reader-plate-title">{{ book.title }}</p>
          <p class="reader-plate-meta">
            <span v-if="currentChapterIndex >= 0">第 {{ currentChapterIndex + 1 }} / {{ chapters.length }} 章</span>
          </p>
        </aside>
        <div class="reader-body" :class="{ 'reader-body-paged': pagedView, 'reader-body-realbook': isRealBook }">
        <div v-if="bookView === 'classic'" class="reader-content reader-pane" :class="{ 'large-chapter': paras.length > 2000, 'chapter-fade-in': chapterFadeIn }" :style="contentStyle" ref="contentRef" @scroll="onScroll" @mouseup="onContentZoneMouseup">
          <div v-if="chapterLoading" class="loading-hint">正在打开章节…</div>
          <template v-else>
            <h3 class="ch-title">{{ currentChapter?.title }}</h3>
            <div v-if="resumeCardView?.available" class="ai-budget-status">
              {{ resumeCardView.card ? '续读卡已准备好' : resumeCardView.reason }}
              <n-button size="tiny" @click="openAiAssistant('recap')">查看续读卡</n-button>
            </div>
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
            <!-- 窗口化：窗口已离开章首时，被跳过的开头段用占位撑住标题与正文之间的距离 -->
            <div v-if="topGapHeight > 0" class="reader-gap top" :style="{ height: `${topGapHeight}px` }" aria-hidden="true"></div>
            <template v-for="{ index: i, segs } in visibleParas" :key="i">
              <p
                :data-p="i"
                :class="['para', { 'para-speaking': i === spokenPara, 'para-unfocused': focusMode !== 'off' && resolveFocusAnchor({ spokenPara: spokenPara, viewportCenterPara }) >= 0 && !isParagraphInFocus({ mode: focusMode, anchorIndex: resolveFocusAnchor({ spokenPara: spokenPara, viewportCenterPara }), paragraphIndex: i, paragraphCount: paras.length }) }]"
              ><template v-for="(s, j) in segs" :key="j"><span v-if="s.noteId" class="classic-note-anchor" :data-note-anchor-id="s.noteId" role="button" tabindex="0" aria-label="查看这条批注" @click.stop="openInlineNoteEditor(s.noteId)" @mouseup.stop @keydown.enter.stop.prevent="openInlineNoteEditor(s.noteId)" @keydown.space.stop.prevent="openInlineNoteEditor(s.noteId)"></span><mark v-else-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template><span v-if="ttsSupported && chapterReady" class="para-tts-zone" aria-hidden="true"></span><button v-if="ttsSupported && chapterReady" type="button" class="para-tts-start" :aria-label="`从第 ${i + 1} 段开始朗读`" title="从此段开始朗读" @mouseup.stop @click.stop="startTtsFromParagraph(i)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3l4-3.2v11.4l-4-3.2H4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg><span class="para-tts-label">从此段朗读</span></button></p>
              <aside
                v-for="note in classicInlineNotes.get(i) ?? []"
                :key="note.id"
                :class="['classic-inline-note', 'real-book-note', handwritingNoteClass, { 'is-ai': note.source === 'ai' }]"
                :data-note-id="note.id"
                role="button"
                tabindex="0"
                :aria-label="`编辑批注：${note.text}`"
                @click.stop="openInlineNoteEditor(note.id)"
                @mouseup.stop
                @keydown.enter.stop.prevent="openInlineNoteEditor(note.id)"
                @keydown.space.stop.prevent="openInlineNoteEditor(note.id)"
              >
                <span class="real-book-note-label">笔记<span v-if="note.source === 'ai'" class="real-book-note-source">AI</span></span>
                <span class="real-book-note-text">{{ note.text }}</span>
                <span v-if="note.tags?.length" class="real-book-note-tags">
                  <span v-for="tag in note.tags" :key="tag" class="real-book-note-tag">#{{ tag }}</span>
                </span>
              </aside>
            </template>
            <!-- 窗口化：跳到后段时，跳过的段用等高的占位撑住，滚动条始终按整章长度显示 -->
            <div v-if="bottomGapHeight > 0" class="reader-gap" :style="{ height: `${bottomGapHeight}px` }" aria-hidden="true"></div>
            <button v-if="chapterReady && followingChapter && renderedCount >= paras.length" class="chapter-end-card" @click="nextChapter">下一章：{{ followingChapter.title }}</button>
            <div v-else-if="chapterReady && currentChapterIndex === chapters.length - 1 && renderedCount >= paras.length" class="chapter-end-card finished">
              <strong>已读完《{{ book.title }}》</strong>
              <n-button size="small" @click="emit('back')">返回书库</n-button>
            </div>
          </template>
        </div>
        <!-- 书脚留白不随底栏显隐变化：收起时多出来的那一截只是空桌面，
             展开时书不会往上跳一截（否则每次显隐都要重排页表，阅读位置会晃）。 -->
        <div v-else ref="realBookHostRef" class="real-book-host" @mouseup="onPagedZoneMouseup">
          <p v-if="chapterFailHint" class="chapter-hint">{{ chapterFailHint }}</p>
          <n-space v-if="canRetryChapter || chapterError" justify="center" style="margin-bottom:16px">
            <n-button v-if="canRetryChapter" size="small" type="warning" :loading="retryingChapter" @click="retryThisChapter">
              重试失败章
            </n-button>
            <n-button v-if="currentChapter?.url || book.sourceUrl" size="small" @click="goBrowseForChapter">
              去浏览页
            </n-button>
          </n-space>
          <RealBookStage
            :theme="theme"
            :show-toolbar="bookView !== 'realbook'"
            :back-visible="!toolsVisible"
            :variant="bookView === 'sheet' ? 'sheet' : 'book'"
            :renderer="bookView === 'realbook' ? realBookRenderer : 'css'"
            :desk="realBookLook.desk"
            :endpaper="realBookLook.endpaper"
            :book-title="book?.title ?? ''"
            :book-author="book?.author ?? ''"
            :book-id="book?.id ?? ''"
            :total-chars="bookTotalChars"
            :book-progress-ratio="bookProgressRatio"
            :book-progress-step="bookTotalChars > 0 && realBookPageCount > 1 ? currentChapterChars / bookTotalChars / Math.max(1, realBookPageCount - 1) : 0"
            :columns="sheetColumns === 'double' ? 2 : 1"
            :pitch="realBookPitch"
            ref="realBookStageRef"
            :paragraphs="effectiveRealBookParagraphs"
            :paragraph-indexes="effectiveRealBookParagraphIndexes"
            :continuous="realBookContinuousActive"
            :window-chapters="effectiveRealBookWindowChapters"
            :current-chapter-id="currentChapter?.id ?? ''"
            :chapter-title="currentChapter?.title ?? ''"
            :highlights="realBookHighlightSpans"
            :search-query="showSearch ? searchQuery : ''"
            :font-size="realBookFontSize"
            :line-height="realBookLineHeight"
            :font-family="realBookFontFamilyStack"
            :paragraph-gap="spacingEmValues[paragraphSpacing]"
            :notes="realBookInlineNotes"
            :show-notes="showInlineNotes"
            :handwriting-font="handwritingFont"
            :start-anchor="realBookRestoreAnchor"
            :start-ratio="scrollRatioView"
            :restore-token="realBookRestoreToken"
            :reveal-note-id="inlineNoteRevealId"
            :reveal-note-token="inlineNoteRevealToken"
@update:anchor="onRealBookAnchorUpdate($event)"
            @update:page="onRealBookPage"
            @update:page-count="realBookPageCount = $event"
            @update:pitch="realBookPitch = $event"
            @update:zoom="realBookZoom = $event"
            @update:open="realBookOpen = $event"
            @update:show-notes="showInlineNotes = $event"
            @edit-note="openInlineNoteEditor"
            @select-range="onRealBookSelectRange"
            @select="onRealBookMouseup"
            @clear-selection="closeSelectionTools"
            @next-chapter="nextChapter"
            @prev-chapter="prevChapter"
            @back="emit('back')"
          />
        </div>
        <div v-if="dim > 0" class="reader-dim" :style="{ opacity: dim / 100 }" aria-hidden="true" />
        <div v-if="readingMode === 'screen' && bookView === 'classic'" class="reader-page-indicator">{{ visualPageLabel(visualPageIndexView, visualPageCountView) }}</div>
        </div>
      </div>

      <div
        class="reader-bottombar"
        :class="{ 'reader-tools-hidden': !toolsVisible, 'is-realbook': isRealBook }"
        :aria-hidden="isRealBook ? realBookBarCollapsed : !toolsVisible"
        :inert="isRealBook ? realBookBarCollapsed : !toolsVisible"
        @mouseenter="onToolbarEnter"
        @mouseleave="onToolbarLeave"
      >
        <template v-if="!isRealBook">
          <button class="bottom-button" type="button" aria-label="目录" title="目录" :class="{ active: activeBottomPanel === 'catalog' || showDrawer }" @click="toggleBottomPanel('catalog')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg><span class="bottom-button-text">目录</span></button>
          <button class="bottom-button" type="button" aria-label="进度" title="进度" :class="{ active: activeBottomPanel === 'progress' }" @click="toggleBottomPanel('progress')"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg><span class="bottom-button-text">进度</span></button>
          <button class="bottom-button" type="button" aria-label="背景" title="背景" :class="{ active: activeBottomPanel === 'background' }" @click="toggleBottomPanel('background')"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/></svg><span class="bottom-button-text">背景</span></button>
          <button class="bottom-button" type="button" aria-label="字体" title="字体" :class="{ active: activeBottomPanel === 'font' }" @click="toggleBottomPanel('font')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7V5h14v2M12 5v14M9 19h6"/></svg><span class="bottom-button-text">字体</span></button>
          <button class="bottom-button real-book-note-toggle" type="button" :aria-label="showInlineNotes ? '关闭批注模式' : '开启批注模式'" :title="showInlineNotes ? '关闭批注模式' : '开启批注模式'" :aria-pressed="showInlineNotes" :class="{ active: showInlineNotes }" @click="showInlineNotes = !showInlineNotes"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1.2-4.2L15.5 5.5l3 3L8.2 18.8 4 20z"/><path d="m13.5 7.5 3 3"/></svg><span class="bottom-button-text">批注</span></button>
        </template>
        <template v-else>
          <!-- 真实书籍底栏：按参考图排成一条图标带——书库 / 目录 / 翻页 /
               进度滑条 / 背景 / 缩放 / 全屏 / 批注。控件本身仍在 Reader，
               缩放与翻页由舞台暴露的方法执行。
               不交互时整条收进底边横条（见下方 .real-book-dock），书桌照完整露出。 -->
          <button class="rb-btn" type="button" aria-label="书库" title="书库" @click="emit('back')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5C10 5 6.8 4.6 4 5v13.5c2.8-.4 6 0 8 1.5 2-1.5 5.2-1.9 8-1.5V5c-2.8-.4-6 0-8 1.5z"/><path d="M12 6.5V20"/></svg></button>
          <button class="rb-btn bottom-button" type="button" aria-label="目录" title="目录" :class="{ active: showDrawer }" @click="toggleBottomPanel('catalog')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg></button>
          <span class="rb-sep" aria-hidden="true"></span>
          <button class="rb-btn" type="button" aria-label="上一页" title="上一页" @click="realBookStageRef?.prevPage()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button>
          <div
            ref="rbProgressRef"
            class="rb-progress"
            role="slider"
            tabindex="0"
            aria-label="阅读进度，拖动按章跳转"
            :aria-valuemin="0"
            :aria-valuemax="Math.max(0, chapters.length - 1)"
            :aria-valuenow="currentChapterIndex >= 0 ? currentChapterIndex : 0"
            :aria-valuetext="`${rbPercent}%`"
            @pointerdown="startRbScrub"
            @pointermove="moveRbScrub"
            @pointerup="endRbScrub"
            @pointercancel="endRbScrub"
            @lostpointercapture="rbScrub = null"
          >
            <div class="rb-progress-track" aria-hidden="true">
              <div class="rb-progress-fill" :style="{ width: `${rbPercent}%` }"></div>
              <div class="rb-progress-dot" :style="{ left: `${rbPercent}%` }"></div>
            </div>
            <span class="rb-progress-label">{{ rbPercent }}%</span>
          </div>
          <button class="rb-btn" type="button" aria-label="下一页" title="下一页" @click="realBookStageRef?.nextPage()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg></button>
          <button
            v-if="realBookRenderer === 'webgl'"
            class="rb-btn"
            type="button"
            :aria-label="realBookOpen ? '合上书籍' : '打开书籍'"
            :title="realBookOpen ? '合上书籍' : '打开书籍'"
            @click="realBookStageRef?.toggleOpen?.()"
          ><svg viewBox="0 0 24 24" aria-hidden="true"><template v-if="realBookOpen"><path d="M6 4h12v16H6z"/><path d="M6 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2M10 8h5"/></template><template v-else><path d="M4 5.5C6.5 4.4 9.5 4.4 12 6c2.5-1.6 5.5-1.6 8-.5V19c-2.5-1.1-5.5-1.1-8 .5-2.5-1.6-5.5-1.6-8-.5z"/><path d="M12 6v13.5"/></template></svg></button>
          <span class="rb-sep" aria-hidden="true"></span>
          <button class="rb-btn bottom-button" type="button" aria-label="背景" title="背景" :class="{ active: activeBottomPanel === 'background' }" @click="toggleBottomPanel('background')"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/></svg></button>
          <button class="rb-btn" type="button" aria-label="缩小" title="缩小" @click="realBookStageRef?.zoomOut()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button>
          <button class="rb-zoom" type="button" title="复原缩放" @click="realBookStageRef?.resetZoom()">{{ Math.round(realBookZoom * 100) }}%</button>
          <button class="rb-btn" type="button" aria-label="放大" title="放大" @click="realBookStageRef?.zoomIn()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg></button>
          <button class="rb-btn" type="button" aria-label="适应屏幕" title="适应屏幕（0）" @click="realBookStageRef?.fitBook?.()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg></button>
          <button class="rb-btn" type="button" :aria-label="isFullscreen ? '退出全屏' : '全屏'" :title="isFullscreen ? '退出全屏' : '全屏'" @click="toggleReaderFullscreen"><svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="!isFullscreen" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path v-else d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg></button>
          <button class="rb-btn rb-pen real-book-note-toggle" type="button" :aria-label="showInlineNotes ? '关闭批注模式' : '开启批注模式'" :title="showInlineNotes ? '关闭批注模式' : '开启批注模式'" :aria-pressed="showInlineNotes" :class="{ active: showInlineNotes }" @click="showInlineNotes = !showInlineNotes"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1.2-4.2L15.5 5.5l3 3L8.2 18.8 4 20z"/><path d="m13.5 7.5 3 3"/></svg></button>
          <button class="rb-btn bottom-button" type="button" aria-label="更多" title="更多" :class="{ active: activeBottomPanel === 'more' }" @click="toggleBottomPanel('more')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h.01M12 12h.01M18 12h.01"/></svg></button>
        </template>
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
              <div class="option-grid four theme-swatches"><button v-for="item in [{v:'paper',l:'纸白'},{v:'sepia',l:'暖黄'},{v:'gray',l:'柔灰'},{v:'night',l:'夜间'}]" :key="item.v" :class="[{ active: theme === item.v }, `swatch-${item.v}`]" @click="theme = item.v as ReaderTheme">{{ item.l }}</button></div>
              <div class="control-label">屏幕压暗 {{ dim > 0 ? `${dim}%` : '关' }}</div>
              <n-slider v-model:value="dim" :min="0" :max="70" :step="5" :format-tooltip="(v: number) => (v > 0 ? `压暗 ${v}%` : '不压暗')" />
              <div class="control-label">夜间想更暗时拉高；只压暗正文区，导航箭头与页码不受影响</div>
              <template v-if="isRealBook">
                <div class="control-label">书籍渲染</div>
                <div class="option-grid" role="group" aria-label="书籍渲染">
                  <button type="button" :class="{ active: realBookRenderer === 'webgl' }" :aria-pressed="realBookRenderer === 'webgl'" :disabled="!webglSupported" @click="realBookRenderer = 'webgl'">WebGL 3D</button>
                  <button type="button" :class="{ active: realBookRenderer === 'css' }" :aria-pressed="realBookRenderer === 'css'" @click="realBookRenderer = 'css'">CSS 3D 回退</button>
                </div>
                <div class="control-label">{{ webglSupported ? 'WebGL 提供连续纸面、书脊厚度和自由视角；CSS 3D 保留原实现。' : '当前环境不支持 WebGL，已使用 CSS 3D。' }}</div>
                <div class="control-label">整本连排</div>
                <div class="option-grid" role="group" aria-label="整本连排">
                  <button type="button" :class="{ active: realBookContinuous }" :aria-pressed="realBookContinuous" @click="setRealBookContinuous(true)">连排</button>
                  <button type="button" :class="{ active: realBookContinuous === false }" :aria-pressed="realBookContinuous === false" @click="setRealBookContinuous(false)">单章</button>
                </div>
                <div class="control-label">连排把已下载的相邻章拼成一本物理书，翻页跨章不停顿；单章则一章一本。仅 WebGL 3D 生效。</div>
                <div class="control-label">书籍字体</div>
                <div class="option-grid four" role="group" aria-label="书籍字体">
                  <button
                    v-for="item in [{ v: 'wenkai', l: '霞鹜文楷' }, { v: 'serif', l: '宋体' }, { v: 'system', l: '黑体' }, { v: 'mono', l: '等宽' }]"
                    :key="item.v"
                    type="button"
                    :class="{ active: bookFontFamily === item.v }"
                    :aria-pressed="bookFontFamily === item.v"
                    @click="bookFontFamily = item.v as ReaderFontFamily"
                  >{{ item.l }}</button>
                </div>
                <template v-if="realBookRenderer === 'webgl'">
                  <div class="control-label">书桌</div>
                  <div class="option-grid" role="group" aria-label="书桌材质">
                    <button v-for="item in realBookDeskOptions" :key="item.id" type="button" :class="{ active: realBookLook.desk === item.id }" :aria-pressed="realBookLook.desk === item.id" @click="realBookLook.desk = item.id"><i class="real-book-swatch" :style="{ background: item.swatch }"></i>{{ item.label }}</button>
                  </div>
                  <div class="control-label">衬纸</div>
                  <div class="option-grid" role="group" aria-label="衬纸颜色">
                    <button v-for="item in realBookEndpaperOptions" :key="item.id" type="button" :class="{ active: realBookLook.endpaper === item.id }" :aria-pressed="realBookLook.endpaper === item.id" @click="realBookLook.endpaper = item.id"><i class="real-book-swatch" :style="{ background: item.swatch }"></i>{{ item.label }}</button>
                  </div>
                  <div class="control-label">视角 {{ Math.round(realBookPitch) }}°</div>
                  <div class="option-grid" role="group" aria-label="书籍视角">
                    <button v-for="item in realBookPitchPresets" :key="item.value" type="button" :class="{ active: Math.abs(realBookPitch - item.value) < 0.5 }" :aria-pressed="Math.abs(realBookPitch - item.value) < 0.5" @click="realBookPitch = item.value">{{ item.label }}</button>
                  </div>
                  <div class="control-label">右键拖动书桌，或按住 Alt 拖动，可连续调整视角。</div>
                </template>
              </template>
            </template>
            <template v-else-if="activeBottomPanel === 'more'">
              <strong>更多</strong>
              <div class="control-label">{{ book.title }}</div>
              <div class="option-grid">
                <button type="button" @click="closeBottomPanel(); openSearch()">搜索</button>
                <button type="button" @click="closeBottomPanel(); showMarks = true">标记</button>
                <button type="button" @click="closeBottomPanel(); showMap = true">书中地图</button>
                <button type="button" @click="toggleToolPanel('tts')">朗读</button>
                <button type="button" @click="toggleToolPanel('ai')">AI</button>
                <button type="button" @click="toggleBottomPanel('font')">字体 / 排版</button>
                <button type="button" @click="realBookStageRef?.resetPitch?.()">平放</button>
                <button type="button" @click="toggleToolPanel('shortcuts')">快捷键</button>
                <button type="button" @click="toggleImmersiveLock(); closeBottomPanel()">沉浸模式</button>
                <button type="button" @click="emit('go-settings')">设置</button>
                <button type="button" @click="emit('go-browse')">浏览</button>
                <button type="button" @click="emit('back')">书架</button>
              </div>
            </template>
            <template v-else>
              <strong>字体</strong>
              <div class="control-label">阅读界面</div>
              <div class="option-grid" role="group" aria-label="阅读界面">
                <button
                  v-for="item in [{ v: 'classic', l: '经典模式' }, { v: 'sheet', l: '书页模式' }, { v: 'realbook', l: '真实书籍' }]"
                  :key="item.v"
                  type="button"
                  :class="{ active: bookView === item.v }"
                  :aria-pressed="bookView === item.v"
                  @click="bookView = item.v as ReaderBookView"
                >{{ item.l }}</button>
              </div>
              <template v-if="bookView === 'sheet'">
                <div class="control-label">排版</div>
                <div class="option-grid" role="group" aria-label="排版">
                  <button
                    v-for="item in [{ v: 'single', l: '单栏' }, { v: 'double', l: '双栏' }]"
                    :key="item.v"
                    type="button"
                    :class="{ active: sheetColumns === item.v }"
                    :aria-pressed="sheetColumns === item.v"
                    @click="sheetColumns = item.v as ReaderSheetColumns"
                  >{{ item.l }}</button>
                </div>
                <div class="control-label">双栏是同一张纸上左右两栏续排，翻页按整张纸走。</div>
              </template>
              <div class="control-label">批注手写体</div>
              <div class="option-grid" role="group" aria-label="批注手写体">
                <button
                  v-for="item in [{ v: 'none', l: '跟随正文字体' }, { v: 'kai', l: '楷体' }, { v: 'xingshu', l: '行书' }]"
                  :key="item.v"
                  type="button"
                  :class="{ active: handwritingFont === item.v }"
                  :aria-pressed="handwritingFont === item.v"
                  @click="handwritingFont = item.v as ReaderHandwritingFont"
                >{{ item.l }}</button>
              </div>
              <div class="control-label">此设置用于页内批注与标记抽屉中的批注预览。</div>
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
              <template v-if="bookView === 'classic'">
                <div class="control-label">阅读方式</div>
                <div class="option-grid">
                  <button v-for="item in [{v:'scroll',l:'连续滚动'},{v:'screen',l:'屏幕翻页'}]" :key="item.v" :class="{ active: readingMode === item.v }" @click="readingMode = item.v as ReaderReadingMode">{{ item.l }}</button>
                </div>
              </template>
              <div class="control-label" v-if="bookView === 'classic'">
                <n-button size="tiny" :type="autoScrolling ? 'warning' : 'default'" @click="toggleAutoScroll">{{ autoScrolling ? '暂停自动滚屏' : '开始自动滚屏' }}</n-button>
              </div>
              <template v-if="bookView === 'classic'">
                <div class="control-label">滚屏速度 {{ autoScrollSpeed }}</div>
                <n-slider v-model:value="autoScrollSpeed" :min="1" :max="5" :step="1" />
                <div class="control-label"><n-switch v-model:value="autoNextChapter" /> 滚到章末自动接下一章</div>
              </template>
              <div class="control-label"><n-switch v-model:value="hideSiteTail" /> 净化</div>
              <div class="control-label">
                <n-switch v-model:value="showRawThisChapter" :disabled="!hideSiteTail" /> 本章显示原文
              </div>
              <div class="control-label">只影响当前章，换章或重开书恢复净化</div>
              <div class="control-label"><n-switch v-model:value="alwaysShowTools" /> 工具一直显示</div>
              <n-button size="small" @click="restoreDefaultReaderPrefs">恢复默认</n-button>
            </template>
          </div>
      </div>

      <!-- 真实书籍底栏收起后的「底边横条」：iPhone 的 Home 指示条读法。
           它不是装饰——点它把整条图标带唤回来；键盘也能 Tab 到（工具栏收起时
           唯一的底栏入口，不能只留给鼠标）。 -->
      <button
        v-if="realBookBarCollapsed"
        class="real-book-dock"
        type="button"
        aria-label="显示工具栏"
        @click.stop="revealReaderToolsFromDock"
      >
        <span class="real-book-dock-bar" aria-hidden="true"></span>
      </button>

      <div
        ref="progressTrackRef"
        class="reader-progress-track"
        :class="{ scrubbing }"
        role="slider"
        tabindex="0"
        aria-roledescription="阅读进度，拖动按章跳转"
        :aria-label="bookProgressDetail"
        :aria-valuemin="0"
        :aria-valuemax="Math.max(0, chapters.length - 1)"
        :aria-valuenow="currentChapterIndex >= 0 ? currentChapterIndex : 0"
        :aria-valuetext="scrubbing ? scrubLabel : bookProgressDetail"
        :title="bookProgressDetail"
        @pointerdown="startProgressScrub"
        @pointermove="moveProgressScrub"
        @pointerup="endProgressScrub"
        @pointercancel="endProgressScrub"
        @lostpointercapture="cancelProgressScrub"
        @keydown="onProgressTrackKeydown"
      >
        <div class="reader-progress-row" aria-hidden="true">
          <div class="reader-progress-fill book" :style="{ width: `${bookPercent}%` }"></div>
          <div v-if="scrubbing" class="reader-progress-fill scrub-preview" :style="{ width: `${scrubPercent}%` }"></div>
        </div>
        <div class="reader-progress-row" aria-hidden="true">
          <div class="reader-progress-fill chapter" :style="{ width: `${chapterPercent}%` }"></div>
        </div>
        <div v-if="scrubbing && scrubLabel" class="reader-progress-scrub-hint" aria-live="polite">
          <span class="reader-progress-scrub-ordinal">{{ scrubOrdinal }}</span>
          <span v-if="scrubTitle" class="reader-progress-scrub-title">{{ scrubTitle }}</span>
        </div>
      </div>

      <!-- Chapter drawer -->
      <n-drawer
        v-model:show="showDrawer"
        placement="left"
        :width="drawerTab === 'mindmap' ? 560 : 320"
        :theme="realBookDrawerTheme"
        :theme-overrides="realBookDrawerThemeOverrides"
      >
        <n-config-provider abstract :theme="realBookDrawerTheme" :theme-overrides="realBookDrawerThemeOverrides">
        <n-drawer-content :class="{ 'reader-drawer-realbook': isRealBook }" :title="drawerTab === 'mindmap' ? '章节导图' : '目录'">
          <div class="drawer-tabs" role="tablist" aria-label="章节抽屉视图">
            <button
              type="button"
              role="tab"
              class="drawer-tab"
              data-drawer-tab="catalog"
              :aria-selected="drawerTab === 'catalog'"
              :class="{ active: drawerTab === 'catalog' }"
              @click="drawerTab = 'catalog'"
            >目录</button>
            <button
              type="button"
              role="tab"
              class="drawer-tab"
              data-drawer-tab="mindmap"
              :aria-selected="drawerTab === 'mindmap'"
              :class="{ active: drawerTab === 'mindmap' }"
              @click="drawerTab = 'mindmap'"
            >导图</button>
          </div>
          <template v-if="drawerTab === 'catalog'">
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
                  <n-tag v-else-if="catalogBadge(ch) === 'unlocked'" size="tiny" type="success">恢复</n-tag>
                  <n-tag v-else-if="catalogBadge(ch) === 'current'" size="tiny" type="info">当前</n-tag>
                  <n-tag v-else-if="catalogBadge(ch) === 'read'" size="tiny">已读</n-tag>
                </div>
              </n-list-item>
            </n-list>
          </template>
          <ReaderMindmap v-else :root="chapterMindmap" @select="jumpToTextAnchor" />
        </n-drawer-content>
        </n-config-provider>
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

      <ai-budget-confirm
        :show="showNotesBudgetConfirm"
        :budget="notesBudget"
        :message="notesBudgetMessage"
        @confirm="confirmNotesBudget"
        @cancel="cancelNotesBudget"
      />

      <ai-budget-confirm
        :show="showFollowBudgetConfirm"
        :budget="followBudget"
        :message="followBudgetMessage"
        @confirm="confirmFollowBudget"
        @cancel="cancelFollowBudget"
      />

      <!-- 侧栏宽度可拖：长回答与引用列表在 420 下要反复横向看，拖宽比缩放正文更省事。-->
      <n-drawer
        v-model:show="showAiAssistant"
        placement="right"
        resizable
        :default-width="aiDrawerWidth"
        :min-width="360"
        :max-width="720"
        @update:width="setAiDrawerWidth"
      >
        <n-drawer-content title="AI 助手" closable>
          <div v-if="legacyReadProposal" class="ai-budget-status">
            <strong>旧书已读范围待确认</strong>
            <div>旧版只记录到当前章节的进度。确认后，将它之前的章节与本章已到位置纳入 AI 已读范围；不确认时只使用新版实际记录的位置。</div>
            <n-button size="small" @click="confirmLegacyFrontier">确认旧进度为已读</n-button>
          </div>

          <!--
            运行信息默认收起：模型端点、当前任务、已读截止、取材边界这些是调试与核对用的，
            平时占据侧栏顶部只会淹没对话。保留原文案，只是移到折叠区里。
          -->
          <details class="ai-runtime-info">
            <summary>
              <span>{{ book?.title }}</span>
              <span v-if="!aiServiceOrigin" class="ai-heading-missing">未配置模型服务</span>
              <span v-else class="subtle">运行信息</span>
            </summary>
            <div class="ai-assistant-heading">
              <strong>{{ book?.title }}</strong>
              <span v-if="aiServiceOrigin">模型服务：{{ aiServiceOrigin }}</span>
              <span v-else class="ai-heading-missing">
                模型服务：未配置
                <n-button size="tiny" text type="primary" @click="emit('go-settings')">去设置</n-button>
              </span>
              <span>当前任务：{{ aiAssistantTaskLabel }}</span>
              <span>{{ book?.progress?.chapterId ? `已读截止：${book.chapters.find((chapter) => chapter.id === book?.progress?.chapterId)?.title || '未知章节'}` : '还没有阅读进度，先阅读一章再使用已读内容分析。' }}</span>
              <span>仅包含当前阅读进度以内的内容，不发送未读章节。</span>
            </div>
            <div v-if="currentAssistantBudget" class="ai-budget-status">
              <strong>本次发送范围</strong>
              <div>预计发送：{{ currentAssistantBudget.chapterCount }} 章 / {{ currentAssistantBudget.paragraphCount }} 段，约 {{ currentAssistantBudget.sentCharacters }} 字 / {{ currentAssistantBudget.estimatedTokens }} tokens（估算）</div>
              <div>{{ currentAssistantBudget.range }}</div>
            </div>
            <div v-if="assistantCompleted" class="ai-assistant-status">
              <template v-if="lastAssistantUsage && (lastAssistantUsage.inputTokens !== undefined || lastAssistantUsage.outputTokens !== undefined)">
                最近一次：输入 {{ lastAssistantUsage.inputTokens ?? 0 }} / 输出 {{ lastAssistantUsage.outputTokens ?? 0 }} tokens
                <span v-if="lastAssistantUsage.cacheHitTokens !== undefined"> · 缓存命中 {{ lastAssistantUsage.cacheHitTokens }} tokens</span>
              </template>
              <template v-else>服务未返回 token 用量。</template>
              <div class="subtle">实际费用以模型服务商的计费规则为准。</div>
            </div>
            <div v-if="bookUsage" class="subtle">本书累计 {{ bookUsage.calls }} 次模型调用，服务已报告输入 {{ bookUsage.inputTokens }} / 输出 {{ bookUsage.outputTokens }} tokens。</div>
            <div v-if="autoBudget" class="subtle">
              本书 {{ autoBudget.month }} 自动任务：已用约 {{ autoBudget.usedTokens }} / {{ autoBudget.limitTokens }} tokens，剩余约 {{ autoBudget.remainingTokens }} tokens；达到上限会暂停自动任务。
            </div>
          </details>

          <!-- 只在真需要告知时浮出来：生成中、被截断、保存失败。 -->
          <div v-if="assistantStageText" class="ai-assistant-status">{{ assistantStageText }}</div>
          <n-tag v-if="lastAssistantTruncated" type="warning">回答可能因输出上限而截断。</n-tag>
          <div v-if="assistantSaveState.token" class="ai-save-warning">
            结果已生成，但未能保存到书库。
            <n-button size="small" :loading="assistantSaveRetrying" :disabled="assistantSaveBusy" @click="retryAssistantSave">重试保存</n-button>
          </div>
          <n-tabs v-model:value="aiAssistantTab" type="line" animated>
            <n-tab-pane name="recap" tab="前情">
              <section v-if="resumeCardView?.available" class="ai-budget-status">
                <strong>断点续读卡</strong>
                <div class="subtle">上次会话附近最多 10 个读完的章节；只在你点击生成时调用模型。</div>
                <div v-if="resumeCardView.reason" class="subtle">{{ resumeCardView.reason }}</div>
                <template v-if="resumeCardView.card">
                  <div v-for="group in ([['关键变化', resumeCardView.card.changes], ['当前冲突', resumeCardView.card.conflicts], ['待解疑问', resumeCardView.card.questions]] as const)" :key="group[0]">
                    <strong>{{ group[0] }}</strong>
                    <div v-for="(item, index) in group[1]" :key="index" class="memory-item">
                      <p>{{ item.text }}</p>
                      <button v-for="source in item.sources" :key="source.id" class="memory-source" type="button" @click="jumpToMemorySource(source)">{{ source.chapterTitle }} · 第 {{ source.paragraphIndex + 1 }} 段：{{ source.excerpt }}</button>
                    </div>
                  </div>
                </template>
                <div v-if="resumeCardWarning">{{ resumeCardWarning }} <n-button size="tiny" @click="generateResumeCard(true)">确认生成</n-button></div>
                <n-button size="small" :loading="resumeCardLoading" @click="generateResumeCard(false)">{{ resumeCardView.card ? '重新生成续读卡' : '生成续读卡' }}</n-button>
              </section>
              <div v-if="chapterSummaryBudget" class="ai-budget-status">
                预计发送：{{ chapterSummaryBudget.chapterCount }} 章 / {{ chapterSummaryBudget.paragraphCount }} 段，约
                {{ chapterSummaryBudget.sentCharacters }} 字 / {{ chapterSummaryBudget.estimatedTokens }} tokens（估算）
              </div>
              <n-radio-group :value="recapLength" size="small" @update:value="setRecapLength">
                <n-radio-button value="short">简短 · 约 200 字</n-radio-button>
                <n-radio-button value="standard">标准 · 约 500 字</n-radio-button>
                <n-radio-button value="detailed">详细 · 约 1000 字</n-radio-button>
              </n-radio-group>
              <p class="subtle">前情只根据已生成的本章摘要和小说记忆整理，不重读正文。</p>
              <div v-if="materialCoverage" class="subtle">
                材料覆盖到{{ materialCoverage.uptoChapterTitle }}（{{ materialCoverage.summarizedChapters }}/{{ materialCoverage.readyChapters }} 章有摘要）<span v-if="materialCoverage.missing.length">，缺摘要 {{ materialCoverage.missing.length }} 章</span>。
              </div>
              <div class="ai-result">{{ recapText || '还没有前情提要。' }}</div>
              <n-space>
                <n-button :disabled="!book?.progress?.chapterId || assistantBusyByKind.recap || assistantSaveRetrying" type="primary" @click="startRecap('story')">刷新前情</n-button>
                <n-button :disabled="!chapterReady || assistantBusyByKind.recap || assistantSaveRetrying" @click="startRecap('chapter')">生成本章摘要</n-button>
              </n-space>
            </n-tab-pane>
            <n-tab-pane name="memory" tab="记忆">
              <n-space vertical>
                <!--
                  关系图默认收起：记忆页一进来先看到的是「更新记忆」和搜索框，
                  图放在这里只是第二个入口，不该让每次进记忆页都要滚过一张画。
                  只有真的有 relations 才渲染，空记忆不该占一个折叠标题。
                -->
                <details v-if="memoryData?.relations?.length" class="memory-graph-panel">
                  <summary class="memory-graph-panel-summary">人物关系图 · {{ memoryGraphCounts.people }} 人 / {{ memoryGraphCounts.edges }} 条关系</summary>
                  <!--
                    进度控制：默认停在当前章，图里只有读者已经读到的关系。
                    滑块上界就是当前章，读者也不能把自己往前拨（那就又是剧透）。
                    右侧小字是当前章标题，告诉读者这个上界到底是哪一章。
                  -->
                  <div class="memory-graph-progress">
                    <label class="memory-graph-progress-label" for="memory-graph-upto">只看读到第 {{ memoryGraphUpto }} 章为止</label>
                    <input
                      id="memory-graph-upto"
                      v-model.number="memoryGraphUpto"
                      class="memory-graph-range"
                      type="range"
                      :min="1"
                      :max="memoryGraphCurrentIndex"
                      aria-label="关系图显示到第几章"
                    />
                    <span class="memory-graph-progress-title" :title="currentChapter?.title">{{ currentChapter?.title }}</span>
                  </div>
                  <MemoryGraph
                    :memory="memoryData"
                    :chapters="book?.chapters"
                    :upto-chapter-index="memoryGraphUpto"
                    @jump="jumpToMemorySource"
                  />
                </details>
                <section class="ai-budget-status">
                  <strong>人物与伏笔时间线</strong>
                  <div class="subtle">按已读章节显示出现、变化与当前状态。未读完的章节不会写入时间线。</div>
                  <div v-if="timelineData?.message" class="subtle">{{ timelineData.message }}</div>
                  <div v-for="entry in timelineData?.entries || []" :key="entry.id" class="memory-item">
                    <strong>{{ entry.source.chapterTitle }} · {{ entry.name }} · {{ entry.phase }}</strong>
                    <n-tag v-if="entry.uncertain" size="small" type="warning">存疑</n-tag>
                    <n-tag v-if="entry.userEdited" size="small">读者已修正</n-tag>
                    <p>{{ entry.text }}</p>
                    <button class="memory-source" type="button" @click="jumpToMemorySource(entry.source)">{{ entry.source.excerpt }} · 查看原文</button>
                  </div>
                </section>
                <n-space>
                  <n-button type="primary" :disabled="!book?.progress?.chapterId || assistantBusyByKind.memory || assistantSaveRetrying" @click="startMemoryJob('update')">更新记忆</n-button>
                  <n-popconfirm
                    positive-text="继续重建"
                    negative-text="取消"
                    @positive-click="startMemoryJob('rebuild')"
                  >
                    全部重建会删除现有 AI 记忆，并重新分析第一章到当前已读章节。旧记忆会在新结果完整保存后替换。确定继续吗？
                    <template #trigger><n-button :disabled="!book?.progress?.chapterId || assistantBusyByKind.memory || assistantSaveRetrying">全部重建</n-button></template>
                  </n-popconfirm>
                  <n-button v-if="memoryJobId" type="warning" :disabled="memoryStopping" @click="stopMemoryJob">{{ memoryStopping ? '正在停止…' : '停止生成' }}</n-button>
                </n-space>
                <div v-if="memoryData?.uptoChapterId" class="subtle">
                  已更新到：{{ book?.chapters.find((chapter) => chapter.id === memoryData?.uptoChapterId)?.title || memoryData.uptoChapterId }}
                  <span v-if="materialCoverage">· 摘要覆盖到 {{ materialCoverage.uptoChapterTitle }}{{ materialCoverage.missing.length ? `，缺 ${materialCoverage.missing.length} 章` : '' }}</span>
                </div>
                <n-input
                  v-if="memoryData"
                  v-model:value="memoryQuery"
                  clearable
                  placeholder="搜索人物、别名、关系、伏笔或事件"
                  aria-label="搜索小说记忆"
                />
                <p v-if="memoryData && memoryQuery" class="subtle">找到 {{ visibleMemoryCount }} 条；搜索只读取本地记忆，不调用模型。</p>
                <n-empty
                  v-if="!memoryData || !(memoryData.characters.length + memoryData.relations.length + memoryData.foreshadows.length + memoryData.events.length)"
                  description="还没有人物与剧情记忆。"
                >
                  <template #extra>更新记忆后，可按人物、关系、伏笔和关键事件查看已读剧情。</template>
                </n-empty>
                <template v-else>
                  <section v-if="visibleMemoryCharacters.length" class="memory-section">
                    <h3>人物</h3>
                    <details v-for="item in visibleMemoryCharacters" :key="item.id" class="memory-item" :open="item.accuracy === 'normal'">
                      <summary><strong>{{ item.name }}</strong><span v-if="item.accuracy !== 'normal'" class="memory-accuracy-tag">{{ item.accuracy === 'review' ? '待复核' : '存疑' }}</span></summary>
                      <p>{{ item.role }} · {{ item.status }}</p><p v-if="item.aliases.length">别名：{{ item.aliases.join('、') }}<span v-if="item.userEditedAliases">（用户修正）</span></p><p>{{ item.summary }}<span v-if="item.userEditedSummary">（用户修正）</span></p>
                      <n-input :value="aliasDrafts[item.id] ?? item.aliases.join('、')" size="small" placeholder="纠正别名，用顿号分隔" @update:value="(value: string) => { aliasDrafts[item.id] = value }" />
                      <n-button size="tiny" :loading="correctingAliasId === item.id" :disabled="assistantBusyByKind.memory" @click="saveCharacterAliases(item)">保存别名</n-button>
                      <n-input v-model:value="summaryDrafts[item.id]" type="textarea" :rows="2" placeholder="修正这条记忆的说明" />
                      <n-button size="tiny" :loading="correctingSummaryId === item.id" :disabled="assistantBusyByKind.memory" @click="saveMemorySummary('character', item)">保存说明</n-button>
                      <n-button size="tiny" :disabled="assistantBusyByKind.memory" @click="rebuildMemoryFromSource(item)">从来源章重建</n-button>
                      <button v-for="source in item.sources" :key="source.id" class="memory-source" type="button" :disabled="memorySourceJumping" @click="jumpToMemorySource(source)">{{ source.chapterTitle }} · 第 {{ source.paragraphIndex + 1 }} 段：{{ source.excerpt }} · 查看原文</button>
                      <n-button v-if="item.accuracy === 'normal'" text type="warning" :disabled="assistantSaveRetrying" @click="markMemoryItem('character', item)">标记不准确</n-button>
                    </details>
                  </section>
                  <section v-if="visibleMemoryRelations.length" class="memory-section">
                    <h3>关系</h3>
                    <details v-for="item in visibleMemoryRelations" :key="item.id" class="memory-item" :open="item.accuracy === 'normal'">
                      <summary><strong>{{ item.from }} — {{ item.to }}：{{ item.relation }}</strong><span v-if="item.accuracy !== 'normal'" class="memory-accuracy-tag">{{ item.accuracy === 'review' ? '待复核' : '存疑' }}</span></summary>
                      <p>{{ item.status }} · {{ item.summary }}<span v-if="item.userEditedSummary">（用户修正）</span></p>
                      <n-input v-model:value="summaryDrafts[item.id]" type="textarea" :rows="2" placeholder="修正这条记忆的说明" />
                      <n-button size="tiny" :loading="correctingSummaryId === item.id" :disabled="assistantBusyByKind.memory" @click="saveMemorySummary('relation', item)">保存说明</n-button>
                      <n-button size="tiny" :disabled="assistantBusyByKind.memory" @click="rebuildMemoryFromSource(item)">从来源章重建</n-button>
                      <button v-for="source in item.sources" :key="source.id" class="memory-source" type="button" :disabled="memorySourceJumping" @click="jumpToMemorySource(source)">{{ source.chapterTitle }} · 第 {{ source.paragraphIndex + 1 }} 段：{{ source.excerpt }} · 查看原文</button>
                      <n-button v-if="item.accuracy === 'normal'" text type="warning" :disabled="assistantSaveRetrying" @click="markMemoryItem('relation', item)">标记不准确</n-button>
                    </details>
                  </section>
                  <section v-if="visibleMemoryForeshadows.length" class="memory-section">
                    <h3>伏笔</h3>
                    <details v-for="item in visibleMemoryForeshadows" :key="item.id" class="memory-item" :open="item.accuracy === 'normal'">
                      <summary><strong>{{ item.desc }}</strong><span v-if="item.accuracy !== 'normal'" class="memory-accuracy-tag">{{ item.accuracy === 'review' ? '待复核' : '存疑' }}</span></summary>
                      <p>{{ item.status }} · {{ item.summary }}<span v-if="item.userEditedSummary">（用户修正）</span></p>
                      <n-input v-model:value="summaryDrafts[item.id]" type="textarea" :rows="2" placeholder="修正这条记忆的说明" />
                      <n-button size="tiny" :loading="correctingSummaryId === item.id" :disabled="assistantBusyByKind.memory" @click="saveMemorySummary('foreshadow', item)">保存说明</n-button>
                      <n-button size="tiny" :disabled="assistantBusyByKind.memory" @click="rebuildMemoryFromSource(item)">从来源章重建</n-button>
                      <button v-for="source in item.sources" :key="source.id" class="memory-source" type="button" :disabled="memorySourceJumping" @click="jumpToMemorySource(source)">{{ source.chapterTitle }} · 第 {{ source.paragraphIndex + 1 }} 段：{{ source.excerpt }} · 查看原文</button>
                      <n-button v-if="item.accuracy === 'normal'" text type="warning" :disabled="assistantSaveRetrying" @click="markMemoryItem('foreshadow', item)">标记不准确</n-button>
                    </details>
                  </section>
                  <section v-if="visibleMemoryEvents.length" class="memory-section">
                    <h3>关键事件</h3>
                    <details v-for="item in visibleMemoryEvents" :key="item.id" class="memory-item" :open="item.accuracy === 'normal'">
                      <summary><strong>{{ item.title }}</strong><span v-if="item.accuracy !== 'normal'" class="memory-accuracy-tag">{{ item.accuracy === 'review' ? '待复核' : '存疑' }}</span></summary>
                      <p v-if="item.participants.length">参与者：{{ item.participants.join('、') }}</p><p>{{ item.result }} · {{ item.summary }}<span v-if="item.userEditedSummary">（用户修正）</span></p>
                      <n-input v-model:value="summaryDrafts[item.id]" type="textarea" :rows="2" placeholder="修正这条记忆的说明" />
                      <n-button size="tiny" :loading="correctingSummaryId === item.id" :disabled="assistantBusyByKind.memory" @click="saveMemorySummary('event', item)">保存说明</n-button>
                      <n-button size="tiny" :disabled="assistantBusyByKind.memory" @click="rebuildMemoryFromSource(item)">从来源章重建</n-button>
                      <button v-for="source in item.sources" :key="source.id" class="memory-source" type="button" :disabled="memorySourceJumping" @click="jumpToMemorySource(source)">{{ source.chapterTitle }} · 第 {{ source.paragraphIndex + 1 }} 段：{{ source.excerpt }} · 查看原文</button>
                      <n-button v-if="item.accuracy === 'normal'" text type="warning" :disabled="assistantSaveRetrying" @click="markMemoryItem('event', item)">标记不准确</n-button>
                    </details>
                  </section>
                  <n-empty v-if="memoryQuery && visibleMemoryCount === 0" description="本地记忆里没有匹配内容" />
                </template>
              </n-space>
            </n-tab-pane>
            <n-tab-pane name="qa" tab="问答">
              <div class="chat-messages">
                <!-- 欢迎态：Sider 的新会话不铺表单，先给问候与可点的问题卡片。 -->
                <div v-if="chatMessages.length === 0 && !chatLoading" class="sider-welcome">
                  <div class="sider-welcome-logo" aria-hidden="true">✦</div>
                  <h3>你好，想从哪里聊起？</h3>
                  <p>我已读到「{{ currentChapter?.title || '当前章' }}」。问剧情、问人物、问生僻字词都行，需要原文时我自己去翻已读章节。</p>
                  <span class="subtle">下面点一下只会填入输入框，确认发送后才调用模型。</span>
                  <div class="sider-welcome-grid">
                    <button
                      v-for="question in QUICK_READING_QUESTIONS"
                      :key="question"
                      type="button"
                      class="sider-welcome-card"
                      @click="prepareQuickQuestion(question)"
                    >{{ question }}</button>
                  </div>
                  <div class="sider-welcome-find">
                    <n-input v-model:value="sceneQuestion" size="small" placeholder="找回情节：那封信是谁交给他的？" @keyup.enter="searchScenes" />
                    <button class="chat-chip" type="button" :disabled="!sceneQuestion.trim() || sceneSearching" @click="searchScenes">找原文</button>
                  </div>
                  <div v-if="sceneMessage" class="subtle">{{ sceneMessage }}</div>
                  <button v-for="hit in sceneHits" :key="hit.id" class="memory-source" type="button" @click="jumpToMemorySource(hit)">{{ hit.chapterTitle }} · 第 {{ hit.paragraphIndex + 1 }} 段：{{ hit.excerpt }} · 查看原文</button>
                </div>
                <div v-if="chatLoading && agentToolActivity" class="chat-tool-activity">{{ agentToolActivity }}…</div>
                <div v-for="(msg, i) in chatMessages" :key="i" :class="['chat-msg', msg.role]">
                  <!-- 思考链在气泡上方：只有想知道「它去查了什么」时才展开，默认只露步数。 -->
                  <details
                    v-if="msg.steps?.length"
                    class="chat-steps"
                    :open="chatLoading && i === chatMessages.length - 1"
                  >
                    <summary>思考过程 · {{ msg.steps.length }} 步</summary>
                    <ol>
                      <li v-for="(step, si) in msg.steps" :key="si" :class="'is-' + step.state">{{ step.label }}</li>
                    </ol>
                  </details>
                  <!-- 有 claims 的回答按句渲染，句尾挂该句自己的角标；没有 claims 的旧回答保持整段原文。 -->
                  <div class="chat-bubble">
                    <template v-if="msg.claims?.length">
                      <p v-for="(line, li) in claimCitationLines(msg)" :key="li" class="chat-claim">{{ line.text }}<button v-for="badge in line.badges" :key="badge.label" class="chat-cite" type="button" :disabled="memorySourceJumping" :title="`跳到依据 ${badge.label} 的原文`" @click="jumpToMemorySource(badge.citation)">[{{ badge.label }}]</button></p>
                    </template>
                    <template v-else>{{ msg.content }}</template>
                  </div>
                  <template v-if="msg.role === 'assistant'">
                    <n-tag v-if="msg.stopped" size="small" type="warning">已停止，以下为停止前生成的部分回答。</n-tag>
                    <!-- 一行操作：复制只拿正文；重问/编辑/删除都以「一问一答」为单位，没有上一句提问时不露。 -->
                    <div class="chat-actions">
                      <button class="chat-chip" type="button" :disabled="chatActionsDisabled" @click="copyChatAnswer(i)">复制</button>
                      <template v-if="chatMessages[i - 1]?.role === 'user'">
                        <n-popconfirm positive-text="确定" negative-text="取消" @positive-click="reAskChatAnswer(i)">
                          会删掉这条回答并重新生成，历史里只留新的这一轮。
                          <template #trigger>
                            <button class="chat-chip" type="button" :disabled="chatActionsDisabled">重问</button>
                          </template>
                        </n-popconfirm>
                        <button class="chat-chip" type="button" :disabled="chatActionsDisabled" @click="editChatQuestion(i)">编辑</button>
                        <n-popconfirm positive-text="确定" negative-text="取消" @positive-click="deleteChatRound(i)">
                          删除这一轮问答，不会调用模型。
                          <template #trigger>
                            <button class="chat-chip" type="button" :disabled="chatActionsDisabled">删除</button>
                          </template>
                        </n-popconfirm>
                      </template>
                    </div>
                    <!-- 可信度徽标：结论到底核过没有，一行说清；旧记录没有这个字段就不显示，不默认说它被核过。 -->
                    <div v-if="msg.claims?.length && evidenceVerificationLabel(msg)" :class="['chat-verify', `is-${msg.verification}`]">{{ evidenceVerificationLabel(msg) }}</div>
                    <!-- 依据默认收起：角标回答按结论分组，旧回答保留「未逐条对应」的平铺列表。 -->
                    <details v-if="msg.claims?.length || msg.citations?.length" class="chat-evidence">
                      <summary>依据 · {{ (msg.citations ?? []).length }} 条</summary>
                      <template v-if="msg.claims?.length">
                        <section v-for="(claim, claimIndex) in msg.claims" :key="claimIndex">
                          <strong>结论 {{ claimIndex + 1 }}：{{ claim.text }}</strong>
                          <button v-for="citation in msg.citations?.filter((item) => claim.citationIds.includes(item.id)) || []" :key="citation.id" class="memory-source" type="button" :disabled="memorySourceJumping" @click="jumpToMemorySource(citation)">{{ citation.chapterTitle }} · 第 {{ citation.paragraphIndex + 1 }} 段：{{ citation.excerpt }} · 查看原文</button>
                        </section>
                        <!-- 这里只说「引文来自已读正文」，不说「已校验」：真正的核验结论在上面的徽标里。 -->
                        <small>引文取自已读正文，可点开原文核对。</small>
                      </template>
                      <template v-else>
                        <strong>依据（旧版回答，未逐条对应）</strong>
                        <button v-for="citation in msg.citations" :key="citation.id" class="memory-source" type="button" :disabled="memorySourceJumping" @click="jumpToMemorySource(citation)">{{ citation.chapterTitle }} · 第 {{ citation.paragraphIndex + 1 }} 段：{{ citation.excerpt }} · 查看原文</button>
                      </template>
                    </details>
                    <div v-else-if="msg.citations === undefined && !msg.content.startsWith('错误：')" class="chat-legacy">旧版回答，无来源</div>
                    <n-button
                      v-if="canSaveSelectionNote(msg, i)"
                      size="tiny"
                      :loading="selectionNoteSaving"
                      @click="saveAnswerAsSelectionNote(msg)"
                    >存为这段的批注</n-button>
                  </template>
                </div>
              </div>
              <div v-if="chatMessages.length > 0" class="chat-topbar">
                <span class="chat-topbar-count">{{ chatMessages.length }} 条消息 · 只读已读内容</span>
                <button class="chat-topbar-btn" type="button" :disabled="chatLoading || assistantSaveRetrying" @click="clearChat">清空聊天</button>
              </div>
              <div class="chat-input-row">
                <div class="sider-composer">
                  <n-input v-model:value="chatInput" type="textarea" :rows="2" :autosize="{ minRows: 2, maxRows: 6 }" placeholder="有问题，随时问。也可以追问、让我读原文核对…" :disabled="assistantBusyByKind.qa || assistantSaveRetrying" @keydown.stop @keyup.ctrl.enter="sendChat" />
                  <!-- 参考范围提示：只在读者开了开关时出现，不占常驻空间 -->
                  <div v-if="qaContextActive" class="subtle sider-composer-hint">发送时会附一行参考范围，模型据此决定先看什么。</div>
                  <div class="sider-composer-bar">
                    <div class="sider-composer-chips">
                      <button class="chat-chip" type="button" :class="{ 'chat-chip-on': chatMode === 'agent' }" title="模型自己决定查目录、读原文、检索、看记忆" @click="chatMode = 'agent'">对话</button>
                      <button class="chat-chip" type="button" :class="{ 'chat-chip-on': chatMode === 'evidence' }" title="单轮严格引用，每条结论绑定已读段落" @click="chatMode = 'evidence'">证据</button>
                      <!-- 参考范围：读者显式告诉模型先看什么；证据模式不拼接，所以这里也一并禁用 -->
                      <button class="chat-chip" type="button" :class="{ 'chat-chip-on': qaContextChips.chapter }" :disabled="chatMode === 'evidence'" :title="chatMode === 'evidence' ? '证据模式只回答检索到的已读段落' : '让模型先读本章原文'" @click="toggleQaContextChip('chapter')">本章</button>
                      <button class="chat-chip" type="button" :class="{ 'chat-chip-on': qaContextChips.memory }" :disabled="chatMode === 'evidence'" :title="chatMode === 'evidence' ? '证据模式只回答检索到的已读段落' : '参考已整理的人物、关系与伏笔'" @click="toggleQaContextChip('memory')">记忆</button>
                      <button class="chat-chip" type="button" :class="{ 'chat-chip-on': qaContextChips.notes }" :disabled="chatMode === 'evidence'" :title="chatMode === 'evidence' ? '证据模式只回答检索到的已读段落' : '参考我在已读章节里的划线批注'" @click="toggleQaContextChip('notes')">批注</button>
                      <n-popconfirm positive-text="确定" negative-text="取消" @positive-click="clearChat">
                        确定清空这本书的全部 AI 问答记录吗？此操作无法撤销。
                        <template #trigger>
                          <button class="chat-chip" type="button" :disabled="chatLoading || assistantSaveRetrying || chatMessages.length === 0">清空</button>
                        </template>
                      </n-popconfirm>
                    </div>
                    <div class="sider-composer-send">
                      <span class="sider-composer-task">{{ aiAssistantTaskLabel }}</span>
                      <n-button v-if="chatLoading" type="warning" size="small" @click="stopChat">停止生成</n-button>
                      <n-button v-else type="primary" size="small" :disabled="!chatInput.trim() || assistantBusyByKind.qa || assistantSaveRetrying" @click="sendChat">发送问题</n-button>
                    </div>
                  </div>
                </div>
              </div>
            </n-tab-pane>
            <n-tab-pane name="notes" tab="笔记">
              <n-space vertical>
                <p class="subtle">只发送本章正文和本章的划线批注来生成读书笔记，不发送未读章节。</p>
                <n-tag v-if="currentChapterNote?.stale" size="small" type="warning">正文已变，建议重新生成</n-tag>
                <n-tag v-if="chapterNoteStopped" size="small" type="warning">已停止，以下为停止前生成的部分笔记。</n-tag>
                <div class="ai-result">{{ chapterNoteView || '还没有本章笔记。' }}</div>
                <n-input
                  v-model:value="chapterNoteDraft"
                  type="textarea"
                  :rows="4"
                  placeholder="也可以自己写：这一章想记住什么就记什么。"
                  :disabled="chapterNoteLoading"
                  @keydown.stop
                />
                <n-space>
                  <n-button
                    type="primary"
                    :loading="chapterNoteStarting"
                    :disabled="!chapterReady || chapterNoteLoading || assistantSaveRetrying"
                    @click="startChapterNote()"
                  >{{ currentChapterNote ? '重新生成' : '生成本章笔记' }}</n-button>
                  <n-button v-if="chapterNoteJobId" type="warning" :disabled="chapterNoteStopping" @click="stopChapterNote">
                    {{ chapterNoteStopping ? '正在停止…' : '停止生成' }}
                  </n-button>
                  <n-button :loading="chapterNoteSaving" :disabled="chapterNoteLoading || assistantSaveRetrying" @click="saveChapterNoteEdit">保存笔记</n-button>
                </n-space>
                <div v-if="noteOverwritePrompt" class="ai-budget-status">
                  {{ noteOverwritePrompt }}
                  <n-space>
                    <n-button size="small" type="warning" :disabled="chapterNoteLoading" @click="startChapterNote(false, true)">覆盖重新生成</n-button>
                    <n-button size="small" @click="noteOverwritePrompt = ''">保留我的笔记</n-button>
                  </n-space>
                </div>
                <div v-if="otherChapterNotes.length" class="notes-archive">
                  <strong>已写笔记的章节</strong>
                  <details v-for="note in otherChapterNotes" :key="note.chapterId" class="notes-archive-item">
                    <summary>{{ book?.chapters.find((chapter) => chapter.id === note.chapterId)?.title || note.chapterId }}</summary>
                    <p>{{ note.text }}</p>
                    <n-button size="tiny" @click="openChapterFromNote(note.chapterId)">跳到这一章</n-button>
                  </details>
                </div>
                <div class="wordbook">
                  <strong>生词本</strong>
                  <p class="subtle">这里只汇总你自己的划线和已核实的记忆，不另外存一份。</p>
                  <details v-if="wordbookPeople.length" class="notes-archive-item">
                    <summary>人物 {{ wordbookPeople.length }} 个</summary>
                    <ul class="wordbook-list">
                      <li v-for="person in wordbookPeople" :key="person.id">
                        <strong>{{ person.name }}</strong>
                        <span v-if="person.aliases.length" class="subtle">{{ person.aliases.join('、') }}</span>
                        <p>{{ person.summary }}</p>
                      </li>
                    </ul>
                  </details>
                  <details v-if="wordbookTerms.length" class="notes-archive-item">
                    <summary>划线 {{ wordbookTerms.length }} 处{{ wordbookTrimmed ? '（只显示最近 60 处）' : '' }}</summary>
                    <ul class="wordbook-list">
                      <li v-for="term in wordbookTerms" :key="term.id">
                        <button type="button" class="wordbook-term" @click="jumpToAnnotation(term)">{{ term.excerpt }}</button>
                        <span class="subtle">{{ book?.chapters.find((chapter) => chapter.id === term.chapterId)?.title || term.chapterId }}</span>
                        <p v-if="term.note">{{ term.note }}<n-tag v-if="term.noteSource === 'ai'" size="tiny">AI 解释</n-tag></p>
                      </li>
                    </ul>
                  </details>
                  <p v-if="!wordbookPeople.length && !wordbookTerms.length" class="subtle">
                    在正文里划一段、或让它先记住几个人物，这里就会开始攒你自己的词表。
                  </p>
                </div>
              </n-space>
            </n-tab-pane>
            <n-tab-pane name="output" tab="输出">
              <n-space vertical>
                <div class="ai-budget-status">
                  <strong>{{ aiResultTitle || '输出' }}</strong>
                  <div v-if="aiResultTitle === '清正文' && lastCleanBudget">
                    预计发送：{{ lastCleanBudget.chapterCount }} 章 / {{ lastCleanBudget.paragraphCount }} 段，约 {{ lastCleanBudget.sentCharacters }} 字 / {{ lastCleanBudget.estimatedTokens }} tokens（估算）
                  </div>
                  <div v-else-if="!aiResult" class="subtle">清正文、翻译这类一次性结果会显示在这里。</div>
                </div>
                <div v-if="aiResult" class="ai-result">{{ aiResult }}</div>
                <n-space v-if="aiResultTitle === '清正文'">
                  <n-button type="primary" size="small" :disabled="!aiResult" @click="applyCleanedBody">应用到正文</n-button>
                  <n-button size="small" @click="showAiAssistant = false">关闭</n-button>
                </n-space>
                <n-button v-else-if="aiResultTitle === '翻译' && translateLoading" type="warning" @click="stopTranslate">停止</n-button>
              </n-space>
            </n-tab-pane>
          </n-tabs>

          <!-- 任务是主体，参数是背景：任务入口放在页签里，整理开关 / 配额这类设置挪到页签之后，
               否则从「聊书」进来第一屏全是配额和状态，提问要滚半屏才看得见。 -->
          <section class="ai-reading-desk" aria-label="AI 阅读工作台">
            <div class="ai-reading-desk__title">
              <strong>现在可以做什么</strong>
              <span>先选任务，再由你决定是否调用模型。</span>
            </div>
            <div class="ai-reading-desk__actions">
              <button type="button" @click="aiAssistantTab = 'recap'"><strong>接着读</strong><span>{{ recapText ? '查看已保存前情' : '整理读到这里的剧情' }}</span></button>
              <button type="button" @click="aiAssistantTab = 'memory'"><strong>找人物与伏笔</strong><span>{{ memoryData ? `${memoryData.characters.length + memoryData.relations.length + memoryData.foreshadows.length + memoryData.events.length} 条本地记忆` : '建立已读剧情记忆' }}</span></button>
              <button type="button" @click="aiAssistantTab = 'qa'"><strong>带依据地问</strong><span>回答可跳回已读原文</span></button>
              <button type="button" @click="aiAssistantTab = 'notes'"><strong>记住本章</strong><span>{{ currentChapterNote ? '已有笔记，可继续修改' : '生成或手写本章笔记' }}</span></button>
            </div>
          </section>
          <div class="ai-budget-status">
            <strong>读完一章后整理</strong>
            <n-radio-group :value="readingAiMode" size="small" @update:value="setReadingAiMode">
              <n-radio-button value="manual">手动</n-radio-button>
              <n-radio-button value="ask">提醒我</n-radio-button>
              <n-radio-button value="auto">自动</n-radio-button>
            </n-radio-group>
            <div class="subtle">读到章节末尾再换章时上报排队；本章不足一屏、翻页即到底的短章同样算读完。自动模式会调用模型并消耗你的 API 额度，关窗、切书后主进程接着跑。</div>
            <div v-if="follow" class="subtle">
              <span v-if="follow.queuedChapters">待整理 {{ follow.queuedChapters }} 章。</span>
              <span v-if="follow.organizedChapters">已整理 {{ follow.organizedChapters }} 章<span v-if="follow.uptoChapterTitle">，到「{{ follow.uptoChapterTitle }}」</span>。</span>
              <span v-if="follow.running">正在整理，跑完当前章节才让路。</span>
              <span v-else-if="follow.paused">已暂停：{{ follow.pauseReason || '达到单次章数上限' }}。</span>
              <span v-if="follow.failed">上次失败：{{ follow.failed.message }}。</span>
              <span>本轮累计 {{ follow.calls }} 次调用、约 {{ follow.estimatedTokens }} tokens（估算，不计算金额）。</span>
            </div>
            <div v-if="follow?.mode === 'auto' && !autoFollowEnabled" class="subtle">
              设置页的「读完一章自动整理」总开关是关的，所以不会自己跑；点「现在整理」可以手动跑一轮。
            </div>
            <n-space>
              <n-button size="small" :disabled="!follow?.queuedChapters" @click="runFollowNow">{{ follow?.paused ? '继续整理' : '现在整理' }}</n-button>
              <n-button v-if="follow && follow.mode !== 'manual'" size="small" @click="stopFollowAuto">停止自动</n-button>
            </n-space>
            <div v-if="bookUsage" class="subtle">本书累计 {{ bookUsage.calls }} 次模型调用，服务已报告输入 {{ bookUsage.inputTokens }} / 输出 {{ bookUsage.outputTokens }} tokens；未报告的用量不计入 token 总数。不计算金额。</div>
            <div v-if="currentAssistantBudget && currentAssistantBudget.sentCharacters > 20000" class="subtle">本次预计 {{ currentAssistantBudget.sentCharacters }} 字，接近 30000 字单次预算。</div>
          </div>
          <div v-if="autoBudget" class="subtle">
            本书 {{ autoBudget.month }} 自动任务：已用约 {{ autoBudget.usedTokens }} / {{ autoBudget.limitTokens }} tokens，剩余约 {{ autoBudget.remainingTokens }} tokens（已含排队预留 {{ autoBudget.reservedTokens }}）；达到上限会暂停自动任务，实际费用以服务商账单为准。
          </div>
          <template #footer>
            <n-button v-if="recapLoading && aiAssistantTab === 'recap'" type="warning" @click="stopRecap">停止生成</n-button>
          </template>
        </n-drawer-content>
      </n-drawer>

      <!-- 划词行内问答卡：
           - 「询问 AI」：结合本书已读内容提问，支持「在侧边栏中继续」；
           - 「解释字词」：单纯解释字词本身的读音与意思，不与书籍或文章内容挂钩。 -->
      <Transition name="popup-scale">
        <div
          v-if="inlineAsk.open.value"
          class="inline-ask"
          role="dialog"
          :aria-label="inlineAsk.mode.value === 'word' ? '解释字词' : '询问 AI'"
          :style="inlineAskStyle"
          @mousedown.stop
          @mouseup.stop
        >
          <div class="inline-ask-head">
            <strong class="inline-ask-title">{{ inlineAsk.mode.value === 'word' ? '解释字词' : '询问 AI' }}</strong>
            <span class="inline-ask-subject">{{ inlineAsk.subject.value }}</span>
            <button class="inline-ask-icon" type="button" title="关闭" aria-label="关闭询问" @click="inlineAsk.close()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
            </button>
          </div>

          <div class="inline-ask-input">
            <n-input
              v-model:value="inlineAsk.question.value"
              type="textarea"
              :rows="1"
              :autosize="{ minRows: 1, maxRows: 4 }"
              :placeholder="inlineAsk.mode.value === 'word' ? '继续追问该字词的读音、释义或用法（不关联书籍）…' : '结合本书已读内容，向 AI 询问上述内容…'"
              :disabled="inlineAsk.busy.value"
              @keydown.stop
              @keyup.ctrl.enter="inlineAsk.submit()"
            />
            <button
              class="inline-ask-send"
              type="button"
              title="发送（Ctrl+Enter）"
              aria-label="发送"
              :disabled="!inlineAsk.canSubmit.value"
              @click="inlineAsk.submit()"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 12 16-8-5.5 16-3-6.5-7.5-1.5Z" /></svg>
            </button>
          </div>

          <div v-if="inlineAsk.errorText.value" class="inline-ask-error">{{ inlineAsk.errorText.value }}</div>

          <div v-if="inlineAsk.answer.value || inlineAsk.busy.value" class="inline-ask-body">
            <div class="inline-ask-answer">{{ inlineAsk.answer.value }}<span v-if="inlineAsk.busy.value" class="inline-ask-caret">▍</span></div>
          </div>

          <div v-if="inlineAsk.status.value === 'ready' || inlineAsk.busy.value" class="inline-ask-foot">
            <button class="inline-ask-continue" type="button" :disabled="!inlineAsk.turns.value.length" @click="inlineAsk.continueInSidebar()">
              <span class="inline-ask-dot" aria-hidden="true">✦</span>在侧边栏中继续
            </button>
            <div class="inline-ask-tools">
              <button class="inline-ask-icon" type="button" title="复制回答" aria-label="复制回答" @click="copyInlineAnswer">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2.2" /><path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5" /></svg>
              </button>
              <button v-if="inlineAsk.busy.value" class="inline-ask-icon" type="button" title="停止生成" aria-label="停止生成" @click="stopInlineAsk">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" /></svg>
              </button>
              <button v-else class="inline-ask-icon" type="button" title="重新问一次" aria-label="重新问一次" @click="inlineAsk.submit()">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.6-5.9" /><path d="M4 4.5V10h5.5" /></svg>
              </button>
            </div>
          </div>
        </div>
      </Transition>

      <Transition name="popup-scale">
        <div
          v-if="showSelPopup"
          class="sel-bar sel-popup"
          role="toolbar"
          aria-label="划词操作"
          :style="{ left: selPopupX + 'px', top: selPopupY + 'px' }"
          @mousedown.prevent
        >
          <button
            v-for="action in pinnedBarActions"
            :key="action.id"
            class="sel-bar-btn"
            :class="{ 'sel-bar-btn-ai': SEL_AI_ACTIONS.has(action.id) }"
            type="button"
            :title="action.label"
            :aria-label="action.aria"
            :data-action="action.id"
            @click="runSelectionAction(action.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" class="sel-bar-glyph"><path :d="SEL_ACTION_ICON[action.id]" /></svg>
            <svg v-if="action.id === 'translate'" viewBox="0 0 24 24" aria-hidden="true" class="sel-bar-caret"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          <button
            class="sel-bar-btn"
            type="button"
            title="更多操作"
            aria-label="更多操作"
            :aria-expanded="showSelMenu"
            @click="showSelMenu = !showSelMenu"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" class="sel-bar-glyph">
              <circle cx="12" cy="6" r="1.6" fill="currentColor" stroke="none" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
              <circle cx="12" cy="18" r="1.6" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <span class="sel-bar-sep" />
          <button class="sel-bar-btn" type="button" title="关闭" aria-label="关闭" @click="closeSelectionTools()">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="sel-bar-glyph"><path d="M7 7l10 10M17 7 7 17" /></svg>
          </button>
        </div>
      </Transition>

      <!--「⋯」展开的完整菜单：每项右侧图钉可钉住/取消，底部一条模型选择行。-->
      <Transition name="popup-scale">
        <div
          v-if="showSelPopup && showSelMenu"
          class="sel-menu"
          role="menu"
          aria-label="划词更多操作"
          :style="selMenuStyle"
          @mousedown.prevent
        >
          <button
            v-for="(action, index) in SELECTION_ACTIONS"
            :key="action.id"
            class="sel-menu-item"
            :class="{ 'sel-menu-item-pinned': isPinned(action.id), 'sel-menu-item-first-ai': index === SEL_MENU_DIVIDER_AT }"
            type="button"
            role="menuitem"
            :data-action="action.id"
            @click="runSelectionAction(action.id)"
          >
            <svg class="sel-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path :d="SEL_ACTION_ICON[action.id]" /></svg>
            <span class="sel-menu-label">{{ action.label }}</span>
            <span
              class="sel-menu-pin"
              :class="{ 'sel-menu-pin-on': isPinned(action.id) }"
              role="button"
              tabindex="0"
              :title="isPinned(action.id) ? '取消钉住' : '钉住到工具栏'"
              :aria-label="isPinned(action.id) ? `从工具栏移除${action.label}` : `钉住${action.label}`"
              :aria-pressed="isPinned(action.id)"
              @click.stop="onTogglePin(action.id)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 5 3.5 3.5-4.5 1.5-3 3V21h-1v-5l-3-3L13 9 9 3Z" /></svg>
            </span>
          </button>

          <div class="sel-menu-footer">
            <div class="sel-model-picker" role="button" tabindex="0" :aria-expanded="showModelMenu" @click.stop="showModelMenu = !showModelMenu">
              <span class="sel-model-dot" aria-hidden="true">✦</span>
              <span class="sel-model-name">{{ aiModelLabel }}</span>
              <svg viewBox="0 0 24 24" aria-hidden="true" class="sel-model-caret"><path d="m6 9 6 6 6-6" /></svg>
            </div>
            <button class="sel-menu-gear" type="button" title="模型与提示词设置" aria-label="模型设置" @click.stop="emit('go-settings')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" /></svg>
            </button>
          </div>

          <div v-if="showModelMenu" class="sel-model-menu" role="menu" aria-label="选择模型">
            <button
              v-for="option in aiModelOptions"
              :key="option.value"
              class="sel-model-option"
              :class="{ 'sel-model-option-on': option.value === aiModelValue }"
              type="button"
              role="menuitem"
              @click.stop="applyAiModel(option.value)"
            >{{ option.label }}</button>
            <div class="sel-model-hint">模型与提示词在设置里改；这里只能切换到已配置好的那几个。</div>
          </div>
        </div>
      </Transition>


      <div v-if="showDirectNote" class="direct-note-editor" :style="{ left: selPopupX + 'px', top: selPopupY + 'px' }">
        <strong>添加批注</strong>
        <div class="direct-note-excerpt">{{ selectedExcerpt }}</div>
        <n-input v-model:value="directNoteDraft" type="textarea" :rows="3" placeholder="写下对这段文字的批注…" autofocus />
        <n-space justify="end">
          <n-button size="small" @click="closeSelectionTools()">取消</n-button>
          <n-button size="small" type="primary" :disabled="!directNoteDraft.trim()" @click="saveDirectNote">保存批注</n-button>
        </n-space>
      </div>

      <!-- 页内批注编辑浮层：固定定位在 3D 舞台外，避免输入框随书页透视变形。 -->
      <div
        v-if="inlineNoteEditor"
        class="inline-note-editor"
        :style="{ left: inlineNoteEditor.left + 'px', top: inlineNoteEditor.top + 'px' }"
        role="dialog"
        aria-label="编辑批注"
        @click.stop
        @mouseup.stop
        @keydown.stop
      >
        <strong>批注</strong>
        <div class="direct-note-excerpt">{{ inlineNoteExcerpt }}</div>
        <n-input
          v-model:value="inlineNoteDraft"
          type="textarea"
          :rows="4"
          placeholder="写下对这段文字的批注…"
          autofocus
          @keydown.ctrl.enter.prevent="saveInlineNote"
          @keydown.meta.enter.prevent="saveInlineNote"
        />
        <n-input v-model:value="inlineNoteTagsDraft" size="small" placeholder="标签，用空格分隔（如 quote）" />
        <p v-if="inlineNoteError" class="inline-note-error">{{ inlineNoteError }}</p>
        <n-space justify="end">
          <n-button size="small" :type="inlineNoteDeleteArmed ? 'error' : 'default'" :disabled="inlineNoteSaving" @click="deleteInlineNote">
            {{ inlineNoteDeleteArmed ? '确认删除' : '删除' }}
          </n-button>
          <n-button size="small" :disabled="inlineNoteSaving" @click="closeInlineNoteEditor">取消</n-button>
          <n-button size="small" type="primary" :disabled="!inlineNoteDraft.trim() || inlineNoteSaving" :loading="inlineNoteSaving" @click="saveInlineNote">保存</n-button>
        </n-space>
      </div>

      <!-- Marks drawer -->
      <n-drawer
        v-model:show="showMarks"
        placement="left"
        :width="340"
        :theme="realBookDrawerTheme"
        :theme-overrides="realBookDrawerThemeOverrides"
      >
        <n-config-provider abstract :theme="realBookDrawerTheme" :theme-overrides="realBookDrawerThemeOverrides">
        <n-drawer-content :class="{ 'reader-drawer-realbook': isRealBook }" title="标记" closable>
          <n-button block secondary style="margin-bottom:12px" @click="showMap = true">书中地图</n-button>
          <n-popconfirm v-if="chapterBookmark" positive-text="删除" negative-text="取消" @positive-click="toggleBookmark">
            删除这条书签？删除后无法恢复。
            <template #trigger><n-button block type="warning" style="margin-bottom:12px">移除本章书签</n-button></template>
          </n-popconfirm>
          <n-button v-else block type="primary" :disabled="!currentChapter" style="margin-bottom:12px" @click="toggleBookmark">给本章加书签</n-button>
          <div v-if="!sortedMarks.length" class="control-label" style="text-align:center;padding:24px 0">
            还没有标记。选中正文可添加划线或批注。
          </div>
          <div v-else class="mark-list">
            <section v-for="group in markGroups" :key="group.key" class="mark-group">
              <div v-if="markGroups.length > 1 || group.tag" class="mark-group-title">
                {{ group.tag ? '#' + group.tag : '未分类' }}
                <span class="mark-group-count">{{ group.items.length }}</span>
              </div>
              <div v-for="a in group.items" :key="a.id" class="mark-row">
                <div class="mark-main" @click="jumpToAnnotation(a)">
                  <span class="mark-icon">{{ a.kind === 'bookmark' ? '🔖' : '🖍' }}</span>
                  <span class="mark-chapter">{{ chapters.find((c) => c.id === a.chapterId)?.title || a.chapterId }}</span>
                  <span v-if="lostHighlightIds.has(a.id)" class="mark-lost">（原文已变化）</span>
                </div>
                <div v-if="a.kind === 'highlight' && a.excerpt && !lostHighlightIds.has(a.id)" class="mark-excerpt" @click="jumpToAnnotation(a)">
                  {{ a.excerpt }}
                </div>
                <div v-if="a.note && editingNoteId !== a.id" :class="['mark-note', handwritingNoteClass]" @click="jumpToAnnotation(a)">
                  <span v-if="a.noteSource === 'ai'" class="mark-note-source">AI</span>批注：{{ a.note }}
                </div>
                <div v-if="a.kind === 'highlight'" class="mark-colors" role="group" :aria-label="`划线颜色：${a.excerpt || '本段'}`">
                  <button
                    v-for="option in markColors"
                    :key="option.value"
                    type="button"
                    class="mark-color-option"
                    :class="[{ active: (a.color ?? 'yellow') === option.value }, 'swatch-' + option.value]"
                    :data-color="option.value"
                    :title="option.label"
                    :aria-label="`划线颜色：${option.label}`"
                    :aria-pressed="(a.color ?? 'yellow') === option.value"
                    @click.stop="setColor(a, option.value)"
                  ></button>
                </div>
                <div class="mark-actions">
                  <n-button size="tiny" quaternary @click.stop="editingNoteId = a.id; noteDraft = a.note ?? ''">批注</n-button>
                  <n-popconfirm positive-text="删除" negative-text="取消" @positive-click="deleteAnnotation(a)">
                    {{ deleteConfirmText(a) }}
                    <template #trigger><n-button size="tiny" quaternary type="error" @click.stop>删除</n-button></template>
                  </n-popconfirm>
                </div>
                <div v-if="editingNoteId === a.id" class="mark-note-edit">
                  <n-input v-model:value="noteDraft" type="textarea" :rows="2" placeholder="写点批注…" />
                  <n-space justify="end" style="margin-top:4px">
                    <n-button size="tiny" @click="editingNoteId = ''">取消</n-button>
                    <n-button size="tiny" type="primary" @click="saveNote(a)">保存</n-button>
                  </n-space>
                </div>
              </div>
            </section>
          </div>
        </n-drawer-content>
        </n-config-provider>
      </n-drawer>

      <!-- 阅读器左下角的地图胶囊：有已识别图片地图或已定位文字地点时出现 -->
      <AtlasDock
        v-if="book?.id && !showMap"
        :key="book.id"
        :book-id="book.id"
        @open-map-page="showMap = true"
      />

      <!-- Book map drawer -->
      <n-drawer v-model:show="showMap" placement="right" :width="760">
        <n-drawer-content title="书中地图" closable>
          <BookMapPage
            v-if="showMap"
            :book-id="book?.id ?? ''"
            :book-title="book?.title ?? ''"
            @go-settings="showMap = false; emit('go-settings')"
            @select-place="jumpToTextAnchor"
          />
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
  /* 划线颜色：黄色沿用既有 --hl-bg，其余四色用半透明墨色，四套主题下都不会遮住正文。 */
  --hl-yellow-bg: var(--hl-bg);
  --hl-green-bg: color-mix(in srgb, #34a853 34%, transparent);
  --hl-blue-bg: color-mix(in srgb, #2f7fd0 32%, transparent);
  --hl-red-bg: color-mix(in srgb, #d64545 30%, transparent);
  --hl-purple-bg: color-mix(in srgb, #8b5cf6 32%, transparent);
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

.reader-content::-webkit-scrollbar { width: 0; height: 0; }

.ch-title {
  /* 书页版式的章名：小一号、靠左、弱色，不抢正文 */
  font-size: 0.82em;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--reader-paper-text) 52%, transparent);
  margin-bottom: 1.4em;
  text-align: left;
}

/* 真实书籍的书台容器：占满正文区，页面的排版与边距都由书台自己管。 */
.real-book-host {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 书页样式下不再用装饰花符：章名只是一行弱色眉题。 */
.ch-title::after { content: none; }

.para {
  text-indent: 2em;
  margin: 0 0 0.5em;
}

.para-speaking {
  background: var(--speaking-bg);
  border-radius: 4px;
}

.para-unfocused { opacity: 0.4; }

/* 从引用角标跳回原文时闪一下目标段落：只动背景色，不碰高度/内边距/边框，
   否则正文会在闪烁的那 1.2 秒里跳动；不透明度收到透明就结束，不残留底色。 */
.para-flash {
  animation: para-flash 1.2s ease-out both;
  border-radius: 4px;
}
@keyframes para-flash {
  0% { background-color: color-mix(in srgb, var(--hit-bg) 55%, transparent); }
  70% { background-color: color-mix(in srgb, var(--hit-bg) 22%, transparent); }
  100% { background-color: transparent; }
}

:deep(mark.search-hit) {
  background: var(--hit-bg);
  color: var(--hit-text);
  border-radius: 3px;
  padding: 0 1px;
}

:deep(mark.hl-mark) {
  background: var(--hl-yellow-bg);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}

:deep(mark.hl-mark.hl-green) { background: var(--hl-green-bg); }
:deep(mark.hl-mark.hl-blue) { background: var(--hl-blue-bg); }
:deep(mark.hl-mark.hl-red) { background: var(--hl-red-bg); }
:deep(mark.hl-mark.hl-purple) { background: var(--hl-purple-bg); }

/*
 * 划词工具条：按 Sider 扩展注入的真实 DOM 规格复刻。
 * 实测取自 sider.ai 页面内 `[aria-label="询问AI"]` 所在的工具条：
 *   外层：absolute rounded-xl（圆角 12px），实测 191×30，text-sm
 *   内层：flex-center gap-1 p-[2px] overflow-hidden rounded-lg shadow-black-middle
 *         → gap 4px、padding 2px、圆角 8px
 *   按钮：p-0 rounded-lg，26×26；图标 viewBox 0 0 14 14，渲染 14×14px
 * 因此图标比截图目测的小，这是 Sider 的真实尺寸，不再按图片估。
 */
.sel-bar {
  position: fixed;
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  background: var(--popover-bg);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(13, 15, 12, 0.12), 0 1px 2px rgba(13, 15, 12, 0.08);
}

.sel-bar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #2f3330;
  cursor: pointer;
}

.sel-bar-btn:hover { background: rgba(13, 15, 12, 0.06); }

.sel-bar-glyph {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 翻译项的下拉箭头：与 Sider 一样贴着图标右侧，比主图标小一号。 */
.sel-bar-caret {
  width: 8px;
  height: 8px;
  margin-left: -1px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.7;
}

/* AI 项用品牌色，与其余单色图标区分开。 */
.sel-bar-btn-ai { color: #7c5cff; }

.sel-bar-sep {
  width: 1px;
  height: 14px;
  margin: 0 1px;
  background: rgba(13, 15, 12, 0.1);
}

/* 点「⋯」后展开的竖向菜单：分组列表 + 底部说明。 */
.sel-menu {
  position: fixed;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  width: 268px;
  background: var(--popover-bg);
  border: 1px solid rgba(13, 15, 12, 0.08);
  border-radius: 14px;
  padding: 6px;
  box-shadow: 0 8px 28px rgba(13, 15, 12, 0.14), 0 2px 6px rgba(13, 15, 12, 0.06);
}

.sel-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--r-text);
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
}

.sel-menu-item:hover { background: var(--popover-hover, rgba(127, 127, 127, 0.12)); }
.sel-menu-item:disabled { opacity: 0.45; cursor: default; }
/* 文稿类与 AI 类之间用上边框分段，不额外插一条元素。 */
.sel-menu-item-first-ai { margin-top: 5px; border-top: 1px solid rgba(13, 15, 12, 0.08); border-radius: 0 0 9px 9px; padding-top: 10px; }
.sel-menu-item-pinned .sel-menu-label { font-weight: 500; }
.sel-menu-icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; opacity: 0.72; }
.sel-menu-icon-fill { fill: #7c5cff; stroke: none; opacity: 1; }
.sel-menu-label { flex: 1; }
.sel-menu-hint { color: var(--r-text-dim, rgba(127, 127, 127, 0.9)); font-size: 12px; }
/* 图钉：未钉住灰色描边，钉住填品牌紫，一眼能分辨。 */
.sel-menu-pin {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: none;
  margin-left: 4px;
  border-radius: 6px;
  color: rgba(13, 15, 12, 0.35);
  cursor: pointer;
}
.sel-menu-pin:hover { background: rgba(13, 15, 12, 0.06); color: rgba(13, 15, 12, 0.6); }
.sel-menu-pin svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.sel-menu-pin-on { color: #7c5cff; }
.sel-menu-pin-on svg { fill: currentColor; stroke: none; }
.sel-menu-divider { height: 1px; margin: 4px 6px; background: var(--r-line); }

/* 底部模型行：左侧模型选择器（可展开），右侧设置入口。 */
.sel-menu-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid rgba(13, 15, 12, 0.08);
}

.sel-model-picker {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 5px 10px;
  border-radius: 999px;
  background: var(--surface-3, rgba(127, 127, 127, 0.1));
  color: var(--r-text);
  font-size: 12.5px;
  cursor: pointer;
}
.sel-model-picker:hover { background: var(--surface-2, rgba(127, 127, 127, 0.14)); }
.sel-model-dot { color: #7c5cff; font-size: 13px; line-height: 1; }
.sel-model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 130px; }
.sel-model-caret { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; opacity: 0.6; }

.sel-menu-gear {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: none;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--r-muted);
  cursor: pointer;
}
.sel-menu-gear:hover { background: rgba(13, 15, 12, 0.06); color: var(--r-text); }
.sel-menu-gear svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

/* 模型下拉：向上展开，避免被屏幕底边裁掉。 */
.sel-model-menu {
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 44px;
  padding: 5px;
  border: 1px solid rgba(13, 15, 12, 0.08);
  border-radius: 10px;
  background: var(--popover-bg);
  box-shadow: 0 8px 24px rgba(13, 15, 12, 0.16);
}
.sel-model-option {
  display: block;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--r-text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.sel-model-option:hover { background: rgba(13, 15, 12, 0.06); }
.sel-model-option-on { color: #7c5cff; font-weight: 600; }
.sel-model-hint { padding: 6px 9px 2px; color: var(--r-muted); font-size: 11px; line-height: 1.5; }
.sel-menu-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  padding: 6px 8px;
  border-top: 1px solid var(--r-line);
  color: var(--r-text-dim, rgba(127, 127, 127, 0.9));
  font-size: 12px;
}

/* 运行信息：默认折叠的一行，展开才是模型端点/已读截止/用量这类核对信息。 */
.ai-runtime-info {
  margin-bottom: 8px;
  border: 1px solid var(--r-line);
  border-radius: 8px;
  background: var(--surface-3, rgba(127, 127, 127, 0.06));
}

.ai-runtime-info > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  color: var(--r-muted);
  font-size: 12px;
  cursor: pointer;
  list-style: none;
}

.ai-runtime-info > summary::-webkit-details-marker { display: none; }
.ai-runtime-info > summary::after { content: '⌄'; margin-left: auto; opacity: 0.6; }
.ai-runtime-info[open] > summary::after { content: '⌃'; }
.ai-runtime-info > summary > span:first-child { color: var(--r-text); font-weight: 500; }
.ai-runtime-info .ai-assistant-heading { padding: 0 10px 8px; }
.ai-runtime-info .ai-budget-status,
.ai-runtime-info .ai-assistant-status,
.ai-runtime-info .subtle { margin: 0 10px 8px; }

/* 划词行内问答卡：挂在选区下方的小窗，比侧栏轻，一问一答不占屏幕。 */
.inline-ask {
  position: fixed;
  z-index: 1002;
  display: flex;
  flex-direction: column;
  max-height: min(60vh, 520px);
  border: 1px solid rgba(13, 15, 12, 0.1);
  border-radius: 14px;
  background: var(--popover-bg);
  box-shadow: 0 12px 32px rgba(13, 15, 12, 0.18), 0 2px 8px rgba(13, 15, 12, 0.08);
  overflow: hidden;
}

.inline-ask-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 6px;
}

.inline-ask-title { font-size: 13px; font-weight: 600; }
.inline-ask-subject {
  flex: 1;
  min-width: 0;
  color: var(--r-muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inline-ask-icon {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: none;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--r-muted);
  cursor: pointer;
}
.inline-ask-icon:hover { background: rgba(13, 15, 12, 0.06); color: var(--r-text); }
.inline-ask-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

.inline-ask-input {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  margin: 0 8px;
  padding: 4px 4px 4px 8px;
  border: 1px solid var(--r-line);
  border-radius: 10px;
  background: var(--card);
}
.inline-ask-input :deep(.n-input),
.inline-ask-input :deep(.n-input .n-input__border),
.inline-ask-input :deep(.n-input .n-input__state-border) { border: 0 !important; box-shadow: none !important; background: transparent !important; }

.inline-ask-send {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: none;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #7c5cff;
  cursor: pointer;
}
.inline-ask-send:hover:not(:disabled) { background: rgba(124, 92, 255, 0.1); }
.inline-ask-send:disabled { opacity: 0.4; cursor: default; }
.inline-ask-send svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }

.inline-ask-error { margin: 6px 10px 0; color: var(--danger); font-size: 12px; }

.inline-ask-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 8px 10px 0;
}
.inline-ask-answer { color: var(--r-text); font-size: 13px; line-height: 1.65; white-space: pre-wrap; }
.inline-ask-caret { color: #7c5cff; }

.inline-ask-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 10px 8px;
  border-top: 1px solid rgba(13, 15, 12, 0.06);
}

/* 「在侧边栏中继续」：品牌色胶囊，与 Sider 那个入口同位置同分量。 */
.inline-ask-continue {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 0;
  border-radius: 999px;
  background: rgba(124, 92, 255, 0.12);
  color: #6b4ce8;
  font-size: 12.5px;
  cursor: pointer;
}
.inline-ask-continue:hover:not(:disabled) { background: rgba(124, 92, 255, 0.18); }
.inline-ask-continue:disabled { opacity: 0.5; cursor: default; }
.inline-ask-dot { font-size: 12px; }
.inline-ask-tools { display: flex; align-items: center; gap: 2px; }

.chat-tool-activity {
  align-self: flex-start;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.12);
  color: var(--r-text-dim, rgba(127, 127, 127, 0.9));
  font-size: 12px;
}

.popup-scale-enter-active,
.popup-scale-leave-active {
  transition: opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1),
              transform 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}

.popup-scale-enter-from,
.popup-scale-leave-to {
  opacity: 0;
  transform: scale(0.95);
}

.popup-scale-enter-to,
.popup-scale-leave-from {
  opacity: 1;
  transform: scale(1);
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

.inline-note-editor {
  position: fixed;
  z-index: 1002;
  width: min(360px, calc(100vw - 24px));
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--r-line);
  border-radius: var(--radius-overlay);
  background: var(--popover-bg);
  box-shadow: var(--shadow-overlay);
}

.inline-note-error {
  margin: 0;
  color: var(--error-color);
  font-size: 12px;
  line-height: 1.5;
}

.mark-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* #tag 聚类视图：分组之间靠间距分隔，标题只用小号弱色文字，不与标记正文争层级。 */
.mark-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mark-group + .mark-group {
  margin-top: 14px;
}

.mark-group-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  color: var(--r-muted);
}

.mark-group-count {
  font-size: 11px;
  padding: 0 5px;
  border: 1px solid var(--r-line);
  border-radius: 999px;
}

.mark-row {
  border: 1px solid var(--r-line);
  border-radius: var(--radius-control);
  padding: 8px 10px;
}

/* 颜色选择器只出现在划线上（书签不渲染底色）；色块本身就是图例，不再另加标签文字。 */
.mark-colors {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.mark-color-option {
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--r-line);
  border-radius: 50%;
  cursor: pointer;
}

.mark-color-option.swatch-yellow { background: var(--hl-yellow-bg); }
.mark-color-option.swatch-green { background: var(--hl-green-bg); }
.mark-color-option.swatch-blue { background: var(--hl-blue-bg); }
.mark-color-option.swatch-red { background: var(--hl-red-bg); }
.mark-color-option.swatch-purple { background: var(--hl-purple-bg); }

.mark-color-option.active {
  border-color: transparent;
  box-shadow: 0 0 0 2px var(--r-focus);
}

.mark-color-option:focus-visible {
  outline: 2px solid var(--r-focus);
  outline-offset: 2px;
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

/* 手写字体用于批注预览；系统缺字体时自然回退到浏览器默认字体。 */
.mark-note.handwriting-kai { font-family: 'KaiTi', '楷体', serif; }
.mark-note.handwriting-xingshu { font-family: 'STXingkai', '华文行楷', 'KaiTi', serif; }

.mark-note-source {
  display: inline-block;
  margin-right: 4px;
  padding: 0 4px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 10px;
  line-height: 14px;
  opacity: 0.7;
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

.drawer-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  padding: 3px;
  border-radius: 8px;
  background: var(--panel-soft, rgba(127, 127, 127, 0.1));
}

.drawer-tab {
  flex: 1;
  border: 0;
  border-radius: 6px;
  padding: 5px 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

/* 选中页签不再刷成实心白药丸：浅色主题下 --r-bar-bg 是白色，可抽屉在深色皮肤 / 真实书籍里是暗底，
   奶油白字落在白底上对比度只有 1.1:1（实测）。改用当前字色的半透明底色，浅底深字、暗底浅字都成立。 */
.drawer-tab.active {
  background: color-mix(in srgb, currentColor 14%, transparent);
  font-weight: 600;
}

.drawer-tab:focus-visible {
  outline: 2px solid var(--r-focus, #2f7fd0);
  outline-offset: 2px;
}

/* 真实书籍的暗色目录 / 标记抽屉：两个手写控件原来吃的是应用浅色变量
   （.drawer-tab.active 刷 --r-bar-bg、次级文字用 --r-muted），暗底上会变成
   白药丸配浅字、或深灰字看不清。这里显式换回奶油白低亮度。 */
.reader-drawer-realbook .drawer-tabs { background: rgba(244, 235, 211, 0.08); }
.reader-drawer-realbook .drawer-tab.active { background: rgba(244, 235, 211, 0.16); color: #f2d887; }
.reader-drawer-realbook .ch-item.active { color: #f2d887; }
.reader-drawer-realbook .mark-excerpt,
.reader-drawer-realbook .mark-group-title,
.reader-drawer-realbook .control-label { color: rgba(244, 235, 211, 0.58); }

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

.ai-reading-desk {
  margin-bottom: 12px;
  padding: 12px;
  border: 1px solid var(--r-line);
  border-radius: 10px;
  background: var(--r-panel-bg);
}

.ai-reading-desk__title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.ai-reading-desk__title span {
  color: var(--r-muted);
  font-size: 12px;
}

.ai-reading-desk__actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.ai-reading-desk__actions button {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 10px;
  border: 1px solid var(--r-line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.ai-reading-desk__actions button:hover,
.ai-reading-desk__actions button:focus-visible {
  border-color: var(--active-chapter);
}

.ai-reading-desk__actions span {
  color: var(--r-muted);
  font-size: 11px;
}

.ai-quick-questions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.ai-quick-questions > div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ai-quick-questions .n-button {
  height: auto;
  min-height: 28px;
  white-space: normal;
  text-align: left;
}

/* 关系图是记忆页的第二个出口，视觉上跟着现有的记忆区块走，不另开一套体系。 */
.memory-graph-panel {
  padding: 10px;
  border: 1px solid var(--r-line);
  border-radius: 8px;
}

.memory-graph-panel-summary {
  cursor: pointer;
  color: inherit;
  font-size: 13px;
}

.memory-graph-panel-summary:focus-visible {
  outline: 2px solid var(--active-chapter);
  outline-offset: 2px;
}
/** 一行进度控制：沿用记忆区块的小字风格，滑块只有 14px 高，不当大控件占位。 */
.memory-graph-progress {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 0;
  color: var(--r-muted);
  font-size: 12px;
}
.memory-graph-progress-label {
  white-space: nowrap;
}
/* 不撑满整行：滑块是给关系图用的旋钮，不是主体。 */
.memory-graph-range {
  flex: 0 0 120px;
  width: 120px;
  height: 14px;
  margin: 0;
  accent-color: var(--active-chapter);
}
.memory-graph-progress-title {
  flex: 1 1 60px;
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
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

.notes-archive strong {
  display: block;
  margin: 12px 0 6px;
}

.notes-archive-item {
  padding: 10px;
  margin-bottom: 8px;
  border: 1px solid var(--r-line);
  border-radius: 8px;
}

.notes-archive-item summary {
  cursor: pointer;
}

.notes-archive-item summary:focus-visible {
  outline: 2px solid var(--active-chapter);
  outline-offset: 2px;
}

.notes-archive-item p {
  margin: 6px 0;
  white-space: pre-wrap;
}

.wordbook > strong {
  display: block;
  margin: 12px 0 6px;
}

.wordbook-list {
  margin: 8px 0 0;
  padding-left: 18px;
  list-style: disc;
}

.wordbook-list li {
  margin-bottom: 8px;
}

.wordbook-list p {
  margin: 4px 0 0;
  white-space: pre-wrap;
}

.wordbook-term {
  padding: 0;
  border: 0;
  background: none;
  color: var(--active-chapter);
  font: inherit;
  text-align: left;
  white-space: pre-wrap;
  cursor: pointer;
}

.wordbook-term:hover {
  text-decoration: underline;
}

.wordbook-term:focus-visible {
  outline: 2px solid var(--r-focus);
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
/* 可信度徽标：紧跟正文、压在「依据」上方一行小字。颜色只区分「核过」与「没核」，
   真正的差别靠文案说——小屏幕上颜色未必看得清。 */
.chat-verify {
  width: 85%;
  font-size: 12px;
  line-height: 1.4;
  color: var(--r-muted);
}
.chat-verify.is-verified { color: var(--active-chapter); }
.chat-verify.is-partial { color: var(--r-text); }
.chat-verify.is-not_run { color: var(--r-muted); }
/* disabled = 读者主动关掉的核验：它不是故障，所以不报警色，跟着 muted 走；
   跟 not_run 同色也说明两者都“没核过”，真正的差别靠文案说清。 */
.chat-verify.is-disabled { color: var(--r-muted); }
.chat-evidence {
  width: 85%;
  padding: 8px 10px;
  border-left: 2px solid var(--active-chapter);
  color: var(--r-muted);
  font-size: 12px;
}

/* 依据默认收起：回答先读结论，需要核对时再展开引用列表（与运行信息同一个折叠箭头语汇）。 */
.chat-evidence > summary,
.chat-steps > summary {
  display: flex;
  align-items: center;
  gap: 4px;
  list-style: none;
  cursor: pointer;
}
.chat-evidence > summary::-webkit-details-marker,
.chat-steps > summary::-webkit-details-marker { display: none; }
.chat-evidence > summary::after,
.chat-steps > summary::after { content: '⌄'; opacity: 0.6; }
.chat-evidence[open] > summary::after,
.chat-steps[open] > summary::after { content: '⌃'; }
.chat-evidence > summary:hover,
.chat-steps > summary:hover { color: var(--r-text); }

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

/* 逐句结论：一句一行，句尾跟自己的角标；不是引用块，所以只留行距不留边框。 */
.chat-claim { margin: 0 0 4px; }
.chat-claim:last-child { margin-bottom: 0; }

/* 行内角标：上标小字，序号与展开后的「依据」列表对得上，点一下跳原文那一段。 */
.chat-cite {
  margin-left: 2px;
  padding: 0 1px;
  border: 0;
  background: transparent;
  color: var(--active-chapter);
  font: inherit;
  font-size: 10px;
  line-height: 1;
  vertical-align: super;
  cursor: pointer;
}
.chat-cite:hover:not(:disabled) { text-decoration: underline; }
.chat-cite:disabled { opacity: 0.5; cursor: default; }

/* 操作条：平时低对比，鼠标在这条气泡上（或键盘进来）才提亮。
   始终占位而不是 hover 才插入 DOM，否则鼠标移过去行高会变，气泡跟着跳。 */
.chat-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0.55;
  transition: opacity 0.15s ease;
}
.chat-msg.assistant:hover .chat-actions,
.chat-actions:focus-within { opacity: 1; }
.chat-actions .chat-chip { padding: 2px 8px; font-size: 11px; }

/* 思考链：本轮正在调/调过的本地工具。running 用主体色提一下，error 用警示色。 */
.chat-steps {
  width: 85%;
  color: var(--r-muted);
  font-size: 12px;
}
.chat-steps ol { margin: 4px 0 0; padding-left: 18px; }
.chat-steps li { line-height: 1.6; }
.chat-steps li.is-running { color: var(--active-chapter); }
.chat-steps li.is-done { opacity: 0.65; }
.chat-steps li.is-error { color: var(--warning); }

.chat-empty {
  text-align: center;
  color: var(--r-muted);
  padding: 40px 20px;
  font-size: 13px;
}

/* ── Sider 式问答界面：欢迎态 + 大圆角输入卡片 ───────────────────── */

.sider-welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 28px 8px 8px;
  text-align: center;
}

.sider-welcome-logo {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: linear-gradient(135deg, #7c5cff, #b06bff 55%, #ff9ecd);
  color: #fff;
  font-size: 20px;
  box-shadow: 0 6px 18px rgba(124, 92, 255, 0.28);
}

.sider-welcome h3 { margin: 0; font-size: 17px; font-weight: 600; }
.sider-welcome p { margin: 0; max-width: 300px; color: var(--r-muted); font-size: 12px; line-height: 1.6; }

.sider-welcome-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  width: 100%;
  margin-top: 6px;
}

.sider-welcome-card {
  padding: 10px;
  border: 1px solid var(--r-line);
  border-radius: 12px;
  background: var(--surface-3, rgba(127, 127, 127, 0.06));
  color: var(--r-text);
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.sider-welcome-card:hover {
  border-color: var(--active-chapter);
  background: var(--surface-2, rgba(127, 127, 127, 0.1));
}

.sider-welcome-find {
  display: flex;
  gap: 6px;
  width: 100%;
  align-items: center;
}

.chat-chip {
  padding: 3px 10px;
  border: 1px solid var(--r-line);
  border-radius: 999px;
  background: transparent;
  color: var(--r-muted);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
}

.chat-chip:hover:not(:disabled) { color: var(--r-text); border-color: var(--active-chapter); }
.chat-chip:disabled { opacity: 0.45; cursor: default; }
.chat-chip-on {
  color: var(--active-chapter);
  border-color: var(--active-chapter);
  background: color-mix(in srgb, var(--active-chapter) 12%, transparent);
}

.sider-composer {
  display: flex;
  flex-direction: column;
  width: 100%;
  border: 1px solid var(--r-line);
  border-radius: 16px;
  background: var(--card);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
  overflow: hidden;
}

.sider-composer :deep(.n-input),
.sider-composer :deep(.n-input .n-input__textarea),
.sider-composer :deep(.n-input .n-input__border),
.sider-composer :deep(.n-input .n-input__state-border) {
  border: 0 !important;
  box-shadow: none !important;
  background: transparent !important;
}

.sider-composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px 8px;
}

.sider-composer-chips { display: flex; align-items: center; gap: 6px; }
.sider-composer-send { display: flex; align-items: center; gap: 8px; }
.sider-composer-task { color: var(--r-muted); font-size: 12px; }
/* 参考范围提示：极小一行，只在开了开关时才占位，不动输入框高度 */
.sider-composer-hint { padding: 0 10px 2px; font-size: 11px; line-height: 1.5; }

:deep(.n-drawer-header__main)::before {
  content: '✦';
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  margin-right: 8px;
  border-radius: 7px;
  background: linear-gradient(135deg, #7c5cff, #b06bff 55%, #ff9ecd);
  color: #fff;
  font-size: 12px;
  vertical-align: middle;
}

/* 会话主体铺满抽屉：Sider 的对话区就是整块面板，不留多余留白。 */
:deep(.n-drawer-body-content-wrapper) { padding-top: 4px; }

.chat-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 2px 8px;
  border-bottom: 1px solid var(--r-line);
}

.chat-topbar-btn {
  border: 0;
  background: transparent;
  color: var(--r-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.chat-topbar-btn:hover:not(:disabled) { color: var(--r-text); background: var(--surface-3, rgba(127, 127, 127, 0.1)); }
.chat-topbar-btn:disabled { opacity: 0.45; cursor: default; }
.chat-topbar-count { color: var(--r-muted); font-size: 11px; }

.chat-input-row {
  display: flex;
  gap: 8px;
  /* 抽屉内容比窗口高，输入框原来会被推到屏幕下方，用户点「聊书」后找不到在哪输入。
     吸在抽屉底边，滑到哪都能直接提问。 */
  position: sticky;
  bottom: 0;
  z-index: 1;
  padding: 8px 0;
  background: var(--card);
}


.reader-toolbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 30;
  flex: 0 0 auto;
  width: 100%;
  min-height: 56px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 24px;
  border-bottom: 1px solid var(--r-line);
  border-radius: 0;
  background: color-mix(in srgb, var(--r-bar-bg) 94%, var(--r-surface));
  opacity: 1;
  pointer-events: auto;
}
.reader-toolbar {
  transform: translateY(0);
  transition: opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1),
              transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
              visibility 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.reader-bottombar {
  transform: translateX(-50%);
  transition: opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1),
              transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
              visibility 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.reader-toolbar.reader-tools-hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(-8px);
  height: 0;
  min-height: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
}

/* 目录 / 标记抽屉是 teleport 到 body 的浮层，它自己的 z-index 是 auto，而阅读器顶栏在应用栈里是 30，
   于是抽屉展开时「残经 / 书架 / 搜索 / 标记 / 地图」会浮在暗色抽屉上面。抽屉本来就盖住了那块区域，
   开抽屉时直接把顶栏收掉，比给三层栈抢 z-index 稳。 */
.reader-wrap.drawer-open .reader-toolbar {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

/* 真实书籍的沉浸式 chrome：页面上不摆应用顶栏，工具入口全在底栏与书页里。
   容器留成零高度只为了给朗读 / AI / 快捷键浮层一个锚点，浮层自己挪到右上角；
   页码缩成读屏文本，辅助技术与测试仍能读当前位置。 */
.reader-toolbar.reader-toolbar-realbook {
  height: 0;
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  overflow: visible;
}
/* 工具条收起时的浮动返回：半透明贴在左上，跟随阅读主题，不抢正文。
   只在 classic 模式用；真实书籍底栏已有 rb-btn 书库钮。 */
.reader-float-back {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 28;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px 5px 8px;
  border: 1px solid var(--r-line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--reader-paper) 78%, transparent);
  color: var(--reader-paper-text);
  font-size: 12.5px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.55;
  backdrop-filter: blur(3px);
  transition: opacity 0.2s ease, background-color 0.2s ease;
}
.reader-float-back:hover {
  opacity: 1;
  background: var(--reader-paper);
}

/* 左页留白里的书名牌：极淡、不可点，只是让画面不空。 */
.reader-plate {
  position: absolute;
  z-index: 12;
  top: 84px;
  left: 32px;
  max-width: 220px;
  pointer-events: none;
  user-select: none;
}

.reader-plate-title {
  margin: 0;
  /* 26%/42% 在纸色底上几乎看不见，可“读到第几章”是读者真的想知道的信息。
     提亮到能读，但仍然比正文弱一档，不抢注意力。 */
  color: color-mix(in srgb, var(--reader-paper-text) 66%, transparent);
  font-family: var(--font-serif);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.04em;
}

.reader-plate-meta {
  margin: 6px 0 0;
  color: color-mix(in srgb, var(--reader-paper-text) 50%, transparent);
  font-size: 11px;
  letter-spacing: 0.08em;
}

.reader-float-back svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }

.reader-toolbar.reader-toolbar-realbook .real-book-page-label {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
.reader-toolbar.reader-toolbar-realbook .tool-panel {
  top: 16px;
  right: 24px;
  border-color: rgba(233, 220, 188, 0.16);
  background: rgba(24, 28, 25, 0.96);
  color: rgba(244, 235, 211, 0.86);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 245, 216, 0.06);
}
.reader-toolbar.reader-toolbar-realbook .tool-panel strong { color: #f2d887; }
.reader-toolbar.reader-toolbar-realbook .tool-panel .control-label { color: rgba(244, 235, 211, 0.58); }

.reader-bottombar.reader-tools-hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateX(-50%) translateY(8px);
}
.toolbar-gap { flex: 1 1 auto; min-width: 8px; }
/* 顶栏分组竖线：工具动作 | 设置 / 浏览 / 快捷键（和网页阅读模式同一条分隔线）。 */
.toolbar-sep { width: 1px; height: 16px; margin: 0 6px; background: color-mix(in srgb, var(--text) 14%, transparent); }
.tool-button.tool-text { width: auto; flex-basis: auto; padding: 0 10px; font: inherit; font-size: 13px; }
/* 图标 + 文字：新用户光看图标认不出「搜索 / 标记 / 朗读 / AI」，补上文字标签。 */
.tool-button.tool-icon-text {
  width: auto;
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
}
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
/* 真实书籍顶栏的页码：只报位置，不抢标题；工具收起时整条顶栏隐藏。 */
.reader-toolbar .real-book-page-label {
  flex: 0 0 auto;
  margin-right: 4px;
  font-size: 12px;
  color: var(--r-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* 书页样式：标题靠左当眉题，其余工具靠右，像一张纸的页眉。 */
.reader-toolbar { border-bottom: 0; }
/* 顶栏底跟应用外壳色走，不是纸面：夜间主题下纸面字色是浅色，写在这里会让白底白字。 */
.reader-toolbar .reader-book-title { flex: 0 1 auto; text-align: left; padding: 0 12px 0 0; font-size: 15px; color: var(--text); }

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
/* 书页 / 真实书籍不需要 96px 的书页内边距：纸面自己按舞台尺寸排版，
   96px 会和舞台的 40px 叠成两道白边，把纸面挤窄一大截。 */
.reader-body.reader-body-paged { padding-left: 24px; padding-right: 24px; }
/* 真实书籍是整屏的书桌照：桌面要铺到窗口四边，不能再留一圈外壳底色的边框。 */
.reader-body.reader-body-realbook { padding: 0; }
.reader-body {
  position: relative; flex: 1 1 auto; min-width: 0;
  padding: 24px 96px 24px; justify-content: center; overflow: hidden;
  background: var(--reader-outer);
}
/* 右侧工具条：一串浮在画布上的圆形按钮，不再是带边框的长胶囊。 */
.reader-bottombar {
  position: absolute; z-index: 28; left: 50%; bottom: 18px; top: auto; right: auto;
  width: max-content; max-width: calc(100% - 32px);
  display: flex; flex-direction: row; align-items: center; justify-content: center;
  gap: 3px; padding: 7px 10px; border: 1px solid rgba(233, 220, 188, 0.16);
  border-radius: 18px; transform: translateX(-50%);
  background: rgba(24, 28, 25, 0.88);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 245, 216, 0.08);
  backdrop-filter: blur(14px) saturate(0.82);
  color: rgba(244, 235, 211, 0.82);
}
/* 目录/进度/背景/字体/批注：图标下面补一行小字。只留图形时新用户得把鼠标移上去才知道每个按钮干什么，
   悬浮提示在首次使用和触屏场景都指望不上（顶栏「搜索/标记/朗读/AI」已按同样理由加了字）。 */
.reader-bottombar:not(.is-realbook) .bottom-button {
  width: auto; min-width: 46px; height: auto; padding: 5px 7px; gap: 3px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.reader-bottombar:not(.is-realbook) .bottom-button-text {
  position: static; width: auto; height: auto; overflow: visible; clip: auto; clip-path: none;
  font-size: 10px; line-height: 1; letter-spacing: 0.04em; opacity: 0.78;
}

.bottom-button {
  position: relative; display: grid; place-items: center;
  width: 34px; height: 34px; min-width: 0; min-height: 0; padding: 0;
  border: 0; border-radius: 11px;
  background: transparent;
  color: rgba(244, 235, 211, 0.74);
  font: inherit; cursor: pointer;
}
.bottom-button svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
/* 图标圈里不排字：文字标签留给读屏与悬浮提示，视觉上只留图形。 */
.bottom-button-text {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
.bottom-button:hover, .bottom-button.active {
  background: rgba(244, 224, 160, 0.14);
  color: #f2d887;
}
.bottom-button:focus-visible { outline: 2px solid var(--r-focus); outline-offset: 2px; }

/* 顶栏也复用了 .bottom-button（真实书籍的字号 / 平放）：底栏的奶油白字色在白顶栏上
   几乎看不见，这两个按钮要跟随顶栏的语义前景色与悬停底色。 */
.reader-toolbar .bottom-button { color: inherit; }
.reader-toolbar .bottom-button:hover { background: var(--r-hover); }
.reader-toolbar .bottom-button.active { background: var(--r-hover); color: var(--active-chapter); }

/* 真实书籍底栏：按参考图排成一条图标带。与经典底栏不同，这条栏只是「抽屉展开态」——
   不交互（点书页中区收起）时整条收进底边横条，书桌照完整露出；
   点横条或书页中区再展开。收起时面板 / 目录抽屉本就不该开着（见 realBookBarCollapsed）。 */
.reader-bottombar.is-realbook {
  gap: 2px;
  padding: 6px 10px;
  border-radius: 20px;
  /* backdrop-filter 会在翻页动画期间每帧重算模糊，把 60fps 的翻页拖到二十几帧：
     这条栏用半透明实底，不要模糊。 */
  backdrop-filter: none;
}
/* 收起与展开都要像抽屉：往下缩一点、淡出，不能整条凭空消失。 */
.reader-bottombar.is-realbook.reader-tools-hidden {
  transform: translateX(-50%) translateY(10px) scale(0.98);
}

/* 收起后的底边横条：一个深色小胶囊，里面一根浅色横条，居中钉在视口底边。
   点击热区比视觉大一圈（48px 宽 × 26px 高），手指不用瞄准那根 4px 的线。 */
.real-book-dock {
  position: absolute;
  z-index: 29;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  display: grid;
  place-items: center;
  width: 64px;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(233, 220, 188, 0.14);
  border-radius: 999px;
  background: rgba(24, 28, 25, 0.82);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.3);
  cursor: pointer;
  animation: real-book-dock-in 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}
.real-book-dock:hover { background: rgba(34, 39, 35, 0.9); }
.real-book-dock:focus-visible { outline: 2px solid var(--r-focus); outline-offset: 2px; }
.real-book-dock-bar {
  width: 26px;
  height: 3px;
  border-radius: 2px;
  background: rgba(244, 235, 211, 0.72);
}
@keyframes real-book-dock-in {
  from { opacity: 0; transform: translateX(-50%) translateY(6px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}
.rb-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: rgba(244, 235, 211, 0.76);
  cursor: pointer;
}
.rb-btn:hover { background: rgba(244, 224, 160, 0.14); color: #f2d887; }
.rb-btn:focus-visible { outline: 2px solid var(--r-focus); outline-offset: 2px; }
.rb-btn.active { color: #f2d887; background: rgba(242, 216, 135, 0.14); }
.rb-btn svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.rb-sep { width: 1px; height: 16px; margin: 0 3px; background: rgba(233, 220, 188, 0.16); }
.rb-progress {
  position: relative;
  width: 92px;
  height: 32px;
  margin: 0 2px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border-radius: 10px;
  cursor: pointer;
  touch-action: none;
}
.rb-progress:hover { background: rgba(244, 224, 160, 0.08); }
.rb-progress-track {
  position: relative;
  width: 76px;
  height: 2px;
  border-radius: 1px;
  background: rgba(244, 235, 211, 0.22);
}
.rb-progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 1px;
  background: rgba(242, 216, 135, 0.75);
}
.rb-progress-dot {
  position: absolute;
  top: 50%;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f2d887;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 0 2px rgba(24, 28, 25, 0.6);
}
.rb-progress-label {
  font-size: 10px;
  line-height: 1;
  color: rgba(244, 235, 211, 0.62);
  font-variant-numeric: tabular-nums;
}
.rb-zoom {
  min-width: 44px;
  height: 32px;
  padding: 0 4px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: rgba(244, 235, 211, 0.8);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.rb-zoom:hover { background: rgba(244, 224, 160, 0.14); color: #f2d887; }

/* 真实书籍底栏的面板从栏上方展开：栏贴近视口底边，向下的面板会被裁掉。
   面板右缘对齐底栏右缘，和参考图的浮层位置一致。 */
.reader-bottombar.is-realbook .bottom-panel {
  top: auto;
  bottom: calc(100% + 10px);
  right: 0;
  transform: none;
}
@media (max-width: 900px) {
  .reader-bottombar.is-realbook .bottom-panel {
    right: auto;
    left: 50%;
    transform: translateX(-50%);
  }
}

/* 真实书籍的外观浮层跟随参考站刷成暗色：底栏本身就是深色图标带，浮层再用浅色
   应用底就像在书桌上贴了一张白纸。面板是底栏子节点，会继承奶油白字色；这里把
   浮层自己的底色与选项按钮一起翻到暗色，并保留浅色面板那套语义规则给经典模式。
   不用 backdrop-filter：面板开着也允许翻页，每帧重算模糊会拖慢翻页。 */
.reader-bottombar.is-realbook .bottom-panel {
  border-color: rgba(233, 220, 188, 0.16);
  background: rgba(24, 28, 25, 0.96);
  color: rgba(244, 235, 211, 0.86);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 245, 216, 0.06);
}
.reader-bottombar.is-realbook .bottom-panel strong { color: #f2d887; }
.reader-bottombar.is-realbook .bottom-panel .control-label { color: rgba(244, 235, 211, 0.58); }
.reader-bottombar.is-realbook .bottom-panel .option-grid button {
  border-color: rgba(244, 235, 211, 0.14);
  background: rgba(244, 235, 211, 0.06);
  color: rgba(244, 235, 211, 0.84);
}
.reader-bottombar.is-realbook .bottom-panel .option-grid button:hover {
  border-color: rgba(242, 216, 135, 0.42);
  background: rgba(244, 235, 211, 0.12);
}
.reader-bottombar.is-realbook .bottom-panel .option-grid button.active {
  border-color: rgba(242, 216, 135, 0.62);
  background: rgba(242, 216, 135, 0.16);
  color: #f2d887;
}
.reader-bottombar.is-realbook .bottom-panel .real-book-swatch {
  box-shadow: inset 0 0 0 1px rgba(244, 235, 211, 0.22);
}
.reader-bottombar.is-realbook .bottom-panel .reader-progress-row.panel {
  background: rgba(244, 235, 211, 0.14);
}
.bottom-panel {
  /* 向上展开：原先 top:50% + translateY(-50%) 把整个面板居中到底栏上，底栏贴着窗口底边时
     面板下沿会跑出屏幕（440 高面板实测出屏 177px），「字号 / 行距 / 主题 / 恢复默认」全在屏幕外。
     改成把面板底边钉在底栏上沿，高度仍由 max-height 控制。 */
  position: absolute; bottom: calc(100% + 12px); right: calc(100% + 12px); width: min(390px, calc(100vw - 96px));
  max-height: min(440px, 70vh); overflow-y: auto; display: flex;
  flex-direction: column; gap: 8px; padding: 14px; border: 1px solid var(--r-line);
  border-radius: var(--radius-overlay); background: var(--popover-bg); box-shadow: var(--shadow-overlay);
  /* 面板是深色底栏的子节点，会继承底栏的奶油白字色；面板自己刷的是浅色浮层底，
     不把字色拉回语义前景色，白底白字就只剩「屏幕压暗」几行弱色标签还看得见。 */
  color: var(--text);
  animation: bottom-panel-in 0.16s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 浮层里的说明文字比正文弱一档就够：沿用全局 --r-muted 的白底对比度只有 3:1，
   12px 小字读着发虚，面板内改用次级前景色。 */
.bottom-panel .control-label { color: var(--text-secondary); }

/* 入场动效走 CSS keyframes，不再依赖 Transition 的 enter/leave 状态机：
   面板 DOM 的存在与否必须严格等于 activeBottomPanel，避免离场被打断后留下透明残影。
   只动 opacity：窄屏样式会给面板加 translateX(-50%)，keyframes 里写 transform 会把它顶掉。 */
@keyframes bottom-panel-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (max-width: 900px) {
  .reader-bottombar {
    bottom: 12px;
    max-width: calc(100% - 20px);
  }
}

.reader-progress-row.panel { height: 6px; overflow: hidden; background: var(--r-surface); }

.reader-content {
  /* 纸页上不长浏览器滚动条：滚动位置另有底部那条细进度线，原生滚动条会穿破“纸”的观感。 */
  scrollbar-width: none;
  position: relative;
  min-height: 0;
  width: min(100%, 38em);
  max-width: 38em;
  flex: 0 1 38em;
  padding: 64px clamp(32px, 5vw, 60px) 100px;
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}

.reader-content.chapter-fade-in {
  animation: chapterFadeIn 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes chapterFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .reader-content.chapter-fade-in {
    animation: none;
  }
}

.reader-dim {
  /* 护眼压暗：盖在正文上的一层纯黑遮罩，只降正文亮度，不吞掉点击。
     z-index 15：高于正文(0)、低于翻章热区(18)与页码(26)，让箭头和页码保持清晰。 */
  position: absolute;
  inset: 0;
  z-index: 15;
  pointer-events: none;
  background: #000;
}

.reader-page-indicator {
  /* 挂在 .reader-body（不滚动的定位上下文）上，不随正文滚动走掉。
     原来 bottom:14px 落在纸页下沿外面、浮在桌面上，像贴歪的标签；
     提到 34px 落进纸内下边距，颜色改用纸面字色，看着是页脚而不是外挂。 */
  position: absolute;
  z-index: 26;
  right: 50%;
  transform: translateX(50%);
  /* 34px 是相对 .reader-body 量的，它比纸页底边低约 10px，页码于是半个身子挂在纸外（实测 749 > 739）。 */
  bottom: 46px;
  padding: 1px 10px;
  border-radius: 999px;
  pointer-events: none;
  color: color-mix(in srgb, var(--reader-paper-text) 46%, transparent);
  /* 页码是浮在滚动正文上的：给一层纸色底，压在段落上时也像个“页码钤印”，不像错位的字。 */
  background: color-mix(in srgb, var(--reader-paper) 86%, transparent);
  backdrop-filter: blur(2px);
  font-size: 12px;
  letter-spacing: 0.04em;
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
  pointer-events: auto;
  opacity: 0.6;
  transition: height 0.2s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.reader-progress-track:hover {
  height: 6px;
  opacity: 1;
}

.reader-progress-row { height: 2px; }
.reader-progress-row { position: relative; }
.reader-progress-fill {
  height: 100%;
  background: var(--active-chapter);
  transition: width .12s linear;
}
.reader-progress-fill.chapter { opacity: .55; }

/* 拖动预览：跟着指针走的细描边，盖在全书填充之上，读成「你要跳到这儿」。 */
.reader-progress-fill.scrub-preview {
  position: absolute;
  inset: 0 auto 0 0;
  opacity: .45;
  background: var(--r-focus);
  transition: none;
}

.reader-progress-track {
  cursor: pointer;
}

.reader-progress-track.scrubbing {
  height: 8px;
  opacity: 1;
  cursor: grabbing;
}

.reader-progress-track:focus-visible {
  outline: 2px solid var(--r-focus);
  outline-offset: -2px;
}

/* 拖动时的目标章名浮标：贴在进度条上方，不遮正文。 */
.reader-progress-scrub-hint {
  position: absolute;
  left: 12px;
  bottom: calc(100% + 8px);
  display: flex;
  align-items: baseline;
  gap: 6px;
  max-width: calc(100vw - 24px);
  padding: 4px 10px;
  border: 1px solid var(--r-line);
  border-radius: 999px;
  background: var(--popover-bg);
  box-shadow: var(--shadow-card);
  /* 浮标底是应用浮层色，不是纸面：夜间主题下纸面字色是浅色，会白底白字。 */
  color: var(--text);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
  overflow: hidden;
}

.reader-progress-scrub-ordinal { font-variant-numeric: tabular-nums; }
.reader-progress-scrub-title { overflow: hidden; text-overflow: ellipsis; color: var(--r-muted); }

.reader-wrap.immersive-locked .reader-progress-track { opacity: 1; }
@media (max-width: 1180px) {
  .reader-body { padding: 16px 16px 78px; }
  .reader-bottombar {
    top: auto; right: auto; bottom: 20px; left: 50%; width: auto;
    flex-direction: row; gap: 8px; padding: 0; transform: translateX(-50%);
  }
  /* 真实书籍的图标带本来就是横条（参考图在窄窗口下也不折行）：
     窄屏的 42px 方块按钮与 8px 间距会把整条撑出视口，这里让它保持紧凑横排。 */
  .reader-bottombar.is-realbook { gap: 2px; padding: 6px 10px; }
  .reader-bottombar.is-realbook .rb-btn { width: 32px; height: 32px; }
  .bottom-button { width: 42px; height: 42px; }
  .bottom-panel {
    top: auto; right: auto; bottom: calc(100% + 12px); left: 50%;
    width: min(390px, calc(100vw - 32px));
    transform: translateX(-50%);
  }
}

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
/* 经典模式页内批注：紧跟被批注段落，与书台旁批共用同一套墨色与分行。 */
.classic-inline-note {
  position: relative;
  z-index: 1;
  margin: 0.08em 0 calc(var(--paragraph-spacing, .45em) + .08em) var(--paragraph-indent, 2em);
  padding: 0.02em 0 0.08em 0.8em;
  border-left: 1.5px solid color-mix(in srgb, #a9552e 52%, transparent);
  border-radius: 0;
  background: none;
  color: color-mix(in srgb, #a33e2f 72%, var(--reader-paper-text));
  font-size: 0.92em;
  line-height: 1.68;
  text-indent: 0;
  text-align: left;
}
.classic-inline-note:focus-visible { outline-color: var(--active-chapter); }
.classic-inline-note + .classic-inline-note { margin-top: 0.38em; }
.classic-inline-note .real-book-note-label {
  display: block;
  margin-bottom: 0.2em;
  color: color-mix(in srgb, #8a6648 76%, var(--reader-paper-text));
  font-size: 0.62em;
  letter-spacing: 0.08em;
  line-height: 1.4;
}
.classic-inline-note .real-book-note-source {
  display: inline-block;
  margin-left: 0.35em;
  padding: 0 0.35em;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 0.9em;
  letter-spacing: 0;
  line-height: 1.3;
}
.classic-inline-note .real-book-note-text {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.classic-inline-note .real-book-note-tags {
  display: flex;
  flex-direction: column;
  gap: 0.08em;
  margin-top: 0.28em;
  color: color-mix(in srgb, #8b5e3c 82%, var(--reader-paper-text));
  font-size: 0.72em;
  line-height: 1.45;
}
.classic-inline-note .real-book-note-tag { display: block; white-space: pre-wrap; }
.classic-inline-note.handwriting-kai { font-family: 'KaiTi', '楷体', serif; }
.classic-inline-note.handwriting-xingshu { font-family: 'STXingkai', '华文行楷', 'KaiTi', serif; }

/* 经典模式的「注」标记：字形用伪元素，正文文本节点保持原文，不改选区与进度坐标。 */
.classic-note-anchor {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.32em;
  height: 2.32em;
  margin: 0 0.16em;
  border-radius: 50%;
  background: color-mix(in srgb, #a9552e 88%, var(--reader-paper-text));
  color: color-mix(in srgb, #fff7e6 94%, var(--reader-paper));
  font-size: 0.58em;
  font-weight: 600;
  line-height: 1;
  text-indent: 0;
  vertical-align: 0.18em;
  cursor: pointer;
  user-select: none;
}
.classic-note-anchor::before { content: '注'; }
.classic-note-anchor:focus-visible { outline: 2px solid var(--active-chapter); outline-offset: 2px; }
/* 窗口化占位间隙：不参与段落定位（无 .para/data-p），纯占高，跳过强制布局风暴 */
.large-chapter .reader-gap { contain: strict; }
.large-chapter .reader-gap.top { margin-top: var(--paragraph-spacing, .45em); }
.large-chapter .reader-gap.bottom { margin-bottom: var(--paragraph-spacing, .45em); }
.para-tts-start {
  position: absolute;
  /* 不再「鼠标扫过整段就弹」，也不再落在字上：原先钉在段落右上角，
     正好压住第一行的末尾几个字（实测截图里「第 7 段的」被盖掉）。
     现在挂在版心右侧的留白里，垂直居中于这一段，像页边的旁注。 */
  top: 50%;
  /* 版心右侧只有 60px 留白，54px 宽的文字胶囊放不进去，会压掉行尾十几个字；
     改成留白里的一枚 28px 图标，悬浮提示给全称。 */
  right: -40px;
  width: 28px; height: 28px; padding: 0;
  display: grid; place-items: center;
  transform: translateY(-50%);
  white-space: nowrap;
  box-shadow: 0 2px 8px rgb(0 0 0 / 8%);
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
.para-tts-start svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.para-tts-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

.para-tts-zone {
  position: absolute;
  /* 热区跟着按钮一起挪到右侧留白：整段高度都能触发，但永远不盖字。 */
  top: 0;
  bottom: 0;
  right: -60px;
  width: 58px;
}
.para-tts-zone:hover + .para-tts-start, .para-tts-start:focus-visible { opacity: 1; }
.para-tts-start:focus-visible { outline: 2px solid var(--r-focus); outline-offset: 2px; }
.shortcut-list { display: grid; gap: 8px; margin: 0; }
.shortcut-list div { display: grid; gap: 2px; }
.shortcut-list dt { color: var(--text); font-weight: 600; }
.shortcut-list dd { margin: 0; color: var(--r-muted); font-size: 12px; }

.option-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; }
.option-grid.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.option-grid .real-book-swatch {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-right: 5px;
  border-radius: 4px;
  vertical-align: -2px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 18%, transparent);
}
.option-grid button {
  min-height: 30px;
  padding: 4px 5px;
  border: 1px solid var(--r-line);
  border-radius: 7px;
  /* 面板是浅色浮层：选项按钮要有可见的浅底与边框，否则白底上的透明按钮只剩字。 */
  background: var(--r-surface);
  color: inherit;
  cursor: pointer;
  font-size: 12px;
}
.option-grid button:hover { border-color: var(--hover-line); background: var(--surface-3); }
.option-grid button.active { border-color: var(--active-chapter); background: var(--info-surface); color: var(--text); font-weight: 600; }
.option-grid button:focus-visible { outline: 2px solid var(--r-focus); outline-offset: 1px; }

/* 背景主题：光写「纸白 / 暖黄 / 柔灰 / 夜间」四个词，点下去才知道长什么样。
   每个选项前面补一块真实色块（取的就是各主题的纸色）。 */
.theme-swatches button { display: flex; align-items: center; justify-content: center; gap: 5px; }
.theme-swatches button::before {
  content: ''; flex: 0 0 auto; width: 12px; height: 12px; border-radius: 3px;
  border: 1px solid color-mix(in srgb, var(--text) 18%, transparent);
}
.theme-swatches .swatch-paper::before { background: #f7f3e8; }
.theme-swatches .swatch-sepia::before { background: #efe1c3; }
.theme-swatches .swatch-gray::before { background: #dfdfd9; }
.theme-swatches .swatch-night::before { background: #1b1f22; }

@media (prefers-reduced-motion: reduce) {
  .reader-wrap, .reader-wrap *, .reader-toolbar, .reader-bottombar, .reader-progress-fill { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}

:deep(button:focus-visible), :deep(.n-button:focus-visible), :deep(.n-input:focus-within) {
  outline: 2px solid var(--active-chapter);
  outline-offset: 2px;
}
</style>
