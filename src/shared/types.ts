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

export interface BrowseState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export interface ReaderPrefs {
  fontSize: number
  lineHeight: number
  nightMode: boolean
}

export interface Settings {
  libraryPath: string
  baseUrl: string
  model: string
  /** 渲染进程只拿是否已配置，不回传明文 */
  apiKeyConfigured: boolean
  reader: ReaderPrefs
}

export interface SettingsUpdate {
  libraryPath?: string
  baseUrl?: string
  model?: string
  /** 空字符串表示清除 */
  apiKey?: string
  reader?: Partial<ReaderPrefs>
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

export interface AiSummaries {
  /** chapterId → 摘要；只含已读章 */
  byChapter: Record<string, string>
  updatedAt: string
}

export const DEFAULT_LIBRARY_PATH = 'D:\\spbf\\library'

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  fontSize: 18,
  lineHeight: 1.8,
  nightMode: false,
}

export const DEFAULT_AI_PLACEHOLDER = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
}
