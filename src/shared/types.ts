/** 共享类型契约。工人只读；要加字段走协调者补丁。 */

export type ImportType = 'download' | 'txt' | 'epub'

export type ChapterStatus = 'pending' | 'ready' | 'failed' | 'empty'

export type FailCode =
  | 'CatalogNotFound'
  | 'BodyEmpty'
  | 'NeedLogin'
  | 'Intercepted'
  | 'NavFailed'
  | 'Cancelled'
  | 'UnknownPage'

export const FAIL_CODE_ZH: Record<FailCode, string> = {
  CatalogNotFound: '找不到目录',
  BodyEmpty: '正文为空或过短',
  NeedLogin: '需要登录后才能看',
  Intercepted: '页面不像正文（拦截或残页）',
  NavFailed: '章节地址加载失败',
  Cancelled: '已取消',
  UnknownPage: '无法识别为书',
}

export type PageKind = 'catalog' | 'chapter' | 'unknown'

export interface ReadingProgress {
  chapterId: string
  /** 0–1，章内滚动比例 */
  scrollRatio: number
  /** 规范化正文的段落位置；旧书缺省时回退到 scrollRatio。 */
  paragraphIndex?: number
  paragraphOffset?: number
  updatedAt: string
}

/** 每本书独立的听书续播位置。 */
export interface TtsPosition {
  chapterId: string
  paragraphIndex: number
  bodyHash: string
  updatedAt: string
}

export interface ChapterMeta {
  id: string
  index: number
  title: string
  url?: string
  file: string
  status: ChapterStatus
  failCode?: FailCode
  failMessage?: string
}

export interface ChapterFile {
  title: string
  url?: string
  body: string
  bodyRaw?: string
  status: ChapterStatus
  failCode?: FailCode
}

export interface Book {
  id: string
  title: string
  author: string
  /** 缺省 []；磁盘旧书无此字段时按空数组读取 */
  tags: string[]
  sourceUrl?: string
  sourceHost?: string
  coverPath?: string
  importType: ImportType
  createdAt: string
  updatedAt: string
  status: 'downloading' | 'ready' | 'partial'
  chapters: ChapterMeta[]
  progress: ReadingProgress | null
}

export interface BookListItem {
  id: string
  title: string
  author: string
  tags: string[]
  coverPath?: string
  importType: ImportType
  status: Book['status']
  chapterCount: number
  readyCount: number
  progress: ReadingProgress | null
  updatedAt: string
  overview?: BookOverviewView
}

export interface BookOverviewView {
  status: 'off' | 'waiting' | 'pending' | 'running' | 'ready' | 'stale' | 'failed'
  text?: string
  message?: string
}

/** 回收站条目（<libraryPath>/__trash__/<bookId>-<删除时间毫秒>）。 */
export interface TrashItem {
  name: string
  bookId: string
  title: string
  author: string
  chapterCount: number
  trashedAt: string
}

export interface CatalogChapter {
  title: string
  url: string
  index: number
}

export interface ExtractBootstrap {
  pageKind: PageKind
  bookTitle: string
  author: string
  coverUrl?: string
  catalogUrl?: string
  chapters: CatalogChapter[]
}

export interface FailedChapterItem {
  chapterId: string
  title: string
  index: number
  reason: string
}

export interface DownloadProgress {
  bookId: string
  title: string
  total: number
  done: number
  failed: number
  currentTitle?: string
  status: 'running' | 'paused' | 'done' | 'cancelled' | 'error'
  lastError?: string
  /** 仅结束事件（done / error / cancelled）携带；无失败或空章时为 []。running 省略。 */
  failedChapters?: FailedChapterItem[]
  qualityIssueCount?: number
}

export interface DownloadPreview {
  token: string
  pageUrl: string
  bookTitle: string
  author: string
  chapterCount: number
  chapterTitles: string[]
  sampleTitle: string
  sampleBody: string
  sampleError?: string
}

export interface QualityIssue {
  chapterId: string
  chapterIndex: number
  chapterTitle: string
  kind: 'short' | 'duplicateBody' | 'duplicateUrl' | 'suspectedAd' | 'suspectedWall'
  reason: string
}

export interface QualityReport {
  bookId: string
  checked: number
  issues: QualityIssue[]
}

export interface SiteRulePreview {
  pageUrl: string
  title: string
  author: string
  chapterCount: number
  chapterTitles: string[]
  bodySample: string
  diagnostics: Record<'title' | 'author' | 'catalog' | 'body', string>
}

