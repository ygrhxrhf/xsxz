<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NInputNumber, NProgress, NTag, useMessage } from 'naive-ui'
import { DEFAULT_READER_PREFS, DEFAULT_TTS_PREFS, DEFAULT_WEB_READING_PREFS } from '@shared/types'
import { READER_THEME_COLORS } from '@shared/readerTheme'
import type { BookListItem, BrowseFavorite, BrowseReadingPage, BrowseState, BrowseFindResult, DownloadPreview, DownloadProgress, FailCode, MirrorProgress, PreviewPageKind, ReaderPrefs, WebAnnotation, WebReadingPrefs, WebShelfBook, WebShelfChapter } from '@shared/types'
import { libraryCoverSrc } from './libraryCard'
import { adjacentVisualPage, scrollTopForVisualPage, visualPageCount, visualPageIndex, visualPageLabel } from './readerPager'
import { autoPageIntervalMs, columnPageCount, columnPageForOffset, columnPageIndex, columnScrollLeft } from './readingColumns'
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
  (e: 'open-web-book', url: string): void
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
/** 分栏滚动停下后吸回整页的短定时器。 */
let columnSnapTimer: ReturnType<typeof setTimeout> | null = null
/** 分栏自动翻页的节拍器。 */
let autoPageTimer: ReturnType<typeof setTimeout> | null = null
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
    // 分栏时版心改由左右留白控制：栏距取两倍留白，翻页步长才恰好等于一屏宽。
    '--web-col-pad': p.contentWidth === 'narrow' ? 'clamp(40px, 9vw, 120px)' : p.contentWidth === 'wide' ? 'clamp(18px, 3vw, 36px)' : 'clamp(28px, 6vw, 72px)',
    '--web-size': `${p.fontSize}px`,
    '--web-line': String(p.lineHeight),
    '--web-spacing': p.paragraphSpacing === 'compact' ? '0.2em' : p.paragraphSpacing === 'relaxed' ? '0.8em' : '0.45em',
    '--web-indent': p.paragraphIndent ? '2em' : '0',
  }
})
const readingParagraphs = computed(() => readingPage.value?.body.split(/\n\s*\n/).filter(Boolean) ?? [])
/** 规范化正文（段落以空行连接）：标注坐标与选区换算的坐标空间，与本地阅读器一致。 */
const readingNormalizedBody = computed(() => readingParagraphs.value.join('\n\n'))
/**
 * 整本连读：一次排进同屏的章节。滚到章末自动接上下一章，整本书在阅读模式里连着读，
 * 不再一章一个屏；当前章（标题、标注、进度、听书）始终由视口位置决定。
 */
const READING_SECTION_LIMIT = 4
const readingSections = ref<BrowseReadingPage[]>([])
const appendingSection = ref(false)
const readingAppendError = ref('')

/** 某章的段落表：与 readingParagraphs 同一套切法，激活前后段落数量一致，切章不跳行。 */
function sectionParagraphs(section: BrowseReadingPage): string[] {
  return section.body.split(/\n\s*\n/).filter(Boolean)
}

const readingTailNext = computed(() => {
  const tail = readingSections.value[readingSections.value.length - 1]
  return tail?.chapter?.next ?? null
})

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
/** 翻页模式下的栏数：1 单栏、2 双栏；滚动模式不分栏。 */
const readingColumns = computed(() => (readingPaged.value ? webReading.value.columns : 0))
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

// Mirror state（整站镜像：从分类 / 作者页批量入书库）
const showMirror = ref(false)
const mirrorProgress = ref<MirrorProgress | null>(null)
const mirrorBusy = ref(false)
const mirrorMaxBooks = ref(10)
const mirrorMaxPages = ref(3)
const mirrorError = ref('')
const mirrorRunning = computed(() => mirrorBusy.value || mirrorProgress.value?.status === 'running')
const mirrorRecentResults = computed(() => (mirrorProgress.value?.results ?? []).slice(-10))
const mirrorStatusText = computed(() => {
  const status = mirrorProgress.value?.status
  if (status === 'running') return '镜像中'
  if (status === 'done') return '已完成'
  if (status === 'cancelled') return '已取消'
  if (status === 'error') return '出错'
  return ''
})
const mirrorCanResume = computed(() => {
  const p = mirrorProgress.value
  if (!p || p.status === 'running') return false
  const planned = p.plan?.length ?? 0
  if (planned === 0) return false
  // 还有没跑完的书目，或上次有失败要重试；页面上停在哪一页不影响继续。
  return p.failed > 0 || p.results.length < planned
})

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

/** 是否真有网页在原生视图里：about:blank 不算，起始页据此代替空白网页。 */
const browsing = computed(() => Boolean(state.value.url && state.value.url !== 'about:blank'))

const startGreeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了，读两页再睡'
  if (hour < 12) return '早上好，挑一本开始'
  if (hour < 18) return '下午好，续上昨天那章'
  return '晚上好，慢慢读'
})

type StartRecent = {
  key: string
  title: string
  meta: string
  cover: string | null
  kind: 'library' | 'web'
  bookId?: string
  url?: string
}

const libraryPath = ref('')
const recentBooks = ref<StartRecent[]>([])
const startInput = ref<HTMLInputElement | null>(null)

/** 起始页的「继续阅读」：本地书库 + 网页书架，按最近读过排序。 */
async function loadStartRecent() {
  let books: BookListItem[] = []
  let shelfBooks: WebShelfBook[] = []
  try {
    // 三个来源各自兜底：启动瞬间书库还在建索引时，任意一个抛错都会把整排「继续阅读」清空，
    // 看上去像“书架还是空的”。分开 catch 至少还能显示拿到的那部分。
    const [library, shelf, settings] = await Promise.all([
      window.api.library.list().catch(() => ({ books: [] as BookListItem[] })),
      window.api.shelf.list().catch(() => ({ ok: false as const })),
      window.api.settings.get().catch(() => null),
    ])
    books = library.books ?? []
    if (shelf.ok) shelfBooks = shelf.books
    if (settings?.libraryPath) libraryPath.value = settings.libraryPath
  } catch {
    return
  }
  const local = books.slice(0, 6).map((book) => ({
    sortAt: book.progress?.updatedAt || book.updatedAt,
    item: {
      key: `library-${book.id}`,
      title: book.title,
      meta: `${book.chapterCount} 章 · ${book.progress ? '继续上次进度' : '尚未开始'}`,
      cover: libraryCoverSrc(libraryPath.value, book.id, book.coverPath),
      kind: 'library' as const,
      bookId: book.id,
    },
  }))
  const web = shelfBooks.slice(0, 4).map((book) => ({
    sortAt: book.progress?.updatedAt || book.updatedAt,
    item: {
      key: `web-${book.id}`,
      title: book.title,
      meta: book.lastChapter?.title ? `网页书架 · ${book.lastChapter.title}` : '网页书架',
      cover: book.coverUrl || null,
      kind: 'web' as const,
      url: book.progress ? book.lastChapter.url : book.catalogUrl,
    },
  }))
  recentBooks.value = [...local, ...web]
    .sort((a, b) => b.sortAt.localeCompare(a.sortAt))
    .slice(0, 5)
    .map((entry) => entry.item)
}

function openRecent(item: StartRecent) {
  if (item.kind === 'library' && item.bookId) {
    emit('open-book', item.bookId)
    return
  }
  if (item.url) emit('open-web-book', item.url)
}

// ---------------------------------------------------------------------------
// 常用网站：沿用 settings.get / settings.set 落盘，不另开 IPC 频道
// ---------------------------------------------------------------------------

const browseFavorites = ref<BrowseFavorite[]>([])
/** 起始页只是把原生网页视图藏起来：回到网页时页面还在，不重开也不丢滚动位置。 */
const showStartPage = ref(false)
const favoriteDraft = ref<{ url: string; title: string; originalUrl: string } | null>(null)
/** 首字色块用固定色板：不拉站点图标，也就不受离线与跨域影响。 */
const FAVORITE_COLORS = ['#4b93dd', '#3b9d77', '#b48436', '#c2689a', '#7c6fd0', '#2f9da8']

const startPageVisible = computed(() => showStartPage.value && !readingPage.value)

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, '') } catch { return url }
}

function favoriteColor(url: string): string {
  let hash = 0
  for (let i = 0; i < url.length; i += 1) hash = (hash * 31 + url.charCodeAt(i)) >>> 0
  return FAVORITE_COLORS[hash % FAVORITE_COLORS.length]!
}

function favoriteInitial(item: BrowseFavorite): string {
  return (item.title || hostOf(item.url)).trim().slice(0, 1).toUpperCase() || '·'
}

/** 同域名算同一个站点：站内翻章时星标不会一会儿亮一会儿灭。 */
const currentFavorite = computed<BrowseFavorite | null>(() => {
  if (startPageVisible.value) return null
  const host = currentHost()
  if (!host) return null
  return browseFavorites.value.find((item) => hostOf(item.url) === host) ?? null
})

let favoritesLoad: Promise<void> | null = null

/** 收藏只加载一次；写之前先等它落地，免得启动瞬间的点击盖掉已存列表。 */
async function ensureFavorites(): Promise<void> {
  if (!favoritesLoad) {
    favoritesLoad = (async () => {
      try {
        const settings = await window.api.settings.get()
        browseFavorites.value = settings.browseFavorites ?? []
      } catch { /* 读不到就按空列表起页，不打断浏览 */ }
    })()
  }
  await favoritesLoad
}

/** 先改本地再落盘：保存失败回滚，界面与磁盘不会各说一套。 */
async function persistFavorites(next: BrowseFavorite[]): Promise<void> {
  const previous = browseFavorites.value
  browseFavorites.value = next
  try {
    await window.api.settings.set({ browseFavorites: next })
  } catch (e: unknown) {
    browseFavorites.value = previous
    message.error(e instanceof Error ? e.message : '常用网站保存失败')
  }
}

