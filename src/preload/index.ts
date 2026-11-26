import { contextBridge, ipcRenderer } from 'electron'
import type { AtlasRecognition } from '../shared/atlas'
import type {
  AiBookUsage,
  AiBudgetEstimate,
  AiBudgetEvent,
  AiCitation,
  AiChapterNote,
  AiChapterNotesResult,
  AiChatMessage,
  AiChatThreadSummary,
  AiCreateThreadResult,
  AiListThreadsResult,
  AiChunkEvent,
  AiCleanResult,
  AiDoneEvent,
  AiFollowCoverage,
  AiFollowMode,
  AiEvidenceChatMessage,
  AiFollowStart,
  AiGetChatResult,
  AiJobStart,
  AiMemoryBase,
  AiMemoryCharacter,
  AiMemoryFile,
  AiMaterialCoverage,
  AiPlaceCandidateView,
  AiPlaceExtractionView,
  AiPlaceGeo,
  AiPlaceGeocodeView,
  MapManualPlaceInput,
  AiProvider,
  AiResumeCard,
  AiResumeCardView,
  AiStageEvent,
  AiSummaries,
  AiTimelineView,
  AiUsage,
  BookListItem,
  BrowseState,
  BrowseFindResult,
  BrowseReadingChapter,
  BrowseReadingPage,
  ChapterFile,
  DownloadBlocked,
  DownloadProgress,
  ReadingProgress,
  ReadFrontier,
  RuleMarketEntry,
  RuleMarketListing,
  ReadFrontierPosition,
  TtsPosition,
  ProxyAutoUpdatePrefs,
  ProxyKernelState,
  ProxyKernelInstallResult,
  ProxyPrefs,
  ProxySpeedTestResult,
  ProxySubscriptionState,
  Settings,
  SettingsUpdate,
  SiteRule,
  SyncAccountState,
  SyncResult,
  WebShelfBook,
  WebShelfChapter,
  WebShelfProgress,
} from '../shared/types'

type Unsub = () => void