/** 批量检查更新：逐本进度推送（download.checkAll.progress） */
export interface CheckAllProgress {
  current: number
  total: number
  bookId: string
  title: string
}

export type CheckOneResult =
  | { ok: true; bookId: string; title: string; added: number }
  | { ok: false; bookId: string; title: string; message: string }

/** download.checkAll 的聚合结果。checked = 已尝试的本数；total = 候选总本数。 */
export interface CheckAllResult {
  ok: boolean
  message?: string
  total: number
  checked: number
  booksWithUpdates: number
  results: CheckOneResult[]
}

/** 本书内全文搜索的单章命中 */
export interface BookSearchHit {
  chapterId: string
  chapterIndex: number
  chapterTitle: string
  /** 本章命中次数 */
  count: number
  /** 首个命中摘录（含前后约 20 字） */
  excerpt: string
  /** 首个命中所在段落下标 */
  paraIndex: number
}

/**
 * 书签 / 划线笔记。坐标以「规范化正文」为准：
 * 章节正文按空行切段、丢弃空段后用 '\n\n' 连接的文本。
 */
export interface Annotation {
  id: string
  bookId: string
  chapterId: string
  kind: 'highlight' | 'bookmark'
  start: number
  end: number
  /** 原文片段，用于漂移校正；书签为空串 */
  excerpt: string
  note?: string
  createdAt: string
}

export interface AnnotationUpdate {
  note?: string
  /** 漂移校正后的新坐标（成对提供才生效） */
  start?: number
  end?: number
}

export interface CharacterEntry {
  name: string
  role?: string
  relations?: string
  status?: string
}

export interface ForeshadowEntry {
  desc: string
  where?: string
  open?: boolean
}

/** ai/characters.json 的内容；材料红线同摘要：只用已读部分 */
export interface CharacterCard {
  version: number
  uptoChapterId?: string
  characters: CharacterEntry[]
  foreshadows: ForeshadowEntry[]
  /** 模型原始返回，JSON 解析失败时兜底展示 */
  raw: string
  updatedAt: string
}

export interface BrowseState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export type ReaderTheme = 'paper' | 'sepia' | 'gray' | 'night'
export type ReaderFontFamily = 'serif' | 'system' | 'mono'
export type ReaderContentWidth = 'narrow' | 'medium' | 'wide'
export type ReaderParagraphSpacing = 'compact' | 'normal' | 'relaxed'
export type ReaderFocusMode = 'off' | 'one' | 'three' | 'five'
export type ReaderReadingMode = 'scroll' | 'screen'

export interface ReaderPrefs {
  fontSize: number
  lineHeight: number
  theme: ReaderTheme
  fontFamily: ReaderFontFamily
  contentWidth: ReaderContentWidth
  paragraphSpacing: ReaderParagraphSpacing
  paragraphIndent: boolean
  focusMode: ReaderFocusMode
  readingMode: ReaderReadingMode
}

/** 朗读偏好（Web speechSynthesis） */
export interface TtsPrefs {
  /** 语速，0.5–2 */
  rate: number
  /** 一章读完后自动跳下一章继续 */
  autoNextChapter: boolean
  source: 'system' | 'online'
  systemVoiceURI: string
  onlineEndpoint: string
  onlineModel: string
  onlineVoice: string
  /** 在线密钥只存在主进程；此字段不含明文。 */
  onlineKeyConfigured: boolean
}

/** 界面皮肤：暖纸 / 白纸 / 夜间 */
export type Skin = 'paper' | 'white' | 'night'

/** 下载章与章之间的固定间隔档位。 */
export type DownloadPace = 'slow' | 'standard' | 'fast'

/** 外观偏好 */
export interface AppearancePrefs {
  skin: Skin
}

export type AiProvider = 'deepseek' | 'custom'
export type AiPromptKind = 'clean' | 'translate' | 'chapterSummary' | 'recap' | 'memory' | 'evidenceQa'
export type AiPromptMode = 'builtin' | 'custom'