async function toggleCurrentSiteFavorite(): Promise<void> {
  const host = currentHost()
  const url = state.value.url
  if (!host || !url || url === 'about:blank' || startPageVisible.value) {
    message.warning('先打开一个网页，再把它存成常用网站')
    return
  }
  await ensureFavorites()
  const existing = currentFavorite.value
  if (existing) {
    await persistFavorites(browseFavorites.value.filter((item) => item.url !== existing.url))
    message.success(`已取消收藏「${existing.title}」`)
    return
  }
  const title = (state.value.title || host).trim().slice(0, 60) || host
  await persistFavorites([...browseFavorites.value, { url, title, addedAt: new Date().toISOString() }])
  message.success(`已收藏「${title}」`)
}

/** 回起始页：只藏视图、不卸载网页，回来还能接着读。 */
function openStartPage(): void {
  favoriteDraft.value = null
  address.value = ''
  showStartPage.value = true
}

/** 侧栏的「添加」：起始页既是唯一的管理面，就顺手把编辑框打开，少一次点击。 */
function openFavoriteManager(): void {
  openStartPage()
  startFavoriteDraft()
}

function openFavorite(item: BrowseFavorite): void {
  favoriteDraft.value = null
  showStartPage.value = false
  address.value = item.url
  void go()
}

function startFavoriteDraft(item?: BrowseFavorite): void {
  favoriteDraft.value = item
    ? { url: item.url, title: item.title, originalUrl: item.url }
    : { url: address.value, title: '', originalUrl: '' }
}

function cancelFavoriteDraft(): void {
  favoriteDraft.value = null
}

async function saveFavoriteDraft(): Promise<void> {
  const draft = favoriteDraft.value
  if (!draft) return
  await ensureFavorites()
  let parsed: URL
  try {
    parsed = new URL(draft.url.trim())
  } catch {
    message.warning('网址要写成完整地址，例如 https://example.com')
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    message.warning('只支持 http / https 地址')
    return
  }
  const url = parsed.toString()
  const title = (draft.title.trim() || hostOf(url)).slice(0, 60)
  const others = browseFavorites.value.filter((item) => item.url !== draft.originalUrl)
  if (others.some((item) => item.url === url)) {
    message.info('这个地址已经在常用网站里了')
    return
  }
  const addedAt = browseFavorites.value.find((item) => item.url === draft.originalUrl)?.addedAt
    || new Date().toISOString()
  const entry: BrowseFavorite = { url, title, addedAt }
  // 改名 / 换地址都在原位替换，卡片不会因为编辑一下跳到末尾。
  await persistFavorites(draft.originalUrl
    ? browseFavorites.value.map((item) => (item.url === draft.originalUrl ? entry : item))
    : [...browseFavorites.value, entry])
  favoriteDraft.value = null
}

async function removeFavorite(item: BrowseFavorite): Promise<void> {
  await ensureFavorites()
  await persistFavorites(browseFavorites.value.filter((entry) => entry.url !== item.url))
  message.success(`已移除「${item.title}」`)
}

/** 原生网页视图盖在 Vue 之上：没有网页、或不在浏览页时收起来，起始页和重绘后的外壳才看得见。 */
function syncNativeVisibility() {
  const visible = Boolean(props.active && browsing.value && !readingPage.value && !startPageVisible.value)
  void window.api.browse.setVisible(visible).catch(() => {})
}

watch([browsing, () => props.active, readingPage, startPageVisible], syncNativeVisibility)

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
  if (!readingPage.value) return
  syncReadingPage()
  snapColumnPage()
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
    void loadStartRecent()
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
  // 手动打开新地址就是离开起始页：视图要跟着放出来，否则网页永远盖不住。
  showStartPage.value = false
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
function readingArticleEl(): HTMLElement | null {
  return readingViewportEl()?.querySelector('.web-reading-article') ?? null
}

/** 当前章的那一段 DOM：正文、标注、搜索都只在它里面找，不会串到下一章。 */
function activeSectionEl(): HTMLElement | null {
  const article = readingArticleEl()
  if (!article) return null
  return article.querySelector<HTMLElement>('.web-reading-section.is-active')
    ?? article.querySelector<HTMLElement>('.web-reading-section')
}

function readingViewportWidth(): number {
  return Math.max(1, readingViewportEl()?.clientWidth ?? 1)
}

/** 分栏模式下的总页数：横向内容有几个视口宽。 */
function readingColumnPageCount(el: HTMLElement): number {
  return columnPageCount(el.scrollWidth, Math.max(1, el.clientWidth))
}

/** 把横向滚动吸到整页：分栏排版停在两栏之间会露出半栏文字。 */
function snapColumnPage(): void {
  const el = readingViewportEl()
  if (!el || !readingColumns.value) return
  const width = Math.max(1, el.clientWidth)
  const target = columnScrollLeft(columnPageIndex(el.scrollLeft, width), width)
  if (Math.abs(el.scrollLeft - target) > 1) el.scrollLeft = target
}

/** 当前屏里阅读顺序最靠前的段落：先左栏，再从上到下。 */
function columnParagraphIndex(): number {
  const el = readingViewportEl()
  const article = activeSectionEl()
  if (!el || !article) return -1
  const viewport = el.getBoundingClientRect()
  const secondColumnFrom = viewport.left + viewport.width / 2
  let best: { band: number; top: number; index: number } | null = null
  const paragraphs = [...article.querySelectorAll('p')] as HTMLElement[]
  paragraphs.forEach((node, index) => {
    const rect = node.getBoundingClientRect()
    if (rect.bottom <= viewport.top + 1 || rect.top >= viewport.bottom - 1) return
    if (rect.right <= viewport.left + 1 || rect.left >= viewport.right - 1) return
    const band = readingColumns.value === 2 && rect.left >= secondColumnFrom ? 1 : 0
    const top = Math.max(0, rect.top - viewport.top)
    if (!best || band < best.band || (band === best.band && top < best.top)) best = { band, top, index }
  })
  const index = best?.index ?? -1
  readingCenterParagraph.value = index
  return index
}

/** 当前读到第几段：分栏按屏取，滚动按视口中心取。 */
function currentReadingAnchor(): number {
  if (!readingPage.value) return -1
  if (readingColumns.value) return columnParagraphIndex()
  if (readingCenterParagraph.value >= 0) return readingCenterParagraph.value
  return resolveParagraphAnchor()
}

/** 分栏模式：滚到某一段所在的那一屏。 */
function scrollToColumnParagraph(index: number, behavior: ScrollBehavior = 'auto'): void {
  const el = readingViewportEl()
  if (!el) return
  const width = Math.max(1, el.clientWidth)
  const article = activeSectionEl()
  const target = index >= 0 ? article?.querySelectorAll<HTMLElement>('p')[index] : undefined
  const articleEl = readingArticleEl()
  if (!target || !articleEl) {
    el.scrollTo({ left: 0, behavior })
    return
  }
  const pad = Number.parseFloat(getComputedStyle(articleEl).paddingLeft) || 0
  const offset = target.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft - pad
  el.scrollTo({ left: columnScrollLeft(columnPageForOffset(offset, width), width), behavior })
}

/** 当前屏起点附近是哪一章：连排时章界由滚动位置决定，而不是进场时那一章。 */
function sectionAtViewport(): BrowseReadingPage | null {
  const el = readingViewportEl()
  const article = readingArticleEl()
  if (!el || !article || readingSections.value.length < 1) return readingPage.value
  const rect = el.getBoundingClientRect()
  const sections = article.querySelectorAll<HTMLElement>('.web-reading-section')
  let current: HTMLElement | null = sections[0] ?? null
  if (readingColumns.value) {
    // 分栏后章是横向铺开的：看当前屏左侧落在哪一节的横向范围里。
    const probe = rect.left + Math.min(rect.width * 0.25, 160)
    for (const node of sections) {
      if (node.getBoundingClientRect().left <= probe) current = node
      else break
    }
  } else {
    const probe = rect.top + Math.min(el.clientHeight * 0.35, 260)
    for (const node of sections) {
      if (node.getBoundingClientRect().top <= probe) current = node
      else break
    }
  }
  const url = current?.dataset.section
  return readingSections.value.find((section) => section.url === url) ?? readingPage.value
}

/** 视口跨过章界：把「当前章」换成新的一章，界面与写盘都跟着走，滚动位置不动。 */
function activateSection(section: BrowseReadingPage | null): void {
  if (!section || readingPage.value?.url === section.url) return
  readingPage.value = section
  readingChapterTitle.value = section.chapter?.title || section.title
  readingParagraphIndex = 0
  readingCenterParagraph.value = -1
  webAiTitle.value = ''
  webAiResult.value = ''
  closeSelectionTools(false)
  closeInBookFind()
  void reloadWebMarks()
  void resolveWebBookDownloaded()
  void ensureReadingCatalog()
}

async function appendNextSection(): Promise<void> {
  const next = readingTailNext.value
  if (appendingSection.value || !next?.url) return
  if (readingSections.value.some((section) => section.url === next.url)) return
  appendingSection.value = true
  readingAppendError.value = ''
  try {
    const res = await window.api.browse.readingPage(next.url)
    if (!res.ok) { readingAppendError.value = res.message || '下一章没取到'; return }
    readingSections.value = [...readingSections.value, res.page].slice(-READING_SECTION_LIMIT)
    prefetchNeighborChapter()
  } catch (e: unknown) {
    readingAppendError.value = e instanceof Error ? e.message : '下一章没取到'
  } finally {
    appendingSection.value = false
  }
}

