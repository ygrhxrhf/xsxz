import { app, BrowserWindow, dialog, ipcMain, session, WebContentsView } from 'electron'
import { join } from 'node:path'
import type { AiBookUsage, AiBudgetEstimate, AiMaterialCoverage, AiPromptKind, AiRequestStage, AiUsage, BrowseState, BrowseChapterLink, Settings, SiteRule } from '../shared/types'
import { DEFAULT_AI_PREFS } from '../shared/types'
import { resolveAiTaskInstruction } from '../shared/aiPrompts'
import {
  listBooks,
  getBook,
  readChapter,
  deleteBook,
  listTrash,
  restoreFromTrash,
  purgeTrash,
  setProgress,
  updateMeta,
  setCover,
  updateChapterBody,
  repairChapterBody,
  setLibraryPath,
  readSummaries,
  writeChapterSummary,
  writeStorySoFar,
  writeChat,
  readChat,
  readCharacterCard,
  writeCharacterCard,
  readAiMemory,
  readAiMemoryCompat,
  writeAiMemory,
  markAiMemoryAccuracy,
  readAiUsage,
  recordAiUsage,
  correctAiCharacterAliases,
  correctAiMemorySummary,
  assertImportable,
  recoverInterruptedStatus,
  type AiMemoryCollection,
} from './library'
import { importTxt } from './importTxt'
import { importEpub } from './importEpub'
import { assertTrustedAiEndpoint, getSettings, updateSettings, getApiKey, normalizeSettingsUpdatePayload, resolveEffectiveAiProvider } from './settings'
import { previewDownload, confirmDownload, previewCurrentSiteRule, redownloadChapter, cancelDownload, retryFailed, checkUpdate, checkAllUpdates, cancelCheckAll, isDownloadBusy, setOwnerWindow, setBrowseView } from './download'
import { beginLibraryRestore, isLibraryRestoring, runAsLibraryRestore } from './libraryMaintenance'
import { listSiteRules, upsertSiteRule, removeSiteRule, findSiteRuleForUrl, normalizeHost } from './siteRules'
import { browserAdCss } from './browserAds'
import { discoverChapterLinks, extractBrowseReadingPage } from './browseReading'
import { getBrowseZoom, getLastBrowsePosition, setBrowsePosition, setBrowseZoom, clampZoom } from './browseState'
import { READ_SCROLL, restoreScrollScript, START_HIDE, STOP_HIDE, UNDO_HIDE, CLEAR_HIDE, COUNT_HIDE } from './browsePageScripts'
import { BrowserAdRequestFilter } from './adRequestFilter'
import { exportBook } from './exportBook'
import { searchInBook } from './search'
import { auditBook } from './quality'
import { createBackup, restoreBackup, runAutoBackupIfDue } from './backup'
import { migrateLibrary } from './libraryMigration'
import { browseUserAgent } from './userAgent'
import { addAnnotation, listAnnotations, removeAnnotation, updateAnnotation } from './annotations'
import {
  AiJobSlot,
  AiPendingSaveStore,
  aiCompletionDoneEvent,
  aiStoppedDoneEvent,
  buildTranslatePrompt,
  cleanChapterBody,
  planChapterSummaryRequest,
  planCleanChapterRequest,
  summarizeUpTo,
  streamAiTaskCompletion,
  translateText,
  clampSummarizeChapters,
  generateCharacterCard,
  runAiSaveStage,
  runAiTaskCompletion,
  parseCharacterCard,
  testConnection,
  type AiConfig,
  type AiSuccessDoneEvent,
} from './ai'
import { executeMemoryOrchestration, planMemoryPromptRequests, selectMemoryChapterBatches } from './aiMemoryOrchestrator'
import { buildAiMemoryCandidates } from './aiMemory'
import { finalizeMemoryUpdate } from './aiMemorySave'
import { selectLocalEvidence, type EvidenceSearchChapter } from './aiEvidenceSearch'
import { describeMaterialCoverage, preserveUserMemoryCorrections, seedMemoryBeforeChapter, selectRebuildBatches } from './aiMaterial'
import { buildEvidenceAnswerMessages, buildEvidenceQueryRewriteMessages, executeEvidenceQaPipeline, planEvidenceChapterReads } from './aiEvidenceQa'
import { aiBudgetWarning, countTextCharacters, estimateAiTokens } from './aiBudget'
import { planAiRecap, selectRecapMaterials, validateAiRecapOutput } from './aiRecap'
import { BookOverviewService } from './bookOverview'
import { cancelTts, readTtsPosition, synthesizeTts, writeTtsPosition } from './tts'
import {
  parseMemoryAliasPayload,
  parseMemoryBookPayload,
  parseMemoryMarkPayload,
  parseMemoryRebuildFromPayload,
  parseMemoryRunPayload,
  parseMemorySummaryPayload,
} from './aiMemoryIpcValidation'

const PARTITION = 'persist:novel'
const SIDEBAR_WIDTH = 200

let mainWindow: BrowserWindow | null = null
let browseView: WebContentsView | null = null
let browserAdRequestFilter: BrowserAdRequestFilter | null = null
let browseAdCssKey: string | null = null
let browseAdApplySeq = 0
let browseVisible = false
let browseReadingMode = false
let browsePreviousChapter: BrowseChapterLink | undefined
let browseNextChapter: BrowseChapterLink | undefined
let browsePageSeq = 0
let browseScrollTimer: ReturnType<typeof setInterval> | null = null
let browseRestore: { url: string; ratio: number } | null = null
let browseLastUrl = ''
let browseLastSavedUrl = ''
let browseLastSavedRatio = -1
let lastBounds = { x: SIDEBAR_WIDTH, y: 52, width: 900, height: 700 }
const aiJobSlot = new AiJobSlot()
const bookOverview = new BookOverviewService(aiJobSlot, () => {
  mainWindow?.webContents.send('bookOverview.changed')
})
const aiPendingSaves = new AiPendingSaveStore()
let activeImports = 0

function trustedAiConfig(
  settings: Settings,
  apiKey: string,
  override: { baseUrl?: string; model?: string; provider?: AiConfig['provider']; thinkingEnabled?: boolean } = {},
): AiConfig {
  const provider = override.provider === 'deepseek' || override.provider === 'custom'
    ? override.provider
    : undefined
  const ai = {
    ...(settings.ai ?? DEFAULT_AI_PREFS),
    ...(provider ? { provider } : {}),
    ...(typeof override.thinkingEnabled === 'boolean' ? { thinkingEnabled: override.thinkingEnabled } : {}),
  }
  const baseUrl = override.baseUrl ?? settings.baseUrl
  assertTrustedAiEndpoint(baseUrl, ai)
  return {
    baseUrl,
    model: override.model ?? settings.model,
    apiKey,
    provider: resolveEffectiveAiProvider(baseUrl, ai.provider),
    thinkingEnabled: ai.thinkingEnabled,
  }
}

function aiTaskInstruction(settings: Settings, kind: AiPromptKind): string {
  return resolveAiTaskInstruction(settings.ai ?? DEFAULT_AI_PREFS, kind)
}

function sendAiStage(jobId: string, stage: AiRequestStage, detail?: string): void {
  mainWindow?.webContents.send('ai.stage', { jobId, stage, ...(detail ? { detail } : {}) })
}

function sendAiBudget(jobId: string, task: 'recap' | 'memory' | 'qa', budget: AiBudgetEstimate): void {
  mainWindow?.webContents.send('ai.budget', { jobId, task, budget })
}

async function persistAiUsage(bookId: string, usage: AiUsage | undefined): Promise<AiBookUsage | undefined> {
  try {
    return await recordAiUsage(bookId, usage)
  } catch {
    return undefined
  }
}

async function materialCoverageFor(bookId: string): Promise<AiMaterialCoverage | null> {
  const book = await getBook(bookId)
  const summaries = await readSummaries(bookId)
  return describeMaterialCoverage(book.chapters, book.progress?.chapterId, new Set(Object.keys(summaries.byChapter)))
}