/** AI 供应商、思考模式、前情长度和用户可编辑提示词偏好。 */
export interface AiPrefs {
  provider: AiProvider
  thinkingEnabled: boolean
  recapLength: 'short' | 'standard' | 'detailed'
  /** 单次预计输入达到此 token 数时，联网前提醒确认。 */
  budgetWarningTokens: number
  /** 已由用户确认信任的规范化 origin；不含路径、query 或 fragment。 */
  trustedCustomOrigins: string[]
  /** 用户主动开启后，完整入库的书在后台串行生成含剧透的全书概览。 */
  autoBookOverview: boolean
  promptMode: Record<AiPromptKind, AiPromptMode>
  customPrompts: Partial<Record<AiPromptKind, string>>
}

export interface Settings {
  libraryPath: string
  baseUrl: string
  model: string
  /** 渲染进程只拿是否已配置，不回传明文 */
  apiKeyConfigured: boolean
  reader: ReaderPrefs
  tts: TtsPrefs
  appearance: AppearancePrefs
  /** A1.2 起主进程始终补齐；可选用于兼容尚未迁移的旧调用方。 */
  ai?: AiPrefs
  /** 章间间隔档位。getSettings 始终返回；缺省或非法回退 standard。 */
  downloadPace: DownloadPace
  /** 主进程总补齐；可选仅用于兼容旧调用方和测试数据。 */
  autoBackup?: { destDir: string; lastSuccessAt: string; lastError: string }
}

export interface SettingsUpdate {
  libraryPath?: string
  baseUrl?: string
  model?: string
  /** 空字符串表示清除 */
  apiKey?: string
  reader?: Partial<ReaderPrefs>
  tts?: Partial<TtsPrefs>
  /** 空字符串清除在线语音密钥。 */
  ttsApiKey?: string
  appearance?: Partial<AppearancePrefs>
  ai?: Partial<AiPrefs>
  /** 省略则不改已保存档位。 */
  downloadPace?: DownloadPace
  autoBackup?: { destDir?: string; lastSuccessAt?: string; lastError?: string }
}

/** 本机按域名的 CSS 规则。不进 Settings / settings.json。 */
export interface SiteRule {
  host: string
  title?: string
  author?: string
  catalog?: string
  body?: string
  /** 缺省开启；仅影响内置浏览页的广告元素显示。 */
  adFilterEnabled?: boolean
  /** 每行一个额外的广告元素 CSS 选择器。 */
  adHideSelectors?: string
}

export interface AiCleanResult {
  original: string
  cleaned: string
}

export interface AiChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** 可回跳到本地纯文本正文的来源坐标。 */
export interface AiCitation {
  id: string
  chapterId: string
  chapterTitle: string
  paragraphIndex: number
  excerpt: string
}

export interface AiMemoryBase {
  id: string
  summary: string
  sources: AiCitation[]
  accuracy: 'normal' | 'review' | 'uncertain'
  /** 用户直接修正的摘要，后续模型更新不得静默覆盖。 */
  userEditedSummary?: boolean
  updatedAt: string
}

export interface AiMemoryCharacter extends AiMemoryBase {
  name: string
  aliases: string[]
  /** 用户直接修正的别名，后续模型更新不得静默覆盖。 */
  userEditedAliases?: boolean
  role: string
  status: string
}

export interface AiMemoryRelation extends AiMemoryBase {
  from: string
  to: string
  relation: string
  status: string
}

export interface AiMemoryForeshadow extends AiMemoryBase {
  desc: string
  status: 'open' | 'resolved' | 'uncertain'
}

export interface AiMemoryEvent extends AiMemoryBase {
  title: string
  participants: string[]
  result: string
}

/** 每书 ai/memory.json v1。 */
export interface AiMemoryFile {
  version: 1
  uptoChapterId?: string
  characters: AiMemoryCharacter[]
  relations: AiMemoryRelation[]
  foreshadows: AiMemoryForeshadow[]
  events: AiMemoryEvent[]
  updatedAt: string
}

export interface AiMemoryUpdateResult {
  memory: AiMemoryFile
  processedChapters: number
  changedItems: number
  remainingChapters: number
}

export interface AiUsage {
  inputTokens?: number
  outputTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
}

/** 每书累计用量，只记 token 计数，不估算金额。 */
export interface AiBookUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  updatedAt: string
}

/** 已读范围内章节摘要覆盖情况；缺摘要的章节仍可被原文检索。 */
export interface AiMaterialCoverage {
  uptoChapterId: string
  uptoChapterTitle: string
  readyChapters: number
  summarizedChapters: number
  missing: Array<{ chapterId: string; title: string }>
}