function syncReadingPage() {
  const el = readingViewportEl()
  if (!el) { readingPageIndex.value = 0; readingPageCount.value = 1; readingRatio.value = 0; return }
  if (readingColumns.value) {
    const width = Math.max(1, el.clientWidth)
    const count = readingColumnPageCount(el)
    readingPageCount.value = count
    readingPageIndex.value = Math.min(count - 1, columnPageIndex(el.scrollLeft, width))
    readingRatio.value = count > 1 ? readingPageIndex.value / (count - 1) : 0
    return
  }
  readingPageCount.value = visualPageCount(el.scrollHeight, el.clientHeight)
  readingPageIndex.value = visualPageIndex(el.scrollTop, el.scrollHeight, el.clientHeight)
  readingRatio.value = clampRatio(el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0)
}

/** 视口中心最近的段落下标，作为位置记忆的锚点；分栏时取当前屏最靠前的段落。 */
function resolveParagraphAnchor(): number {
  if (readingColumns.value) {
    const index = columnParagraphIndex()
    return index >= 0 ? index : 0
  }
  const el = readingViewportEl()
  const total = readingParagraphs.value.length
  if (!el || total === 0) return 0
  const article = activeSectionEl()
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
  if (readingColumns.value) {
    if (position.paragraphIndex >= 0) scrollToColumnParagraph(position.paragraphIndex)
    else {
      const count = readingColumnPageCount(el)
      const page = clampRatio(position.scrollRatio) * Math.max(0, count - 1)
      el.scrollLeft = columnScrollLeft(Math.round(page), Math.max(1, el.clientWidth))
    }
    readingCenterParagraph.value = position.paragraphIndex
    readingParagraphIndex = position.paragraphIndex
    syncReadingPage()
    if (readingRestoreTimer) clearTimeout(readingRestoreTimer)
    readingRestoreTimer = setTimeout(() => { readingRestoreTimer = null; readingRestoring = false }, 400)
    return
  }
  const article = activeSectionEl()
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
  if (readingColumns.value) {
    const width = Math.max(1, el.clientWidth)
    const count = readingColumnPageCount(el)
    const current = columnPageIndex(el.scrollLeft, width)
    const next = Math.max(0, Math.min(count - 1, current + direction))
    el.scrollTo({ left: columnScrollLeft(next, width), behavior })
    readingPageIndex.value = next
    return
  }
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
function turnReadingPage(delta: number, options: { keepAuto?: boolean } = {}) {
  const el = readingViewportEl()
  if (!el) return
  if (!options.keepAuto) stopAutoScroll()
  if (readingColumns.value) {
    const width = Math.max(1, el.clientWidth)
    const count = readingColumnPageCount(el)
    const next = columnPageIndex(el.scrollLeft, width) + delta
    if (next < 0) { void changeChapter('previous'); return }
    if (next > count - 1) { void changeChapter('next'); return }
    pageByScreen(delta > 0 ? 1 : -1)
    return
  }
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
  // 分栏是横向的：触控板横扫也当翻页，不再只认纵向滚轮。
  if (readingColumns.value && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    if (Math.abs(event.deltaX) < 8) return
    event.preventDefault()
    stopAutoScroll()
    turnReadingPage(event.deltaX > 0 ? 1 : -1)
    return
  }
  const direction = wheelPageDirection(event.deltaY)
  if (!direction) return
  event.preventDefault()
  stopAutoScroll()
  turnReadingPage(direction)
}

function onReadingScroll() {
  activateSection(sectionAtViewport())
  syncReadingPage()
  saveReadingPosition()
  if (selPopup.value) closeSelectionTools()
  maybeAppendNextSection()
  // 手势/触控板把分栏滚到两栏之间时，停下来后吸回整页。
  if (readingColumns.value) {
    if (columnSnapTimer) clearTimeout(columnSnapTimer)
    columnSnapTimer = setTimeout(() => { columnSnapTimer = null; snapColumnPage() }, 180)
  }
}

/** 滚到章末附近就把下一章接上来；超过窗口上限时 appendNextSection 自己丢最旧的一章。 */
function maybeAppendNextSection(): void {
  const el = readingViewportEl()
  if (!el || appendingSection.value) return
  if (readingColumns.value) {
    if (el.scrollWidth - el.scrollLeft - el.clientWidth > 260) return
  } else if (el.scrollHeight - el.scrollTop - el.clientHeight > 260) return
  if (!readingTailNext.value) return
  void appendNextSection()
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
  const el = activeSectionEl()?.querySelectorAll('p')[index] as HTMLElement | undefined
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
  const el = activeSectionEl()?.querySelectorAll('p')[hits[inBookFindIndex.value]!] as HTMLElement | undefined
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

function clearAutoPageTimer() {
  if (autoPageTimer) { clearTimeout(autoPageTimer); autoPageTimer = null }
}

function autoPageDelay(): number {
  return autoPageIntervalMs(webReading.value.autoSpeed)
}

/** 分栏模式没有纵向滚动：按节拍翻一页，章末照旧自动续章。 */
function startColumnAutoPage() {
  if (!readingPage.value) return
  autoScrolling.value = true
  const tick = (): void => {
    autoPageTimer = null
    if (!autoScrolling.value) return
    turnReadingPage(1, { keepAuto: true })
    saveReadingPosition()
    if (autoScrolling.value) autoPageTimer = setTimeout(tick, autoPageDelay())
  }
  autoPageTimer = setTimeout(tick, autoPageDelay())
}

function startAutoScroll() {
  if (!readingPage.value || autoScrolling.value) return
  if (readingColumns.value) { startColumnAutoPage(); return }
  autoScrolling.value = true
  lastAutoTickAt = 0
  autoScroll.start()
  autoScrollRaf = requestAnimationFrame(autoScrollStep)
}

function stopAutoScroll() {
  clearAutoPageTimer()
  if (!autoScrolling.value && autoScrollRaf == null) return
  autoScrolling.value = false
  autoScroll.stop()
  if (autoScrollRaf != null) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = null }
  lastAutoTickAt = 0
}

function toggleAutoScroll() {
  if (autoScrolling.value) {
    stopAutoScroll()
    message.info(readingColumns.value ? '已暂停自动翻页' : '已暂停自动滚动')
    return
  }
  startAutoScroll()
  if (!autoScrolling.value) return
  if (readingColumns.value) {
    message.info(`自动翻页中（每 ${Math.round(autoPageDelay() / 1000)} 秒一页，速度 ${webReading.value.autoSpeed}）`)
    return
  }
  message.info(`自动滚动中（${autoScrollSpeed.value} px/秒，速度 ${webReading.value.autoSpeed}）`)
}

// ---------------------------------------------------------------------------
// 听书
// ---------------------------------------------------------------------------

function scrollToParagraph(index: number) {
  const el = readingViewportEl()
  if (!el) return
  const behavior = readerScrollBehavior(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true)
  if (readingColumns.value) {
    scrollToColumnParagraph(index, behavior)
    return
  }
  const article = activeSectionEl()
  const paragraphs = article ? [...article.querySelectorAll('p')] : []
  const target = paragraphs[index] as HTMLElement | undefined
  if (!target) return
  const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - el.clientHeight * 0.4
  el.scrollTo({ top: Math.max(0, top), behavior })
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
const ttsSleepMinutes = computed(() => tts.sleepMinutes.value)
function setTtsSleepMinutes(minutes: number): void {
  tts.setSleepMinutes(minutes)
  message.info(minutes > 0 ? `听书将在 ${minutes} 分钟后停止` : '已取消定时停止')
}

// ---------------------------------------------------------------------------
// 进入 / 退出 / 翻章
// ---------------------------------------------------------------------------

function openReadingPage(page: BrowseReadingPage) {
  readingPage.value = page
  readingSections.value = [page]
  readingAppendError.value = ''
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
    if (el) { el.scrollTop = 0; el.scrollLeft = 0 }
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
  const anchor = currentReadingAnchor()
  readerPrefs.value = { ...readerPrefs.value, [key]: value }
  void window.api.settings.set({ reader: { [key]: value } })
  void nextTick(() => {
    const el = readingViewportEl()
    if (!el) return
    if (readingColumns.value) {
      // 字号 / 行距变了，栏宽跟着变：按段落锚点重新算在第几页。
      el.scrollTop = 0
      scrollToColumnParagraph(anchor)
      syncReadingPage()
      return
    }
    el.scrollLeft = 0
    syncReadingPage()
    if (readingPaged.value) el.scrollTop = scrollTopForVisualPage(readingPageIndex.value, el.scrollHeight, el.clientHeight)
  })
  saveReadingPosition()
}

function setWebReading<K extends keyof WebReadingPrefs>(key: K, value: WebReadingPrefs[K]) {
  webReading.value = { ...webReading.value, [key]: value }
  void window.api.settings.set({ webReading: { [key]: value } })
  if (key === 'autoSpeed' && autoScrolling.value) message.info(readingColumns.value ? `自动翻页间隔已调（${Math.round(autoPageDelay() / 1000)} 秒一页）` : `自动滚动速度 ${value}`)
}

/**
 * 翻页方式：滚动 / 单栏 / 双栏。
 * 换栏数时先把当前段落记下来，重排后回到同一段，不让读者丢位置。
 */
function setPageLayout(mode: 'scroll' | 'single' | 'double') {
  if (!readingPage.value) return
  if (mode === 'scroll') {
    if (!readingPaged.value) return
    const anchor = currentReadingAnchor()
    setReaderPref('readingMode', 'scroll')
    void nextTick(() => scrollToParagraph(anchor))
    return
  }
  const columns: 1 | 2 = mode === 'double' ? 2 : 1
  if (readingPaged.value && webReading.value.columns === columns) return
  const anchor = currentReadingAnchor()
  if (webReading.value.columns !== columns) setWebReading('columns', columns)
  if (!readingPaged.value) setReaderPref('readingMode', 'screen')
  else void nextTick(() => { scrollToColumnParagraph(anchor); syncReadingPage() })
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
  // 只在浏览页可见时响应：App 用 v-show 挂载，组件常驻，不加这道门控会在书库/设置页
  // 也把 Ctrl+F、Alt+方向键吃掉，对隐藏的网页发无效 IPC。
  if (!props.active) return
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
  if (event.ctrlKey && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    if (!readingPage.value && browsing.value) findOpen.value = true
    return
  }
  if (event.ctrlKey && event.key.toLowerCase() === 'd' && !readingPage.value && !startPageVisible.value) {
    event.preventDefault()
    void toggleCurrentSiteFavorite()
    return
  }
  if (!readingPage.value && !browsing.value && event.key === '/') {
    event.preventDefault()
    startInput.value?.focus()
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
  // 镜像与下载共用同一个隐藏视图：两边同时跑会互相踩导航。
  if (mirrorRunning.value) {
    message.warning('整站镜像进行中，等它结束再下载单本')
    return
  }
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
  let res: Awaited<ReturnType<typeof window.api.download.confirm>>
  try {
    res = await window.api.download.confirm(token)
  } catch {
    // IPC reject 也要复位，否则按钮永久 loading、「下载本书」永久禁用。
    downloading.value = false
    message.error('下载失败，请重新预览')
    return
  }
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

async function openMirror() {
  if (!state.value.url || state.value.url === 'about:blank') return
  mirrorError.value = ''
  showMirror.value = true
  try {
    const res = await window.api.mirror.state()
    if (res.ok && res.state.last) mirrorProgress.value = res.state.last
  } catch {
    /* 读不到上次状态不影响开始 */
  }
}

async function startMirrorJob(resume = false) {
  if (mirrorRunning.value) return
  if (downloading.value) {
    message.warning('下载任务进行中，等它结束再镜像')
    return
  }
  mirrorError.value = ''
  // 续跑用上次保存的种子地址：用户可能已经翻到别的页，任务仍属于原列表页。
  const seedUrl = resume && mirrorProgress.value?.seedUrl
    ? mirrorProgress.value.seedUrl
    : (state.value.url || address.value)
  if (!seedUrl || seedUrl === 'about:blank') {
    mirrorError.value = '请先打开分类页、作者页或搜索结果页'
    return
  }
  mirrorBusy.value = true
  try {
    const res = await window.api.mirror.start({
      seedUrl,
      maxBooks: mirrorMaxBooks.value ?? 10,
      maxPages: mirrorMaxPages.value ?? 3,
      ...(resume ? { resume: true } : {}),
    })
    if (!res.ok) {
      mirrorError.value = res.message
      return
    }
    if (!resume) {
      mirrorProgress.value = {
        jobId: res.jobId,
        seedUrl,
        status: 'running',
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        pagesScanned: 0,
        results: [],
        plan: [],
      }
    } else if (mirrorProgress.value) {
      mirrorProgress.value = { ...mirrorProgress.value, jobId: res.jobId, status: 'running', message: undefined }
    }
  } catch (error) {
    mirrorError.value = error instanceof Error ? error.message : '镜像启动失败'
  } finally {
    mirrorBusy.value = false
  }
}

async function cancelMirrorJob() {
  try {
    await window.api.mirror.cancel()
  } catch {
    /* 取消失败时等进度事件收口 */
  }
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
  void loadStartRecent()
  void ensureFavorites()
  syncNativeVisibility()
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
      if (p.status === 'done') void loadStartRecent()
    }
  }))
  unsubs.push(window.api.mirror.onProgress((progress) => { mirrorProgress.value = progress }))
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
    <div v-show="!readingPage" class="browse-body">
      <aside class="browse-side" aria-label="浏览辅助">
        <section class="side-block">
          <p class="side-label">当前站点</p>
          <div class="browser-action-row">
            <div class="site-status" :class="{ inactive: !currentHost() }" :title="siteLabel">
              <span>{{ siteLabel }}</span>
            </div>
            <div class="browser-actions">
              <n-button
                type="primary"
                size="small"
                :disabled="downloading || mirrorRunning || !address"
                :loading="previewing || downloading"
                @click.prevent="startDownload"
              >
                下载本书
              </n-button>
              <n-button
                size="small"
                secondary
                :disabled="mirrorRunning || !state.url"
                @click.prevent="openMirror"
              >
                {{ mirrorRunning ? '镜像中…' : '整站镜像' }}
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
                  <div class="side-inline">
                    <button type="button" aria-label="缩小网页" @click.prevent="setZoom(-0.1)">－</button>
                    <button type="button" title="恢复默认缩放" @click.prevent="setZoom('reset')">{{ Math.round(state.zoom * 100) }}%</button>
                    <button type="button" aria-label="放大网页" @click.prevent="setZoom(0.1)">＋</button>
                  </div>
                  <button type="button" class="side-tool" @click.prevent="findOpen ? closeFind() : findOpen = true">{{ findOpen ? '关闭查找' : '网页查找' }}</button>
                  <button type="button" class="side-tool" @click.prevent="hideAction(hidePicking ? 'stop' : 'start')">{{ hidePicking ? '退出点选' : '点选隐藏' }}</button>
                  <button type="button" class="side-tool" :disabled="hiddenCount === 0" @click.prevent="hideAction('undo')">撤销隐藏{{ hiddenCount ? `（${hiddenCount}）` : '' }}</button>
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
        </section>

        <section class="side-block side-fav" aria-label="常用网站">
          <div class="side-head">
            <span class="side-label">常用网站</span>
            <span class="side-fav-head-actions">
              <span v-if="browseFavorites.length" class="side-count">{{ String(browseFavorites.length).padStart(2, '0') }}</span>
              <button type="button" class="side-fav-add" title="添加常用网站" @click="openFavoriteManager">＋</button>
            </span>
          </div>
          <ul v-if="browseFavorites.length" class="side-fav-list">
            <li v-for="item in browseFavorites" :key="item.url">
              <div class="side-fav-row" :class="{ current: currentFavorite?.url === item.url }">
                <button type="button" class="side-fav-main" :title="item.url" @click="openFavorite(item)">
                  <span class="side-fav-badge" :style="{ '--fav-color': favoriteColor(item.url) }">{{ favoriteInitial(item) }}</span>
                  <span class="side-fav-text">
                    <span class="side-fav-title">{{ item.title }}</span>
                    <span class="side-fav-host">{{ hostOf(item.url) }}</span>
                  </span>
                </button>
                <span class="side-fav-tools">
                  <button type="button" title="改名" @click="openStartPage(); startFavoriteDraft(item)">改名</button>
                  <button type="button" title="移除" @click="removeFavorite(item)">移除</button>
                </span>
              </div>
            </li>
          </ul>
          <button v-else type="button" class="side-fav-empty" @click="openFavoriteManager">
            还没有常用网站<br /><small>点地址栏右侧的星标，或点这里添加</small>
          </button>
        </section>

        <section class="side-block side-recent">
          <div class="side-head">
            <span class="side-label">继续阅读</span>
            <span v-if="recentBooks.length" class="side-count">{{ String(recentBooks.length).padStart(2, '0') }}</span>
          </div>
          <ul v-if="recentBooks.length" class="recent-list">
            <li v-for="(item, index) in recentBooks" :key="item.key">
              <button type="button" class="recent-row" @click="openRecent(item)">
                <span class="recent-index" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
                <span
                  class="recent-thumb"
                  :class="{ 'has-cover': item.cover }"
                  :style="item.cover ? { backgroundImage: `url(${item.cover})` } : undefined"
                ><template v-if="!item.cover">{{ item.title.slice(0, 1) }}</template></span>
                <span class="recent-text">
                  <span class="recent-title">{{ item.title }}</span>
                  <span class="recent-meta">{{ item.meta }}</span>
                </span>
              </button>
            </li>
          </ul>
          <div v-else class="recent-empty">
            <p><strong>书架还是空的</strong>打开一个小说站，点「加书架」或下载本书。</p>
          </div>
        </section>

        <p class="side-note">正文只在本机渲染<br />阅读模式不落盘</p>
      </aside>

      <div class="browse-main">
        <form v-show="!toolbarCollapsed && !readingPage" class="browse-toolbar" @submit="onSubmit">
          <div class="browser-nav-row">
            <div class="nav-group">
              <button
                class="browser-icon-button"
                type="button"
                title="起始页（常用网站）"
                aria-label="回到起始页"
                :disabled="startPageVisible"
                @click="openStartPage"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20h-5.5v-6h-5v6H4z" /></svg>
              </button>
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
            </div>
            <label class="address-field">
              <svg class="address-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
              <input v-model="address" aria-label="网页地址" placeholder="粘贴或输入网址，回车打开" spellcheck="false" />
              <button
                class="address-star"
                type="button"
                :class="{ saved: Boolean(currentFavorite) }"
                :disabled="!currentHost() || startPageVisible"
                :title="currentFavorite ? '已收藏本站，点击取消' : '收藏本站（Ctrl+D）'"
                :aria-label="currentFavorite ? '取消收藏本站' : '收藏本站'"
                :aria-pressed="Boolean(currentFavorite)"
                @click.prevent="toggleCurrentSiteFavorite"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.5 5.1 5.6.8-4 4 1 5.6-5-2.7-5 2.7 1-5.6-4-4 5.6-.8z" /></svg>
              </button>
              <span class="address-hint" aria-hidden="true">Enter</span>

            </label>
            <button class="browser-open-button" type="submit">打开</button>
          </div>
          <div v-if="state.loading" class="browse-loading" aria-hidden="true"><span /></div>
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

        <div v-show="!readingPage" class="browse-canvas">
          <section v-if="!readingPage && (!browsing || startPageVisible)" class="start-page" aria-label="起始页">
            <div class="start-grid" aria-hidden="true"><span class="start-glow" /></div>
            <div class="start-stage">
              <div class="start-top">
                <span class="start-kicker"><span class="start-dot" aria-hidden="true" />本地阅读终端</span>
                <span class="start-top-note">离线书库 · 自备 AI</span>
              </div>
              <h1 class="start-title">把想读的故事，<br /><em>都留在本机。</em></h1>
              <p class="start-sub">粘贴小说站地址开始浏览。读到喜欢的书，一键下载进本地书库，没网也能接着读。网页正文只在本机渲染，阅读模式不落盘。</p>
              <form class="start-search" @submit="onSubmit">
                <span class="start-prompt" aria-hidden="true">›</span>
                <input
                  ref="startInput"
                  v-model="address"
                  aria-label="起始页网址"
                  placeholder="粘贴或输入小说站网址，回车开始"
                  spellcheck="false"
                />
                <button type="submit">开始浏览</button>
              </form>
              <ul class="start-meta">
                <li><b>本地书库</b><span>下载后离线可读</span></li>
                <li><b>阅读模式</b><span>去广告 · 可排版</span></li>
                <li><b>AI 助手</b><span>自备 API Key</span></li>
              </ul>
              <p class="start-foot">Alt＋↑↓ 换章 · Ctrl＋F 网页查找</p>
            </div>

            <section class="start-fav" aria-label="常用网站">
              <div class="start-fav-head">
                <span class="start-fav-label">常用网站</span>
                <button type="button" class="start-fav-add" @click="startFavoriteDraft()">＋ 添加</button>
              </div>
              <form v-if="favoriteDraft" class="start-fav-editor" @submit.prevent="saveFavoriteDraft">
                <label>
                  <span>名称</span>
                  <input v-model="favoriteDraft.title" placeholder="站点或书名" maxlength="60" />
                </label>
                <label class="url">
                  <span>网址</span>
                  <input v-model="favoriteDraft.url" placeholder="https://example.com/book/123" spellcheck="false" />
                </label>
                <div class="start-fav-editor-actions">
                  <button type="submit" class="primary" :disabled="!favoriteDraft.url.trim()">保存</button>
                  <button type="button" @click="cancelFavoriteDraft">取消</button>
                </div>
              </form>
              <ul v-if="browseFavorites.length" class="start-fav-grid">
                <li v-for="item in browseFavorites" :key="item.url">
                  <article class="start-fav-card">
                    <button type="button" class="start-fav-main" :title="item.url" @click="openFavorite(item)">
                      <span class="start-fav-badge" :style="{ '--fav-color': favoriteColor(item.url) }">{{ favoriteInitial(item) }}</span>
                      <span class="start-fav-text">
                        <strong>{{ item.title }}</strong>
                        <small>{{ hostOf(item.url) }}</small>
                      </span>
                    </button>
                    <div class="start-fav-tools">
                      <button type="button" @click="startFavoriteDraft(item)">改名</button>
                      <button type="button" @click="removeFavorite(item)">移除</button>
                    </div>
                  </article>
                </li>
              </ul>
              <p v-else-if="!favoriteDraft" class="start-fav-empty">
                还没有常用网站：打开一个小说站，点地址栏右侧的星标就能收进来。
              </p>
            </section>
          </section>

          <div ref="slot" v-show="!readingPage" class="browse-slot" />
        </div>
      </div>
    </div>

    <div
      v-if="readingPage"
      ref="readingStage"
      class="web-reading-stage"
      :class="{ paged: readingPaged, 'cols-2': readingColumns === 2, 'tools-hidden': !readingToolsVisible, 'catalog-open': catalogOpen }"
      :style="readingStyle"
      @mousemove="scheduleReadingTools"
      @click.self="readingToolsVisible = !readingToolsVisible"
    >
      <header
        v-show="readingToolsVisible || readingToolsLocked"
        class="web-reading-chrome top"
        @mouseenter="clearReadingHideTimer"
      >
        <button type="button" title="返回原网页（Esc）" @click="exitReadingMode"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg><span>返回</span></button>
        <span class="web-reading-title" :title="readingChapterLabel">{{ readingChapterLabel }}</span>
        <!-- 图标 + 文字：和书库阅读器的顶栏同一套图形与字号，两个阅读入口看着才是同一个软件。 -->
        <div class="web-chrome-actions">
          <button type="button" @click="openCatalog"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg><span>目录</span></button>
          <button type="button" @click="openInBookFind"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg><span>搜索</span></button>
          <button type="button" @click="marksOpen = true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z"/></svg><span>标记</span></button>
          <span class="web-chrome-sep" aria-hidden="true"></span>
          <button type="button" class="secondary" :class="{ active: autoScrolling }" @click="toggleAutoScroll">
            <svg v-if="autoScrolling" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>
            <span>{{ autoScrolling ? '暂停' : '自动' }}</span>
          </button>
          <button type="button" class="secondary" :class="{ active: ttsSpeaking }" @click="toggleTts"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h4l5 4V6L9 10z"/><path d="M18 9a5 5 0 0 1 0 6"/></svg><span>{{ ttsSpeaking ? '停止' : '听书' }}</span></button>
          <button type="button" class="secondary" :class="{ active: webAiPanelOpen }" @click="toggleWebAiPanel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 9.8 8.8 4 11l5.8 2.2L12 19l2.2-5.8L20 11l-5.8-2.2z"/></svg><span>AI</span></button>
          <span class="web-chrome-sep" aria-hidden="true"></span>
          <button type="button" :disabled="shelfSaving" @click="addCurrentToShelf"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H18v18H6.5A2.5 2.5 0 0 1 4 18.5z"/><path d="M11 9v6M8 12h6"/></svg><span>加书架</span></button>
          <button type="button" :class="{ active: readingPanel }" @click="readingPanel = !readingPanel; webAiPanelOpen = false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h9M4 11h16M4 16h12M4 21h8"/></svg><span>排版</span></button>
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
          <button type="button" class="swatch swatch-paper" :class="{ active: readerPrefs.theme === 'paper' }" @click="setReaderPref('theme', 'paper')">纸白</button>
          <button type="button" class="swatch swatch-sepia" :class="{ active: readerPrefs.theme === 'sepia' }" @click="setReaderPref('theme', 'sepia')">暖黄</button>
          <button type="button" class="swatch swatch-gray" :class="{ active: readerPrefs.theme === 'gray' }" @click="setReaderPref('theme', 'gray')">柔灰</button>
          <button type="button" class="swatch swatch-night" :class="{ active: readerPrefs.theme === 'night' }" @click="setReaderPref('theme', 'night')">夜间</button>
        </div>
        <div class="web-panel-row">
          <span>字号</span>
          <button type="button" @click="setReaderPref('fontSize', Math.max(12, readerPrefs.fontSize - 1))">A−</button>
          <strong>{{ readerPrefs.fontSize }}</strong>
          <button type="button" @click="setReaderPref('fontSize', Math.min(36, readerPrefs.fontSize + 1))">A＋</button>
        </div>
        <div class="web-panel-row">
          <span>翻页</span>
          <button type="button" :class="{ active: !readingPaged }" @click="setPageLayout('scroll')">滚动</button>
          <button type="button" :class="{ active: readingPaged && readingColumns === 1 }" @click="setPageLayout('single')">单栏</button>
          <button type="button" :class="{ active: readingPaged && readingColumns === 2 }" @click="setPageLayout('double')">双栏</button>
          <em class="web-panel-note">翻页时左右整屏换页；双栏像摊开的书，两页一起翻</em>
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
        <div class="web-panel-row">
          <span>听书</span>
          <button
            v-for="option in [{ v: 0, l: '不限时' }, { v: 10, l: '10 分' }, { v: 20, l: '20 分' }, { v: 30, l: '30 分' }, { v: 60, l: '60 分' }]"
            :key="option.v"
            type="button"
            :class="{ active: ttsSleepMinutes === option.v }"
            @click="setTtsSleepMinutes(option.v)"
          >{{ option.l }}</button>
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
              :disabled="previewing || downloading || mirrorRunning"
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
        :class="{ 'reading-columns': readingColumns > 0, 'reading-columns-1': readingColumns === 1, 'reading-columns-2': readingColumns === 2 }"
        @scroll.passive="onReadingScroll"
        @wheel="onReadingWheel"
        @mouseup="onReadingMouseup"
        @touchstart.passive="stopAutoScroll"
      >
        <article class="web-reading-article">
          <section
            v-for="section in readingSections"
            :key="section.url"
            class="web-reading-section"
            :class="{ 'is-active': section.url === readingPage?.url }"
            :data-section="section.url"
          >
            <h1>{{ section.title }}</h1>
            <template v-if="section.url === readingPage?.url">
              <p
                v-for="(paragraph, i) in readingParagraphs"
                :key="i"
                :data-p="i"
                :class="{ focused: focusedParagraph(i), speaking: ttsSpeaking && ttsSpokenPara === i }"
              ><template v-for="(seg, j) in readingParagraphSegments(i)" :key="j"><mark v-if="seg.hit" class="web-hit">{{ seg.text }}</mark><mark v-else-if="seg.hl" class="web-hl">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></p>
            </template>
            <template v-else>
              <p v-for="(paragraph, i) in sectionParagraphs(section)" :key="i">{{ paragraph }}</p>
            </template>
          </section>
          <div class="web-reading-end">
            <template v-if="readingTailNext">
              <span>{{ appendingSection ? '正在接上下一章…' : '继续往下读' }}</span>
              <button type="button" :disabled="appendingSection" @click="appendNextSection">
                {{ readingTailNext.title ? `接上 · ${readingTailNext.title}` : '接上下一章' }}
              </button>
            </template>
            <template v-else>
              <span>{{ autoScrolling ? '自动滚动中…' : '全书读完' }}</span>
            </template>
            <span v-if="readingAppendError" class="web-reading-append-error">{{ readingAppendError }}</span>
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

    <!-- 整站镜像：列表页批量入书库 -->
    <n-drawer v-model:show="showMirror" placement="right" :width="440">
      <n-drawer-content title="整站镜像" closable>
        <div class="mirror-panel">
          <p class="mirror-hint">从当前分类 / 作者 / 搜索结果页批量下载同站的书。每本都走「下载本书」同一条通道，按本串行。</p>
          <div class="mirror-options">
            <label>最多本数
              <n-input-number v-model:value="mirrorMaxBooks" size="small" :min="1" :max="50" />
            </label>
            <label>最多页数
              <n-input-number v-model:value="mirrorMaxPages" size="small" :min="1" :max="10" />
            </label>
          </div>
          <div class="mirror-actions">
            <n-button type="primary" size="small" :loading="mirrorBusy" :disabled="mirrorRunning || downloading" @click="startMirrorJob()">开始镜像</n-button>
            <n-button v-if="mirrorCanResume" size="small" secondary :loading="mirrorBusy" :disabled="mirrorRunning || downloading" @click="startMirrorJob(true)">继续上次</n-button>
            <n-button size="small" quaternary type="error" :disabled="!mirrorRunning" @click="cancelMirrorJob">取消镜像</n-button>
          </div>
          <div v-if="mirrorError" class="dl-error" role="alert">{{ mirrorError }}</div>
          <div v-if="mirrorProgress" class="dl-progress">
            <div class="dl-title">{{ mirrorStatusText }} · {{ mirrorProgress.seedUrl }}</div>
            <n-progress
              type="line"
              :percentage="mirrorProgress.total > 0 ? Math.round((mirrorProgress.done + mirrorProgress.failed + mirrorProgress.skipped) / mirrorProgress.total * 100) : 0"
              :status="mirrorProgress.status === 'error' ? 'error' : mirrorProgress.status === 'done' ? 'success' : mirrorProgress.status === 'cancelled' ? 'warning' : 'default'"
            />
            <div class="dl-stats">
              <span>已下 {{ mirrorProgress.done }} / 跳过 {{ mirrorProgress.skipped }} / 失败 {{ mirrorProgress.failed }} / 共 {{ mirrorProgress.total }} 本</span>
              <span>已扫描 {{ mirrorProgress.pagesScanned }} 页</span>
            </div>
            <div v-if="mirrorProgress.currentTitle" class="dl-current">正在下载：{{ mirrorProgress.currentTitle }}</div>
            <div v-if="mirrorProgress.message" class="dl-error">{{ mirrorProgress.message }}</div>
            <ul v-if="mirrorRecentResults.length > 0" class="mirror-results">
              <li v-for="item in mirrorRecentResults" :key="item.url">
                <span class="mirror-name">{{ item.title }}</span>
                <n-tag
                  size="small"
                  :type="item.status === 'downloaded' ? 'success' : item.status === 'skipped' ? 'info' : 'error'"
                >
                  {{ item.status === 'downloaded' ? '已入库' : item.status === 'skipped' ? '已在书库' : '失败' }}
                </n-tag>
                <span v-if="item.message" class="mirror-reason">{{ item.message }}</span>
              </li>
            </ul>
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.browse-page {
  color: var(--text-primary);
  background: var(--app-bg);
}

/* 章节工具条：与命令条同一套发丝线语言 */
.web-reading-controls, .web-find-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin: 8px 16px 0;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-1) 82%, transparent);
  box-shadow: var(--shadow-card);
  backdrop-filter: blur(18px) saturate(140%);
  z-index: 2;
}

