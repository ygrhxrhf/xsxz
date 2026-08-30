import { app, BrowserWindow, dialog, ipcMain, session, WebContentsView } from 'electron'
import { join } from 'node:path'
import type { AiPromptKind, AiRequestStage, AiUsage, BrowseState, Settings, SiteRule } from '../shared/types'
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
  updateChapterBody,
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
  assertImportable,
  type AiMemoryCollection,
} from './library'
import { importTxt } from './importTxt'
import { importEpub } from './importEpub'
import { assertTrustedAiEndpoint, getSettings, updateSettings, getApiKey, normalizeSettingsUpdatePayload, resolveEffectiveAiProvider } from './settings'
import { startDownload, cancelDownload, retryFailed, checkUpdate, checkAllUpdates, cancelCheckAll, setOwnerWindow, setBrowseView } from './download'
import { listSiteRules, upsertSiteRule, removeSiteRule } from './siteRules'
import { exportBook } from './exportBook'
import { searchInBook } from './search'
import { createBackup, restoreBackup } from './backup'
import { addAnnotation, listAnnotations, removeAnnotation, updateAnnotation } from './annotations'
import {
  AiJobSlot,
  AiPendingSaveStore,
  aiCompletionDoneEvent,
  aiStoppedDoneEvent,
  buildBookChatMessages,
  buildTranslatePrompt,
  cleanChapterBody,
  planChapterSummaryRequest,
  planCleanChapterRequest,
  summarizeUpTo,
  streamAiTaskCompletion,
  translateText,
  chatAboutBook,
  clampSummarizeChapters,
  generateCharacterCard,
  runAiSaveStage,
  runAiTaskCompletion,
  parseCharacterCard,
  testConnection,
  type AiConfig,
  type AiSuccessDoneEvent,
} from './ai'
import { executeMemoryOrchestration, selectMemoryChapterBatches } from './aiMemoryOrchestrator'
import { finalizeMemoryUpdate } from './aiMemorySave'
import { selectLocalEvidence, type EvidenceSearchChapter } from './aiEvidenceSearch'
import { executeEvidenceQaPipeline } from './aiEvidenceQa'
import { planAiRecap, selectRecapMaterials, validateAiRecapOutput } from './aiRecap'
import {
  parseMemoryBookPayload,
  parseMemoryMarkPayload,
  parseMemoryRunPayload,
} from './aiMemoryIpcValidation'

const PARTITION = 'persist:novel'
const SIDEBAR_WIDTH = 200

let mainWindow: BrowserWindow | null = null
let browseView: WebContentsView | null = null
let browseVisible = false
let lastBounds = { x: SIDEBAR_WIDTH, y: 52, width: 900, height: 700 }
const aiJobSlot = new AiJobSlot()
const aiPendingSaves = new AiPendingSaveStore()

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