function promptBudget(
  requestGroups: readonly (readonly string[])[],
  chapters: readonly { id: string; title: string }[],
  paragraphCount: number,
  range?: string,
): AiBudgetEstimate {
  const prompts = requestGroups.flat()
  const sentCharacters = prompts.reduce((total, prompt) => total + countTextCharacters(prompt), 0)
  const unique = [...new Map(chapters.map((chapter) => [chapter.id, chapter])).values()]
  return {
    originalCharacters: sentCharacters,
    sentCharacters,
    estimatedTokens: prompts.reduce((total, prompt) => total + estimateAiTokens(prompt), 0),
    chapterCount: unique.length,
    paragraphCount,
    batchCount: requestGroups.length,
    range: range ?? (unique.length ? `${unique[0]!.title} → ${unique.at(-1)!.title}` : '0 条本地证据'),
  }
}

async function saveAiDone(
  jobId: string,
  event: AiSuccessDoneEvent,
  save: () => Promise<void>,
  options: {
    signal?: AbortSignal
    stoppedEvent?: AiSuccessDoneEvent
    saveStopped?: () => Promise<void>
    retrySave?: () => Promise<void>
  } = {},
): Promise<void> {
  await runAiSaveStage(
    aiPendingSaves,
    jobId,
    event,
    save,
    options,
    sendAiStage,
    (done) => mainWindow?.webContents.send('ai.done', done),
  )
}

function novelSession() {
  const ses = session.fromPartition(PARTITION)
  // 浏览 View 和下载 View 共用这个分区，一处覆盖两处
  ses.setUserAgent(browseUserAgent())
  return ses
}

function emitBrowseState(): void {
  if (!mainWindow || !browseView) return
  const wc = browseView.webContents
  const state: BrowseState = {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
    zoom: wc.getZoomFactor(),
    previousChapter: browsePreviousChapter,
    nextChapter: browseNextChapter,
  }
  mainWindow.webContents.send('browse.state', state)
  mainWindow.webContents.send('browse.url', { url: state.url })
}

async function captureBrowsePosition(): Promise<void> {
  const wc = browseView?.webContents
  if (!wc || wc.isDestroyed()) return
  const url = wc.getURL()
  if (!/^https?:\/\//i.test(url) || wc.isLoading() || browseRestore?.url === url) return
  try {
    const ratio = await wc.executeJavaScript(READ_SCROLL)
    if (wc.getURL() === url && typeof ratio === 'number' && (browseLastSavedUrl !== url || Math.abs(browseLastSavedRatio - ratio) >= 0.002)) {
      browseLastSavedUrl = url
      browseLastSavedRatio = ratio
      await setBrowsePosition(url, ratio)
    }
  } catch { /* page may navigate while sampled */ }
}

async function inspectBrowsePage(): Promise<void> {
  const wc = browseView?.webContents
  if (!wc || wc.isDestroyed()) return
  const url = wc.getURL()
  const seq = ++browsePageSeq
  browsePreviousChapter = undefined
  browseNextChapter = undefined
  emitBrowseState()
  if (!/^https?:\/\//i.test(url)) return
  try {
    wc.setZoomFactor(await getBrowseZoom(url))
    const [html, rule] = await Promise.all([
      wc.executeJavaScript('document.documentElement.outerHTML'),
      findSiteRuleForUrl(url),
    ])
    if (seq !== browsePageSeq || wc.isDestroyed() || wc.getURL() !== url) return
    const links = discoverChapterLinks(html, url, rule)
    browsePreviousChapter = links.previous
    browseNextChapter = links.next
    emitBrowseState()
    if (browseRestore?.url === url) {
      const ratio = browseRestore.ratio
      browseRestore = null
      browseLastSavedUrl = url
      browseLastSavedRatio = ratio
      await wc.executeJavaScript(restoreScrollScript(ratio))
      setTimeout(() => {
        if (!wc.isDestroyed() && wc.getURL() === url) void wc.executeJavaScript(restoreScrollScript(ratio)).catch(() => {})
      }, 350)
    }
  } catch { /* page remains browsable */ }
}

async function refreshBrowseAdCss(): Promise<void> {
  const view = browseView
  if (!view || view.webContents.isDestroyed()) return
  const wc = view.webContents
  const url = wc.getURL()
  const seq = ++browseAdApplySeq
  let rule: SiteRule | undefined
  if (/^https?:\/\//i.test(url)) {
    try { rule = await findSiteRuleForUrl(url) } catch { /* no site rule */ }
  }
  if (seq !== browseAdApplySeq || wc.isDestroyed() || wc.getURL() !== url) return
  if (browseAdCssKey) {
    try { await wc.removeInsertedCSS(browseAdCssKey) } catch { /* prior document navigated */ }
    browseAdCssKey = null
  }
  const css = /^https?:\/\//i.test(url) ? browserAdCss(rule) : ''
  if (!css || seq !== browseAdApplySeq || wc.isDestroyed()) return
  try {
    const key = await wc.insertCSS(css, { cssOrigin: 'user' })
    if (seq === browseAdApplySeq && !wc.isDestroyed() && wc.getURL() === url) {
      browseAdCssKey = key
    } else {
      await wc.removeInsertedCSS(key).catch(() => {})
    }
  } catch { /* browsing must continue if a site rejects injected CSS */ }
}

function attachBrowseListeners(view: WebContentsView): void {
  const wc = view.webContents
  const bump = () => emitBrowseState()
  wc.on('did-start-loading', bump)
  wc.on('did-stop-loading', bump)
  wc.on('did-navigate', bump)
  wc.on('did-navigate-in-page', bump)
  wc.on('will-navigate', () => { void captureBrowsePosition() })
  wc.on('did-navigate', () => {
    const url = wc.getURL()
    if (url !== browseLastUrl && /^https?:\/\//i.test(url) && browseRestore?.url !== url) void setBrowsePosition(url, 0)
    browseLastUrl = url
    void inspectBrowsePage()
  })
  wc.on('did-navigate-in-page', () => {
    const url = wc.getURL()
    if (url !== browseLastUrl && /^https?:\/\//i.test(url)) {
      if (browseRestore?.url !== url) void setBrowsePosition(url, 0)
      void wc.executeJavaScript(CLEAR_HIDE).catch(() => {})
    }
    browseLastUrl = url
    void inspectBrowsePage()
  })
  wc.on('dom-ready', () => { void refreshBrowseAdCss() })
  wc.on('did-finish-load', () => { void refreshBrowseAdCss(); void inspectBrowsePage() })
  wc.on('did-navigate-in-page', () => { void refreshBrowseAdCss() })
  wc.on('page-title-updated', bump)
  wc.on('found-in-page', (_event, result) => {
    mainWindow?.webContents.send('browse.findResult', { matches: result.matches, activeMatch: result.activeMatchOrdinal })
  })
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const direction = input.alt && input.key === 'ArrowUp' ? 'previous' : input.alt && input.key === 'ArrowDown' ? 'next' : null
    const find = input.control && input.key.toLowerCase() === 'f'
    if (!direction && !find) return
    event.preventDefault()
    void wc.executeJavaScript(`(() => { const el = document.activeElement; return !!el?.closest('input, textarea, select, [contenteditable="true"]'); })()`)
      .then((editing) => { if (!editing) mainWindow?.webContents.send('browse.shortcut', direction ? { direction } : { find: true }) })
      .catch(() => {})
  })
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void wc.loadURL(url)
    }
    return { action: 'deny' }
  })
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withProto)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

function applyBrowseBounds(): void {
  if (!browseView || !mainWindow) return
  if (!browseVisible || browseReadingMode) {
    browseView.setVisible(false)
    return
  }
  browseView.setVisible(true)
  browseView.setBounds(lastBounds)
}