.web-reading-controls button, .web-find-row button {
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  padding: 6px 10px;
  font: 12px/1 var(--font-ui);
  cursor: pointer;
  transition: background var(--motion-duration) var(--motion-easing), color var(--motion-duration) var(--motion-easing);
}

.web-reading-controls button:hover:not(:disabled), .web-find-row button:hover:not(:disabled) { background: color-mix(in srgb, var(--focus) 10%, transparent); color: var(--text-primary); }
.web-current-site {
  min-width: 0;
  max-width: 32ch;
  overflow: hidden;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-secondary);
  font: 11px/1.3 var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.web-more { min-width: 0; margin-left: auto; }
.web-more[open] { flex: 1 0 100%; }
.web-more-content { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); padding-top: var(--space-2); }
.web-shortcut-hint { margin-left: auto; padding-right: 6px; }
.web-more summary, .browser-more summary { list-style: none; border: 1px solid var(--border); border-radius: 8px; padding: 5px 10px; color: var(--text-secondary); background: var(--surface-1); font: 11px/1.4 var(--font-mono); cursor: pointer; transition: border-color var(--motion-duration) var(--motion-easing), color var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing); }
.web-more summary::-webkit-details-marker, .browser-more summary::-webkit-details-marker { display: none; }
.web-more summary:hover, .browser-more summary:hover { border-color: color-mix(in srgb, var(--focus) 40%, transparent); background: color-mix(in srgb, var(--focus) 8%, transparent); color: var(--focus); }
.web-more summary:focus-visible, .browser-more summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.web-reading-controls button:disabled { opacity: 0.45; cursor: default; }
.web-shortcut-hint { color: var(--text-muted); font-size: 12px; }
.web-find-row input { min-width: 160px; flex: 1; padding: 6px 10px; border: 1px solid color-mix(in srgb, var(--border) 85%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--surface-2) 80%, transparent); color: var(--text-primary); font: inherit; font-size: 13px; }
.web-find-row span { min-width: 70px; text-align: center; }
/* 阅读模式是沉浸层：正文自己滚，工具条浮在上面，不占正文高度。 */
.web-reading-stage { position: relative; flex: 1; min-height: 0; overflow: hidden; background: var(--web-outer); color: var(--web-ink); }
.web-reading-viewport {
  position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden;
  background: var(--web-outer); scrollbar-width: none; overscroll-behavior: contain;
}
.web-reading-viewport::-webkit-scrollbar { width: 0; height: 0; }
/* 与书库阅读器的 .reader-toolbar 同一把尺子：56px 高、24px 内边距、13px 字。
   两个阅读入口长得像同一家做的，比各写一套更容易维护。 */
