/** 共享类型契约。工人只读；要加字段走协调者补丁。 */

export type ImportType = 'download' | 'txt' | 'epub'

export type ChapterStatus = 'pending' | 'ready' | 'failed' | 'empty'

export type FailCode =
  | 'CatalogNotFound'
  | 'BodyEmpty'
  | 'NeedLogin'
  | 'Paywall'
  | 'Intercepted'
  | 'RateLimited'
  | 'NavFailed'
  | 'UnknownPage'

export const FAIL_CODE_ZH: Record<FailCode, string> = {
  CatalogNotFound: '找不到目录',
  BodyEmpty: '正文为空或过短',
  NeedLogin: '需要登录后才能看',
  Paywall: '本章需要付费或会员',
  Intercepted: '页面不像正文（拦截或残页）',
  RateLimited: '站点限流，请求过于频繁',
  NavFailed: '章节地址加载失败',
  UnknownPage: '无法识别为书',
}

export type PageKind = 'catalog' | 'chapter' | 'unknown'

/**
 * 付费墙自动恢复正文的手段；`paywallUnlock.ts` 的尝试顺序即下方的排列顺序。
 * 只见于「正文已到浏览器、只是被页面挡住」的情形。
 */
export type UnlockMethod = 'rule' | 'hiddenDom' | 'embeddedJson' | 'encoded' | 'paged' | 'api' | 'ocr'

export const UNLOCK_METHOD_ZH: Record<UnlockMethod, string> = {
  rule: '站点规则容器',
  hiddenDom: '页面隐藏正文',
  embeddedJson: '页面内嵌数据',
  encoded: '编码载荷',
  paged: '隐藏续页拼接',
  api: '站点章节接口',
  ocr: '图片/字形 OCR',
}

export interface ReadingProgress {
  chapterId: string
  /** 0–1，章内滚动比例 */
  scrollRatio: number
  /** 规范化正文的段落位置；旧书缺省时回退到 scrollRatio。 */
  paragraphIndex?: number
  paragraphOffset?: number
  updatedAt: string
}

/** 已显示到视窗底部的正文位置；正文变化后旧记录不能用于 AI 取材。 */
export interface ReadFrontierPosition {
  paragraphIndex: number
  characterOffset: number
  bodyHash: string
  updatedAt: string
}

export interface ReadFrontier {
  chapters: Record<string, ReadFrontierPosition>
  legacyConfirmed: boolean
  legacyProposal: ReadingProgress | null
  sessions: Array<{ startedAt: string; lastActivityAt: string; fromChapterId: string; toChapterId: string }>
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
  /** 正文是付费墙自动恢复来的；缺省表示正常抓取。见 `UNLOCK_METHOD_ZH`。 */
  unlockedBy?: UnlockMethod
}

export interface ChapterFile {
  title: string
  url?: string
  body: string
  bodyRaw?: string
  status: ChapterStatus
  failCode?: FailCode
  /** 本章正文是付费墙自动恢复来的；缺省表示正常抓取。见 `UNLOCK_METHOD_ZH`。 */
  unlockedBy?: UnlockMethod
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
  /** 其中正文由付费墙自动恢复来的章数；缺省 0。 */
  unlockedCount?: number
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
  /** 缺省表示「正文为空或过短」等无码失败；界面按码分组展示。 */
  failCode?: FailCode
}

export interface DownloadProgress {
  bookId: string
  title: string
  total: number
  done: number
  failed: number
  currentTitle?: string
  /**
   * `awaitingHuman` 是 running 的子态：撞见登录 / 付费 / 验证页后暂停在当章，
   * 等用户在内置浏览页亲自处理后用 `download.resumeUnblock` 续跑。
   * 它不是结束态，不携带 `failedChapters`。
   */
  status: 'running' | 'awaitingHuman' | 'done' | 'cancelled' | 'error'
  lastError?: string
  /** 仅结束事件（done / error / cancelled）携带；无失败或空章时为 []。running 省略。 */
  failedChapters?: FailedChapterItem[]
  qualityIssueCount?: number
}

