import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import type { Book, ChapterMeta, ReaderReadingMode, AiResumeCardView, AiBookUsage, AiBudgetEstimate, AiBudgetEvent, AiChapterNote, AiCitation, AiEvidenceChatMessage, AiFollowCoverage, AiFollowMode, AiMaterialCoverage, AiMemoryBase, AiMemoryCharacter, AiMemoryFile, AiTimelineView, AiUsage } from '@shared/types'
import { aiSaveRecoveryActive, runAiSaveRecovery } from '../aiSaveRecoveryLock'
import { clearRetriedAssistantSaveToken, describeAssistantStage, currentAssistantStage as resolveAssistantStage, type AssistantJobKind, type AssistantPanelTab, type AssistantSaveTokenState, type AssistantStageState } from './aiAssistantStatus'
import { normalizeEvidenceChatHistory } from './aiEvidenceUi'
import { locateMemorySourceParagraph } from './memorySourceLocator'
import { splitIntoParagraphs } from './useTts'

/**
 * 阅读器的「AI 助手面板」域：前情/记忆/问答/笔记/输出五个 tab 的状态与行为。
 *
 * 从 Reader.vue（4000+ 行单体）整块搬出来，只做这一件事，便于单独测试。
 * 依赖（当前书/章、正文、提示、跳章与滚动、若干与模板共用的 ref）由 Reader.vue 注入；
 * 模板沿用同名变量，所以搬动不改变界面行为。事件订阅（ai.chunk/stage/budget/done）
 * 仍在 Reader.vue 的 onMounted 里接线，调用的就是这里导出的函数。
 */
export interface ReaderAssistantDeps {
  book: Ref<Book | null>
  currentChapter: Ref<ChapterMeta | null>
  chapterBody: Ref<string>
  paras: Ref<string[]>
  chapters: Ref<ChapterMeta[]>
  contentRef: Ref<HTMLElement | null>
  fontSize: Ref<number>
  readingMode: Ref<ReaderReadingMode>
  /** naive-ui 的 message API：同形注入，搬来的代码不用改调用姿势 */
  message: { error: (text: string) => void; success: (text: string) => void; warning: (text: string) => void; info: (text: string) => void }
  loadBook: (bookId: string) => Promise<void>
  openChapter: (chapter: ChapterMeta, position?: number) => Promise<void>
  /** 跳章时给滚动逻辑留的段落下标（Reader.vue 里的裸变量，用存取器注入） */
  pendingScrollPara: { get: () => number; set: (value: number) => void }
  /** 以下引用留在 Reader.vue（模板与其它面板共用），以 Ref/回调形式注入 */
  resumeCardView: Ref<AiResumeCardView | null>
  resumeCardLoading: Ref<boolean>
  resumeCardWarning: Ref<string>
  showSelPopup: Ref<boolean>
  selectedExcerpt: Ref<string>
  restoringChat: Ref<boolean>
  aiResult: Ref<string>
  aiResultTitle: Ref<string>
  closeSelectionTools: (clearBrowserSelection?: boolean) => void
}