.web-reading-chrome {
  position: absolute; z-index: 4;
  display: flex; align-items: center; gap: 4px; min-height: 56px; padding: 6px 24px;
  color: var(--web-ink); background: color-mix(in srgb, var(--web-paper) 94%, transparent);
  backdrop-filter: blur(6px); transition: opacity 160ms ease, transform 160ms ease;
}
.web-reading-chrome.top { top: 0; left: 0; right: 0; border-bottom: 1px solid color-mix(in srgb, var(--web-ink) 12%, transparent); }
/* 底栏改成和书库阅读器一样的深色浮层胶囊：同样是「阅读时浮在纸上的控制条」。
   原来是一条通栏白条，跟另一个阅读器完全不是一套语言。 */
.web-reading-chrome.bottom {
  left: 50%; right: auto; transform: translateX(-50%);
  bottom: 18px; width: max-content; max-width: calc(100% - 32px);
  min-height: 0; padding: 7px 10px; border: 1px solid rgba(233, 220, 188, 0.16); border-radius: 18px;
  background: rgba(24, 28, 25, 0.88); color: rgba(244, 235, 211, 0.82);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 245, 216, 0.08);
  backdrop-filter: blur(14px) saturate(0.82);
}
.web-reading-stage.tools-hidden .web-reading-chrome { opacity: 0; pointer-events: none; }
.web-reading-stage.tools-hidden .web-reading-chrome.top { transform: translateY(-100%); }
.web-reading-stage.tools-hidden .web-reading-chrome.bottom { transform: translate(-50%, 100%); }
.web-reading-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.web-chrome-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.web-reading-chrome button, .web-reading-panel button, .catalog-head button {
  border: 0; border-radius: 8px; background: transparent; color: inherit;
  padding: 6px 10px; font-size: 13px; line-height: 1.4; cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.web-reading-chrome button:hover { background: color-mix(in srgb, var(--web-ink) 8%, transparent); }
.web-reading-chrome.bottom button { color: rgba(244, 235, 211, 0.86); }
.web-reading-chrome.bottom button:hover { background: rgba(244, 235, 211, 0.12); }
.web-reading-chrome.bottom button:disabled { color: rgba(244, 235, 211, 0.34); }
/* 图标 + 文字：尺寸与书库阅读器顶栏一致（16px 图标、4px 间距、13px 字）。 */
.web-reading-chrome.top button {
  display: inline-flex; align-items: center; gap: 4px;
}
.web-reading-chrome.top button svg {
  width: 16px; height: 16px; flex: 0 0 auto;
  fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round;
}

/* 顶栏里的次要动作（自动 / 听书 / 加书架）压一档，别和「目录 / 搜索 / 标记」抢注意力。 */
.web-reading-chrome.top .web-chrome-actions button.secondary { color: color-mix(in srgb, var(--web-ink) 58%, transparent); }
.web-reading-chrome.top .web-chrome-actions button.secondary:hover { color: var(--web-ink); }
/* 分组竖线：导航动作 | 朗读 / 自动 / AI | 书架 / 排版 */
.web-chrome-sep { width: 1px; height: 16px; margin: 0 6px; background: color-mix(in srgb, var(--web-ink) 14%, transparent); }
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
.web-panel-note { flex-basis: 100%; font-size: 11px; font-style: normal; opacity: 0.55; }
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
  min-height: 100%; padding: 56px clamp(28px, 6vw, 72px) 96px;
  background: var(--web-paper); color: var(--web-ink);
  font: var(--web-size)/var(--web-line) var(--web-font); white-space: pre-wrap; overflow-wrap: anywhere;
}
/* 单栏 / 双栏：正文按栏横向铺开，一屏就是一页。
   栏距取两倍左右留白，于是每栏步长恰好是「一屏宽 ÷ 栏数」，翻页按屏对齐。 */