/** 下载暂停等人工时推送的那一章（主进程只做导航，不代用户点击或登录）。 */
export interface DownloadBlocked {
  bookId: string
  chapterId: string
  chapterTitle: string
  url: string
  failCode: FailCode
  /** 给人看的一句话：失败原因 + 该去浏览页做什么。 */
  message: string
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
  kind:
    | 'short'
    | 'truncated'
    | 'duplicateBody'
    | 'duplicateUrl'
    | 'suspectedAd'
    | 'suspectedWall'
    /** 正文是付费墙自动恢复来的：内容是否完整要本人核对。 */
    | 'unlockedBody'
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
  /**
   * 备注出处：AI 生成（解释/本章笔记）标 'ai'，读者自己写的标 'user'。
   * 缺省视为 'user'，旧数据不需要迁移。界面据此区分「AI 建议」和「我的话」，
   * 也让 AI 知道这段关注点是读者本人的判断还是模型自己的上一轮输出。
   */
  noteSource?: AnnotationNoteSource
  createdAt: string
}

export type AnnotationNoteSource = 'user' | 'ai'

export interface AnnotationUpdate {
  note?: string
  /** 备注出处，只在与 note 一起提交时生效；note 被清空时该字段自动删除 */
  noteSource?: AnnotationNoteSource
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

/**
 * ai/characters.json 的内容。
 *
 * @deprecated 人物卡生成侧已下线（无 `ai.characterCard` / `ai.getCharacterCard` 频道）。
 * 这个形状只保留给 `readAiMemoryCompat` 读旧书，并作为 `ai.getMemory` 的兼容返回；
 * 新写入路径一律用 `AiMemoryFile`，不要再为它添加生成入口。
 */
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
  zoom: number
  previousChapter?: BrowseChapterLink
  nextChapter?: BrowseChapterLink
}

export interface BrowseChapterLink { title: string; url: string }
export interface BrowseReadingPage { url: string; title: string; body: string }
export interface BrowseFindResult { matches: number; activeMatch: number }

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

/** 应用界面外观：浅色 / 深色；阅读正文主题独立保存。 */
export type Skin = 'light' | 'dark'

/** 下载章与章之间的固定间隔档位。 */
export type DownloadPace = 'slow' | 'standard' | 'fast'

/** 外观偏好 */
export interface AppearancePrefs {
  skin: Skin
}

export type AiProvider = 'deepseek' | 'custom'
export type AiPromptKind =
  | 'clean' | 'translate' | 'chapterSummary' | 'chapterNote' | 'recap' | 'memory' | 'evidenceQa'
export type AiPromptMode = 'builtin' | 'custom'

export interface TierSensePrefs {
  enabled: boolean
  baseUrl: string
  difficultyEnabled: boolean
  compressionEnabled: boolean
  memoryDecideEnabled: boolean
  compressionMinTokens: number
  difficultyThreshold: number
}

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
  /** 自动追剧：读完一章后自动整理本章摘要与记忆。默认关闭，必须由用户明确开启。 */
  autoReadingFollow: boolean
  /** 单次追剧/记忆更新最多处理的章节数；记忆仍按每 5 章一批送模型。 */
  followMaxChaptersPerRun: number
  /** 每书每自然月的自动任务估算 token 门禁；不代表服务商账单金额。 */
  autoMonthlyTokenLimit: number
  promptMode: Record<AiPromptKind, AiPromptMode>
  customPrompts: Partial<Record<AiPromptKind, string>>
  tierSense: TierSensePrefs
}

