import { contextBridge, ipcRenderer } from 'electron'
import type { AiChatMessage, BrowseState, DownloadProgress, Settings, SettingsUpdate } from '../shared/types'

type Unsub = () => void

function on<T>(channel: string, handler: (payload: T) => void): Unsub {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
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
    list: () => ipcRenderer.invoke('library.list'),
    get: (bookId: string) => ipcRenderer.invoke('library.get', { bookId }),
    readChapter: (bookId: string, chapterId: string) =>
      ipcRenderer.invoke('library.readChapter', { bookId, chapterId }),
    delete: (bookId: string) => ipcRenderer.invoke('library.delete', { bookId }),
    import: (filePath: string) => ipcRenderer.invoke('library.import', { filePath }),
    setProgress: (bookId: string, progress: unknown) =>
      ipcRenderer.invoke('library.setProgress', { bookId, progress }),
    updateChapterBody: (bookId: string, chapterId: string, body: string, restoreRaw?: boolean) =>
      ipcRenderer.invoke('library.updateChapterBody', { bookId, chapterId, body, restoreRaw }),
  },
  download: {
    start: () => ipcRenderer.invoke('download.start'),
    cancel: (bookId?: string) => ipcRenderer.invoke('download.cancel', { bookId }),
    retryFailed: (bookId: string) => ipcRenderer.invoke('download.retryFailed', { bookId }),
    onProgress: (handler: (payload: DownloadProgress) => void) => on('download.progress', handler),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings.get') as Promise<Settings>,
    set: (update: SettingsUpdate) => ipcRenderer.invoke('settings.set', update) as Promise<Settings>,
  },
  ai: {
    clean: (bookId: string, chapterId: string) => ipcRenderer.invoke('ai.clean', { bookId, chapterId }),
    summarize: (bookId: string, uptoChapterId: string) =>
      ipcRenderer.invoke('ai.summarize', { bookId, uptoChapterId }),
    translate: (text: string) => ipcRenderer.invoke('ai.translate', { text }),
    chat: (bookId: string, chapterId: string, messages: AiChatMessage[]) =>
      ipcRenderer.invoke('ai.chat', { bookId, chapterId, messages }),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type AppApi = typeof api