.web-reading-viewport.reading-columns { overflow-x: auto; overflow-y: hidden; }
.web-reading-viewport.reading-columns .web-reading-article {
  width: 100%; min-height: 0; height: 100%; margin: 0;
  padding: 56px var(--web-col-pad) 64px;
  column-gap: calc(var(--web-col-pad) * 2);
  column-fill: auto;
}
.web-reading-viewport.reading-columns-1 .web-reading-article { column-count: 1; }
/* 一屏一页时也得守版心：原先 width:100% 把行宽拉到整个窗口（18px 下一行 59 字，远超中文舒服的 30~40 字）。
   左右内边距按「(窗口宽 - 版心宽) / 2」算，翻页步长仍是一屏宽，所以页对齐不受影响。 */
.web-reading-viewport.reading-columns-1 .web-reading-article {
  padding-left: max(24px, calc((100% - var(--web-width)) / 2));
  padding-right: max(24px, calc((100% - var(--web-width)) / 2));
}
.web-reading-viewport.reading-columns-2 .web-reading-article { column-count: 2; }
.web-reading-section + .web-reading-section {
  margin-top: 3em;
  padding-top: 2.4em;
  border-top: 1px solid color-mix(in srgb, var(--web-ink) 12%, transparent);
}
/* 背景四个档位的类名（swatch-paper/sepia/gray/night）之前只有类名没有样式，
   面板上只是四个一样的灰胶囊，点之前看不出纸色。补一枚圆点色卡。 */