export function useReaderAssistant(deps: ReaderAssistantDeps) {
  const {
    book, currentChapter, chapterBody, paras, chapters, contentRef, fontSize, readingMode, message,
    loadBook, openChapter, pendingScrollPara,
    resumeCardView, resumeCardLoading, resumeCardWarning, showSelPopup, selectedExcerpt,
    restoringChat, aiResult, aiResultTitle, closeSelectionTools,
  } = deps

const showAiAssistant = ref(false)
const aiAssistantTab = ref<AssistantPanelTab>('recap')
const aiServiceOrigin = ref('')
const aiAssistantTaskLabel = computed(() => ({ recap: '前情', memory: '记忆', qa: '问答', notes: '笔记', output: '输出' })[aiAssistantTab.value])
const assistantBudgets = ref<Partial<Record<AiBudgetEvent['task'], AiBudgetEstimate>>>({})
// 前情 tab 跑的可能是整本前情也可能是本章摘要，按当前这次任务优先显示，另一种兜底。
const currentAssistantBudget = computed(() => {
  const budgets = assistantBudgets.value
  switch (aiAssistantTab.value) {
    case 'recap':
      return (recapJobKind.value === 'chapter'
        ? budgets.chapterSummary ?? budgets.recap
        : budgets.recap ?? budgets.chapterSummary) ?? null
    case 'memory':
      return budgets.memory ?? null
    case 'notes':
      return budgets.chapterNote ?? null
    case 'output':
      return null
    default:
      return budgets.qa ?? null
  }
})
const recapText = ref('')
const recapJobId = ref('')
const recapJobKind = ref<'chapter' | 'story' | ''>('')
const recapStopping = ref(false)
const recapStarting = ref(false)
const recapLength = ref<'short' | 'standard' | 'detailed'>('standard')
const memoryData = ref<AiMemoryFile | null>(null)
const timelineData = ref<AiTimelineView | null>(null)
const memorySourceJumping = ref(false)
const memoryJobId = ref('')
const memoryJobKind = ref<'update' | 'rebuild' | 'fromSource' | ''>('')
const memoryStarting = ref(false)
const memoryStopping = ref(false)
const memoryLoading = computed(() => memoryStarting.value || Boolean(memoryJobId.value))
const assistantStages = ref<Record<string, AssistantStageState>>({})
const lastAssistantUsage = ref<AiUsage | null>(null)
const assistantCompleted = ref(false)
const lastAssistantTruncated = ref(false)
const assistantSaveState = ref<AssistantSaveTokenState>({ token: '', kind: '' })
const assistantSaveRetrying = aiSaveRecoveryActive
const chapterSummaryBudget = ref<AiBudgetEstimate | null>(null)
const chapterSummaryBudgetMessage = ref('')
const showChapterSummaryBudgetConfirm = ref(false)
const memoryBudget = ref<AiBudgetEstimate | null>(null)
const memoryBudgetMessage = ref('')
const showMemoryBudgetConfirm = ref(false)
const memoryBudgetRequest = ref<{ kind: 'update' | 'rebuild' | 'fromSource'; fromChapterId?: string } | null>(null)
const recapBudgetConfirmKind = ref<'chapter' | 'story'>('chapter')
const chapterNotes = ref<AiChapterNote[]>([])
const currentChapterNote = ref<(AiChapterNote & { stale: boolean }) | null>(null)
const chapterNoteJobId = ref('')
const chapterNoteText = ref('')
const chapterNoteDraft = ref('')
const chapterNoteStarting = ref(false)
const chapterNoteStopping = ref(false)
const chapterNoteStopped = ref(false)
const chapterNoteSaving = ref(false)
const chapterNoteLoading = computed(() => Boolean(chapterNoteJobId.value))
const notesBudget = ref<AiBudgetEstimate | null>(null)
const notesBudgetMessage = ref('')
const showNotesBudgetConfirm = ref(false)
const noteOverwritePrompt = ref('')
const chapterNoteView = computed(() => chapterNoteText.value || currentChapterNote.value?.text || '')
const otherChapterNotes = computed(() => chapterNotes.value.filter((note) => note.chapterId !== currentChapter.value?.id))
const recapLoading = computed(() => Boolean(recapJobId.value))
const translateJobId = ref('')
const translateLoading = computed(() => Boolean(translateJobId.value))
const chatMessages = ref<AiEvidenceChatMessage[]>([])
const chatInput = ref('')
const chatLoading = ref(false)
const chatStarting = ref(false)
const chatJobId = ref('')
const chatAssistantIndex = ref(-1)
/**
 * 从选区发起的那次提问：记住气泡序号与选区区间，回答完成后就能把 AI 的解释
 * 存回读者刚才选中的同一段文字。换章、清空记录或手动提问都会让它失效。
 */
const selectionNoteTarget = ref<{
  messageIndex: number
  start: number
  end: number
  text: string
} | null>(null)
const selectionNoteSaving = ref(false)
/** 追剧的队列、模式、进度和失败原因都在主进程的 follow.json 里，界面只显示与触发。 */
const follow = ref<AiFollowCoverage | null>(null)
const readingAiMode = computed<AiFollowMode>(() => follow.value?.mode ?? 'manual')
const materialCoverage = ref<AiMaterialCoverage | null>(null)
const bookUsage = ref<AiBookUsage | null>(null)
const autoBudget = ref<{ month: string; usedTokens: number; reservedTokens: number; limitTokens: number; remainingTokens: number } | null>(null)
const semanticState = ref<{ enabled: boolean; indexed: number; total: number; message: string } | null>(null)
const sceneQuestion = ref('')
const sceneHits = ref<AiCitation[]>([])
const sceneMessage = ref('')
const sceneSearching = ref(false)
const aliasDrafts = ref<Record<string, string>>({})
const summaryDrafts = ref<Record<string, string>>({})
const memoryQuery = ref('')
const correctingAliasId = ref('')
const correctingSummaryId = ref('')
/** 首次切到 auto 前的预算确认：确认后才把用户点的那个模式写给主进程。 */
const pendingFollowMode = ref<AiFollowMode>('manual')
const followBudget = ref<AiBudgetEstimate | null>(null)
const followBudgetMessage = ref('')
const showFollowBudgetConfirm = ref(false)
/** 设置页的自动追剧总开关：本书选了自动但总开关关着时，界面要说明为什么不会自己跑。 */
const autoFollowEnabled = ref(false)
/** 追剧在跑时的拉取间隔：单元一跑几十秒，3 秒足够让进度跟上，也不会常占磁盘。 */
const FOLLOW_POLL_MS = 3000
/** 后台没任务在跑、或窗口不前台时的低频间隔。 */
const FOLLOW_POLL_IDLE_MS = 15000
let followPollBusy = false
let followPollTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 主进程的车道会排队而不是拒绝，所以界面也只按任务种类记账：
 * 后台在整理记忆或前情时，问答输入框不该跟着变灰。
 */
const assistantBusyByKind = computed<Record<AssistantJobKind, boolean>>(() => ({
  recap: recapStarting.value || recapLoading.value,
  memory: memoryStarting.value || memoryLoading.value,
  qa: chatStarting.value || chatLoading.value,
  notes: chapterNoteStarting.value || chapterNoteLoading.value,
}))
/** 重试保存只该等它自己那一类任务，别的 tab 在跑不该挡住这次补写。 */
const assistantSaveBusy = computed(() => {
  const kind = assistantSaveState.value.kind
  return kind ? assistantBusyByKind.value[kind] : false
})
const assistantJobIds = computed(() => ({
  recap: recapJobId.value,
  memory: memoryJobId.value,
  qa: chatJobId.value,
  notes: chapterNoteJobId.value,
}))
const currentAssistantStage = computed(() => aiAssistantTab.value === 'output'
  ? undefined
  : resolveAssistantStage(assistantStages.value, aiAssistantTab.value, assistantJobIds.value))
const assistantStageText = computed(() => describeAssistantStage(currentAssistantStage.value))
/**
 * 后台 AI 是否在跑：面板关掉之后以前完全看不出来，用户不知道钱正在花。
 * 这里给出常驻入口，点一下就能打开面板看细节。
 */
const backgroundAiLabel = computed(() => {
  if (follow.value?.running) {
    return follow.value.queuedChapters > 0
      ? `AI 整理中 ${follow.value.queuedChapters} 章`
      : 'AI 正在整理'
  }
  if (assistantStageText.value) return assistantStageText.value
  if (follow.value?.paused && follow.value.pauseReason) return 'AI 已暂停，点开看原因'
  return ''
})

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

async function loadTimeline() {
  if (!book.value) return
  const result = await window.api.ai.timeline?.(book.value.id)
  if (result?.ok) timelineData.value = result.timeline
}

async function loadAssistantMaterial() {
  if (!book.value) return
  const [coverage, usage] = await Promise.all([
    window.api.ai.getMaterialCoverage(book.value.id),
    window.api.ai.getUsage(book.value.id),
  ])
  if (coverage.ok && coverage.coverage) {
    materialCoverage.value = coverage.coverage
    applyFollow(coverage.coverage.follow)
  }
  if (usage.ok) { bookUsage.value = usage.usage; autoBudget.value = usage.autoBudget }
}

async function loadResumeCard() {
  if (!book.value) return
  const bookId = book.value.id
  const result = await window.api.ai.resumeCard?.(bookId)
  if (book.value?.id === bookId) resumeCardView.value = result?.ok ? result.view : null
}

async function generateResumeCard(confirm = false) {
  if (!book.value || resumeCardLoading.value) return
  resumeCardLoading.value = true
  resumeCardWarning.value = ''
  try {
    const result = await window.api.ai.generateResumeCard(book.value.id, confirm)
    if (result.ok) {
      resumeCardView.value = { available: true, reason: '', stale: false, card: result.card }
      message.success('续读卡已生成')
    } else if (result.confirmationRequired) {
      resumeCardWarning.value = `${result.message} 估算上限不等于服务商账单金额。`
    } else message.error(result.message)
  } finally { resumeCardLoading.value = false }
}

async function refreshSemanticStatus() {
  if (!book.value) return
  const result = await window.api.ai.semanticIndexStatus(book.value.id)
  if (result.ok) semanticState.value = result.status
}

async function toggleSemanticIndex() {
  if (!book.value) return
  const result = await window.api.ai.semanticIndexSet(book.value.id, !semanticState.value?.enabled)
  if (result.ok) semanticState.value = result.status
  else message.error(result.message)
}

async function searchScenes() {
  if (!book.value || !sceneQuestion.value.trim()) return
  sceneSearching.value = true
  try {
    const result = await window.api.ai.findScenes(book.value.id, sceneQuestion.value)
    if (result.ok) { sceneHits.value = result.hits; sceneMessage.value = result.message }
    else { sceneHits.value = []; sceneMessage.value = result.message }
    await refreshSemanticStatus()
  } finally { sceneSearching.value = false }
}

function askFromScene() {
  chatInput.value = sceneQuestion.value
}

/**
 * 「这一章读完了」只有渲染层判得出来（主进程拿不到滚动位置），判出来就把实测比率交出去。
 * 上报只往主进程的 follow.json 排队，失败也不打扰阅读——追剧漏一章可以补，读不下去才是事故。
 */
async function reportFinishedChapter(finished: { bookId: string; chapterId: string; ratio: number }) {
  const result = await window.api.ai.chapterFinished(finished.bookId, finished.chapterId, finished.ratio)
  if (!result.ok) return
  applyFollow(result.coverage)
  if (result.coverage.mode === 'ask') message.info('这一章已读完，可在 AI 助手中整理摘要和小说记忆')
}

function applyFollow(coverage: AiFollowCoverage | null) {
  follow.value = coverage
  if (!coverage || coverage.mode === 'manual') {
    stopFollowPolling()
    return
  }
  startFollowPolling()
}

/** 队列、进度、失败原因都在主进程，界面只能拉：关窗、切书、刷新都不会打断它。 */
function startFollowPolling() {
  if (followPollTimer) return
  const tick = async (): Promise<void> => {
    // 窗口在后台时不必每 3 秒问一次；上一次还没回来也不叠加新请求
    if (document.hidden) {
      followPollTimer = setTimeout(() => void tick(), FOLLOW_POLL_IDLE_MS)
      return
    }
    if (!followPollBusy) {
      followPollBusy = true
      try {
        await pollFollow()
      } catch {
        /* 拉取失败下次再来 */
      } finally {
        followPollBusy = false
      }
    }
    // 后台没任务在跑时改成低频轮询，有任务才恢复 3 秒
    const active = follow.value?.running === true || (follow.value?.queuedChapters ?? 0) > 0
    followPollTimer = setTimeout(() => void tick(), active ? FOLLOW_POLL_MS : FOLLOW_POLL_IDLE_MS)
  }
  followPollTimer = setTimeout(() => void tick(), FOLLOW_POLL_MS)
}

function stopFollowPolling() {
  if (!followPollTimer) return
  clearTimeout(followPollTimer)
  followPollTimer = null
}

async function pollFollow() {
  const bookId = book.value?.id
  if (!bookId) {
    stopFollowPolling()
    return
  }
  const result = await window.api.ai.getMaterialCoverage(bookId).catch(() => null)
  if (!result?.ok || !result.coverage) return
  materialCoverage.value = result.coverage
  applyFollow(result.coverage.follow)
}

/** 模式的真源在主进程：只有拿到成功回执才认这个新模式，被拒绝就退回磁盘上的旧值。 */
async function setReadingAiMode(mode: AiFollowMode) {
  if (!book.value || mode === readingAiMode.value) return
  pendingFollowMode.value = mode
  const result = await window.api.ai.followSet(book.value.id, mode, false)
  if (!result.ok) {
    if ('confirmationRequired' in result && result.confirmationRequired) {
      followBudget.value = result.budget
      followBudgetMessage.value = result.message
      showFollowBudgetConfirm.value = true
      showAiAssistant.value = true
      return
    }
    message.warning(result.message)
    return
  }
  followBudget.value = null
  followBudgetMessage.value = ''
  applyFollow(result.coverage)
}

async function confirmFollowBudget() {
  const mode = pendingFollowMode.value
  showFollowBudgetConfirm.value = false
  followBudget.value = null
  if (!book.value) return
  const result = await window.api.ai.followSet(book.value.id, mode, true)
  if (!result.ok) {
    message.warning(result.message)
    return
  }
  applyFollow(result.coverage)
}

function cancelFollowBudget() {
  showFollowBudgetConfirm.value = false
  followBudget.value = null
  followBudgetMessage.value = ''
  pendingFollowMode.value = 'manual'
}

/** 「现在整理 / 继续」：读者当场授权，主进程清掉失败与暂停标记后跑一轮。 */
async function runFollowNow() {
  if (!book.value) return
  const result = await window.api.ai.followRetry(book.value.id)
  if (!result.ok) {
    message.warning(result.message)
    return
  }
  applyFollow(result.coverage)
}

function stopFollowAuto() {
  void setReadingAiMode('manual')
}

/** 一次性结果（清正文、翻译）不再单开抽屉，切到同一个 AI 壳的「输出」pane。 */
function showAiOutput() {
  aiAssistantTab.value = 'output'
  showAiAssistant.value = true
}

async function openAiAssistant(tab: AssistantPanelTab = 'recap') {
  if (!book.value) return
  aiAssistantTab.value = tab
  showAiAssistant.value = true
  await Promise.allSettled([
    recapLoading.value ? Promise.resolve() : loadStoredRecap(),
    loadStoredMemory(),
    loadAssistantMaterial(),
    refreshSemanticStatus(),
    chatLoading.value || restoringChat.value
      ? Promise.resolve()
      : window.api.ai.getChat(book.value.id).then((res) => { if (res.ok) chatMessages.value = normalizeEvidenceChatHistory(res.messages) }),
  ])
}

async function startMemoryJob(kind: 'update' | 'rebuild', confirmOverBudget = false) {
  if (!book.value?.progress?.chapterId || assistantBusyByKind.value.memory || assistantSaveRetrying.value) return
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
    pendingScrollPara.set(location.paragraphIndex)
    showAiAssistant.value = false
    try {
      await openChapter(chapter, 0)
    } finally {
      pendingScrollPara.set(-1)
    }
    if (location.mode === 'fallback') {
      message.warning('原段落已变化，已跳到该章开头。')
    }
  } catch {
    pendingScrollPara.set(-1)
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
  if (!book.value?.progress?.chapterId || assistantBusyByKind.value.memory || assistantSaveRetrying.value) return
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
  if (!book.value || correctingAliasId.value || assistantBusyByKind.value.memory) return
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
  if (!book.value || correctingSummaryId.value || assistantBusyByKind.value.memory || assistantSaveRetrying.value) return
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
  if (!token || assistantSaveRetrying.value || assistantSaveBusy.value) return
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
  if (!book.value || !currentChapter.value || assistantBusyByKind.value.recap || assistantSaveRetrying.value) return
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
        // 前情与本章摘要的确认分支同形，但三目把两个频道并成更窄的交叉类型，这里显式取预算
        chapterSummaryBudget.value = (res as unknown as { budget: AiBudgetEstimate }).budget
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

/**
 * 笔记的唯一真源是磁盘上的 ai/notes.json：整本列表用于「回看」，
 * 当前章那条额外带回 stale，因为过期要拿正文重算 hash，只有主进程能做。
 */
async function loadChapterNotes() {
  if (!book.value || !currentChapter.value) {
    chapterNotes.value = []
    currentChapterNote.value = null
    return
  }
  try {
    const res = await window.api.ai.chapterNotes(book.value.id, currentChapter.value.id)
    if (!res.ok) {
      message.error(res.message)
      return
    }
    chapterNotes.value = res.notes
    const previous = currentChapterNote.value?.text ?? ''
    if (!chapterNoteDraft.value.trim() || chapterNoteDraft.value === previous) {
      chapterNoteDraft.value = res.current?.text ?? ''
    }
    if (!chapterNoteLoading.value) chapterNoteText.value = ''
    currentChapterNote.value = res.current
  } catch {
    message.error('无法读取本章笔记')
  }
}

async function startChapterNote(confirmOverBudget = false, overwriteUserNote = false) {
  if (!book.value || !currentChapter.value || chapterNoteStarting.value || chapterNoteLoading.value || assistantSaveRetrying.value) return
  if (!confirmOverBudget) notesBudget.value = null
  noteOverwritePrompt.value = ''
  chapterNoteStarting.value = true
  try {
    const res = await window.api.ai.chapterNote(book.value.id, currentChapter.value.id, confirmOverBudget, overwriteUserNote)
    if (!res.ok) {
      if ('confirmationRequired' in res && res.confirmationRequired) {
        notesBudget.value = res.budget
        notesBudgetMessage.value = res.message
        showNotesBudgetConfirm.value = true
        return
      }
      if ('userNoteConfirmedRequired' in res && res.userNoteConfirmedRequired) {
        noteOverwritePrompt.value = res.message
        return
      }
      message.error(res.message)
      return
    }
    chapterNoteStopping.value = false
    chapterNoteJobId.value = res.jobId
    chapterNoteText.value = ''
    currentChapterNote.value = null
    aiAssistantTab.value = 'notes'
    showAiAssistant.value = true
  } catch {
    message.error('无法启动本章笔记任务')
  } finally {
    chapterNoteStarting.value = false
  }
}

function confirmNotesBudget() {
  showNotesBudgetConfirm.value = false
  void startChapterNote(true)
}

function cancelNotesBudget() {
  showNotesBudgetConfirm.value = false
  notesBudget.value = null
}

function stopChapterNote() {
  if (!chapterNoteJobId.value) return
  chapterNoteStopping.value = true
  void window.api.ai.cancel(chapterNoteJobId.value)
}

async function saveChapterNoteEdit() {
  if (!book.value || !currentChapter.value || chapterNoteSaving.value) return
  const text = chapterNoteDraft.value.trim()
  if (!text) {
    message.warning('笔记不能为空')
    return
  }
  chapterNoteSaving.value = true
  try {
    const res = await window.api.ai.saveChapterNote(book.value.id, currentChapter.value.id, text)
    if (!res.ok) {
      message.error(res.message)
      return
    }
    chapterNoteText.value = ''
    noteOverwritePrompt.value = ''
    currentChapterNote.value = { ...res.note, stale: false }
    await loadChapterNotes()
    message.success('笔记已保存')
  } catch {
    message.error('笔记保存失败')
  } finally {
    chapterNoteSaving.value = false
  }
}

async function openChapterFromNote(chapterId: string) {
  if (!book.value) return
  const chapter = chapters.value.find((item) => item.id === chapterId)
  if (!chapter) {
    message.warning('章节不存在')
    return
  }
  await openChapter(chapter)
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
    showAiOutput()
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
  showAiOutput()
  closeSelectionTools()
}

function stopTranslate() {
  if (translateJobId.value) void window.api.ai.cancel(translateJobId.value)
}

const QUICK_READING_QUESTIONS = [
  '用三点概括我读到这里的主线进展，并说明当前最重要的冲突。',
  '列出目前最重要的人物关系，以及最近发生了什么变化。',
  '有哪些已经出现但尚未回收的伏笔？请按重要程度排列。',
  '当前主要人物各自想要什么？他们的目标在哪里发生冲突？',
] as const

/** 快捷问题只填入草稿，仍由读者确认发送，避免误触产生模型调用和费用。 */
function prepareQuickQuestion(question: string) {
  aiAssistantTab.value = 'qa'
  chatInput.value = question
}

async function sendChat() {
  if (!book.value || !currentChapter.value || !chatInput.value.trim()) return
  if (assistantBusyByKind.value.qa || assistantSaveRetrying.value) {
    message.warning('请先停止当前生成')
    return
  }
  const userMsg = chatInput.value.trim()
  selectionNoteTarget.value = null
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
    selectionNoteTarget.value = null
  } else {
    message.error(res.message)
  }
}

  return {
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
    stopTranslate,
    QUICK_READING_QUESTIONS,
    prepareQuickQuestion,
    sendChat,
    stopChat,
    clearChat,
  }
}