export interface Settings {
  libraryPath: string
  baseUrl: string
  model: string
  /** 渲染进程只拿是否已配置，不回传明文 */
  apiKeyConfigured: boolean
  /** 主进程始终补齐；可选仅为旧调用方与测试兼容。 */
  embedding?: { baseUrl: string; model: string; keyConfigured: boolean }
  /** TierSense API Key 是否已配置；渲染进程只拿布尔值。 */
  tierSenseKeyConfigured: boolean
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
  embedding?: { baseUrl?: string; model?: string }
  /** 空字符串清除独立的向量服务密钥。 */
  embeddingApiKey?: string
  reader?: Partial<ReaderPrefs>
  tts?: Partial<TtsPrefs>
  /** 空字符串清除在线语音密钥。 */
  ttsApiKey?: string
  /** 空字符串清除 TierSense 密钥。 */
  tierSenseApiKey?: string
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
  previousChapter?: string
  nextChapter?: string
  /** 缺省开启；仅影响内置浏览页的广告元素显示。 */
  adFilterEnabled?: boolean
  /** 每行一个额外的广告元素 CSS 选择器。 */
  adHideSelectors?: string
  /**
   * 付费墙自动恢复正文：缺省开启。false 时遇到付费墙直接按墙暂停等本人处理。
   */
  paywallUnlock?: boolean
  /**
   * 每行一个解锁容器 CSS 选择器：站点把全文藏在页面里时直取。
   * 命中即取该节点全文（含被样式隐藏的部分），不看可见性。
   */
  unlockSelectors?: string
  /**
   * 章节接口模板：首屏只有试读、正文要走站点自己的接口时填这个。
   * 占位符 `{id}` / `{cid}` / `{chapterId}` / `{page}` 用当前页线索替换。
   * 例：`/ajax/chapter?id={id}`、`/api/novel/content/{id}`。留空则只用页面里现成的线索。
   */
  chapterApi?: string
  /** 接口方法，缺省 GET。只有配上 `chapterApiBody` 才会真的用 POST。 */
  chapterApiMethod?: 'GET' | 'POST'
  /** POST 请求体模板（JSON 文本），同样支持 `{id}` 占位。 */
  chapterApiBody?: string
  /**
   * 图片正文 / 字形替换（字体混淆）时走 OCR：缺省关闭（要装 OCR 引擎、也慢）。
   * 开了之后，接口也没拿到正文才认得动图，认得的结果要本人核对。
   */
  ocrUnlock?: boolean
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
  /** 本次实际送模型的章节数。 */
  processedChapters: number
  changedItems: number
  /** 受 followMaxChaptersPerRun 截断后仍未处理的已读章节数；重建恒为 0。 */
  remainingChapters: number
}

export interface AiResumeCard {
  generatedAt: string
  sessionEndedAt: string
  sourceHash: string
  chapters: Array<{ id: string; title: string }>
  changes: Array<{ text: string; sources: AiCitation[] }>
  conflicts: Array<{ text: string; sources: AiCitation[] }>
  questions: Array<{ text: string; sources: AiCitation[] }>
}

export interface AiResumeCardView {
  available: boolean
  reason: string
  stale: boolean
  card: AiResumeCard | null
}

export interface AiTimelineEntry {
  id: string
  kind: 'character' | 'foreshadow'
  name: string
  phase: '出现' | '变化' | '当前状态'
  text: string
  uncertain: boolean
  userEdited: boolean
  source: AiCitation
}