function on<T>(channel: string, handler: (payload: T) => void): Unsub {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  agentAudit: {
    list: (limit = 100) => ipcRenderer.invoke('agentAudit.list', { limit }) as Promise<{
      ok: true
      entries: Array<{
        ts: string
        client: string
        tool: string
        channel: string
        tier: string
        dryRun: boolean
        confirmed: boolean
        ok: boolean
        code?: string
        ms: number
        argsHash: string
      }>
    }>,
  },
  dialog: {
    openFile: () => ipcRenderer.invoke('dialog.openFile') as Promise<{ filePaths: string[] }>,
    openDirectory: (title?: string) => ipcRenderer.invoke('dialog.openDirectory', { title }) as Promise<{ filePaths: string[] }>,
    openZip: () => ipcRenderer.invoke('dialog.openZip') as Promise<{ filePaths: string[] }>,
  },
  tts: {
    getPosition: (bookId: string) => ipcRenderer.invoke('tts.getPosition', { bookId }) as Promise<TtsPosition | null>,
    setPosition: (bookId: string, position: TtsPosition) => ipcRenderer.invoke('tts.setPosition', { bookId, position }) as Promise<{ ok: true }>,
    synthesize: (requestId: string, text: string) => ipcRenderer.invoke('tts.synthesize', { requestId, text }) as Promise<Uint8Array>,
    cancel: (requestId: string) => ipcRenderer.invoke('tts.cancel', { requestId }) as Promise<{ ok: true }>,
  },
  browse: {
    load: (url: string) => ipcRenderer.invoke('browse.load', { url }),
    back: () => ipcRenderer.invoke('browse.back'),
    forward: () => ipcRenderer.invoke('browse.forward'),
    reload: () => ipcRenderer.invoke('browse.reload'),
    stop: () => ipcRenderer.invoke('browse.stop'),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('browse.setBounds', bounds),
    setVisible: (visible: boolean) => ipcRenderer.invoke('browse.setVisible', { visible }),
    resume: () => ipcRenderer.invoke('browse.resume') as Promise<{ ok: boolean; restored?: boolean; message?: string }>,
    zoom: (factor: number) => ipcRenderer.invoke('browse.zoom', { factor }) as Promise<{ ok: boolean; factor?: number; message?: string }>,
    // isCatalog：当前页其实是书页（目录页），没有章节可读；调用方应改成「从第一章开始」。
    readingPage: (url?: string) => ipcRenderer.invoke('browse.readingPage', { url }) as Promise<{ ok: true; page: BrowseReadingPage } | { ok: false; message: string; isCatalog?: boolean }>,
    setReadingMode: (enabled: boolean) => ipcRenderer.invoke('browse.setReadingMode', { enabled }),
    chapter: (direction: 'previous' | 'next') => ipcRenderer.invoke('browse.chapter', { direction }) as Promise<{ ok: boolean; message?: string }>,
    prefetchChapter: (url: string) => ipcRenderer.invoke('browse.prefetchChapter', { url }) as Promise<{ ok: boolean; cached: boolean }>,
    chapterCatalog: (params: { catalogUrl?: string; url?: string } = {}) =>
      ipcRenderer.invoke('browse.chapterCatalog', { catalogUrl: params.catalogUrl, url: params.url }) as Promise<{ ok: true; catalogUrl: string; chapters: WebShelfChapter[]; currentIndex: number } | { ok: false; message: string }>,
    saveReadingPos: (params: { url: string; title?: string; paragraphIndex: number; scrollRatio: number }) =>
      ipcRenderer.invoke('browse.saveReadingPos', {
        url: params.url,
        title: params.title,
        paragraphIndex: params.paragraphIndex,
        scrollRatio: params.scrollRatio,
      }) as Promise<{ ok: boolean }>,
    getReadingPos: (url: string) => ipcRenderer.invoke('browse.getReadingPos', { url }) as Promise<{ ok: true; position: WebShelfProgress | null }>,
    find: (query: string, forward = true, findNext = false) => ipcRenderer.invoke('browse.find', { query, forward, findNext }),
    stopFind: () => ipcRenderer.invoke('browse.stopFind'),
    hide: (action: 'start' | 'stop' | 'undo' | 'count') => ipcRenderer.invoke('browse.hide', { action }) as Promise<{ ok: boolean; remaining?: number; message?: string }>,
    onFindResult: (handler: (payload: BrowseFindResult) => void) => on('browse.findResult', handler),
    onShortcut: (handler: (payload: { direction?: 'previous' | 'next'; find?: boolean }) => void) => on('browse.shortcut', handler),
    onUrl: (handler: (payload: { url: string }) => void) => on('browse.url', handler),
    onState: (handler: (payload: BrowseState) => void) => on('browse.state', handler),
    onReadingChapter: (handler: (payload: BrowseReadingChapter) => void) => on('browse.readingChapter', handler),
  },
  shelf: {
    list: () => ipcRenderer.invoke('shelf.list') as Promise<{ ok: true; books: WebShelfBook[] }>,
    add: (url?: string) => ipcRenderer.invoke('shelf.add', { url }) as Promise<{ ok: true; book: WebShelfBook } | { ok: false; message: string }>,
    remove: (id: string) => ipcRenderer.invoke('shelf.remove', { id }) as Promise<{ ok: boolean }>,
    refresh: (id: string) => ipcRenderer.invoke('shelf.refresh', { id }) as Promise<{ ok: true; added: number; book: WebShelfBook } | { ok: false; message: string }>,
    refreshAll: () => ipcRenderer.invoke('shelf.refreshAll') as Promise<{ ok: true; checked: number; updated: number }>,
    setProgress: (id: string, chapter: WebShelfChapter, paragraphIndex: number, scrollRatio: number) =>
      ipcRenderer.invoke('shelf.setProgress', { id, chapter, paragraphIndex, scrollRatio }) as Promise<{ ok: boolean }>,
    chapters: (id: string) => ipcRenderer.invoke('shelf.chapters', { id }) as Promise<{ ok: true; chapters: WebShelfChapter[]; currentIndex: number } | { ok: false; message: string }>,
    onChanged: (handler: (payload: { reason: 'add' | 'remove' | 'refresh' | 'progress' }) => void) => on('shelf.changed', handler),
  },
  library: {
    list: () =>
      ipcRenderer.invoke('library.list') as Promise<{ books: BookListItem[]; libraryPath?: string; readable?: boolean }>,
    get: (bookId: string) => ipcRenderer.invoke('library.get', { bookId }) as Promise<{ book?: import('../shared/types').Book; ok?: false; message?: string }>,
    readBookStats: (bookId: string) =>
      ipcRenderer.invoke('library.readBookStats', { bookId }) as Promise<{ stats?: Array<{ chapterId: string; chars: number }>; ok?: false; message?: string }>,
    readChapter: (bookId: string, chapterId: string) =>
      ipcRenderer.invoke('library.readChapter', { bookId, chapterId }) as Promise<{ chapter?: ChapterFile; ok?: false; message?: string }>,
    delete: (bookId: string) => ipcRenderer.invoke('library.delete', { bookId }),
    import: (filePath: string) => ipcRenderer.invoke('library.import', { filePath }) as Promise<{ ok: boolean; bookId?: string; message?: string }>,
    setProgress: (bookId: string, progress: ReadingProgress) =>
      ipcRenderer.invoke('library.setProgress', { bookId, progress }),
    getReadFrontier: (bookId: string) => ipcRenderer.invoke('library.getReadFrontier', { bookId }) as Promise<{ ok: true; frontier: ReadFrontier } | { ok: false; message: string }>,
    markReadFrontier: (bookId: string, chapterId: string, paragraphIndex: number, characterOffset: number) =>
      ipcRenderer.invoke('library.markReadFrontier', { bookId, chapterId, paragraphIndex, characterOffset }) as Promise<{ ok: true; position: ReadFrontierPosition } | { ok: false; message: string }>,
    confirmLegacyReadRange: (bookId: string) => ipcRenderer.invoke('library.confirmLegacyReadRange', { bookId }) as Promise<{ ok: true; frontier: ReadFrontier } | { ok: false; message: string }>,
    updateMeta: (payload: { bookId: string; title: string; author: string; tags: string[] }) =>
      ipcRenderer.invoke('library.updateMeta', payload) as Promise<{ ok: true } | { ok: false; message: string }>,
    setCover: (payload: { bookId: string; sourcePath: string }) =>
      ipcRenderer.invoke('library.setCover', payload) as Promise<
        { ok: true; coverPath: string } | { ok: false; message: string }
      >,
    pickCoverFile: () => ipcRenderer.invoke('library.pickCoverFile') as Promise<string | null>,
    generateCover: (bookId: string, opts?: { force?: boolean }) =>
      ipcRenderer.invoke('library.generateCover', { bookId, force: opts?.force === true }) as Promise<
        { ok: true; bookId: string; coverPath: string } | { ok: false; code: string; message: string }
      >,
    updateChapterBody: (bookId: string, chapterId: string, body: string, restoreRaw?: boolean) =>
      ipcRenderer.invoke('library.updateChapterBody', { bookId, chapterId, body, restoreRaw }),
    repairChapterBody: (bookId: string, chapterId: string, body: string) =>
      ipcRenderer.invoke('library.repairChapterBody', { bookId, chapterId, body }) as Promise<{ ok: boolean; message?: string }>,
    audit: (bookId: string) => ipcRenderer.invoke('library.audit', { bookId }) as Promise<
      { ok: true; report: import('../shared/types').QualityReport } | { ok: false; message: string }
    >,
    migrate: (targetPath: string) => ipcRenderer.invoke('library.migrate', { targetPath }) as Promise<
      { ok: true; oldPath: string; newPath: string; files: number } | { ok: false; message: string }
    >,
    export: (bookId: string, format: 'txt' | 'epub', destDir: string) =>
      ipcRenderer.invoke('library.export', { bookId, format, destDir }) as Promise<
        { ok: true; path: string } | { ok: false; message: string }
      >,
    searchInBook: (bookId: string, query: string) =>
      ipcRenderer.invoke('library.searchInBook', { bookId, query }) as Promise<
        { ok: true; hits: import('../shared/types').BookSearchHit[] } | { ok: false; message: string }
      >,
    getReadingStats: (limitDays?: number) =>
      ipcRenderer.invoke('library.getReadingStats', { limitDays }) as Promise<
        { ok: true; stats: import('../shared/types').ReadingStatsView } | { ok: false; message: string }
      >,
    listTrash: () =>
      ipcRenderer.invoke('library.listTrash') as Promise<
        { ok: true; items: import('../shared/types').TrashItem[] } | { ok: false; message: string }
      >,
    restoreTrash: (name: string) =>
      ipcRenderer.invoke('library.restoreTrash', { name }) as Promise<{ ok: true } | { ok: false; message: string }>,
    purgeTrash: (name?: string) =>
      ipcRenderer.invoke('library.purgeTrash', { name }) as Promise<
        { ok: true; purged: number } | { ok: false; message: string }
      >,
  },
  bookOverview: {
    retry: (bookId: string) => ipcRenderer.invoke('bookOverview.retry', { bookId }) as Promise<{ ok: true } | { ok: false; message: string }>,
    onChanged: (handler: () => void) => on('bookOverview.changed', handler),
  },
  download: {
    preview: () => ipcRenderer.invoke('download.preview') as Promise<
      { ok: true; preview: import('../shared/types').DownloadPreview } | { ok: false; message: string; pageKind?: import('../shared/types').PreviewPageKind }
    >,
    confirm: (token: string) => ipcRenderer.invoke('download.confirm', { token }) as Promise<
      { ok: true; bookId: string } | { ok: false; message: string }
    >,
    redownloadChapter: (bookId: string, chapterId: string, url: string) =>
      ipcRenderer.invoke('download.redownloadChapter', { bookId, chapterId, url }) as Promise<{ ok: boolean; message?: string }>,
    cancel: (bookId?: string) => ipcRenderer.invoke('download.cancel', { bookId }),
    retryFailed: (bookId: string) => ipcRenderer.invoke('download.retryFailed', { bookId }),
    openUnblock: (bookId: string, chapterId: string) =>
      ipcRenderer.invoke('download.openUnblock', { bookId, chapterId }) as Promise<
        { ok: true; url: string } | { ok: false; message: string }
      >,
    resumeUnblock: (bookId: string) =>
      ipcRenderer.invoke('download.resumeUnblock', { bookId }) as Promise<{ ok: boolean; message?: string }>,
    checkUpdate: (bookId: string) => ipcRenderer.invoke('download.checkUpdate', { bookId }),
    checkAll: () =>
      ipcRenderer.invoke('download.checkAll') as Promise<import('../shared/types').CheckAllResult>,
    cancelCheckAll: () => ipcRenderer.invoke('download.cancelCheckAll') as Promise<{ ok: true }>,
    onProgress: (handler: (payload: DownloadProgress) => void) => on('download.progress', handler),
    onBlocked: (handler: (payload: DownloadBlocked) => void) => on('download.blocked', handler),
    onCheckAllProgress: (handler: (payload: import('../shared/types').CheckAllProgress) => void) =>
      on('download.checkAll.progress', handler),
  },
  mirror: {
    start: (options: { seedUrl?: string; maxBooks?: number; maxPages?: number; resume?: boolean }) =>
      ipcRenderer.invoke('mirror.start', options) as Promise<
        { ok: true; jobId: string } | { ok: false; message: string }
      >,
    cancel: () => ipcRenderer.invoke('mirror.cancel') as Promise<{ ok: true }>,
    state: () =>
      ipcRenderer.invoke('mirror.state') as Promise<{ ok: true; state: import('../shared/types').MirrorStateView }>,
    onProgress: (handler: (payload: import('../shared/types').MirrorProgress) => void) =>
      on('mirror.progress', handler),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings.get') as Promise<Settings>,
    set: (update: SettingsUpdate) => ipcRenderer.invoke('settings.set', update) as Promise<Settings>,
  },
  map: {
    /** 打开地图页时按需取解密后的 Key；未配置或本机解不开时返回空串。 */
    getKey: () => ipcRenderer.invoke('map.getKey') as Promise<string>,
    getImage: (bookId: string) => ipcRenderer.invoke('map.getImage', { bookId }) as Promise<
      { ok: true; url: string | null } | { ok: false; message: string }
    >,
    setImage: (payload: { bookId: string; sourcePath: string }) => ipcRenderer.invoke('map.setImage', payload) as Promise<
      { ok: true; url: string } | { ok: false; message: string }
    >,
    getPlaces: (bookId: string) => ipcRenderer.invoke('map.getPlaces', { bookId }) as Promise<
      { ok: true; places: AiPlaceGeo[] } | { ok: false; message: string }
    >,
    confirmPlace: (bookId: string, placeId: string, accepted: boolean) =>
      ipcRenderer.invoke('map.confirmPlace', { bookId, placeId, accepted }) as Promise<
        { ok: true; places: AiPlaceGeo[] } | { ok: false; message: string }
      >,
    searchPlaceCandidates: (bookId: string, placeId: string) =>
      ipcRenderer.invoke('map.searchPlaceCandidates', { bookId, placeId }) as Promise<
        { ok: true; view: AiPlaceCandidateView } | { ok: false; message: string }
      >,
    choosePlaceCandidate: (bookId: string, placeId: string, candidate: { latitude: number; longitude: number }) =>
      ipcRenderer.invoke('map.choosePlaceCandidate', { bookId, placeId, candidate }) as Promise<
        { ok: true; places: AiPlaceGeo[] } | { ok: false; message: string }
      >,
    geocodePlaces: (bookId: string, retryNotFound = false) =>
      ipcRenderer.invoke('map.geocodePlaces', { bookId, retryNotFound }) as Promise<
        { ok: true; view: AiPlaceGeocodeView } | { ok: false; message: string }
      >,
    /** 手工标注一个地名坐标（不消耗腾讯配额）。 */
    addManualPlace: (payload: MapManualPlaceInput) =>
      ipcRenderer.invoke('map.addManualPlace', payload) as Promise<
        { ok: true; places: AiPlaceGeo[] } | { ok: false; message: string }
      >,
    /** 自动识别书中原图（视觉模型 + 城市坐标库）；refresh 为 true 时绕过缓存重新识别。 */
    recognize: (bookId: string, refresh = false) =>
      ipcRenderer.invoke('map.recognize', { bookId, refresh }) as Promise<
        { ok: true; recognition: AtlasRecognition } | { ok: false; message: string }
      >,
    /** 只读上次保存的识别结论，不调用模型。 */
    getRecognition: (bookId: string) =>
      ipcRenderer.invoke('map.getRecognition', { bookId }) as Promise<
        { ok: true; recognition: AtlasRecognition | null } | { ok: false; message: string }
      >,
  },
  proxy: {
    /** 用真会话试一次：只看有没有拿到 HTTP 响应，403 / 挑战页也算通。 */
    test: (args?: { url?: string; prefs?: Partial<ProxyPrefs> }) =>
      ipcRenderer.invoke('proxy.test', args) as Promise<{ ok: boolean; message: string }>,
    /**
     * 扫本机常见代理端口。只查回环地址，只回答「在不在监听」；
     * 能不能真转发要再调 `test` 确认。
     */
    scan: () =>
      ipcRenderer.invoke('proxy.scan') as Promise<{
        ok: true
        ports: { port: number; label: string; protocol: 'socks5' | 'http' }[]
        message: string
      }>,
    /** 拉订阅并启动内置内核（本应用自带 sing-box，不需要外部客户端）。 */
    subscribe: (args?: { url?: string }) =>
      ipcRenderer.invoke('proxy.subscribe', args) as Promise<
        | { ok: true; port: number; node: { name: string; protocol: string }; overview: ProxySubscriptionState }
        | { ok: false; message: string }
      >,
    /** 只解析不启动，先看有多少节点。 */
    parseSubscription: (args: { body: string }) =>
      ipcRenderer.invoke('proxy.parseSubscription', args) as Promise<
        { ok: true; overview: ProxySubscriptionState } | { ok: false; message: string }
      >,
    /** 换节点：重启内核。 */
    selectNode: (args: { index: number; body?: string }) =>
      ipcRenderer.invoke('proxy.selectNode', args) as Promise<
        { ok: true; port: number; node: { name: string; protocol: string } } | { ok: false; message: string }
      >,
    kernelState: () =>
      ipcRenderer.invoke('proxy.kernelState') as Promise<{
        ok: true
        state: ProxyKernelState
        /** 内核可执行文件是否已就位（含手动放置）。 */
        installed: boolean
      }>,
    /** 下载并安装内置内核；已安装时直接返回成功。 */
    installKernel: () =>
      ipcRenderer.invoke('proxy.installKernel') as Promise<ProxyKernelInstallResult>,
    stopKernel: () => ipcRenderer.invoke('proxy.stopKernel') as Promise<{ ok: true }>,
    /** 订阅自动更新的开关与上次结果。 */
    autoUpdateState: () =>
      ipcRenderer.invoke('proxy.autoUpdateState') as Promise<{ ok: true; prefs: ProxyAutoUpdatePrefs }>,
    /** 开关订阅自动更新；间隔分钟数非法时回退 60。 */
    setAutoUpdate: (payload: { enabled?: boolean; intervalMinutes?: number }) =>
      ipcRenderer.invoke('proxy.setAutoUpdate', payload) as Promise<
        { ok: true; prefs: ProxyAutoUpdatePrefs } | { ok: false; message: string }
      >,
    /** 立刻重拉一次订阅（不换节点）。 */
    refreshSubscription: () =>
      ipcRenderer.invoke('proxy.refreshSubscription') as Promise<
        { ok: true; overview: ProxySubscriptionState; prefs: ProxyAutoUpdatePrefs } | { ok: false; message: string }
      >,
    /** 多节点测速：并发探测各节点，返回每个节点的延迟。 */
    speedTest: () =>
      ipcRenderer.invoke('proxy.speedTest') as Promise<
        { ok: true; result: ProxySpeedTestResult } | { ok: false; message: string }
      >,
  },
  backup: {
    create: (destDir: string) =>
      ipcRenderer.invoke('backup.create', { destDir }) as Promise<
        { ok: true; path: string; files: number } | { ok: false; message: string }
      >,
    restore: (zipPath: string) =>
      ipcRenderer.invoke('backup.restore', { zipPath }) as Promise<
        { ok: true; books: number; files: number } | { ok: false; message: string }
      >,
    runAuto: () => ipcRenderer.invoke('backup.runAuto') as Promise<
      { status: 'disabled' | 'notDue' | 'created' | 'failed'; message?: string }
    >,
  },
  /** OCR 兜底引擎的可用性：设置页要显示「本机是否装了 tesseract.js」。 */
  ocr: {
    status: () => ipcRenderer.invoke('ocr.status') as Promise<{ ok: true; ready: boolean; reason?: string }>,
  },
  annotations: {
    list: (bookId: string) =>
      ipcRenderer.invoke('annotations.list', { bookId }) as Promise<
        { ok: true; items: import('../shared/types').Annotation[] } | { ok: false; message: string }
      >,
    add: (draft: Omit<import('../shared/types').Annotation, 'id' | 'createdAt'>) =>
      ipcRenderer.invoke('annotations.add', draft) as Promise<
        { ok: true; item: import('../shared/types').Annotation } | { ok: false; message: string }
      >,
    update: (
      bookId: string,
      annotationId: string,
      patch: import('../shared/types').AnnotationUpdate,
    ) =>
      ipcRenderer.invoke('annotations.update', { bookId, annotationId, patch }) as Promise<
        { ok: true; item: import('../shared/types').Annotation } | { ok: false; message: string }
      >,
    remove: (bookId: string, annotationId: string) =>
      ipcRenderer.invoke('annotations.remove', { bookId, annotationId }) as Promise<{ ok: true } | { ok: false; message: string }>,
  },
  /** 网页阅读模式的标注：归属键是规范化章节地址，不是书库 bookId。 */
  webAnnotations: {
    list: (url: string) =>
      ipcRenderer.invoke('webAnnotations.list', { url }) as Promise<
        { ok: true; items: import('../shared/types').WebAnnotation[] } | { ok: false; message: string }
      >,
    add: (draft: Omit<import('../shared/types').WebAnnotation, 'id' | 'createdAt'>) =>
      ipcRenderer.invoke('webAnnotations.add', draft) as Promise<
        { ok: true; item: import('../shared/types').WebAnnotation } | { ok: false; message: string }
      >,
    update: (url: string, annotationId: string, patch: import('../shared/types').WebAnnotationUpdate) =>
      ipcRenderer.invoke('webAnnotations.update', { url, annotationId, patch }) as Promise<
        { ok: true; item: import('../shared/types').WebAnnotation } | { ok: false; message: string }
      >,
    remove: (url: string, annotationId: string) =>
      ipcRenderer.invoke('webAnnotations.remove', { url, annotationId }) as Promise<
        { ok: true; removed: boolean } | { ok: false; message: string }
      >,
  },
  /** 站点 CSS 选择器市场：只含 CSS 规则，不含任何凭据。 */
  ruleMarket: {
    /** 列出市场里的共享规则（内置 + 远端）。 */
    list: () => ipcRenderer.invoke('ruleMarket.list') as Promise<RuleMarketListing>,
    /** 把市场规则应用到本机（写进 site-rules.json）。 */
    apply: (payload: { id: string }) =>
      ipcRenderer.invoke('ruleMarket.apply', payload) as Promise<
        { ok: true; rule: SiteRule } | { ok: false; message: string }
      >,
    /** 订阅某个来源的规则列表（按 URL 拉取远端清单）。 */
    subscribe: (payload: { url: string }) =>
      ipcRenderer.invoke('ruleMarket.subscribe', payload) as Promise<
        { ok: true; entries: RuleMarketEntry[] } | { ok: false; message: string }
      >,
    /** 取消订阅某个来源。 */
    unsubscribe: (payload: { url: string }) =>
      ipcRenderer.invoke('ruleMarket.unsubscribe', payload) as Promise<
        { ok: true } | { ok: false; message: string }
      >,
  },
  /** 账号与云同步：只同步设置与站点规则，书库正文不上云。 */
  sync: {
    /** 当前登录状态；未登录时 signedIn 为 false。 */
    status: () => ipcRenderer.invoke('sync.status') as Promise<{ ok: true; state: SyncAccountState }>,
    /** 用令牌登录（令牌由本人提供，保存在本机）。 */
    signIn: (payload: { token: string; endpoint?: string; account?: string }) =>
      ipcRenderer.invoke('sync.signIn', payload) as Promise<
        { ok: true; state: SyncAccountState } | { ok: false; message: string }
      >,
    signOut: () => ipcRenderer.invoke('sync.signOut') as Promise<{ ok: true; state: SyncAccountState }>,
    /** 与云端同步设置与站点规则。 */
    run: () =>
      ipcRenderer.invoke('sync.run') as Promise<{ ok: true; result: SyncResult } | { ok: false; message: string }>,
  },
  siteRules: {
    list: () => ipcRenderer.invoke('siteRules.list') as Promise<{ rules: SiteRule[] }>,
    preview: (rule: SiteRule) => ipcRenderer.invoke('siteRules.preview', rule) as Promise<
      { ok: true; preview: import('../shared/types').SiteRulePreview } | { ok: false; message: string }
    >,
    upsert: (rule: SiteRule) =>
      ipcRenderer.invoke('siteRules.upsert', rule) as Promise<
        { ok: true; rule: SiteRule } | { ok: false; message: string }
      >,
    remove: (host: string) =>
      ipcRenderer.invoke('siteRules.remove', { host }) as Promise<{ ok: true } | { ok: false; message: string }>,
  },
  ai: {
    clean: (bookId: string, chapterId: string, confirmOverBudget = false) =>
      ipcRenderer.invoke('ai.clean', { bookId, chapterId, confirmOverBudget }) as Promise<
        | { ok: true; result: AiCleanResult; budget: AiBudgetEstimate }
        | { ok: false; confirmationRequired: true; message: string; budget: AiBudgetEstimate }
        | { ok: false; stopped?: boolean; message: string }
      >,
    getChat: (bookId: string, threadId?: string) =>
      ipcRenderer.invoke('ai.getChat', { bookId, threadId }) as Promise<AiGetChatResult>,
    clearChat: (bookId: string, threadId?: string) =>
      ipcRenderer.invoke('ai.clearChat', { bookId, threadId }) as Promise<{ ok: true } | { ok: false; message: string }>,
    /** 整段覆盖问答历史：重问 / 编辑重发 / 删除某一轮都用它，避免重复轮次堆积。 */
    replaceChat: (bookId: string, messages: AiEvidenceChatMessage[], threadId?: string) =>
      ipcRenderer.invoke('ai.replaceChat', { bookId, messages, threadId }) as Promise<{ ok: true } | { ok: false; message: string }>,
    /** 会话栏：一本书的多条问答会话（问人物线 / 问这卷剧情 / 问伏笔各一条）。 */
    listThreads: (bookId: string) =>
      ipcRenderer.invoke('ai.listThreads', { bookId }) as Promise<AiListThreadsResult>,
    createThread: (bookId: string, title?: string) =>
      ipcRenderer.invoke('ai.createThread', { bookId, title }) as Promise<AiCreateThreadResult>,
    deleteThread: (bookId: string, threadId: string) =>
      ipcRenderer.invoke('ai.deleteThread', { bookId, threadId }) as Promise<{ ok: true } | { ok: false; message: string }>,
    test: (opts?: {
      baseUrl?: string
      model?: string
      apiKey?: string
      provider?: AiProvider
      thinkingEnabled?: boolean
    }) =>
      ipcRenderer.invoke('ai.test', opts) as Promise<{ ok: boolean; text?: string; message?: string }>,
    summarizeChapter: (bookId: string, chapterId: string, confirmOverBudget = false) =>
      ipcRenderer.invoke('ai.summarizeChapter', { bookId, chapterId, confirmOverBudget }) as Promise<
        AiJobStart | { ok: false; confirmationRequired: true; message: string; budget: AiBudgetEstimate }
      >,
    getMindmap: (bookId: string, chapterId: string) =>
      ipcRenderer.invoke('ai.getMindmap', { bookId, chapterId }) as Promise<
        import('../shared/mindmap').AiMindmapGetResponse
      >,
    generateMindmap: (bookId: string, chapterId: string, force = false) =>
      ipcRenderer.invoke('ai.generateMindmap', { bookId, chapterId, force }) as Promise<
        import('../shared/mindmap').AiMindmapGenerateResponse
      >,
    chapterNote: (
      bookId: string,
      chapterId: string,
      confirmOverBudget = false,
      overwriteUserNote = false,
    ) =>
      ipcRenderer.invoke('ai.chapterNote', { bookId, chapterId, confirmOverBudget, overwriteUserNote }) as Promise<
        | AiJobStart
        | { ok: false; confirmationRequired: true; message: string; budget: AiBudgetEstimate }
        | { ok: false; userNoteConfirmedRequired: true; message: string }
        | { ok: false; message: string }
      >,
    chapterNotes: (bookId: string, chapterId?: string) =>
      ipcRenderer.invoke('ai.chapterNotes', { bookId, chapterId }) as Promise<AiChapterNotesResult>,
    saveChapterNote: (bookId: string, chapterId: string, text: string) =>
      ipcRenderer.invoke('ai.saveChapterNote', { bookId, chapterId, text }) as Promise<
        | { ok: true; note: AiChapterNote }
        | { ok: false; message: string }
      >,
    storySoFar: (bookId: string, uptoChapterId: string, confirmOverBudget = false) =>
      ipcRenderer.invoke('ai.storySoFar', { bookId, uptoChapterId, confirmOverBudget }) as Promise<
        AiJobStart | { ok: false; confirmationRequired: true; message: string; budget: AiBudgetEstimate }
      >,
    getSummaries: (bookId: string) =>
      ipcRenderer.invoke('ai.getSummaries', { bookId }) as Promise<
        | { ok: true; summaries: AiSummaries }
        | { ok: false; message: string }
      >,
    chatStream: (bookId: string, chapterId: string, messages: AiChatMessage[], threadId?: string) =>
      ipcRenderer.invoke('ai.chatStream', { bookId, chapterId, messages, threadId }) as Promise<AiJobStart>,
    /** 「对话」tab：pi 驱动的多轮 agent，模型可自行调工具查原文/检索/看记忆。 */
    agentChat: (bookId: string, chapterId: string, messages: AiChatMessage[], threadId?: string, recallScope: 'book' | 'progress' = 'book') =>
      ipcRenderer.invoke('ai.agentChat', { bookId, chapterId, messages, threadId, recallScope }) as Promise<AiJobStart>,
    /** 「字词 / 百科」模式：脱离书籍、不校验阅读进度的多轮通用流式问答。 */
    generalChat: (bookId: string, messages: AiChatMessage[], threadId?: string) =>
      ipcRenderer.invoke('ai.generalChat', { bookId, messages, threadId }) as Promise<AiJobStart>,
    translateStream: (text: string, bookId?: string) =>
      ipcRenderer.invoke('ai.translateStream', { text, bookId }) as Promise<AiJobStart>,
    /** 「解释这段」：网页阅读模式用；与 translateStream 同形，不依赖书库条目。 */
    explainText: (text: string, bookId?: string) =>
      ipcRenderer.invoke('ai.explainSelection', { text, bookId }) as Promise<AiJobStart>,
    getMemory: (bookId: string) => ipcRenderer.invoke('ai.getMemory', { bookId }) as Promise<
      | { ok: true; memory: AiMemoryFile | import('../shared/types').CharacterCard | null }
      | { ok: false; message: string }
    >,
    updateMemory: (bookId: string, uptoChapterId: string, confirmOverBudget = false) =>
      ipcRenderer.invoke('ai.updateMemory', { bookId, uptoChapterId, confirmOverBudget }) as Promise<AiJobStart | { ok: false; confirmationRequired: true; message: string; budget: AiBudgetEstimate }>,
    rebuildMemory: (bookId: string, uptoChapterId: string, confirmOverBudget = false) =>
      ipcRenderer.invoke('ai.rebuildMemory', { bookId, uptoChapterId, confirmOverBudget }) as Promise<AiJobStart | { ok: false; confirmationRequired: true; message: string; budget: AiBudgetEstimate }>,
    rebuildMemoryFrom: (bookId: string, fromChapterId: string, uptoChapterId: string, confirmOverBudget = false) =>
      ipcRenderer.invoke('ai.rebuildMemoryFrom', { bookId, fromChapterId, uptoChapterId, confirmOverBudget }) as Promise<AiJobStart | { ok: false; confirmationRequired: true; message: string; budget: AiBudgetEstimate }>,
    markMemoryInaccurate: (
      bookId: string,
      kind: 'character' | 'relation' | 'foreshadow' | 'event',
      itemId: string,
    ) => ipcRenderer.invoke('ai.markMemoryInaccurate', { bookId, kind, itemId }) as Promise<
      { ok: true; item: AiMemoryBase } | { ok: false; message: string }
    >,
    correctCharacterAliases: (bookId: string, itemId: string, aliases: string[]) =>
      ipcRenderer.invoke('ai.correctCharacterAliases', { bookId, itemId, aliases }) as Promise<
        | { ok: true; character: AiMemoryCharacter; affectedChapterIds: string[] }
        | { ok: false; message: string }
      >,
    correctMemorySummary: (
      bookId: string,
      kind: 'character' | 'relation' | 'foreshadow' | 'event',
      itemId: string,
      summary: string,
    ) => ipcRenderer.invoke('ai.correctMemorySummary', { bookId, kind, itemId, summary }) as Promise<
      | { ok: true; item: AiMemoryBase; affectedChapterIds: string[] }
      | { ok: false; message: string }
    >,
    getMaterialCoverage: (bookId: string) =>
      ipcRenderer.invoke('ai.getMaterialCoverage', { bookId }) as Promise<
        | { ok: true; coverage: AiMaterialCoverage | null }
        | { ok: false; message: string }
      >,
    chapterFinished: (bookId: string, chapterId: string, ratio: number) =>
      ipcRenderer.invoke('ai.chapterFinished', { bookId, chapterId, ratio }) as Promise<
        | { ok: true; coverage: AiFollowCoverage }
        | { ok: false; message: string }
      >,
    followSet: (bookId: string, mode: AiFollowMode, confirmOverBudget = false) =>
      ipcRenderer.invoke('ai.followSet', { bookId, mode, confirmOverBudget }) as Promise<AiFollowStart | { ok: false; message: string }>,
    followRetry: (bookId: string) =>
      ipcRenderer.invoke('ai.followRetry', { bookId }) as Promise<
        | { ok: true; coverage: AiFollowCoverage }
        | { ok: false; message: string }
      >,
    getUsage: (bookId: string) =>
      ipcRenderer.invoke('ai.getUsage', { bookId }) as Promise<
        | { ok: true; usage: AiBookUsage; autoBudget: { month: string; usedTokens: number; reservedTokens: number; limitTokens: number; remainingTokens: number } }
        | { ok: false; message: string }
      >,
    semanticIndexStatus: (bookId: string) => ipcRenderer.invoke('ai.semanticIndexStatus', { bookId }) as Promise<
      { ok: true; status: { enabled: boolean; indexed: number; total: number; message: string } } | { ok: false; message: string }>,
    semanticIndexSet: (bookId: string, enabled: boolean) => ipcRenderer.invoke('ai.semanticIndexSet', { bookId, enabled }) as Promise<
      { ok: true; status: { enabled: boolean; indexed: number; total: number; message: string } } | { ok: false; message: string }>,
    findScenes: (bookId: string, question: string) => ipcRenderer.invoke('ai.findScenes', { bookId, question }) as Promise<
      { ok: true; hits: AiCitation[]; mode: 'semantic' | 'local'; message: string } | { ok: false; message: string }>,
    resumeCard: (bookId: string) => ipcRenderer.invoke('ai.resumeCard', { bookId }) as Promise<
      { ok: true; view: AiResumeCardView } | { ok: false; message: string }>,
    timeline: (bookId: string) => ipcRenderer.invoke('ai.timeline', { bookId }) as Promise<
      { ok: true; timeline: AiTimelineView } | { ok: false; message: string }>,
    extractPlaces: (bookId: string, confirmOverBudget = false) =>
      ipcRenderer.invoke('ai.extractPlaces', { bookId, confirmOverBudget }) as Promise<
        | { ok: true; view: AiPlaceExtractionView; usage?: AiUsage; budget: AiBudgetEstimate }
        | { ok: false; message: string; confirmationRequired?: boolean; budget?: AiBudgetEstimate }
      >,
    generateResumeCard: (bookId: string, confirmOverBudget = false) => ipcRenderer.invoke('ai.generateResumeCard', { bookId, confirmOverBudget }) as Promise<
      { ok: true; card: AiResumeCard; budget: AiBudgetEstimate } |
      { ok: false; message: string; confirmationRequired?: boolean; budget?: AiBudgetEstimate }>,
    retrySave: (saveToken: string) => ipcRenderer.invoke('ai.retrySave', { saveToken }) as Promise<
      { ok: true } | { ok: false; message: string }
    >,
    cancel: (jobId?: string) => ipcRenderer.invoke('ai.cancel', { jobId }) as Promise<{ ok: true }>,
    onChunk: (handler: (payload: AiChunkEvent) => void) => on('ai.chunk', handler),
    onStage: (handler: (payload: AiStageEvent) => void) => on('ai.stage', handler),
    onBudget: (handler: (payload: AiBudgetEvent) => void) => on('ai.budget', handler),
    onDone: (handler: (payload: AiDoneEvent) => void) => on('ai.done', handler),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type AppApi = typeof api
