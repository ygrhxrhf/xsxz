import { app, BrowserWindow, dialog, ipcMain, session, WebContentsView } from 'electron'
import { join } from 'node:path'
import type { BrowseState, Settings, SettingsUpdate, SiteRule } from '../shared/types'
import {
  listBooks,
  getBook,
  readChapter,
  deleteBook,
  listTrash,
  restoreFromTrash,
  purgeTrash,
  setProgress,
  updateChapterBody,
  setLibraryPath,
  readSummaries,
  writeChapterSummary,
  writeStorySoFar,
  writeChat,
  readChat,
  readCharacterCard,
  writeCharacterCard,
  assertImportable,
} from './library'
import { importTxt } from './importTxt'
import { importEpub } from './importEpub'
import { getSettings, updateSettings, getApiKey } from './settings'
import { startDownload, cancelDownload, retryFailed, checkUpdate, checkAllUpdates, cancelCheckAll, setOwnerWindow, setBrowseView } from './download'
import { listSiteRules, upsertSiteRule, removeSiteRule } from './siteRules'
import { exportBook } from './exportBook'
import { searchInBook } from './search'
import { createBackup, restoreBackup } from './backup'
import { addAnnotation, listAnnotations, removeAnnotation, updateAnnotation } from './annotations'
import { AiJobSlot, buildBookChatMessages, buildChapterSummaryPrompt, buildStorySoFarPrompt, buildTranslatePrompt, cleanChapterBody, summarizeUpTo, streamChatCompletion, translateText, chatAboutBook, clampSummarizeChapters, generateCharacterCard, parseCharacterCard, testConnection } from './ai'

const PARTITION = 'persist:novel'
const SIDEBAR_WIDTH = 200