function createWindow(): void {
  const ses = novelSession()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 720,
    title: '小说浏览器',
    backgroundColor: '#1c1c1c',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  browseView = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.contentView.addChildView(browseView)
  browseView.setVisible(false)
  attachBrowseListeners(browseView)
  browseScrollTimer = setInterval(() => { if (browseVisible && !browseReadingMode) void captureBrowsePosition() }, 1500)
  setBrowseView(browseView)
  void browseView.webContents.loadURL('about:blank')

  mainWindow.on('resize', () => applyBrowseBounds())
  mainWindow.on('closed', () => {
    mainWindow = null
    browseView = null
    browseAdCssKey = null
    browseAdApplySeq++
    if (browseScrollTimer) clearInterval(browseScrollTimer)
    browseScrollTimer = null
  })

  setOwnerWindow(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('browse.load', async (_e, payload: { url: string }) => {
    const url = normalizeUrl(payload?.url ?? '')
    if (!url || !browseView) return { ok: false, message: '无效地址' }
    browseRestore = null
    try {
      await browseView.webContents.loadURL(url)
      await setBrowsePosition(url, 0).catch(() => {})
      emitBrowseState()
      return { ok: true }
    } catch { return { ok: false, message: '网页打开失败，请检查网络或网址' } }
  })
  ipcMain.handle('browse.back', async () => {
    if (!browseView?.webContents.navigationHistory.canGoBack()) return { ok: false }
    browseView.webContents.navigationHistory.goBack()
    return { ok: true }
  })
  ipcMain.handle('browse.forward', async () => {
    if (!browseView?.webContents.navigationHistory.canGoForward()) return { ok: false }
    browseView.webContents.navigationHistory.goForward()
    return { ok: true }
  })
  ipcMain.handle('browse.reload', async () => {
    browseView?.webContents.reload()
    return { ok: true }
  })
  ipcMain.handle('browse.stop', async () => {
    browseView?.webContents.stop()
    return { ok: true }
  })
  ipcMain.handle(
    'browse.setBounds',
    (_e, bounds: { x: number; y: number; width: number; height: number }) => {
      lastBounds = bounds
      applyBrowseBounds()
      return { ok: true }
    },
  )
  ipcMain.handle('browse.setVisible', (_e, payload: { visible: boolean }) => {
    if (!payload?.visible) void captureBrowsePosition()
    browseVisible = Boolean(payload?.visible)
    applyBrowseBounds()
    return { ok: true }
  })
  ipcMain.handle('browse.resume', async () => {
    const wc = browseView?.webContents
    if (!wc || wc.getURL() !== 'about:blank') return { ok: true, restored: false }
    const last = await getLastBrowsePosition()
    if (!last) return { ok: true, restored: false }
    browseRestore = { url: last.url, ratio: last.ratio }
    try {
      await wc.loadURL(last.url)
      return { ok: true, restored: true }
    } catch {
      browseRestore = null
      return { ok: false, message: '上次网页无法打开，请检查网络或网址' }
    }
  })
  ipcMain.handle('browse.zoom', async (_e, payload: { factor: number }) => {
    const wc = browseView?.webContents
    if (!wc || !/^https?:\/\//i.test(wc.getURL()) || typeof payload?.factor !== 'number' || !Number.isFinite(payload.factor)) return { ok: false, message: '请先打开网页' }
    const factor = await setBrowseZoom(wc.getURL(), clampZoom(payload.factor))
    wc.setZoomFactor(factor)
    emitBrowseState()
    return { ok: true, factor }
  })
  ipcMain.handle('browse.readingPage', async () => {
    const wc = browseView?.webContents
    const url = wc?.getURL() ?? ''
    if (!wc || !/^https?:\/\//i.test(url)) return { ok: false, message: '请先打开章节网页' }
    try {
      const html = await wc.executeJavaScript('document.documentElement.outerHTML') as string
      if (wc.getURL() !== url) return { ok: false, message: '网页已跳转，请重新开启阅读模式' }
      if (html.length > 8_000_000) return { ok: false, message: '当前网页过大，无法开启阅读模式' }
      return extractBrowseReadingPage(html, url, await findSiteRuleForUrl(url))
    } catch { return { ok: false, message: '读取当前网页失败' } }
  })
  ipcMain.handle('browse.setReadingMode', (_e, payload: { enabled: boolean }) => {
    browseReadingMode = Boolean(payload?.enabled)
    applyBrowseBounds()
    return { ok: true }
  })
  ipcMain.handle('browse.chapter', async (_e, payload: { direction: 'previous' | 'next' }) => {
    const wc = browseView?.webContents
    const target = payload?.direction === 'previous' ? browsePreviousChapter : browseNextChapter
    if (!wc || !target || new URL(target.url).origin !== new URL(wc.getURL()).origin) return { ok: false, message: '未识别到可靠的章节链接' }
    try { await wc.loadURL(target.url); return { ok: true } }
    catch { return { ok: false, message: '章节打开失败' } }
  })
  ipcMain.handle('browse.find', (_e, payload: { query: string; forward: boolean; findNext: boolean }) => {
    const wc = browseView?.webContents
    const query = typeof payload?.query === 'string' ? payload.query.slice(0, 200).trim() : ''
    if (!wc || !query) return { ok: false }
    wc.findInPage(query, { forward: payload.forward !== false, findNext: Boolean(payload.findNext) })
    return { ok: true }
  })
  ipcMain.handle('browse.stopFind', () => { browseView?.webContents.stopFindInPage('clearSelection'); return { ok: true } })
  ipcMain.handle('browse.hide', async (_e, payload: { action: 'start' | 'stop' | 'undo' | 'count' }) => {
    const wc = browseView?.webContents
    if (!wc || !/^https?:\/\//i.test(wc.getURL())) return { ok: false, message: '请先打开网页' }
    try {
      const script = payload?.action === 'start' ? START_HIDE : payload?.action === 'stop' ? STOP_HIDE : payload?.action === 'undo' ? UNDO_HIDE : payload?.action === 'count' ? COUNT_HIDE : null
      if (!script) return { ok: false, message: '无效操作' }
      return { ok: true, remaining: await wc.executeJavaScript(script) as number }
    } catch { return { ok: false, message: '网页已跳转，请重试' } }
  })

  ipcMain.handle('dialog.openFile', async () => {
    if (!mainWindow) return { filePaths: [] }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入的文件',
      filters: [{ name: '小说文件', extensions: ['txt', 'epub'] }],
      properties: ['openFile'],
    })
    return { filePaths: result.filePaths }
  })
  ipcMain.handle('dialog.openZip', async () => {
    if (!mainWindow) return { filePaths: [] }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择书库备份文件',
      filters: [{ name: '书库备份', extensions: ['zip'] }],
      properties: ['openFile'],
    })
    return { filePaths: result.filePaths }
  })
  ipcMain.handle('dialog.openDirectory', async () => {
    if (!mainWindow) return { filePaths: [] }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择书库目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    return { filePaths: result.filePaths }
  })

  ipcMain.handle('library.list', async () => {
    const books = await listBooks()
    return { books: await bookOverview.decorate(books, await getSettings()) }
  })
  ipcMain.handle('bookOverview.retry', async (_e, payload: { bookId?: string }) => {
    try {
      const bookId = payload?.bookId
      if (typeof bookId !== 'string' || !/^[a-z0-9_]+$/i.test(bookId)) return { ok: false, message: '书籍编号无效' }
      await bookOverview.retry(bookId)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('library.get', async (_e, { bookId }: { bookId: string }) => {
    try {
      const book = await getBook(bookId)
      return { book }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })
  ipcMain.handle('library.readChapter', async (_e, { bookId, chapterId }: { bookId: string; chapterId: string }) => {
    try {
      const chapter = await readChapter(bookId, chapterId)
      return { chapter }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })
  ipcMain.handle('library.delete', async (_e, { bookId }: { bookId: string }) => {
    try {
      await deleteBook(bookId)
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('library.listTrash', async () => {
    try {
      const items = await listTrash()
      return { ok: true, items }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('library.restoreTrash', async (_e, { name }: { name: string }) => {
    try {
      await restoreFromTrash(name)
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('library.purgeTrash', async (_e, payload?: { name?: string }) => {
    try {
      const purged = await purgeTrash(payload?.name)
      return { ok: true, purged }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('library.import', async (_e, { filePath }: { filePath: string }) => {
    let started = false
    try {
      if (isLibraryRestoring()) return { ok: false, message: '书库正在恢复，请稍后再试' }
      activeImports++
      started = true
      const guard = assertImportable(filePath)
      if (!guard.ok) return guard
      const ext = filePath.toLowerCase().split('.').pop()
      const result = ext === 'epub' ? await importEpub(filePath) : await importTxt(filePath)
      bookOverview.wake()
      return { ok: true, bookId: result.bookId }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    } finally {
      if (started) activeImports--
    }
  })
  ipcMain.handle('library.setProgress', async (_e, { bookId, progress }: { bookId: string; progress: unknown }) => {
    try {
      await setProgress(bookId, progress as import('../shared/types').ReadingProgress)
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })
  ipcMain.handle(
    'library.updateMeta',
    async (_e, payload: { bookId: string; title: string; author: string; tags: string[] }) => {
      try {
        return await updateMeta(payload)
      } catch (e: unknown) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
  )
  ipcMain.handle('library.setCover', async (_e, payload: { bookId: string; sourcePath: string }) => {
    try {
      return await setCover(payload)
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('library.pickCoverFile', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择封面图片',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('library.updateChapterBody', async (_e, args: { bookId: string; chapterId: string; body: string; restoreRaw?: boolean }) => {
    try {
      await updateChapterBody(args.bookId, args.chapterId, args.body, args.restoreRaw)
      bookOverview.wake()
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })
  ipcMain.handle('library.repairChapterBody', async (_e, args: { bookId: string; chapterId: string; body: string }) => {
    try { await repairChapterBody(args.bookId, args.chapterId, args.body); bookOverview.wake(); return { ok: true } }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('library.audit', async (_e, args: { bookId: string }) => {
    try { return { ok: true, report: await auditBook(args.bookId) } }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(
    'library.export',
    async (_e, args: { bookId: string; format: 'txt' | 'epub'; destDir: string }) => {
      try {
        return await exportBook(args.bookId, args.format, args.destDir)
      } catch (e: unknown) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
  )
  ipcMain.handle('library.searchInBook', async (_e, { bookId, query }: { bookId: string; query: string }) => {
    try {
      const hits = await searchInBook(bookId, query || '')
      return { ok: true, hits }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('backup.create', async (_e, args: { destDir: string }) => {
    try {
      return await createBackup(args.destDir)
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('backup.restore', async (_e, args: { zipPath: string }) => {
    try {
      if (isDownloadBusy() || aiJobSlot.busy || activeImports > 0) {
        return { ok: false, message: '书库正在下载、导入或保存 AI 内容，请等待完成后再恢复' }
      }
      const release = beginLibraryRestore()
      try {
        return await runAsLibraryRestore(() => restoreBackup(args.zipPath))
      } finally {
        release()
      }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('backup.runAuto', async () => {
    try {
      if (isDownloadBusy() || aiJobSlot.busy || activeImports > 0) {
        return { status: 'failed', message: '书库正忙，请稍后再备份' }
      }
      const release = beginLibraryRestore()
      try { return await runAsLibraryRestore(() => runAutoBackupIfDue()) }
      finally { release() }
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('library.migrate', async (_e, args: { targetPath: string }) => {
    try {
      if (isDownloadBusy() || aiJobSlot.busy || activeImports > 0) {
        return { ok: false, message: '书库正在下载、导入或保存 AI 内容，请等待完成后再搬迁' }
      }
      const release = beginLibraryRestore()
      try { return await runAsLibraryRestore(() => migrateLibrary(args.targetPath)) }
      finally { release() }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('annotations.list', async (_e, { bookId }: { bookId: string }) => {
    try {
      return { ok: true, items: await listAnnotations(bookId) }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(
    'annotations.add',
    async (_e, draft: import('../shared/types').Annotation) => {
      try {
        const item = await addAnnotation(draft)
        return { ok: true, item }
      } catch (e: unknown) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
  )
  ipcMain.handle(
    'annotations.update',
    async (
      _e,
      args: { bookId: string; annotationId: string; patch: import('../shared/types').AnnotationUpdate },
    ) => {
      try {
        const item = await updateAnnotation(args.bookId, args.annotationId, args.patch)
        if (!item) return { ok: false, message: '标记不存在' }
        return { ok: true, item }
      } catch (e: unknown) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
  )
  ipcMain.handle('annotations.remove', async (_e, args: { bookId: string; annotationId: string }) => {
    try {
      await removeAnnotation(args.bookId, args.annotationId)
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('download.preview', async () => {
    try { return await previewDownload() }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('download.confirm', async (_e, args: { token: string }) => confirmDownload(args.token))
  ipcMain.handle('download.redownloadChapter', async (_e, args: { bookId: string; chapterId: string; url: string }) =>
    redownloadChapter(args.bookId, args.chapterId, args.url))
  ipcMain.handle('download.cancel', async (_e, { bookId }: { bookId?: string }) => {
    cancelDownload(bookId)
    return { ok: true }
  })
  ipcMain.handle('download.retryFailed', async (_e, { bookId }: { bookId: string }) => retryFailed(bookId))
  ipcMain.handle('download.checkUpdate', (_e, { bookId }: { bookId: string }) => checkUpdate(bookId))
  ipcMain.handle('download.checkAll', () => checkAllUpdates())
  ipcMain.handle('download.cancelCheckAll', () => {
    cancelCheckAll()
    return { ok: true }
  })

  ipcMain.handle('siteRules.list', async () => {
    const rules = await listSiteRules()
    return { rules }
  })
  ipcMain.handle('siteRules.preview', async (_e, rule: SiteRule) => {
    try { return await previewCurrentSiteRule(rule) }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('siteRules.upsert', async (_e, rule: SiteRule) => {
    try {
      const saved = await upsertSiteRule(rule)
      browserAdRequestFilter?.updateSiteRule(saved)
      void refreshBrowseAdCss()
      if (browseView?.webContents.getURL().startsWith('http')) void inspectBrowsePage()
      return { ok: true, rule: saved }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('siteRules.remove', async (_e, payload: { host: string }) => {
    try {
      await removeSiteRule(payload?.host ?? '')
      browserAdRequestFilter?.removeSiteRule(normalizeHost(payload?.host ?? ''))
      void refreshBrowseAdCss()
      if (browseView?.webContents.getURL().startsWith('http')) void inspectBrowsePage()
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('settings.get', async () => getSettings())
  ipcMain.handle('tts.getPosition', async (_e, { bookId }: { bookId: string }) => readTtsPosition(bookId))
  ipcMain.handle('tts.setPosition', async (_e, args: { bookId: string; position: unknown }) => {
    await writeTtsPosition(args.bookId, args.position)
    return { ok: true }
  })
  ipcMain.handle('tts.synthesize', async (_e, args: { requestId: string; text: string }) => synthesizeTts(args.requestId, args.text))
  ipcMain.handle('tts.cancel', (_e, { requestId }: { requestId: string }) => { cancelTts(requestId); return { ok: true } })
  ipcMain.handle('settings.set', async (_e, update: unknown) => {
    if (isLibraryRestoring()) throw new Error('书库正在恢复，请稍后再试')
    const patch = normalizeSettingsUpdatePayload(update)
    const next = await updateSettings(patch)
    if (typeof patch.libraryPath === 'string') {
      await setLibraryPath(next.libraryPath)
    }
    bookOverview.settingsChanged(next.ai?.autoBookOverview === true)
    return next
  })

  ipcMain.handle('ai.getChat', async (_e, { bookId }: { bookId: string }) => {
    try {
      const chat = await readChat(bookId)
      return { ok: true, version: chat.version, messages: chat.messages }
    }
    catch (e: unknown) { return { ok: false, message: e instanceof Error ? e.message : String(e) } }
  })

  ipcMain.handle('ai.getSummaries', async (_e, { bookId }: { bookId: string }) => {
    try {
      return { ok: true, summaries: await readSummaries(bookId) }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ai.clearChat', async (_e, { bookId }: { bookId: string }) => {
    try {
      await writeChat(bookId, [])
      return { ok: true }
    } catch {
      return { ok: false, message: '无法保存到书库，请检查磁盘空间和权限' }
    }
  })

  ipcMain.handle('ai.getMemory', async (_e, payload?: unknown) => {
    try {
      const { bookId } = parseMemoryBookPayload(payload)
      return { ok: true, memory: await readAiMemoryCompat(bookId) }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  const startMemoryUpdate = async (
    mode: 'update' | 'rebuild' | 'rebuildFrom',
    unsafePayload?: unknown,
  ) => {
    try {
      const payload = mode === 'rebuildFrom'
        ? parseMemoryRebuildFromPayload(unsafePayload)
        : parseMemoryRunPayload(unsafePayload)
      const book = await getBook(payload.bookId)
      const previous = await readAiMemory(payload.bookId)
      const existing = mode === 'update' ? previous
        : mode === 'rebuildFrom'
          ? seedMemoryBeforeChapter(previous, book.chapters, (payload as import('./aiMemoryIpcValidation').MemoryRebuildFromPayload).fromChapterId)
          : null
      const selection = selectMemoryChapterBatches(
        book.chapters,
        payload.uptoChapterId,
        book.progress?.chapterId,
        existing?.uptoChapterId,
        mode === 'update' ? 'update' : 'rebuild',
      )
      if (mode === 'rebuildFrom') {
        const fromId = (payload as import('./aiMemoryIpcValidation').MemoryRebuildFromPayload).fromChapterId
        selection.batches = selectRebuildBatches(selection.batches.flat(), fromId, book.chapters)
      }
      const eligibleChapterIds = new Set(selection.eligibleChapterIds)
      const hasReviewItems = mode === 'update' && Boolean(existing) && [
        ...(existing?.characters ?? []),
        ...(existing?.relations ?? []),
        ...(existing?.foreshadows ?? []),
        ...(existing?.events ?? []),
      ].some((item) => item.accuracy === 'review'
        && item.sources.every((source) => eligibleChapterIds.has(source.chapterId)))
      if (!selection.batches.length && !hasReviewItems) return { ok: false, message: '已更新到当前阅读进度' }
      const settings = await getSettings()
      const batches: Array<Array<(typeof selection.batches)[number][number] & { body: string }>> = []
      for (const batch of selection.batches) {
        const loaded = []
        for (const chapter of batch) {
          const file = await readChapter(payload.bookId, chapter.id)
          loaded.push({ ...chapter, body: file.body })
        }
        batches.push(loaded)
      }
      const instruction = aiTaskInstruction(settings, 'memory')
      const reviewRequests = mode === 'update'
        ? planMemoryPromptRequests(book.title, instruction, [], existing, true, eligibleChapterIds)
        : []
      const candidateGroups = batches.map((batch) => batch.flatMap((chapter) =>
        buildAiMemoryCandidates(chapter.id, chapter.title, chapter.body ?? '')))
      const extractionRequests = candidateGroups.flatMap((candidates) =>
        planMemoryPromptRequests(book.title, instruction, candidates, existing, false, eligibleChapterIds))
      const memoryRequests = [...reviewRequests, ...extractionRequests]
      const materialChapterIds = new Set(memoryRequests.flatMap((request) =>
        request.candidates.map((candidate) => candidate.chapterId)))
      const materialChapters = book.chapters
        .filter((chapter) => materialChapterIds.has(chapter.id))
        .sort((left, right) => left.index - right.index)
        .map((chapter) => ({ id: chapter.id, title: chapter.title }))
      const memoryBudget = promptBudget(
        memoryRequests.map((request) => [request.prompt]),
        materialChapters,
        memoryRequests.reduce((total, request) => total + request.candidates.length, 0),
        memoryRequests.length ? undefined : '无模型请求',
      )
      const confirmOverBudget = unsafePayload && typeof unsafePayload === 'object' &&
        'confirmOverBudget' in unsafePayload &&
        (unsafePayload as { confirmOverBudget?: unknown }).confirmOverBudget === true
      const memoryWarning = aiBudgetWarning(memoryBudget, settings.ai?.budgetWarningTokens ?? DEFAULT_AI_PREFS.budgetWarningTokens)
      if (memoryWarning && !confirmOverBudget) return {
        ok: false, confirmationRequired: true, message: memoryWarning, budget: memoryBudget,
      }
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const config = trustedAiConfig(settings, apiKey)
      return aiJobSlot.start(async (jobId, signal) => {
        sendAiBudget(jobId, 'memory', memoryBudget)
        sendAiStage(jobId, 'preparing')
        let usage: AiUsage | undefined
        try {
          const memoryUpdate = await executeMemoryOrchestration(
            book.title,
            existing,
            batches,
            selection.remainingChapters,
            instruction,
            async (request, requestSignal) => {
              sendAiStage(jobId, 'requesting')
              const completion = await runAiTaskCompletion(
                config,
                [{ role: 'user', content: request.prompt }],
                { task: 'memory', signal: requestSignal },
              )
              await persistAiUsage(payload.bookId, completion.usage)
              if (!completion.json) throw new Error('模型返回的记忆 JSON 无法识别，原有记忆未改变')
              if (completion.usage) {
                usage = {
                  inputTokens: (usage?.inputTokens ?? 0) + (completion.usage.inputTokens ?? 0),
                  outputTokens: (usage?.outputTokens ?? 0) + (completion.usage.outputTokens ?? 0),
                  cacheHitTokens: (usage?.cacheHitTokens ?? 0) + (completion.usage.cacheHitTokens ?? 0),
                  cacheMissTokens: (usage?.cacheMissTokens ?? 0) + (completion.usage.cacheMissTokens ?? 0),
                }
              }
              return completion.json
            },
            {
              includeReviews: mode === 'update',
              reviewChapterIds: new Set(selection.eligibleChapterIds),
              signal,
            },
          )
          memoryUpdate.memory = preserveUserMemoryCorrections(memoryUpdate.memory, previous)
          const snapshot = structuredClone(memoryUpdate.memory)
          await finalizeMemoryUpdate(jobId, memoryUpdate, usage, signal, {
            save: (saveSignal) => writeAiMemory(payload.bookId!, snapshot, { signal: saveSignal }),
            retrySave: () => writeAiMemory(payload.bookId!, snapshot),
            registerRetry: (save) => aiPendingSaves.register(save),
            emitStage: () => sendAiStage(jobId, 'saving'),
            emitDone: (event) => {
              mainWindow?.webContents.send('ai.done', event)
            },
          })
        } catch (e: unknown) {
          mainWindow?.webContents.send('ai.done', {
            jobId,
            ok: false,
            message: signal.aborted ? '已停止生成' : e instanceof Error ? e.message : String(e),
          })
        }
      })
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  ipcMain.handle('ai.updateMemory', (_e, payload?: unknown) => startMemoryUpdate('update', payload))
  ipcMain.handle('ai.rebuildMemory', (_e, payload?: unknown) => startMemoryUpdate('rebuild', payload))
  ipcMain.handle('ai.rebuildMemoryFrom', (_e, payload?: unknown) => startMemoryUpdate('rebuildFrom', payload))

  ipcMain.handle('ai.markMemoryInaccurate', async (_e, unsafePayload?: unknown) => {
    try {
      if (aiJobSlot.busy) return { ok: false, message: '请先停止当前生成' }
      const payload = parseMemoryMarkPayload(unsafePayload)
      let collection: AiMemoryCollection
      switch (payload.kind) {
        case 'character': collection = 'characters'; break
        case 'relation': collection = 'relations'; break
        case 'foreshadow': collection = 'foreshadows'; break
        case 'event': collection = 'events'; break
      }
      const item = await markAiMemoryAccuracy(payload.bookId, collection, payload.itemId, 'review')
      return { ok: true, item }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ai.correctCharacterAliases', async (_e, unsafePayload?: unknown) => {
    try {
      if (aiJobSlot.busy) return { ok: false, message: '请先停止当前生成' }
      const payload = parseMemoryAliasPayload(unsafePayload)
      const corrected = await correctAiCharacterAliases(payload.bookId, payload.itemId, payload.aliases)
      return { ok: true, ...corrected }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ai.correctMemorySummary', async (_e, unsafePayload?: unknown) => {
    try {
      if (aiJobSlot.busy) return { ok: false, message: '请先停止当前生成' }
      const payload = parseMemorySummaryPayload(unsafePayload)
      const corrected = await correctAiMemorySummary(payload.bookId, payload.kind, payload.itemId, payload.summary)
      return { ok: true, ...corrected }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ai.getMaterialCoverage', async (_e, unsafePayload?: unknown) => {
    try {
      const { bookId } = parseMemoryBookPayload(unsafePayload)
      return { ok: true, coverage: await materialCoverageFor(bookId) }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ai.getUsage', async (_e, unsafePayload?: unknown) => {
    try {
      const { bookId } = parseMemoryBookPayload(unsafePayload)
      return { ok: true, usage: await readAiUsage(bookId) }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ai.retrySave', async (_e, payload?: unknown) => {
    const saveToken = payload && typeof payload === 'object' && 'saveToken' in payload
      ? (payload as { saveToken?: unknown }).saveToken
      : undefined
    if (typeof saveToken !== 'string' || !saveToken.trim() || saveToken.length > 200) {
      return { ok: false, message: '未保存结果已过期，请重新生成' }
    }
    return aiPendingSaves.retry(saveToken)
  })

  ipcMain.handle('ai.cancel', (_e, payload?: { jobId?: string }) => {
    aiJobSlot.cancel(payload?.jobId)
    return { ok: true }
  })

  ipcMain.handle('ai.storySoFar', async (_e, unsafePayload?: unknown) => {
    try {
      const payload = parseMemoryRunPayload(unsafePayload)
      const book = await getBook(payload.bookId)
      const stored = await readSummaries(payload.bookId)
      const memory = await readAiMemory(payload.bookId)
      const settings = await getSettings()
      const recapLength = settings.ai?.recapLength ?? 'standard'
      const materials = selectRecapMaterials(
        book.chapters,
        payload.uptoChapterId,
        book.progress?.chapterId,
        stored,
        memory,
      )
      const plan = planAiRecap(
        book.title,
        aiTaskInstruction(settings, 'recap'),
        recapLength,
        materials,
      )
      const confirmOverBudget = unsafePayload && typeof unsafePayload === 'object' &&
        'confirmOverBudget' in unsafePayload &&
        (unsafePayload as { confirmOverBudget?: unknown }).confirmOverBudget === true
      const budgetWarning = aiBudgetWarning(plan.budget, settings.ai?.budgetWarningTokens ?? DEFAULT_AI_PREFS.budgetWarningTokens)
      if ((plan.requiresConfirmation || budgetWarning) && !confirmOverBudget) {
        return {
          ok: false,
          confirmationRequired: true,
          message: plan.requiresConfirmation ? '预计输入超过 30000 字。是否按上方缩减范围继续？' : budgetWarning!,
          budget: plan.budget,
        }
      }
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      return aiJobSlot.start(async (jobId, signal) => {
        let partial = ''
        sendAiBudget(jobId, 'recap', plan.budget)
        sendAiStage(jobId, 'preparing')
        try {
          sendAiStage(jobId, 'requesting')
          const result = await streamAiTaskCompletion(
            trustedAiConfig(settings, apiKey),
            [{ role: 'user', content: plan.prompt }],
            signal,
            (delta) => {
              partial += delta
              mainWindow?.webContents.send('ai.chunk', { jobId, delta })
            },
            { task: 'recap', recapLength },
          )
          await persistAiUsage(payload.bookId, result.usage)
          if (result.truncated) throw new Error('模型输出被截断，原有前情未改变')
          const text = validateAiRecapOutput(result.text, recapLength)
          await saveAiDone(
            jobId,
            aiCompletionDoneEvent(jobId, result, text),
            () => writeStorySoFar(payload.bookId, plan.uptoChapterId, text, { signal }),
            {
              signal,
              stoppedEvent: aiStoppedDoneEvent(jobId, partial),
              retrySave: () => writeStorySoFar(payload.bookId, plan.uptoChapterId, text),
            },
          )
        } catch (e: unknown) {
          if (signal.aborted) {
            mainWindow?.webContents.send('ai.done', aiStoppedDoneEvent(jobId, partial))
            return
          }
          mainWindow?.webContents.send('ai.done', {
            jobId,
            ok: false,
            message: e instanceof Error ? e.message : String(e),
          })
        }
      })
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ai.summarizeChapter', async (_e, args: {
    bookId: string
    chapterId: string
    confirmOverBudget?: boolean
  }) => {
    try {
      const settings = await getSettings()
      const book = await getBook(args.bookId)
      if (!book.chapters.some((chapter) => chapter.id === args.chapterId)) {
        return { ok: false, message: '章节不存在' }
      }
      const chapter = await readChapter(args.bookId, args.chapterId)
      if (!chapter.body.trim()) return { ok: false, message: '当前章节没有可摘要的正文' }
      const instruction = aiTaskInstruction(settings, 'chapterSummary')
      const plan = planChapterSummaryRequest(book.title, chapter.title, chapter.body, instruction)
      const budgetWarning = aiBudgetWarning(plan.budget, settings.ai?.budgetWarningTokens ?? DEFAULT_AI_PREFS.budgetWarningTokens)
      if ((plan.requiresConfirmation || budgetWarning) && args.confirmOverBudget !== true) {
        return {
          ok: false,
          confirmationRequired: true,
          message: plan.requiresConfirmation ? '预计输入超过 30000 字。是否按上方缩减范围继续？' : budgetWarning!,
          budget: plan.budget,
        }
      }
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      return aiJobSlot.start(async (jobId, signal) => {
        let partial = ''
        sendAiBudget(jobId, 'recap', plan.budget)
        sendAiStage(jobId, 'preparing')
        try {
          sendAiStage(jobId, 'requesting')
          const result = await streamAiTaskCompletion(
            trustedAiConfig(settings, apiKey),
            [{
              role: 'user',
              content: plan.prompt,
            }],
            signal,
            (delta) => {
              partial += delta
              mainWindow?.webContents.send('ai.chunk', { jobId, delta })
            },
            { task: 'chapterSummary' },
          )
          await persistAiUsage(args.bookId, result.usage)
          await saveAiDone(
            jobId,
            aiCompletionDoneEvent(jobId, result),
            () => writeChapterSummary(args.bookId, args.chapterId, result.text, { signal }),
            { signal, stoppedEvent: aiStoppedDoneEvent(jobId, partial) },
          )
        } catch (e: unknown) {
          if (signal.aborted) {
            mainWindow?.webContents.send('ai.done', aiStoppedDoneEvent(jobId, partial))
            return
          }
          mainWindow?.webContents.send('ai.done', {
            jobId,
            ok: false,
            message: e instanceof Error ? e.message : String(e),
          })
        }
      })
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ai.clean', async (_e, args: {
    bookId: string
    chapterId: string
    confirmOverBudget?: boolean
  }) => {
    try {
      const settings = await getSettings()
      const ch = await readChapter(args.bookId, args.chapterId)
      if (!ch.body) return { ok: false, message: '当前章节没有可清理的正文' }
      const instruction = aiTaskInstruction(settings, 'clean')
      const plan = planCleanChapterRequest(ch.title, ch.body, instruction)
      if (!plan.batches.length) return { ok: false, message: '当前章节没有可清理的正文' }
      const budgetWarning = aiBudgetWarning(plan.budget, settings.ai?.budgetWarningTokens ?? DEFAULT_AI_PREFS.budgetWarningTokens)
      if ((plan.requiresConfirmation || budgetWarning) && args.confirmOverBudget !== true) {
        return {
          ok: false,
          confirmationRequired: true,
          message: plan.requiresConfirmation ? '预计输入超过 30000 字。是否按上方缩减范围继续？' : budgetWarning!,
          budget: plan.budget,
        }
      }
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const exclusive = await aiJobSlot.runExclusive(async (signal) => {
        try {
          return await cleanChapterBody(
            trustedAiConfig(settings, apiKey),
            ch.title,
            ch.body,
            instruction,
            signal,
            plan,
            async (usage) => { await persistAiUsage(args.bookId, usage) },
          )
        } catch (error) {
          if (signal.aborted) throw new DOMException('aborted', 'AbortError')
          throw error
        }
      })
      if (!exclusive.ok) return exclusive
      return { ok: true, result: exclusive.value, budget: plan.budget }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') {
        return { ok: false, stopped: true, message: '已停止生成' }
      }
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ai.summarize', async (_e, { bookId, uptoChapterId }: { bookId: string; uptoChapterId: string }) => {
    try {
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const book = await getBook(bookId)
      if (!book.chapters.some((c) => c.id === uptoChapterId)) {
        return { ok: false, message: '章节不存在' }
      }
      const progressChapterId = book.progress?.chapterId ?? null
      const cutoff = clampSummarizeChapters(book.chapters, uptoChapterId, progressChapterId)
      const summaries: Array<(typeof cutoff)[number] & { body: string }> = []
      for (const ch of cutoff) {
        try {
          const file = await readChapter(bookId, ch.id)
          summaries.push({ ...ch, body: file.body })
        } catch {
          /* skip */
        }
      }
      const exclusive = await aiJobSlot.runExclusive(() => summarizeUpTo(
        trustedAiConfig(settings, apiKey),
        book.title,
        summaries,
        { uptoChapterId, progressChapterId },
        aiTaskInstruction(settings, 'recap'),
      ))
      if (!exclusive.ok) return exclusive
      const storyUptoChapterId = cutoff[cutoff.length - 1]?.id ?? uptoChapterId
      await persistAiUsage(bookId, undefined)
      await writeStorySoFar(bookId, storyUptoChapterId, exclusive.value)
      return { ok: true, text: exclusive.value }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ai.translateStream', async (_e, { text, bookId }: { text: string; bookId?: string }) => {
    try {
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      if (!text.trim()) return { ok: false, message: '请先在正文中选中要翻译的文字' }
      if (text.length > 2000) return { ok: false, message: '选中过长，请缩短后再问' }
      if (bookId !== undefined) await getBook(bookId)
      return aiJobSlot.start(async (jobId, signal) => {
        let partial = ''
        sendAiStage(jobId, 'preparing')
        try {
          sendAiStage(jobId, 'requesting')
          const result = await streamAiTaskCompletion(
            trustedAiConfig(settings, apiKey),
            [{ role: 'user', content: buildTranslatePrompt(text, aiTaskInstruction(settings, 'translate')) }],
            signal,
            (delta) => {
              partial += delta
              mainWindow?.webContents.send('ai.chunk', { jobId, delta })
            },
            { task: 'translate', inputTokenEstimate: Math.ceil(text.length / 2) },
          )
          if (bookId) await persistAiUsage(bookId, result.usage)
          mainWindow?.webContents.send('ai.done', aiCompletionDoneEvent(jobId, result))
        } catch (e: unknown) {
          if (signal.aborted) {
            mainWindow?.webContents.send('ai.done', aiStoppedDoneEvent(jobId, partial))
            return
          }
          mainWindow?.webContents.send('ai.done', {
            jobId,
            ok: false,
            message: e instanceof Error ? e.message : String(e),
          })
        }
      })
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ai.translate', async (_e, { text }: { text: string }) => {
    try {
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const exclusive = await aiJobSlot.runExclusive(() => translateText(
        trustedAiConfig(settings, apiKey),
        text,
        aiTaskInstruction(settings, 'translate'),
      ))
      if (!exclusive.ok) return exclusive
      return { ok: true, text: exclusive.value }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ai.chatStream', async (_e, args: { bookId: string; chapterId: string; messages: import('../shared/types').AiChatMessage[] }) => {
    try {
      const book = await getBook(args.bookId)
      const progressChapterId = book.progress?.chapterId
      if (!progressChapterId) return { ok: false, message: '还没有阅读进度，先阅读一章再使用已读内容分析。' }
      if (!book.chapters.some((chapter) => chapter.id === args.chapterId)) return { ok: false, message: '章节不存在' }
      const question = [...args.messages].reverse().find((message) => message.role === 'user')?.content.trim() ?? ''
      if (!question) return { ok: false, message: '请输入问题' }
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const config = trustedAiConfig(settings, apiKey)
      const existingChat = await readChat(args.bookId)
      const persistedMessages: import('../shared/types').AiEvidenceChatMessage[] = [...existingChat.messages]
      const latest = persistedMessages.at(-1)
      if (latest?.role !== 'user' || latest.content !== question) {
        persistedMessages.push({ role: 'user', content: question })
      }
      return aiJobSlot.start(async (jobId, signal) => {
        sendAiStage(jobId, 'preparing')
        try {
          await writeChat(args.bookId, persistedMessages, { version: existingChat.version })
        } catch {
          mainWindow?.webContents.send('ai.done', signal.aborted
            ? aiStoppedDoneEvent(jobId, '')
            : { jobId, ok: false, message: '无法保存到书库，请检查磁盘空间和权限' })
          return
        }

        try {
          const readPlan = planEvidenceChapterReads(book.chapters, progressChapterId)
          const taskInstruction = aiTaskInstruction(settings, 'evidenceQa')
          const result = await executeEvidenceQaPipeline({
            question,
            taskInstruction,
            stopped: () => signal.aborted,
            onStage: (stage) => sendAiStage(jobId, stage),
            onRewriteStarted: (messages) => sendAiBudget(jobId, 'qa', promptBudget(
              [messages.map((message) => message.content)], [], 0,
              '仅发送查询改写；正在检索本地已读内容',
            )),
            rewrite: async (messages) => {
              const completion = await runAiTaskCompletion(config, messages, { task: 'queryRewrite', signal })
              await persistAiUsage(args.bookId, completion.usage)
              return completion
            },
            search: async (query) => {
              const [memory, summaries] = await Promise.all([
                readAiMemory(args.bookId), readSummaries(args.bookId),
              ])
              const searchChapters: EvidenceSearchChapter[] = []
              for (let index = 0; index < readPlan.ordered.length; index += 1) {
                const chapter = readPlan.ordered[index]!
                if (signal.aborted) break
                if (index > readPlan.progressPosition) {
                  searchChapters.push({ ...chapter, body: '' })
                  continue
                }
                const local = await readChapter(args.bookId, chapter.id)
                searchChapters.push({
                  id: chapter.id,
                  index: chapter.index,
                  title: chapter.title,
                  status: local.status,
                  body: local.body,
                })
              }
              if (signal.aborted) return { citations: [], uptoChapterId: progressChapterId }
              return selectLocalEvidence(searchChapters, query, {
                requestedUptoChapterId: progressChapterId,
                progressChapterId,
                currentChapterId: args.chapterId,
                memory,
                summaries,
              })
            },
            onEvidenceSelected: (citations) => {
              const rewriteMessages = buildEvidenceQueryRewriteMessages(question)
              const answerMessages = citations.length
                ? buildEvidenceAnswerMessages(question, citations, taskInstruction)
                : []
              const citedChapterIds = new Set(citations.map((citation) => citation.chapterId))
              const citedChapters = book.chapters
                .filter((chapter) => citedChapterIds.has(chapter.id))
                .sort((left, right) => left.index - right.index)
                .map((chapter) => ({ id: chapter.id, title: chapter.title }))
              sendAiBudget(jobId, 'qa', promptBudget(
                [
                  rewriteMessages.map((message) => message.content),
                  ...(answerMessages.length ? [answerMessages.map((message) => message.content)] : []),
                ],
                citedChapters,
                citations.length,
                citations.length
                  ? `${citedChapters[0]!.title} → ${citedChapters.at(-1)!.title}`
                  : '仅发送查询改写；0 条本地证据，未请求最终回答',
              ))
            },
            answer: async (messages) => {
              const completion = await runAiTaskCompletion(config, messages, { task: 'evidenceQa', signal })
              await persistAiUsage(args.bookId, completion.usage)
              return completion
            },
          })
          if (result.kind === 'stopped') {
            mainWindow?.webContents.send('ai.done', aiStoppedDoneEvent(jobId, ''))
            return
          }
          const completedMessages: import('../shared/types').AiEvidenceChatMessage[] = [
            ...persistedMessages,
            {
              role: 'assistant',
              content: result.text,
              citations: result.citations,
              uptoChapterId: result.uptoChapterId,
            },
          ]
          const stoppedMessages: import('../shared/types').AiEvidenceChatMessage[] = [
            ...persistedMessages,
            {
              role: 'assistant', content: result.text, citations: result.citations,
              uptoChapterId: result.uptoChapterId, stopped: true,
            },
          ]
          const retrySave = () => writeChat(args.bookId, completedMessages)
          await saveAiDone(jobId, {
            jobId, ok: true, text: result.text, usage: result.usage,
            citations: result.citations, uptoChapterId: result.uptoChapterId,
            truncated: result.kind === 'answer' ? result.truncated : false,
          }, () => writeChat(args.bookId, completedMessages, { signal }), {
            signal,
            stoppedEvent: {
              jobId, ok: true, text: result.text, stopped: true,
              citations: result.citations, uptoChapterId: result.uptoChapterId,
            },
            saveStopped: () => writeChat(args.bookId, stoppedMessages),
            retrySave,
          })
        } catch (e: unknown) {
          if (signal.aborted) {
            mainWindow?.webContents.send('ai.done', aiStoppedDoneEvent(jobId, ''))
            return
          }
          mainWindow?.webContents.send('ai.done', {
            jobId,
            ok: false,
            message: e instanceof Error ? e.message : String(e),
          })
        }
      })
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  // Kept for preload/backward compatibility, but deliberately cannot bypass evidence-grounded chatStream.
  ipcMain.handle('ai.chat', async () => ({ ok: false, message: '请使用已读证据问答' }))
  ipcMain.handle(
    'ai.test',
    async (_e, payload?: {
      baseUrl?: string
      model?: string
      apiKey?: string
      provider?: AiConfig['provider']
      thinkingEnabled?: boolean
    }) => {
      try {
        const settings = await getSettings()
        const stored = await getApiKey()
        const providedKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : ''
        const apiKey = providedKey || stored
        if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
        const providedBaseUrl = typeof payload?.baseUrl === 'string' ? payload.baseUrl.trim() : ''
        const providedModel = typeof payload?.model === 'string' ? payload.model.trim() : ''
        const baseUrl = providedBaseUrl || settings.baseUrl
        const model = providedModel || settings.model
        const exclusive = await aiJobSlot.runExclusive(() => testConnection(
          trustedAiConfig(settings, apiKey, {
            baseUrl,
            model,
            provider: payload?.provider,
            thinkingEnabled: payload?.thinkingEnabled,
          }),
        ))
        if (!exclusive.ok) return exclusive
        return { ok: true, text: exclusive.value }
      } catch (e: unknown) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
  )
  ipcMain.handle('ai.characterCard', async (_e, { bookId, uptoChapterId }: { bookId: string; uptoChapterId: string }) => {
    try {
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const book = await getBook(bookId)
      if (!book.chapters.some((c) => c.id === uptoChapterId)) {
        return { ok: false, message: '章节不存在' }
      }
      // 材料红线：夹紧到已读进度，未读章绝不进提示词
      const progressChapterId = book.progress?.chapterId ?? null
      const cutoff = clampSummarizeChapters(book.chapters, uptoChapterId, progressChapterId)
      if (cutoff.length === 0) {
        return { ok: false, message: '还没有已读章节，先读几章再生成人物卡' }
      }
      const cutoffIds = new Set(cutoff.map((c) => c.id))
      const cutIdx = Math.max(...book.chapters.map((c, i) => (cutoffIds.has(c.id) ? i : -1)))
      const catalogTitles = book.chapters.slice(0, cutIdx + 1).map((c) => c.title)
      const stored = await readSummaries(bookId)
      const chapterSummaries = book.chapters
        .slice(0, cutIdx + 1)
        .map((c) => ({ title: c.title, text: stored.byChapter[c.id] || '' }))
        .filter((s) => s.text)
      const recentBodies: Array<{ title: string; body: string }> = []
      for (const ch of cutoff.slice(-3)) {
        try {
          const file = await readChapter(bookId, ch.id)
          if (file.body) recentBodies.push({ title: ch.title, body: file.body })
        } catch {
          /* skip */
        }
      }
      const exclusive = await aiJobSlot.runExclusive(() => generateCharacterCard(
        trustedAiConfig(settings, apiKey),
        {
          bookTitle: book.title,
          uptoChapterTitle: book.chapters[cutIdx]?.title || '',
          catalogTitles,
          chapterSummaries,
          recentBodies,
        },
      ))
      if (!exclusive.ok) return exclusive
      const raw = exclusive.value
      await persistAiUsage(bookId, undefined)
      const parsed = parseCharacterCard(raw)
      const card = {
        version: 1 as const,
        uptoChapterId,
        characters: parsed?.characters ?? [],
        foreshadows: parsed?.foreshadows ?? [],
        raw,
        updatedAt: new Date().toISOString(),
      }
      await writeCharacterCard(bookId, card)
      return { ok: true, card }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ai.getCharacterCard', async (_e, { bookId }: { bookId: string }) => {
    try {
      const card = await readCharacterCard(bookId)
      return { ok: true, card }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
}

app.setName('spbf')

app.whenReady().then(async () => {
  const settings = await getSettings()
  await setLibraryPath(settings.libraryPath)
  // 上次退出或崩溃会把在跑的书留在「下载中」：先按实际章节状态修正，再开窗口
  const repaired = await recoverInterruptedStatus()
  if (repaired > 0) console.info(`已修正 ${repaired} 本中断下载的书状态`)
  browserAdRequestFilter = new BrowserAdRequestFilter(app.getPath('userData'), () => {
    const wc = browseView?.webContents
    return wc && !wc.isDestroyed() ? { id: wc.id, url: wc.getURL() } : null
  })
  browserAdRequestFilter.setSiteRules(await listSiteRules())
  browserAdRequestFilter.install(novelSession())
  registerIpc()
  createWindow()
  bookOverview.start()
  // 启动后检查到期备份；维护锁使压缩期间的书库快照保持一致。
  setTimeout(() => {
    void (async () => {
      let release: (() => void) | undefined
      try {
        if (isDownloadBusy() || aiJobSlot.busy || activeImports > 0) return
        release = beginLibraryRestore()
        await runAsLibraryRestore(() => runAutoBackupIfDue())
      } catch (error) {
        console.warn('自动备份暂未完成：', error)
      } finally { release?.() }
    })()
  }, 2_000)
  void browserAdRequestFilter.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 退出前停掉后台任务：取消下载与批量检查、中断当前 AI 生成、关掉全书概览队列。
// 取消后的状态落盘不保证赶得上进程退出，所以启动时还有一次 recoverInterruptedStatus 兜底。
app.on('before-quit', () => {
  cancelDownload()
  cancelCheckAll()
  aiJobSlot.cancel()
  bookOverview.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
