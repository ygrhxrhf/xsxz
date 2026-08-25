import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiChatMessage,
  BookListItem,
  BrowseState,
  ChapterFile,
  DownloadProgress,
  ReadingProgress,
  Settings,
  SettingsUpdate,
  SiteRule,
} from '../shared/types'

type Unsub = () => void

function on<T>(channel: string, handler: (payload: T) => void): Unsub {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  dialog: {
    openFile: () => ipcRenderer.invoke('dialog.openFile') as Promise<{ filePaths: string[] }>,
    openDirectory: () => ipcRenderer.invoke('dialog.openDirectory') as Promise<{ filePaths: string[] }>,
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
    onUrl: (handler: (payload: { url: string }) => void) => on('browse.url', handler),
    onState: (handler: (payload: BrowseState) => void) => on('browse.state', handler),
  },
  library: {
    list: () => ipcRenderer.invoke('library.list') as Promise<{ books: BookListItem[] }>,
    get: (bookId: string) => ipcRenderer.invoke('library.get', { bookId }) as Promise<{ book?: import('../shared/types').Book; ok?: false; message?: string }>,
    readChapter: (bookId: string, chapterId: string) =>
      ipcRenderer.invoke('library.readChapter', { bookId, chapterId }) as Promise<{ chapter?: ChapterFile; ok?: false; message?: string }>,
    delete: (bookId: string) => ipcRenderer.invoke('library.delete', { bookId }),
    import: (filePath: string) => ipcRenderer.invoke('library.import', { filePath }) as Promise<{ ok: boolean; bookId?: string; message?: string }>,
    setProgress: (bookId: string, progress: ReadingProgress) =>
      ipcRenderer.invoke('library.setProgress', { bookId, progress }),
    updateChapterBody: (bookId: string, chapterId: string, body: string, restoreRaw?: boolean) =>
      ipcRenderer.invoke('library.updateChapterBody', { bookId, chapterId, body, restoreRaw }),
    export: (bookId: string, format: 'txt' | 'epub', destDir: string) =>
      ipcRenderer.invoke('library.export', { bookId, format, destDir }) as Promise<
        { ok: true; path: string } | { ok: false; message: string }
      >,
  },
  download: {
    start: () => ipcRenderer.invoke('download.start'),
    cancel: (bookId?: string) => ipcRenderer.invoke('download.cancel', { bookId }),
    retryFailed: (bookId: string) => ipcRenderer.invoke('download.retryFailed', { bookId }),
    checkUpdate: (bookId: string) => ipcRenderer.invoke('download.checkUpdate', { bookId }),
    onProgress: (handler: (payload: DownloadProgress) => void) => on('download.progress', handler),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings.get') as Promise<Settings>,
    set: (update: SettingsUpdate) => ipcRenderer.invoke('settings.set', update) as Promise<Settings>,
  },
  siteRules: {
    list: () => ipcRenderer.invoke('siteRules.list') as Promise<{ rules: SiteRule[] }>,
    upsert: (rule: SiteRule) =>
      ipcRenderer.invoke('siteRules.upsert', rule) as Promise<
        { ok: true; rule: SiteRule } | { ok: false; message: string }
      >,
    remove: (host: string) =>
      ipcRenderer.invoke('siteRules.remove', { host }) as Promise<{ ok: true } | { ok: false; message: string }>,
  },
  ai: {
    clean: (bookId: string, chapterId: string) => ipcRenderer.invoke('ai.clean', { bookId, chapterId }),
    summarize: (bookId: string, uptoChapterId: string) =>
      ipcRenderer.invoke('ai.summarize', { bookId, uptoChapterId }),
    translate: (text: string) => ipcRenderer.invoke('ai.translate', { text }),
    chat: (bookId: string, chapterId: string, messages: AiChatMessage[]) =>
      ipcRenderer.invoke('ai.chat', { bookId, chapterId, messages }),
    test: (opts?: { baseUrl?: string; model?: string; apiKey?: string }) =>
      ipcRenderer.invoke('ai.test', opts) as Promise<{ ok: boolean; text?: string; message?: string }>,
  },
}

contextBridge.exposeInMainWorld('api', api)

export type AppApi = typeof api
