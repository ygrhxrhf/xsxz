import type { ChapterFile, ChapterMeta } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  adjacentReadyTargets,
  createChapterPrefetch,
  prefetchCacheKey,
  scheduleIdleWork,
  type IdleSchedulerHost,
} from './readerPrefetch'

function meta(id: string, status: ChapterMeta['status']): ChapterMeta {
  return { id, index: Number(id.replace(/\D/g, '') || 0), title: id, file: `${id}.json`, status }
}

function file(id: string, status: ChapterFile['status'] = 'ready'): ChapterFile {
  return { title: id, body: `body-${id}`, status }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function manualIdleHost() {
  const queued: Array<() => void> = []
  let timeoutUsed = 0
  const host: IdleSchedulerHost = {
    requestIdleCallback: (cb) => {
      queued.push(cb)
      return queued.length
    },
    cancelIdleCallback: () => { queued.length = 0 },
    setTimeout: () => {
      timeoutUsed += 1
      throw new Error('requestIdleCallback should be used')
    },
    clearTimeout: () => {},
  }
  return {
    host,
    flush() {
      const jobs = queued.splice(0)
      for (const job of jobs) job()
    },
    queued,
    timeoutUsed: () => timeoutUsed,
  }
}

describe('adjacentReadyTargets', () => {
  it('returns only ready neighbors and supports a missing side', () => {
    expect(adjacentReadyTargets('book-1', null, meta('c2', 'ready'))).toEqual([
      { bookId: 'book-1', chapterId: 'c2' },
    ])
    expect(adjacentReadyTargets('book-1', meta('c1', 'ready'), null)).toEqual([
      { bookId: 'book-1', chapterId: 'c1' },
    ])
    expect(adjacentReadyTargets('book-1', meta('c1', 'ready'), meta('c3', 'ready'))).toEqual([
      { bookId: 'book-1', chapterId: 'c1' },
      { bookId: 'book-1', chapterId: 'c3' },
    ])
  })

  it('skips pending, failed, and empty neighbors', () => {
    expect(adjacentReadyTargets(
      'book-1',
      meta('c1', 'pending'),
      meta('c3', 'failed'),
    )).toEqual([])
    expect(adjacentReadyTargets('book-1', meta('c1', 'empty'), meta('c3', 'ready'))).toEqual([
      { bookId: 'book-1', chapterId: 'c3' },
    ])
    expect(adjacentReadyTargets(null, meta('c1', 'ready'), meta('c2', 'ready'))).toEqual([])
  })
})

describe('scheduleIdleWork', () => {
  it('uses requestIdleCallback when present and otherwise falls back to setTimeout', () => {
    const ric: Array<() => void> = []
    const cancelRic = scheduleIdleWork(() => ric.push(() => {}), {
      requestIdleCallback: (cb) => { ric.push(cb); return 7 },
      cancelIdleCallback: () => {},
      setTimeout: () => { throw new Error('fallback') },
      clearTimeout: () => {},
    })
    expect(ric).toHaveLength(1)
    cancelRic()

    const timeouts: Array<() => void> = []
    scheduleIdleWork(() => {}, {
      setTimeout: (cb) => { timeouts.push(cb); return 1 },
      clearTimeout: () => {},
    })
    expect(timeouts).toHaveLength(1)
  })
})

describe('createChapterPrefetch', () => {
  it('keeps at most two session-memory entries keyed by book and chapter', async () => {
    const idle = manualIdleHost()
    const prefetch = createChapterPrefetch({ idleHost: idle.host })
    const reads: string[] = []
    prefetch.scheduleNeighbors({
      bookId: 'book-1',
      previous: meta('c1', 'ready'),
      following: meta('c3', 'ready'),
      readChapter: async (bookId, chapterId) => {
        reads.push(`${bookId}:${chapterId}`)
        return { chapter: file(chapterId) }
      },
    })
    idle.flush()
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toEqual(['book-1:c1', 'book-1:c3'])
    expect(prefetch.size()).toBe(2)
    expect(prefetch.get('book-1', 'c1')?.body).toBe('body-c1')
    expect(prefetch.get('book-1', 'c3')?.body).toBe('body-c3')
    expect(prefetchCacheKey('book-1', 'c1')).toBe('book-1\tc1')
  })

  it('drops stale results after the user changes chapter and never writes a failed read', async () => {
    const idle = manualIdleHost()
    const prefetch = createChapterPrefetch({ idleHost: idle.host })
    const first = deferred<{ chapter: ChapterFile }>()
    prefetch.scheduleNeighbors({
      bookId: 'book-1',
      previous: null,
      following: meta('c2', 'ready'),
      readChapter: async () => first.promise,
    })
    idle.flush()
    prefetch.beginNavigation()
    first.resolve({ chapter: file('c2') })
    await Promise.resolve()
    await Promise.resolve()
    expect(prefetch.get('book-1', 'c2')).toBeUndefined()
    expect(prefetch.size()).toBe(0)

    prefetch.scheduleNeighbors({
      bookId: 'book-1',
      previous: meta('c1', 'ready'),
      following: meta('c3', 'failed'),
      readChapter: async (_bookId, chapterId) => {
        if (chapterId === 'c1') return { chapter: file('c1', 'pending') }
        return { chapter: file(chapterId) }
      },
    })
    idle.flush()
    await Promise.resolve()
    await Promise.resolve()
    expect(prefetch.get('book-1', 'c1')).toBeUndefined()
    expect(prefetch.size()).toBe(0)
  })

  it('discards cache on book change, adjacent-set change, rewrite, and swallows read errors', async () => {
    const idle = manualIdleHost()
    const prefetch = createChapterPrefetch({ idleHost: idle.host })
    prefetch.scheduleNeighbors({
      bookId: 'book-1',
      previous: meta('c1', 'ready'),
      following: meta('c3', 'ready'),
      readChapter: async (_bookId, chapterId) => ({ chapter: file(chapterId) }),
    })
    idle.flush()
    await Promise.resolve()
    await Promise.resolve()
    expect(prefetch.size()).toBe(2)

    prefetch.invalidate('book-1', 'c1')
    expect(prefetch.get('book-1', 'c1')).toBeUndefined()
    expect(prefetch.size()).toBe(1)

    prefetch.onBookChange('book-2')
    expect(prefetch.size()).toBe(0)

    const reads: string[] = []
    prefetch.scheduleNeighbors({
      bookId: 'book-2',
      previous: meta('p1', 'ready'),
      following: meta('n1', 'ready'),
      readChapter: async (_bookId, chapterId) => {
        reads.push(chapterId)
        if (chapterId === 'p1') throw new Error('disk')
        return { chapter: file(chapterId) }
      },
    })
    idle.flush()
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toEqual(['p1', 'n1'])
    expect(prefetch.get('book-2', 'p1')).toBeUndefined()
    expect(prefetch.get('book-2', 'n1')?.body).toBe('body-n1')

    prefetch.scheduleNeighbors({
      bookId: 'book-2',
      previous: null,
      following: meta('n2', 'ready'),
      readChapter: async (_bookId, chapterId) => ({ chapter: file(chapterId) }),
    })
    expect(prefetch.get('book-2', 'n1')).toBeUndefined()
    idle.flush()
    await Promise.resolve()
    await Promise.resolve()
    expect(prefetch.get('book-2', 'n2')?.body).toBe('body-n2')
    expect(prefetch.size()).toBe(1)
  })

  it('保留当前章的缓存：滚动中回到本章不该重读磁盘', async () => {
    const idle = manualIdleHost()
    const prefetch = createChapterPrefetch({ idleHost: idle.host })
    // 在第一章时把第二章预取进来（following）
    prefetch.scheduleNeighbors({
      bookId: 'book-1',
      currentChapterId: 'c1',
      previous: null,
      following: meta('c2', 'ready'),
      readChapter: async (_bookId, chapterId) => ({ chapter: file(chapterId) }),
    })
    idle.flush()
    await Promise.resolve()
    await Promise.resolve()
    expect(prefetch.get('book-1', 'c2')?.body).toBe('body-c2')

    // 翻到第二章：相邻集变成 [c1, c3]，若不保留当前章，刚读过的 c2 会被清出缓存
    prefetch.scheduleNeighbors({
      bookId: 'book-1',
      currentChapterId: 'c2',
      previous: meta('c1', 'ready'),
      following: meta('c3', 'ready'),
      readChapter: async (_bookId, chapterId) => ({ chapter: file(chapterId) }),
    })
    expect(prefetch.get('book-1', 'c2')?.body).toBe('body-c2')
  })
})
