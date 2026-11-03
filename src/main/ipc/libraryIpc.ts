import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ReadingProgress } from '../../shared/types'
import {
  assertImportable,
  deleteBook,
  getBook,
  listBooks,
  listTrash,
  purgeTrash,
  readChapter,
  repairChapterBody,
  restoreFromTrash,
  setCover,
  setProgress,
  updateChapterBody,
  updateMeta,
} from '../library'
import { confirmLegacyReadRange, getReadFrontier, markReadFrontier } from '../readFrontier'
import { searchInBook } from '../search'
import { importTxt } from '../importTxt'
import { importEpub } from '../importEpub'
import { auditBook } from '../quality'
import { exportBook } from '../exportBook'
import { readReadingStats } from '../readingStats'
import { getSettings } from '../settings'
import { isLibraryRestoring } from '../libraryMaintenance'
import { wakeSemanticIndex } from '../semanticSearch'
import { wakeEvidenceIndex } from '../aiEvidenceIndex'

/** 主进程 IPC 注册器：把 core 模块和 Electron 解耦，测试里可传入假实现。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 与 ipcMain.handle 的 ...args: any[] 对齐
export type IpcRegistrar = (channel: string, listener: (...args: any[]) => unknown) => void

export interface LibraryIpcDeps {
  /** 书库概览服务：列表装饰、失败重试、唤醒队列。 */
  bookOverview: {
    decorate(books: Awaited<ReturnType<typeof listBooks>>, settings: Awaited<ReturnType<typeof getSettings>>): Promise<unknown>
    retry(bookId: string): Promise<void>
    wake(): void
  }
  /** 导入互斥计数由 index.ts 持有，backup.* 的守卫也读它，所以注入而不是复制。 */
  imports: {
    current(): number
    begin(): void
    end(): void
  }
  /** `library.pickCoverFile` 需要父窗口；无窗口时返回 null。 */
  getParentWindow(): BrowserWindow | null
}

/**
 * 书库域的能力注册：只依赖磁盘与 Electron 对话框，不依赖浏览视图。
 * 频道名、入参形状与返回结构必须与迁移前逐字一致（`docs/ipc-contract.md` 与
 * `src/preload/ipcContract.test.ts` 同时约束）。
 */
export function registerLibraryIpc(register: IpcRegistrar, deps: LibraryIpcDeps): void {
  const { bookOverview, imports, getParentWindow } = deps

  register('library.list', async () => {
    const books = await listBooks()
    return { books: await bookOverview.decorate(books, await getSettings()) }
  })
  register('bookOverview.retry', async (_e, payload: { bookId?: string }) => {
    try {
      const bookId = payload?.bookId
      if (typeof bookId !== 'string' || !/^[a-z0-9_]+$/i.test(bookId)) return { ok: false, message: '书籍编号无效' }
      await bookOverview.retry(bookId)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  register('library.get', async (_e, { bookId }: { bookId: string }) => {
    try {
      const book = await getBook(bookId)
      return { book }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })
  register('library.readChapter', async (_e, { bookId, chapterId }: { bookId: string; chapterId: string }) => {
    try {
      const chapter = await readChapter(bookId, chapterId)
      // 正文刚落盘就补索引：不 await，读章返回不该为检索加速件等待。
      wakeEvidenceIndex(bookId)
      return { chapter }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })
  register('library.delete', async (_e, { bookId }: { bookId: string }) => {
    try {
      await deleteBook(bookId)
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  register('library.listTrash', async () => {
    try {
      const items = await listTrash()
      return { ok: true, items }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  register('library.restoreTrash', async (_e, { name }: { name: string }) => {
    try {
      await restoreFromTrash(name)
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  register('library.purgeTrash', async (_e, payload?: { name?: string }) => {
    try {
      const purged = await purgeTrash(payload?.name)
      return { ok: true, purged }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  register('library.import', async (_e, { filePath }: { filePath: string }) => {
    let started = false
    try {
      if (isLibraryRestoring()) return { ok: false, message: '书库正在恢复，请稍后再试' }
      // 导入是长任务：重复点击会同时开两个导入，写同一份索引
      if (imports.current() > 0) return { ok: false, message: '已经有一个导入在进行，请等它完成' }
      imports.begin()
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
      if (started) imports.end()
    }
  })
  register('library.setProgress', async (_e, { bookId, progress }: { bookId: string; progress: unknown }) => {
    try {
      await setProgress(bookId, progress as ReadingProgress)
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })
  register('library.getReadFrontier', async (_e, payload: { bookId: string }) => {
    try { return { ok: true, frontier: await getReadFrontier(payload.bookId) } }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  register('library.markReadFrontier', async (_e, payload: { bookId: string; chapterId: string; paragraphIndex: number; characterOffset: number }) => {
    try {
      const position = await markReadFrontier(payload.bookId, payload.chapterId, payload.paragraphIndex, payload.characterOffset)
      wakeSemanticIndex(payload.bookId)
      return { ok: true, position }
    }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  register('library.confirmLegacyReadRange', async (_e, payload: { bookId: string }) => {
    try { return { ok: true, frontier: await confirmLegacyReadRange(payload.bookId) } }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  register('library.getReadingStats', async (_e, payload?: { limitDays?: number }) => {
    try {
      const limit = typeof payload?.limitDays === 'number' ? payload.limitDays : 30
      return { ok: true, stats: await readReadingStats(limit) }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  register(
    'library.updateMeta',
    async (_e, payload: { bookId: string; title: string; author: string; tags: string[] }) => {
      try {
        return await updateMeta(payload)
      } catch (e: unknown) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
  )
  register('library.setCover', async (_e, payload: { bookId: string; sourcePath: string }) => {
    try {
      return await setCover(payload)
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  register('library.pickCoverFile', async () => {
    const parent = getParentWindow()
    if (!parent) return null
    const result = await dialog.showOpenDialog(parent, {
      title: '选择封面图片',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  register('library.updateChapterBody', async (_e, args: { bookId: string; chapterId: string; body: string; restoreRaw?: boolean }) => {
    try {
      await updateChapterBody(args.bookId, args.chapterId, args.body, args.restoreRaw)
      bookOverview.wake()
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, message: String(e) }
    }
  })
  register('library.repairChapterBody', async (_e, args: { bookId: string; chapterId: string; body: string }) => {
    try { await repairChapterBody(args.bookId, args.chapterId, args.body); bookOverview.wake(); return { ok: true } }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  register('library.audit', async (_e, args: { bookId: string }) => {
    try { return { ok: true, report: await auditBook(args.bookId) } }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  register(
    'library.export',
    async (_e, args: { bookId: string; format: 'txt' | 'epub'; destDir: string }) => {
      try {
        return await exportBook(args.bookId, args.format, args.destDir)
      } catch (e: unknown) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
  )
  register('library.searchInBook', async (_e, { bookId, query }: { bookId: string; query: string }) => {
    try {
      const hits = await searchInBook(bookId, query || '')
      return { ok: true, hits }
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
}