export interface AiTimelineView {
  entries: AiTimelineEntry[]
  stale: boolean
  message: string
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

/**
 * 追剧整理的每本书选择：manual 不自动整理；ask 读完只记账、等用户点「现在整理」；
 * auto 读完即排队整理（仍受设置页总开关与单次章数上限约束）。
 */
export type AiFollowMode = 'manual' | 'ask' | 'auto'

/** 自动追剧的运行视图，随 `ai.getMaterialCoverage` 返回，不另开事件通道。 */
export interface AiFollowCoverage {
  mode: AiFollowMode
  /** 主进程当前是否正为这本书跑整理单元。 */
  running: boolean
  /** 因单次章数上限或连续网络失败而停住，等用户点「继续」。 */
  paused: boolean
  pauseReason?: string
  /** 已判定读完、摘要或记忆还没跑完的章节数。 */
  queuedChapters: number
  /** 摘要已落盘的章节数。 */
  organizedChapters: number
  /** 摘要真正落盘到的最后一章；跳过的章（正文没了、超出已读范围）不会推进它。 */
  uptoChapterId?: string
  uptoChapterTitle?: string
  failed?: { message: string; at: string }
  calls: number
  estimatedTokens: number
}

/**
 * `ai.followSet` 的成功与预算确认结果。首次开启 auto 时与 `ai.updateMemory` 用同一套门禁：
 * 没带 `confirmOverBudget` 就只回预算与文案，不落盘、不排队、不花额度。
 * 只带 `message` 的失败（书不存在、模式非法）由 handler 的 catch 追加，见 preload 与契约文档。
 */
export type AiFollowStart =
  | { ok: true; coverage: AiFollowCoverage }
  | { ok: false; confirmationRequired: true; message: string; budget: AiBudgetEstimate }

/** 已读范围内章节摘要覆盖情况；缺摘要的章节仍可被原文检索。 */
export interface AiMaterialCoverage {
  uptoChapterId: string
  uptoChapterTitle: string
  readyChapters: number
  summarizedChapters: number
  missing: Array<{ chapterId: string; title: string }>
  /** 自动追剧的运行状态；主进程按当前 follow.json 与在跑标记填充。 */
  follow: AiFollowCoverage
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

/**
 * `queued` / `indexing` 只携带 `detail` 文案，不改变终态：旧监听方按未知阶段忽略即可，
 * 界面拿它们解释「为什么还没开始出字」，不拿它们推断成败。
 */
export type AiRequestStage =
  | 'preparing' | 'queued' | 'indexing' | 'rewriting' | 'searching' | 'requesting' | 'saving'

export interface AiStageEvent {
  jobId: string
  stage: AiRequestStage
  /** 面向用户的一句话进度（排队位置、索引覆盖度、批次进度）；缺省时界面按阶段名显示。 */
  detail?: string
  /** 证据问答的本地引用已先于回答算出，可提前展示；旧监听方可忽略。 */
  citations?: AiCitation[]
  /** 与 citations 同时推送的已读夹紧截止。 */
  uptoChapterId?: string
}

export interface AiBudgetEvent {
  jobId: string
  task: 'recap' | 'chapterSummary' | 'chapterNote' | 'memory' | 'qa'
  budget: AiBudgetEstimate
}

export interface AiEvidenceChatMessage {
  role: 'user' | 'assistant'
  content: string
  citations?: AiCitation[]
  claims?: Array<{ text: string; citationIds: string[] }>
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

/**
 * 「一键本章笔记」的落盘条目：正文一改，bodyHash 就对不上，界面提示重新生成，
 * 但绝不悄悄改写读者已经认可的内容（userEdited 为真时更是只提示不覆盖）。
 */
export interface AiChapterNote {
  chapterId: string
  /** 生成时正文的 sha256，用来判断这条笔记是否已经过期 */
  bodyHash: string
  text: string
  updatedAt: string
  /** 读者亲手编辑过：AI 只提示过期，不再覆盖 */
  userEdited?: boolean
}

/**
 * ai.chapterNotes 的响应：notes 按章节顺序返回这本书已有的本章笔记；
 * current 是调用方指定 chapterId 的那条笔记并带 stale 判定，未指定或该章无笔记则为 null。
 * 过期要拿正文重算 hash，因此只对请求的这一章算，其余章节不谎报新鲜度。
 */
export type AiChapterNotesResult =
  | { ok: true; notes: AiChapterNote[]; current: (AiChapterNote & { stale: boolean }) | null }
  | { ok: false; message: string }

/**
 * 异步 AI 任务的启动响应。队列只排队不拒绝，因此成功分支可携带排队信息：
 * `position` 是该任务在等待队列里的位次（从 1 开始），已经在跑则为 0。旧调用方忽略这两个字段即可。
 */
export type AiJobStart =
  | { ok: true; jobId: string; queued?: boolean; position?: number }
  | { ok: false; message: string }

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
      claims?: Array<{ text: string; citationIds: string[] }>
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
  skin: 'light',
}

export const AI_PROMPT_KINDS: readonly AiPromptKind[] = [
  'clean',
  'translate',
  'chapterSummary',
  'chapterNote',
  'recap',
  'memory',
  'evidenceQa',
]

export const DEFAULT_TIER_SENSE_PREFS: TierSensePrefs = {
  enabled: false,
  baseUrl: '',
  difficultyEnabled: true,
  compressionEnabled: true,
  memoryDecideEnabled: true,
  compressionMinTokens: 6000,
  difficultyThreshold: 0.6,
}

export const DEFAULT_AI_PREFS: AiPrefs = {
  provider: 'deepseek',
  thinkingEnabled: true,
  recapLength: 'standard',
  budgetWarningTokens: 8000,
  trustedCustomOrigins: [],
  autoBookOverview: false,
  autoReadingFollow: false,
  followMaxChaptersPerRun: 12,
  autoMonthlyTokenLimit: 100_000,
  promptMode: {
    clean: 'builtin',
    translate: 'builtin',
    chapterSummary: 'builtin',
    chapterNote: 'builtin',
    recap: 'builtin',
    memory: 'builtin',
    evidenceQa: 'builtin',
  },
  customPrompts: {},
  tierSense: DEFAULT_TIER_SENSE_PREFS,
}

export const DEFAULT_AI_PLACEHOLDER = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
}