.web-reading-panel .swatch { display: inline-flex; align-items: center; gap: 6px; }
.web-reading-panel .swatch::before {
  content: ''; width: 12px; height: 12px; border-radius: 50%;
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  flex: 0 0 auto;
}
.web-reading-panel .swatch-paper::before { background: #fbf8f0; }
.web-reading-panel .swatch-sepia::before { background: #f1e2c4; }
.web-reading-panel .swatch-gray::before { background: #e6e7e3; }
.web-reading-panel .swatch-night::before { background: #1a211d; }

.web-reading-append-error { color: var(--negative, #d64545); }

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

/* 两栏：左侧常驻上下文栏，右侧命令条 + 网页 / 起始页 */
.browse-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.browse-side {
  display: flex;
  flex: 0 0 264px;
  flex-direction: column;
  gap: 10px;
  width: 264px;
  padding: 12px;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-1) 42%, transparent);
}

.browse-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.side-block {
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-1);
}

.side-label {
  margin: 0;
  color: var(--text-muted);
  font: 10px/1.4 var(--font-mono);
  letter-spacing: 0.14em;
}

.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.side-count {
  color: var(--focus);
  font: 10px/1 var(--font-mono);
}

/* 侧栏常用网站：起始页是完整的管理面，这里只保证「收藏完随时能点回去」。 */
.side-fav {
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  max-height: 38%;
  min-height: 0;
}

.side-fav-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.side-fav-add {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  font: 12px/1 var(--font-mono);
  cursor: pointer;
}

.side-fav-add:hover {
  border-color: var(--hover-line);
  color: var(--text-primary);
  background: var(--hover);
}

.side-fav-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.side-fav-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 7px;
  transition: background var(--motion-duration) var(--motion-easing);
}

.side-fav-row:hover { background: var(--hover); }
.side-fav-row.current { background: color-mix(in srgb, var(--focus) 10%, transparent); }

.side-fav-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 4px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.side-fav-badge {
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  background: color-mix(in srgb, var(--fav-color, var(--focus)) 18%, transparent);
  color: var(--fav-color, var(--focus));
  font: 600 11px/1 var(--font-mono);
}

.side-fav-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.side-fav-title,
.side-fav-host {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-fav-title { color: var(--text-primary); font-size: 12px; font-weight: 600; }
.side-fav-host { color: var(--text-muted); font: 10px/1.3 var(--font-mono); }

.side-fav-tools {
  display: flex;
  flex: 0 0 auto;
  gap: 1px;
  padding-right: 3px;
  opacity: 0;
  transition: opacity var(--motion-duration) var(--motion-easing);
}

.side-fav-row:hover .side-fav-tools,
.side-fav-row:focus-within .side-fav-tools { opacity: 1; }

.side-fav-tools button {
  padding: 2px 5px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}

.side-fav-tools button:hover { background: var(--hover); color: var(--text-primary); }

.side-fav-empty {
  width: 100%;
  padding: 10px 8px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
  cursor: pointer;
}

.side-fav-empty small { font-size: 11px; opacity: 0.8; }
.side-fav-empty:hover { border-color: var(--hover-line); color: var(--text-secondary); }

.side-recent {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 180px;
  padding-bottom: 4px;
}

.side-note {
  margin: 0 2px;
  color: var(--text-muted);
  font: 10px/1.7 var(--font-mono);
  letter-spacing: 0.06em;
}

.browse-side .browser-action-row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  min-height: 0;
  margin: 8px 0 0;
  padding: 0;
  border-top: 0;
}

.browse-side .site-status {
  font-size: 11px;
}

.browse-side .browser-actions {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}

.browse-side .browser-actions :deep(.n-button) {
  width: 100%;
  justify-content: flex-start;
}

.browse-side .browser-more {
  width: 100%;
}

.browse-side .browser-more summary {
  width: 100%;
  /* 它和上面两颗 secondary 按钮同一列，但原来是 11px 等宽字 + 白底描边，
     看着就像一个输入框。这里拉回按钮的字形字号並补一个展开箭头。 */
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 6px 10px;
  font: inherit; font-size: 13px;
  color: var(--text-secondary);
}
.browse-side .browser-more summary::after {
  content: '▾'; font-size: 10px; line-height: 1; opacity: 0.7;
}
.browse-side .browser-more[open] summary::after { content: '▴'; }

.browse-side .browser-more-content {
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 6px;
  padding-top: 8px;
}

.side-inline {
  display: flex;
  gap: 4px;
}

.side-inline button,
.side-tool {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-1);
  color: var(--text-secondary);
  font: 11px/1 var(--font-mono);
  cursor: pointer;
}

.side-inline button {
  flex: 1;
  padding: 6px 4px;
}

.side-tool {
  width: 100%;
  text-align: left;
}

.side-inline button:hover,
.side-tool:hover:not(:disabled) {
  border-color: var(--hover-line);
  color: var(--text-primary);
  background: var(--surface-2);
}

.side-tool:disabled {
  color: var(--disabled);
  cursor: default;
}

.browse-canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.browse-slot {
  position: absolute;
  inset: 0;
}

/* 命令条：只有导航与地址，操作搬到左栏 */
.browse-toolbar {
  position: relative;
  z-index: 3;
  display: block;
  height: auto;
  margin: 12px 14px 0;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-1) 86%, transparent);
  box-shadow: var(--shadow-card);
  backdrop-filter: blur(20px) saturate(140%);
}

.browser-nav-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 2px;
}

.nav-group {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-1);
}

.nav-group .browser-icon-button + .browser-icon-button {
  border-left: 1px solid var(--border);
}

.address-field {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 120px;
}

.address-icon {
  position: absolute;
  left: 10px;
  width: 15px;
  height: 15px;
  color: var(--text-muted);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: none;
  transition: color var(--motion-duration) var(--motion-easing);
}

.address-field:focus-within .address-icon {
  color: var(--focus);
}

.address-hint {
  position: absolute;
  right: 8px;
  padding: 3px 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  font: 10px/1 var(--font-mono);
  letter-spacing: 0.12em;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-duration) var(--motion-easing);
}

.address-field:focus-within .address-hint {
  opacity: 1;
}

.browser-nav-row input {
  width: 100%;
  min-width: 0;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0 54px 0 32px;
  color: var(--text-primary);
  background: var(--surface-2);
  font: 13px/1 var(--font-mono);
  letter-spacing: 0.01em;
  transition: border-color var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing), box-shadow var(--motion-duration) var(--motion-easing);
}

.browser-nav-row input::placeholder {
  color: var(--text-muted);
  font-family: var(--font-ui);
  letter-spacing: 0;
}

.browser-nav-row input:hover {
  border-color: var(--hover-line);
}

.browser-nav-row input:focus {
  border-color: var(--focus);
  background: var(--surface-1);
  box-shadow: var(--input-ring);
}

.browser-nav-row input:focus:not(:focus-visible) {
  outline: none;
}

.browser-icon-button {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 0;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  transition: background var(--motion-duration) var(--motion-easing), color var(--motion-duration) var(--motion-easing);
}

.browser-icon-button:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text-primary);
}

.browser-icon-button:active:not(:disabled) {
  background: var(--surface-3);
}

.browser-icon-button:focus-visible,
.browser-open-button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.browser-icon-button:disabled {
  color: var(--disabled);
  cursor: default;
}

.browser-icon-button svg,
.site-status svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.browser-open-button {
  height: 34px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 999px;
  padding: 0 18px;
  color: var(--on-accent);
  background: var(--focus);
  font: 600 13px/1 var(--font-ui);
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: filter var(--motion-duration) var(--motion-easing), transform var(--motion-duration) var(--motion-easing);
}