let mainWindow: BrowserWindow | null = null
let browseView: WebContentsView | null = null
let browseVisible = false
let lastBounds = { x: SIDEBAR_WIDTH, y: 52, width: 900, height: 700 }
const aiJobSlot = new AiJobSlot()

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
      return await restoreBackup(args.zipPath)
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
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

  ipcMain.handle('download.start', async () => startDownload())
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

  ipcMain.handle('ai.getChat', async (_e, { bookId }: { bookId: string }) => {
    try { return { ok: true, messages: (await readChat(bookId)).messages } }
    catch (e: unknown) { return { ok: false, message: e instanceof Error ? e.message : String(e) } }
  })

  ipcMain.handle('ai.clearChat', async (_e, { bookId }: { bookId: string }) => {
    try {
      await writeChat(bookId, [])
      return { ok: true }
    } catch {
      return { ok: false, message: '无法保存到书库，请检查磁盘空间和权限' }
    }
  })

  ipcMain.handle('ai.cancel', (_e, payload?: { jobId?: string }) => {
    aiJobSlot.cancel(payload?.jobId)
    return { ok: true }
  })

  ipcMain.handle('ai.storySoFar', async (_e, { bookId, uptoChapterId }: { bookId: string; uptoChapterId: string }) => {
    try {
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const book = await getBook(bookId)
      if (!book.progress?.chapterId) return { ok: false, message: '还没有阅读进度，打开阅读器读几章再来。' }
      const requested = book.chapters.findIndex((chapter) => chapter.id === uptoChapterId)
      const progressed = book.chapters.findIndex((chapter) => chapter.id === book.progress!.chapterId)
      const cutoff = Math.min(requested, progressed)
      if (cutoff < 0) return { ok: false, message: '章节不存在' }
      const stored = await readSummaries(bookId)
      const read = book.chapters.slice(0, cutoff + 1).filter((chapter) => chapter.status === 'ready')
      const summaries = read.map((chapter) => ({ title: chapter.title, text: stored.byChapter[chapter.id] || '' })).filter((item) => item.text)
      if (!summaries.length) return { ok: false, message: '还没有前情提要。请先「生成本章摘要」，再点「刷新看到这里」。' }
      const missing = read.length - summaries.length
      return aiJobSlot.start(async (jobId, signal) => {
        try {
          const generated = await streamChatCompletion(
            { baseUrl: settings.baseUrl, model: settings.model, apiKey },
            [{ role: 'user', content: buildStorySoFarPrompt(book.title, summaries) }], signal,
            (delta) => mainWindow?.webContents.send('ai.chunk', { jobId, delta }),
          )
          const text = `${missing > 0 ? `以下仅根据已有摘要的章节整理，另有 ${missing} 章尚未生成本章摘要。\n\n` : ''}${generated}`
          try {
            await writeStorySoFar(bookId, book.chapters[cutoff]!.id, text)
          } catch {
            mainWindow?.webContents.send('ai.done', { jobId, ok: false, message: '无法保存到书库，请检查磁盘空间和权限' })
            return
          }
          mainWindow?.webContents.send('ai.done', { jobId, ok: true, text })
        } catch (e: unknown) {
          mainWindow?.webContents.send('ai.done', { jobId, ok: false, message: e instanceof Error ? e.message : String(e) })
        }
      })
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ai.summarizeChapter', async (_e, { bookId, chapterId }: { bookId: string; chapterId: string }) => {
    try {
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const book = await getBook(bookId)
      if (!book.chapters.some((chapter) => chapter.id === chapterId)) {
        return { ok: false, message: '章节不存在' }
      }
      const chapter = await readChapter(bookId, chapterId)
      if (!chapter.body.trim()) return { ok: false, message: '当前章节没有可摘要的正文' }
      return aiJobSlot.start(async (jobId, signal) => {
        try {
          const text = await streamChatCompletion(
            { baseUrl: settings.baseUrl, model: settings.model, apiKey },
            [{ role: 'user', content: buildChapterSummaryPrompt(book.title, chapter.title, chapter.body) }],
            signal,
            (delta) => mainWindow?.webContents.send('ai.chunk', { jobId, delta }),
          )
          try {
            await writeChapterSummary(bookId, chapterId, text)
          } catch {
            mainWindow?.webContents.send('ai.done', { jobId, ok: false, message: '无法保存到书库，请检查磁盘空间和权限' })
            return
          }
          mainWindow?.webContents.send('ai.done', { jobId, ok: true, text })
        } catch (e: unknown) {
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
      const text = await summarizeUpTo(
        { baseUrl: settings.baseUrl, model: settings.model, apiKey },
        book.title,
        summaries,
        { uptoChapterId, progressChapterId },
      )
      const storyUptoChapterId = cutoff[cutoff.length - 1]?.id ?? uptoChapterId
      await writeStorySoFar(bookId, storyUptoChapterId, text)
      return { ok: true, text }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ai.translateStream', async (_e, { text }: { text: string }) => {
    try {
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      if (!text.trim()) return { ok: false, message: '请先在正文中选中要翻译的文字' }
      if (text.length > 2000) return { ok: false, message: '选中过长，请缩短后再问' }
      return aiJobSlot.start(async (jobId, signal) => {
        let partial = ''
        try {
          const translated = await streamChatCompletion(
            { baseUrl: settings.baseUrl, model: settings.model, apiKey },
            [{ role: 'user', content: buildTranslatePrompt(text) }],
            signal,
            (delta) => {
              partial += delta
              mainWindow?.webContents.send('ai.chunk', { jobId, delta })
            },
          )
          mainWindow?.webContents.send('ai.done', { jobId, ok: true, text: translated })
        } catch (e: unknown) {
          if (signal.aborted) {
            mainWindow?.webContents.send('ai.done', { jobId, ok: true, text: partial })
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
      const result = await translateText({ baseUrl: settings.baseUrl, model: settings.model, apiKey }, text)
      return { ok: true, text: result }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ai.chatStream', async (_e, args: { bookId: string; chapterId: string; messages: import('../shared/types').AiChatMessage[] }) => {
    try {
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const book = await getBook(args.bookId)
      const ch = await readChapter(args.bookId, args.chapterId)
      const uptoIdx = book.chapters.findIndex((chapter) => chapter.id === args.chapterId)
      if (uptoIdx < 0) return { ok: false, message: '章节不存在' }
      const catalogSummary = book.chapters.slice(0, uptoIdx + 1).map((chapter) => chapter.title).join('、')
      const stored = await readSummaries(args.bookId)
      const readSummary = book.chapters
        .slice(0, uptoIdx + 1)
        .map((chapter) => stored.byChapter[chapter.id])
        .filter(Boolean)
        .join('\n\n')
      const persistedMessages = args.messages.filter((message) => message.role !== 'system')
      const apiMessages = buildBookChatMessages(
        book.title,
        ch.title,
        ch.body,
        catalogSummary,
        readSummary,
        args.messages,
      )
      return aiJobSlot.start(async (jobId, signal) => {
        try {
          await writeChat(args.bookId, persistedMessages)
        } catch {
          mainWindow?.webContents.send('ai.done', { jobId, ok: false, message: '无法保存到书库，请检查磁盘空间和权限' })
          return
        }

        let partial = ''
        try {
          const text = await streamChatCompletion(
            { baseUrl: settings.baseUrl, model: settings.model, apiKey },
            apiMessages,
            signal,
            (delta) => {
              partial += delta
              mainWindow?.webContents.send('ai.chunk', { jobId, delta })
            },
          )
          try {
            await writeChat(args.bookId, [...persistedMessages, { role: 'assistant', content: text }])
          } catch {
            mainWindow?.webContents.send('ai.done', { jobId, ok: false, message: '无法保存到书库，请检查磁盘空间和权限' })
            return
          }
          mainWindow?.webContents.send('ai.done', { jobId, ok: true, text })
        } catch (e: unknown) {
          if (signal.aborted) {
            try {
              await writeChat(args.bookId, partial
                ? [...persistedMessages, { role: 'assistant', content: partial }]
                : persistedMessages)
            } catch {
              mainWindow?.webContents.send('ai.done', { jobId, ok: false, message: '无法保存到书库，请检查磁盘空间和权限' })
              return
            }
            mainWindow?.webContents.send('ai.done', { jobId, ok: true, text: partial })
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
      await writeChat(args.bookId, [...args.messages.filter((message) => message.role !== 'system'), { role: 'assistant', content: text }])
      return { ok: true, text }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(
    'ai.test',
    async (_e, payload?: { baseUrl?: string; model?: string; apiKey?: string }) => {
      try {
        const settings = await getSettings()
        const stored = await getApiKey()
        const apiKey = (payload?.apiKey || '').trim() || stored
        if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
        const text = await testConnection({
          baseUrl: (payload?.baseUrl || settings.baseUrl).trim() || settings.baseUrl,
          model: (payload?.model || settings.model).trim() || settings.model,
          apiKey,
        })
        return { ok: true, text }
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
      const raw = await generateCharacterCard(
        { baseUrl: settings.baseUrl, model: settings.model, apiKey },
        {
          bookTitle: book.title,
          uptoChapterTitle: book.chapters[cutIdx]?.title || '',
          catalogTitles,
          chapterSummaries,
          recentBodies,
        },
      )
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
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
