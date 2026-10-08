import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiBookUsage,
  AiBudgetEstimate,
  AiBudgetEvent,
  AiChatMessage,
  AiChunkEvent,
  AiCleanResult,
  AiDoneEvent,
  AiJobStart,
  AiMemoryBase,
  AiMemoryCharacter,
  AiMemoryFile,
  AiMaterialCoverage,
  AiProvider,
  AiStageEvent,
  AiSummaries,
  BookListItem,
  BrowseState,
  ChapterFile,
  DownloadProgress,
  ReadingProgress,
  TtsPosition,
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
    updateMeta: (payload: { bookId: string; title: string; author: string; tags: string[] }) =>
      ipcRenderer.invoke('library.updateMeta', payload) as Promise<{ ok: true } | { ok: false; message: string }>,
    setCover: (payload: { bookId: string; sourcePath: string }) =>
      ipcRenderer.invoke('library.setCover', payload) as Promise<
        { ok: true; coverPath: string } | { ok: false; message: string }
      >,
    pickCoverFile: () => ipcRenderer.invoke('library.pickCoverFile') as Promise<string | null>,
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
      { ok: true; preview: import('../shared/types').DownloadPreview } | { ok: false; message: string }
    >,
    confirm: (token: string) => ipcRenderer.invoke('download.confirm', { token }) as Promise<
      { ok: true; bookId: string } | { ok: false; message: string }
    >,
    redownloadChapter: (bookId: string, chapterId: string, url: string) =>
      ipcRenderer.invoke('download.redownloadChapter', { bookId, chapterId, url }) as Promise<{ ok: boolean; message?: string }>,
    cancel: (bookId?: string) => ipcRenderer.invoke('download.cancel', { bookId }),
    retryFailed: (bookId: string) => ipcRenderer.invoke('download.retryFailed', { bookId }),
    checkUpdate: (bookId: string) => ipcRenderer.invoke('download.checkUpdate', { bookId }),
    checkAll: () =>
      ipcRenderer.invoke('download.checkAll') as Promise<import('../shared/types').CheckAllResult>,
    cancelCheckAll: () => ipcRenderer.invoke('download.cancelCheckAll') as Promise<{ ok: true }>,
    onProgress: (handler: (payload: DownloadProgress) => void) => on('download.progress', handler),
    onCheckAllProgress: (handler: (payload: import('../shared/types').CheckAllProgress) => void) =>
      on('download.checkAll.progress', handler),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings.get') as Promise<Settings>,
    set: (update: SettingsUpdate) => ipcRenderer.invoke('settings.set', update) as Promise<Settings>,
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
    summarize: (bookId: string, uptoChapterId: string) =>
      ipcRenderer.invoke('ai.summarize', { bookId, uptoChapterId }),
    translate: (text: string) => ipcRenderer.invoke('ai.translate', { text }),
    chat: (bookId: string, chapterId: string, messages: AiChatMessage[]) =>
      ipcRenderer.invoke('ai.chat', { bookId, chapterId, messages }),
    getChat: (bookId: string) => ipcRenderer.invoke('ai.getChat', { bookId }) as Promise<{ ok: true; messages: AiChatMessage[] } | { ok: false; message: string }>,
    clearChat: (bookId: string) => ipcRenderer.invoke('ai.clearChat', { bookId }) as Promise<{ ok: true } | { ok: false; message: string }>,
    test: (opts?: {
      baseUrl?: string
      model?: string
      apiKey?: string
      provider?: AiProvider
      thinkingEnabled?: boolean
    }) =>
      ipcRenderer.invoke('ai.test', opts) as Promise<{ ok: boolean; text?: string; message?: string }>,
    characterCard: (bookId: string, uptoChapterId: string) =>
      ipcRenderer.invoke('ai.characterCard', { bookId, uptoChapterId }) as Promise<
        | { ok: true; card: import('../shared/types').CharacterCard }
        | { ok: false; message: string }
      >,
    getCharacterCard: (bookId: string) =>
      ipcRenderer.invoke('ai.getCharacterCard', { bookId }) as Promise<
        | { ok: true; card: import('../shared/types').CharacterCard | null }
        | { ok: false; message: string }
      >,
    summarizeChapter: (bookId: string, chapterId: string, confirmOverBudget = false) =>
      ipcRenderer.invoke('ai.summarizeChapter', { bookId, chapterId, confirmOverBudget }) as Promise<
        AiJobStart | { ok: false; confirmationRequired: true; message: string; budget: AiBudgetEstimate }
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
    chatStream: (bookId: string, chapterId: string, messages: AiChatMessage[]) =>
      ipcRenderer.invoke('ai.chatStream', { bookId, chapterId, messages }) as Promise<AiJobStart>,
    translateStream: (text: string, bookId?: string) =>
      ipcRenderer.invoke('ai.translateStream', { text, bookId }) as Promise<AiJobStart>,
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
    getUsage: (bookId: string) =>
      ipcRenderer.invoke('ai.getUsage', { bookId }) as Promise<
        | { ok: true; usage: AiBookUsage }
        | { ok: false; message: string }
      >,
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