export interface AiBudgetEstimate {
  originalCharacters: number
  sentCharacters: number
  estimatedTokens: number
  chapterCount: number
  paragraphCount: number
  batchCount: number
  range: string
}

export type AiRequestStage = 'preparing' | 'rewriting' | 'searching' | 'requesting' | 'saving'

export interface AiStageEvent {
  jobId: string
  stage: AiRequestStage
  detail?: string
}

export interface AiBudgetEvent {
  jobId: string
  task: 'recap' | 'memory' | 'qa'
  budget: AiBudgetEstimate
}

export interface AiEvidenceChatMessage {
  role: 'user' | 'assistant'
  content: string
  citations?: AiCitation[]
  uptoChapterId?: string
  stopped?: boolean
}

/** ai.getChat 的兼容响应：旧 handler 可暂不返回 version，消息字段保持可读。 */
export type AiGetChatResult =
  | { ok: true; version?: 1 | 2; messages: AiEvidenceChatMessage[] }
  | { ok: false; message: string }

export interface AiStorySoFar {
  /** 合成前情的已读截止章节 */
  uptoChapterId: string
  /** 仅根据该截止范围内已保存的本章摘要合成 */
  text: string
  updatedAt: string
}

/** 每书 ai/summaries.json v2；byChapter 只保存单章摘要。 */
export interface AiSummaries {
  version: number
  /** chapterId → 本章摘要；只含已读章，不能存合成前情 */
  byChapter: Record<string, string>
  storySoFar?: AiStorySoFar
  updatedAt: string
}

/** 异步 AI 任务的启动响应。 */
export type AiJobStart = { ok: true; jobId: string } | { ok: false; message: string }

/** 主进程发送的流式文本增量。 */
export interface AiChunkEvent {
  jobId: string
  delta: string
}

/** 主进程发送的流式任务终态；新增字段均为可选，旧监听方可继续只读 text。 */
export type AiDoneEvent =
  | {
      jobId: string
      ok: true
      text: string
      usage?: AiUsage
      truncated?: boolean
      stopped?: boolean
      /** 证据问答终态的白名单引用；保存失败时也必须保留。 */
      citations?: AiCitation[]
      /** 本次回答严格夹紧的已读截止。 */
      uptoChapterId?: string
      /** 记忆更新/重建的结构化结果与处理统计。 */
      memoryUpdate?: AiMemoryUpdateResult
      /** 写盘失败后仅当前主进程有效的重试令牌。 */
      saveToken?: string
    }
  | { jobId: string; ok: false; message: string }

/** 旧 ai/chat.json v1；读取兼容，不含来源。 */
export interface AiChatFile {
  version: 1
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  updatedAt: string
}

/** 新 ai/chat.json v2；首次成功保存证据问答时升级。 */
export interface AiChatFileV2 {
  version: 2
  messages: AiEvidenceChatMessage[]
  updatedAt: string
}

export const DEFAULT_LIBRARY_PATH = 'D:\\spbf\\library'

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  theme: 'paper',
  fontFamily: 'serif',
  fontSize: 18,
  lineHeight: 1.8,
  contentWidth: 'medium',
  paragraphSpacing: 'normal',
  paragraphIndent: true,
  focusMode: 'off',
  readingMode: 'scroll',
}

export const DEFAULT_TTS_PREFS: TtsPrefs = {
  rate: 1,
  autoNextChapter: true,
  source: 'system',
  systemVoiceURI: '',
  onlineEndpoint: '',
  onlineModel: '',
  onlineVoice: '',
  onlineKeyConfigured: false,
}

export const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = {
  skin: 'paper',
}

export const AI_PROMPT_KINDS: readonly AiPromptKind[] = [
  'clean',
  'translate',
  'chapterSummary',
  'recap',
  'memory',
  'evidenceQa',
]

export const DEFAULT_AI_PREFS: AiPrefs = {
  provider: 'deepseek',
  thinkingEnabled: true,
  recapLength: 'standard',
  budgetWarningTokens: 8000,
  trustedCustomOrigins: [],
  autoBookOverview: false,
  promptMode: {
    clean: 'builtin',
    translate: 'builtin',
    chapterSummary: 'builtin',
    recap: 'builtin',
    memory: 'builtin',
    evidenceQa: 'builtin',
  },
  customPrompts: {},
}

export const DEFAULT_AI_PLACEHOLDER = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
}
