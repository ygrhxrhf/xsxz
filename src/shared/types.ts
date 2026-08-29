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
  importType: ImportType
  status: Book['status']
  chapterCount: number
  readyCount: number
  progress: ReadingProgress | null
  updatedAt: string
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

export interface DownloadProgress {
  bookId: string
  title: string
  total: number
  done: number
  failed: number
  currentTitle?: string
  status: 'running' | 'paused' | 'done' | 'cancelled' | 'error'
  lastError?: string
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

export interface ReaderPrefs {
  fontSize: number
  lineHeight: number
  theme: ReaderTheme
  fontFamily: ReaderFontFamily
  contentWidth: ReaderContentWidth
  paragraphSpacing: ReaderParagraphSpacing
  paragraphIndent: boolean
}

/** 朗读偏好（Web speechSynthesis） */
export interface TtsPrefs {
  /** 语速，0.5–2 */
  rate: number
  /** 一章读完后自动跳下一章继续 */
  autoNextChapter: boolean
}

/** 界面皮肤：夜樱 / 简约 */
export type Skin = 'sakura' | 'minimal'

/** 外观偏好 */
export interface AppearancePrefs {
  skin: Skin
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
}

export interface SettingsUpdate {
  libraryPath?: string
  baseUrl?: string
  model?: string
  /** 空字符串表示清除 */
  apiKey?: string
  reader?: Partial<ReaderPrefs>
  tts?: Partial<TtsPrefs>
  appearance?: Partial<AppearancePrefs>
}

/** 本机按域名的 CSS 规则。不进 Settings / settings.json。 */
export interface SiteRule {
  host: string
  title?: string
  author?: string
  catalog?: string
  body?: string
}

export interface AiCleanResult {
  original: string
  cleaned: string
}

export interface AiChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

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

/** 主进程发送的流式任务终态。 */
export type AiDoneEvent =
  | { jobId: string; ok: true; text: string }
  | { jobId: string; ok: false; message: string }

/** 每书 ai/chat.json 的内容；不包含 system 消息或 API Key。 */
export interface AiChatFile {
  version: 1
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
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
}

export const DEFAULT_TTS_PREFS: TtsPrefs = {
  rate: 1,
  autoNextChapter: true,
}

export const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = {
  skin: 'sakura',
}

export const DEFAULT_AI_PLACEHOLDER = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
}
