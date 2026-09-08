import type { ChapterFile, ChapterMeta } from '@shared/types'

export const PREFETCH_CACHE_LIMIT = 2

export type PrefetchNeighbor = Pick<ChapterMeta, 'id' | 'status'> | null | undefined

export type PrefetchReadResult = { chapter?: ChapterFile; message?: string }

export type PrefetchReadChapter = (bookId: string, chapterId: string) => Promise<PrefetchReadResult>

export type IdleSchedulerHost = {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
  setTimeout: (cb: () => void, ms?: number) => unknown
  clearTimeout: (id: unknown) => void
}

export function prefetchCacheKey(bookId: string, chapterId: string): string {
  return `${bookId}\t${chapterId}`
}

export function adjacentReadyTargets(
  bookId: string | null | undefined,
  previous: PrefetchNeighbor,
  following: PrefetchNeighbor,
): Array<{ bookId: string; chapterId: string }> {
  if (!bookId) return []
  const targets: Array<{ bookId: string; chapterId: string }> = []
  for (const chapter of [previous, following]) {
    if (chapter && chapter.status === 'ready' && chapter.id) {
      targets.push({ bookId, chapterId: chapter.id })
    }
  }
  return targets
}

export function scheduleIdleWork(
  run: () => void,
  host: IdleSchedulerHost,
  timeoutMs = 2000,
): () => void {
  if (typeof host.requestIdleCallback === 'function') {
    const id = host.requestIdleCallback(() => run(), { timeout: timeoutMs })
    return () => host.cancelIdleCallback?.(id)
  }
  const id = host.setTimeout(() => run(), 1)
  return () => host.clearTimeout(id)
}

function resolveIdleHost(override?: IdleSchedulerHost): IdleSchedulerHost {
  if (override) return override
  const globalHost = globalThis as typeof globalThis & IdleSchedulerHost
  return {
    requestIdleCallback:
      typeof globalHost.requestIdleCallback === 'function'
        ? (cb, opts) => globalHost.requestIdleCallback!(cb, opts)
        : undefined,
    cancelIdleCallback:
      typeof globalHost.cancelIdleCallback === 'function'
        ? (id) => globalHost.cancelIdleCallback!(id)
        : undefined,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }
}

export function createChapterPrefetch(options?: {
  limit?: number
  idleHost?: IdleSchedulerHost
  idleTimeoutMs?: number
}) {
  const limit = options?.limit ?? PREFETCH_CACHE_LIMIT
  const cache = new Map<string, ChapterFile>()
  let epoch = 0
  let activeBookId: string | null = null
  let cancelScheduled: (() => void) | null = null

  function cancelIdle() {
    cancelScheduled?.()
    cancelScheduled = null
  }

  function beginNavigation() {
    epoch += 1
    cancelIdle()
    return epoch
  }

  function get(bookId: string, chapterId: string): ChapterFile | undefined {
    const hit = cache.get(prefetchCacheKey(bookId, chapterId))
    return hit ? { ...hit } : undefined
  }

  function put(bookId: string, chapterId: string, file: ChapterFile) {
    const key = prefetchCacheKey(bookId, chapterId)
    if (cache.has(key)) cache.delete(key)
    cache.set(key, { ...file })
    while (cache.size > limit) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  function invalidate(bookId: string, chapterId: string) {
    cache.delete(prefetchCacheKey(bookId, chapterId))
  }

  function onBookChange(bookId: string) {
    if (activeBookId !== null && activeBookId !== bookId) {
      cache.clear()
      beginNavigation()
    }
    activeBookId = bookId
  }

  function retainTargets(targets: Array<{ bookId: string; chapterId: string }>) {
    const allowed = new Set(targets.map((target) => prefetchCacheKey(target.bookId, target.chapterId)))
    for (const key of [...cache.keys()]) {
      if (!allowed.has(key)) cache.delete(key)
    }
  }

  async function prefetchTargets(
    myEpoch: number,
    targets: Array<{ bookId: string; chapterId: string }>,
    readChapter: PrefetchReadChapter,
  ) {
    for (const target of targets) {
      if (myEpoch !== epoch) return
      if (cache.has(prefetchCacheKey(target.bookId, target.chapterId))) continue
      try {
        const result = await readChapter(target.bookId, target.chapterId)
        if (myEpoch !== epoch) return
        const file = result.chapter
        if (!file || file.status !== 'ready') {
          invalidate(target.bookId, target.chapterId)
          continue
        }
        put(target.bookId, target.chapterId, file)
      } catch {
        // Prefetch failures stay silent and never reach the current chapter UI.
      }
    }
  }

  function scheduleNeighbors(input: {
    bookId: string
    previous: PrefetchNeighbor
    following: PrefetchNeighbor
    readChapter: PrefetchReadChapter
  }) {
    onBookChange(input.bookId)
    const myEpoch = beginNavigation()
    const targets = adjacentReadyTargets(input.bookId, input.previous, input.following)
    retainTargets(targets)
    if (targets.length === 0) return
    const host = resolveIdleHost(options?.idleHost)
    cancelScheduled = scheduleIdleWork(() => {
      void prefetchTargets(myEpoch, targets, input.readChapter)
    }, host, options?.idleTimeoutMs)
  }

  function dispose() {
    beginNavigation()
    cache.clear()
    activeBookId = null
  }

  return {
    get,
    invalidate,
    onBookChange,
    beginNavigation,
    scheduleNeighbors,
    dispose,
    size: () => cache.size,
    keys: () => [...cache.keys()],
  }
}
