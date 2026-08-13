import { app, BrowserWindow, ipcMain, session, WebContentsView } from 'electron'
import { join } from 'node:path'
import type { BrowseState } from '../shared/types'

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
  void browseView.webContents.loadURL('about:blank')

  mainWindow.on('resize', () => applyBrowseBounds())
  mainWindow.on('closed', () => {
    mainWindow = null
    browseView = null
  })

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

  const notReady = () => ({ ok: false, message: '尚未实现（P1+）' })
  ipcMain.handle('library.list', async () => ({ books: [] }))
  ipcMain.handle('library.get', async () => notReady())
  ipcMain.handle('library.readChapter', async () => notReady())
  ipcMain.handle('library.delete', async () => notReady())
  ipcMain.handle('library.import', async () => notReady())
  ipcMain.handle('library.setProgress', async () => ({ ok: true }))
  ipcMain.handle('library.updateChapterBody', async () => notReady())
  ipcMain.handle('download.start', async () => ({
    ok: false,
    code: 'UnknownPage',
    message: '下载将在后续版本提供',
  }))
  ipcMain.handle('download.cancel', async () => ({ ok: true }))
  ipcMain.handle('download.retryFailed', async () => notReady())
  ipcMain.handle('settings.get', async () => ({
    libraryPath: 'D:\\spbf\\library',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyConfigured: false,
    reader: { fontSize: 18, lineHeight: 1.8, nightMode: false },
  }))
  ipcMain.handle('settings.set', async (_e, update: Record<string, unknown>) => ({
    libraryPath: 'D:\\spbf\\library',
    baseUrl: typeof update?.baseUrl === 'string' ? update.baseUrl : 'https://api.deepseek.com/v1',
    model: typeof update?.model === 'string' ? update.model : 'deepseek-chat',
    apiKeyConfigured: false,
    reader: { fontSize: 18, lineHeight: 1.8, nightMode: false },
  }))
  ipcMain.handle('ai.clean', async () => ({ ok: false, message: '请先在设置中配置 API Key（P3）' }))
  ipcMain.handle('ai.summarize', async () => ({ ok: false, message: '请先在设置中配置 API Key（P3）' }))
  ipcMain.handle('ai.translate', async () => ({ ok: false, message: '请先在设置中配置 API Key（P3）' }))
  ipcMain.handle('ai.chat', async () => ({ ok: false, message: '请先在设置中配置 API Key（P3）' }))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