async function saveAiDone(
  jobId: string,
  event: AiSuccessDoneEvent,
  save: () => Promise<void>,
  options: {
    signal?: AbortSignal
    stoppedEvent?: AiSuccessDoneEvent
    saveStopped?: () => Promise<void>
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
  ipcMain.handle('settings.set', async (_e, update: unknown) => {
    const patch = normalizeSettingsUpdatePayload(update)
    const next = await updateSettings(patch)
    if (typeof patch.libraryPath === 'string') {
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

  ipcMain.handle('ai.getMemory', async (_e, payload?: unknown) => {
    try {
      const { bookId } = parseMemoryBookPayload(payload)
      return { ok: true, memory: await readAiMemoryCompat(bookId) }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  const startMemoryUpdate = async (
    mode: 'update' | 'rebuild',
    unsafePayload?: unknown,
  ) => {
    try {
      const payload = parseMemoryRunPayload(unsafePayload)
      const book = await getBook(payload.bookId)
      const existing = mode === 'update' ? await readAiMemory(payload.bookId) : null
      const selection = selectMemoryChapterBatches(
        book.chapters,
        payload.uptoChapterId,
        book.progress?.chapterId,
        existing?.uptoChapterId,
        mode,
      )
      if (!selection.batches.length) return { ok: false, message: '已更新到当前阅读进度' }
      const settings = await getSettings()
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const batches = []
      for (const batch of selection.batches) {
        const loaded = []
        for (const chapter of batch) {
          const file = await readChapter(payload.bookId, chapter.id)
          loaded.push({ ...chapter, body: file.body })
        }
        batches.push(loaded)
      }
      const config = trustedAiConfig(settings, apiKey)
      const instruction = aiTaskInstruction(settings, 'memory')
      return aiJobSlot.start(async (jobId, signal) => {
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
          const snapshot = structuredClone(memoryUpdate.memory)
          await finalizeMemoryUpdate(jobId, memoryUpdate, usage, signal, {
            save: (saveSignal) => writeAiMemory(payload.bookId!, snapshot, { signal: saveSignal }),
            retrySave: () => writeAiMemory(payload.bookId!, snapshot),
            registerRetry: (save) => aiPendingSaves.register(save),
            emitStage: () => sendAiStage(jobId, 'saving'),
            emitDone: (event) => mainWindow?.webContents.send('ai.done', event),
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

  ipcMain.handle('ai.markMemoryInaccurate', async (_e, unsafePayload?: unknown) => {
    try {
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
      if (plan.requiresConfirmation && !confirmOverBudget) {
        return {
          ok: false,
          confirmationRequired: true,
          message: '预计输入超过 30000 字。是否按上方缩减范围继续？',
          budget: plan.budget,
        }
      }
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      return aiJobSlot.start(async (jobId, signal) => {
        let partial = ''
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
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const book = await getBook(args.bookId)
      if (!book.chapters.some((chapter) => chapter.id === args.chapterId)) {
        return { ok: false, message: '章节不存在' }
      }
      const chapter = await readChapter(args.bookId, args.chapterId)
      if (!chapter.body.trim()) return { ok: false, message: '当前章节没有可摘要的正文' }
      const instruction = aiTaskInstruction(settings, 'chapterSummary')
      const plan = planChapterSummaryRequest(book.title, chapter.title, chapter.body, instruction)
      if (plan.requiresConfirmation && args.confirmOverBudget !== true) {
        return {
          ok: false,
          confirmationRequired: true,
          message: '预计输入超过 30000 字。是否按上方缩减范围继续？',
          budget: plan.budget,
        }
      }
      return aiJobSlot.start(async (jobId, signal) => {
        let partial = ''
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
      const apiKey = await getApiKey()
      if (!apiKey) return { ok: false, message: '请先在设置中配置 API Key' }
      const ch = await readChapter(args.bookId, args.chapterId)
      if (!ch.body) return { ok: false, message: '当前章节没有可清理的正文' }
      const instruction = aiTaskInstruction(settings, 'clean')
      const plan = planCleanChapterRequest(ch.title, ch.body, instruction)
      if (!plan.batches.length) return { ok: false, message: '当前章节没有可清理的正文' }
      if (plan.requiresConfirmation && args.confirmOverBudget !== true) {
        return {
          ok: false,
          confirmationRequired: true,
          message: '预计输入超过 30000 字。是否按上方缩减范围继续？',
          budget: plan.budget,
        }
      }
      const exclusive = await aiJobSlot.runExclusive(async (signal) => {
        try {
          return await cleanChapterBody(
            trustedAiConfig(settings, apiKey),
            ch.title,
            ch.body,
            instruction,
            signal,
            plan,
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
      await writeStorySoFar(bookId, storyUptoChapterId, exclusive.value)
      return { ok: true, text: exclusive.value }
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
      const persistedMessages = args.messages.filter((message) => message.role !== 'system')
      return aiJobSlot.start(async (jobId, signal) => {
        sendAiStage(jobId, 'preparing')
        try {
          await writeChat(args.bookId, persistedMessages)
        } catch {
          mainWindow?.webContents.send('ai.done', signal.aborted
            ? aiStoppedDoneEvent(jobId, '')
            : { jobId, ok: false, message: '无法保存到书库，请检查磁盘空间和权限' })
          return
        }

        try {
          const progressIndex = book.chapters.findIndex((chapter) => chapter.id === progressChapterId)
          if (progressIndex < 0) throw new Error('还没有阅读进度，先阅读一章再使用已读内容分析。')
          const result = await executeEvidenceQaPipeline({
            question,
            taskInstruction: aiTaskInstruction(settings, 'evidenceQa'),
            stopped: () => signal.aborted,
            onStage: (stage) => sendAiStage(jobId, stage),
            rewrite: (messages) => runAiTaskCompletion(config, messages, { task: 'queryRewrite', signal }),
            search: async (query) => {
              const searchChapters: EvidenceSearchChapter[] = []
              for (let index = 0; index < book.chapters.length; index += 1) {
                const chapter = book.chapters[index]!
                if (signal.aborted) break
                if (index > progressIndex) {
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
              })
            },
            answer: (messages) => runAiTaskCompletion(config, messages, { task: 'evidenceQa', signal }),
          })
          if (result.kind === 'stopped') {
            mainWindow?.webContents.send('ai.done', aiStoppedDoneEvent(jobId, ''))
            return
          }
          const completedMessages = [...persistedMessages, { role: 'assistant' as const, content: result.text }]
          await saveAiDone(jobId, {
            jobId, ok: true, text: result.text, usage: result.usage,
            citations: result.citations, uptoChapterId: result.uptoChapterId,
            truncated: result.kind === 'answer' ? result.truncated : false,
          }, () => writeChat(args.bookId, completedMessages, { signal }), { signal })
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
      const exclusive = await aiJobSlot.runExclusive(() => chatAboutBook(
        trustedAiConfig(settings, apiKey),
        book.title,
        ch.title,
        ch.body,
        catalogSummary,
        readSummary,
        args.messages,
      ))
      if (!exclusive.ok) return exclusive
      await writeChat(args.bookId, [...args.messages.filter((message) => message.role !== 'system'), { role: 'assistant', content: exclusive.value }])
      return { ok: true, text: exclusive.value }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
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