.browser-open-button:hover:not(:disabled) {
  filter: brightness(1.06);
}

.browser-open-button:active:not(:disabled) {
  transform: translateY(1px);
}

.browser-open-button:disabled {
  background: var(--disabled);
  cursor: default;
}

.site-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--text-secondary);
  font: 11px/1.4 var(--font-mono);
  letter-spacing: 0.04em;
}

.site-status::before {
  content: '';
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 1px;
  background: var(--disabled);
}

.site-status:not(.inactive)::before {
  background: var(--focus);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 14%, transparent);
}

.site-status span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.site-status.inactive {
  color: var(--text-muted);
}

.browser-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  justify-content: flex-end;
}

.browser-more {
  min-width: 0;
}

.browser-more[open] {
  flex: 1 0 100%;
}

.browser-more-content {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-2);
}

/* 加载指示：一条贴着命令条底边的细扫描线 */
.browse-loading {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 2px;
  height: 1px;
  overflow: hidden;
  pointer-events: none;
}

.browse-loading span {
  display: block;
  width: 30%;
  height: 100%;
  background: linear-gradient(90deg, transparent, var(--focus), transparent);
  animation: browse-loading-slide 1.1s linear infinite;
}

@keyframes browse-loading-slide {
  from { transform: translateX(-110%); }
  to { transform: translateX(380%); }
}

/* ---------- 起始页：网格 + 左侧强调竖线的编辑版式 ---------- */
.start-page {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: clamp(20px, 3vw, 44px);
}

.start-grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(to right, var(--grid-line) 1px, transparent 1px),
    linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px);
  background-size: 64px 64px;
  -webkit-mask-image: radial-gradient(110% 100% at 20% 20%, #000 30%, transparent 82%);
  mask-image: radial-gradient(110% 100% at 20% 20%, #000 30%, transparent 82%);
}

.start-glow {
  position: absolute;
  left: 32%;
  top: -240px;
  width: 820px;
  height: 440px;
  transform: translateX(-50%);
  background: radial-gradient(50% 50% at 50% 50%, color-mix(in srgb, var(--focus) 14%, transparent), transparent 72%);
}

.start-stage {
  position: relative;
  z-index: 1;
  width: min(760px, 100%);
  margin: auto;
  padding-left: clamp(16px, 2.4vw, 26px);
  border-left: 2px solid var(--focus);
}

.start-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 22px;
}

.start-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--text-muted);
  font: 10px/1 var(--font-mono);
  letter-spacing: 0.14em;
}

.start-dot {
  width: 6px;
  height: 6px;
  border-radius: 1px;
  background: var(--focus);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 14%, transparent);
}

.start-top-note {
  color: var(--text-muted);
  font: 10px/1 var(--font-mono);
  letter-spacing: 0.12em;
}

.start-title {
  margin: 0;
  color: var(--text-primary);
  font-size: clamp(34px, 4vw, 54px);
  font-weight: 650;
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.start-title em {
  font-style: normal;
  color: var(--focus);
}

.start-sub {
  max-width: 32em;
  margin: 16px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.9;
}

.start-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 26px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-1);
  box-shadow: var(--shadow-card);
  transition: border-color var(--motion-duration) var(--motion-easing), box-shadow var(--motion-duration) var(--motion-easing);
}

.start-search:focus-within {
  border-color: var(--focus);
  box-shadow: var(--input-ring), var(--shadow-card);
}

.start-prompt {
  margin-left: 8px;
  color: var(--focus);
  font: 14px/1 var(--font-mono);
}

.start-search input {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font: 13px/1 var(--font-mono);
  outline: none;
}

.start-search input::placeholder {
  color: var(--text-muted);
  font-family: var(--font-ui);
}

.start-search button {
  flex: 0 0 auto;
  height: 38px;
  padding: 0 20px;
  border: 0;
  border-radius: 999px;
  color: var(--on-accent);
  background: var(--focus);
  font: 600 13px/1 var(--font-ui);
  cursor: pointer;
  transition: filter var(--motion-duration) var(--motion-easing);
}

.start-search button:hover {
  filter: brightness(1.07);
}

/* 三条规格：只用两类发丝线，不用卡片 */
.start-meta {
  display: flex;
  flex-wrap: wrap;
  margin: 26px 0 0;
  padding: 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  list-style: none;
}

.start-meta li {
  flex: 1 1 150px;
  min-width: 0;
  padding: 12px 16px 12px 0;
}

.start-meta li + li {
  padding-left: 16px;
  border-left: 1px solid var(--border);
}

.start-meta b {
  display: block;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}

.start-meta span {
  display: block;
  margin-top: 4px;
  color: var(--text-muted);
  font: 11px/1.5 var(--font-mono);
  letter-spacing: 0.02em;
}

.start-foot {
  margin: 22px 0 0;
  color: var(--text-muted);
  font: 10px/1.6 var(--font-mono);
  letter-spacing: 0.1em;
}

/* ---------- 左栏里的继续阅读 ---------- */
.recent-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.recent-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 2px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-duration) var(--motion-easing);
}

.recent-list li:last-child .recent-row {
  border-bottom: 0;
}

.recent-row:hover {
  background: var(--hover);
}

.recent-index {
  flex: 0 0 16px;
  color: var(--text-muted);
  font: 10px/1 var(--font-mono);
  letter-spacing: 0.06em;
}

.recent-thumb {
  flex: 0 0 26px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background-image: linear-gradient(150deg, color-mix(in srgb, var(--focus) 18%, var(--surface-2)), var(--surface-3));
  background-size: cover;
  background-position: center;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.recent-thumb.has-cover {
  color: transparent;
}

.recent-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.recent-title {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-meta {
  overflow: hidden;
  color: var(--text-muted);
  font: 10px/1.3 var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-empty p {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}

.recent-empty strong {
  display: block;
  margin-bottom: 4px;
  color: var(--text-primary);
  font-weight: 600;
}

@media (max-width: 1180px) {
  .browse-side {
    flex-basis: 232px;
    width: 232px;
  }
}

@media (max-height: 720px) {
  .start-title {
    font-size: clamp(28px, 3vw, 40px);
  }

  .start-top {
    margin-bottom: 14px;
  }

  .start-sub {
    margin-top: 10px;
  }

  .start-search {
    margin-top: 18px;
  }

  .start-meta {
    margin-top: 18px;
  }
}

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

.mirror-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.mirror-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.mirror-options {
  display: flex;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.mirror-options label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  color: var(--text-secondary);
}

.mirror-actions {
  display: flex;
  gap: var(--space-2);
}

.mirror-results {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow: auto;
}

.mirror-results li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
}

.mirror-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mirror-reason {
  color: var(--text-secondary);
  font-size: 12px;
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
/* 地址栏右侧的收藏星标：同域名算同一站，已收藏时实心。 */
.address-star {
  position: absolute;
  right: 44px;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing);
}

.address-star svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linejoin: round;
}

.address-star:hover:not(:disabled) { background: var(--hover); color: var(--text-primary); }
.address-star.saved { color: var(--focus); }
.address-star.saved svg { fill: currentColor; }
.address-star:disabled { opacity: 0.35; cursor: default; }
.address-star:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

/* 起始页底部的常用网站：与左侧栏同一套卡片语言，只用一条细分隔线起头。 */
.start-fav {
  position: relative;
  z-index: 1;
  width: min(760px, 100%);
  margin: 0 auto clamp(12px, 2vw, 24px);
  padding: clamp(14px, 1.6vw, 20px) 0 0;
  border-top: 1px solid var(--border);
}

.start-fav-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.start-fav-label {
  font-size: 11px;
  letter-spacing: 0.16em;
  color: var(--text-muted);
  text-transform: uppercase;
}

.start-fav-add {
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: color var(--motion-duration) var(--motion-easing), border-color var(--motion-duration) var(--motion-easing);
}

.start-fav-add:hover { color: var(--text-primary); border-color: var(--hover-line); }

.start-fav-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  margin-bottom: 10px;
}

.start-fav-editor label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.start-fav-editor label.url { flex: 1 1 320px; }

.start-fav-editor input {
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface-1);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
}

.start-fav-editor input:focus { outline: none; border-color: var(--focus); }

.start-fav-editor-actions { display: flex; gap: 6px; }

.start-fav-editor-actions button {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.start-fav-editor-actions button.primary {
  border-color: transparent;
  background: var(--focus);
  color: #fff;
}

.start-fav-editor-actions button:disabled { opacity: 0.5; cursor: default; }

.start-fav-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.start-fav-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-1);
  transition: border-color var(--motion-duration) var(--motion-easing), transform var(--motion-duration) var(--motion-easing);
}

.start-fav-card:hover,
.start-fav-card:focus-within { border-color: var(--hover-line); transform: translateY(-1px); }

.start-fav-main {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.start-fav-badge {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  background: color-mix(in srgb, var(--fav-color, var(--focus)) 18%, transparent);
  color: var(--fav-color, var(--focus));
  font: 600 13px/1 var(--font-mono);
}

.start-fav-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

.start-fav-text strong,
.start-fav-text small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.start-fav-text strong { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.start-fav-text small { font-size: 11px; color: var(--text-muted); }

.start-fav-tools {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  padding: 0 8px 6px;
  opacity: 0;
  transition: opacity var(--motion-duration) var(--motion-easing);
}

.start-fav-card:hover .start-fav-tools,
.start-fav-card:focus-within .start-fav-tools { opacity: 1; }

.start-fav-tools button {
  padding: 2px 7px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.start-fav-tools button:hover { background: var(--hover); color: var(--text-primary); }

.start-fav-empty {
  margin: 0;
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}
</style>
