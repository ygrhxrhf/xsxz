import { app, BrowserWindow, dialog, ipcMain, session, WebContentsView } from 'electron'
import { join } from 'node:path'
import type { BrowseState, Settings, SettingsUpdate, SiteRule } from '../shared/types'
import {
  listBooks,
  getBook,
  readChapter,
  deleteBook,
  setProgress,
  updateChapterBody,
  setLibraryPath,
  readSummaries,
  writeChapterSummary,
  assertImportable,
} from './library'
import { importTxt } from './importTxt'
import { importEpub } from './importEpub'
import { getSettings, updateSettings, getApiKey } from './settings'
import { startDownload, cancelDownload, retryFailed, checkUpdate, setOwnerWindow, setBrowseView } from './download'
import { listSiteRules, upsertSiteRule, removeSiteRule } from './siteRules'
import { cleanChapterBody, summarizeUpTo, translateText, chatAboutBook, clampSummarizeChapters } from './ai'

const PARTITION = 'persist:novel'
const SIDEBAR_WIDTH = 200

let mainWindow: BrowserWindow | null = null
let browseView: WebContentsView | null = null
let browseVisible = false
let lastBounds = { x: SIDEBAR_WIDTH, y: 52, width: 900, height: 700 }

function novelSession() {
  return session.fromPartition(PARTITION)
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
  }
  mainWindow.webContents.send('browse.state', state)
  mainWindow.webContents.send('browse.url', { url: state.url })
}

function attachBrowseListeners(view: WebContentsView): void {
  const wc = view.webContents
  const bump = () => emitBrowseState()
  wc.on('did-start-loading', bump)
  wc.on('did-stop-loading', bump)
  wc.on('did-navigate', bump)
  wc.on('did-navigate-in-page', bump)
  wc.on('page-title-updated', bump)
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
  if (!browseVisible) {
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
  setBrowseView(browseView)
  void browseView.webContents.loadURL('about:blank')

  mainWindow.on('resize', () => applyBrowseBounds())
  mainWindow.on('closed', () => {
    mainWindow = null
    browseView = null
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
    await browseView.webContents.loadURL(url)
    emitBrowseState()
    return { ok: true }
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
    browseVisible = Boolean(payload?.visible)
    applyBrowseBounds()
    return { ok: true }
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
    return { books }
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
      return { ok: false, message: String(e) }
    }
  })
  ipcMain.handle('library.import', async (_e, { filePath }: { filePath: string }) => {
    try {
      const guard = assertImportable(filePath)
      if (!guard.ok) return guard
      const ext = filePath.toLowerCase().split('.').pop()
      const result = ext === 'epub' ? await importEpub(filePath) : await importTxt(filePath)
      return { ok: true, bookId: result.bookId }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
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
  ipcMain.handle('library.updateChapterBody', async (_e, args: { bookId: string; chapterId: string; body: string; restoreRaw?: boolean }) => {
    try {
      await updateChapterBody(args.bookId, args.chapterId, args.body, args.restoreRaw)
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })

  ipcMain.handle('download.start', async () => startDownload())
  ipcMain.handle('download.cancel', async (_e, { bookId }: { bookId?: string }) => {
    cancelDownload(bookId)
    return { ok: true }
  })
  ipcMain.handle('download.retryFailed', async (_e, { bookId }: { bookId: string }) => retryFailed(bookId))
  ipcMain.handle('download.checkUpdate', (_e, { bookId }: { bookId: string }) => checkUpdate(bookId))

  ipcMain.handle('siteRules.list', async () => {
    const rules = await listSiteRules()
    return { rules }
  })
  ipcMain.handle('siteRules.upsert', async (_e, rule: SiteRule) => {
    try {
      const saved = await upsertSiteRule(rule)
      return { ok: true, rule: saved }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('siteRules.remove', async (_e, payload: { host: string }) => {
    try {
      await removeSiteRule(payload?.host ?? '')
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('settings.get', async () => getSettings())
  ipcMain.handle('settings.set', async (_e, update: SettingsUpdate) => {
    // SettingsUpdate.reader is Partial<ReaderPrefs>; updateSettings's param type is stricter.
    const next = await updateSettings(update as Partial<Settings> & { apiKey?: string })
    if (typeof update.libraryPath === 'string') {
      await setLibraryPath(next.libraryPath)
    }
    return next
  })

  ipcMain.handle('ai.clean', async (_e, { bookId, chapterId }: { bookId: string; chapterId: string }) => {
    try {
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const ch = await readChapter(bookId, chapterId)
      if (!ch.body) return { ok: false, message: '当前章节没有可清理的正文' }
      const result = await cleanChapterBody({ baseUrl: settings.baseUrl, model: settings.model, apiKey }, ch.title, ch.body)
      return { ok: true, result }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
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
      const text = await summarizeUpTo(
        { baseUrl: settings.baseUrl, model: settings.model, apiKey },
        book.title,
        summaries,
        { uptoChapterId, progressChapterId },
      )
      await writeChapterSummary(bookId, uptoChapterId, text)
      return { ok: true, text }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })
  ipcMain.handle('ai.translate', async (_e, { text }: { text: string }) => {
    try {
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const result = await translateText({ baseUrl: settings.baseUrl, model: settings.model, apiKey }, text)
      return { ok: true, text: result }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })
  ipcMain.handle('ai.chat', async (_e, args: { bookId: string; chapterId: string; messages: import('../shared/types').AiChatMessage[] }) => {
    try {
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const book = await getBook(args.bookId)
      const ch = await readChapter(args.bookId, args.chapterId)
      const uptoIdx = book.chapters.findIndex((c) => c.id === args.chapterId)
      const catalogSummary = book.chapters
        .slice(0, uptoIdx + 1)
        .map((c) => c.title)
        .join('、')
      const stored = await readSummaries(args.bookId)
      const readSummary = book.chapters
        .slice(0, uptoIdx + 1)
        .map((c) => stored.byChapter[c.id])
        .filter(Boolean)
        .join('\n\n')
      const text = await chatAboutBook(
        { baseUrl: settings.baseUrl, model: settings.model, apiKey },
        book.title,
        ch.title,
        ch.body,
        catalogSummary,
        readSummary,
        args.messages,
      )
      return { ok: true, text }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })
}

app.setName('spbf')

app.whenReady().then(async () => {
  const settings = await getSettings()
  await setLibraryPath(settings.libraryPath)
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
