import { beforeEach, describe, expect, it } from 'vitest'
import {
  cancelMirror,
  clampMirrorOptions,
  extractMirrorBookLinks,
  findMirrorNextPage,
  getMirrorState,
  resetMirrorForTests,
  setMirrorDeps,
  startMirror,
} from './mirror'
import type { MirrorDeps } from './mirror'
import type { MirrorProgress } from '../shared/types'

const LIST_PAGE = `<!doctype html><html><body>
  <nav>
    <a href="/">首页</a>
    <a href="/login">登录</a>
    <a href="/search?q=x">搜索</a>
    <a href="https://other.example/book/9/">站外书</a>
    <a href="#top">顶部</a>
  </nav>
  <ul class="book-list">
    <li><a href="/book/101/">剑来</a></li>
    <li><a href="/book/102/">诡秘之主</a></li>
    <li><a href="/book/103/">宿命之环</a></li>
    <li><a href="/book/101/#comments">剑来（重复）</a></li>
  </ul>
  <a href="/category/2?page=2">下一页</a>
</body></html>`

const NEXT_PAGE = `<html><body><ul class="book-list">
  <li><a href="/book/104/">长夜余火</a></li>
</ul><a href="/category/2?page=3">下一页</a></body></html>`

function makeDeps(overrides: Partial<MirrorDeps> = {}): {
  deps: MirrorDeps
  started: string[]
  loaded: string[]
  cancelledBooks: string[]
  prefetched: string[]
  completed: Set<string>
} {
  const started: string[] = []
  const loaded: string[] = []
  const cancelledBooks: string[] = []
  const prefetched: string[] = []
  const completed = new Set<string>()
  const pages: Record<string, string> = {
    'https://novel.test/category/2': LIST_PAGE,
    'https://novel.test/category/2?page=2': NEXT_PAGE,
    'https://novel.test/book/101/': '<html>101</html>',
    'https://novel.test/book/102/': '<html>102</html>',
    'https://novel.test/book/103/': '<html>103</html>',
    'https://novel.test/book/104/': '<html>104</html>',
  }
  const deps: MirrorDeps = {
    loadHtml: async (url: string) => {
      loaded.push(url)
      const html = pages[url]
      if (!html) throw new Error(`no fixture for ${url}`)
      return html
    },
    startBook: async (_html: string, url: string) => {
      started.push(url)
      if (url.endsWith('/102/')) return { ok: false, message: '需要登录' }
      completed.add(url)
      return { ok: true, bookId: `book-${url.split('/').filter(Boolean).pop()}` }
    },
    waitIdle: async () => {},
    cancelBook: (bookId: string) => { cancelledBooks.push(bookId) },
    lookupExisting: async (url: string) =>
      completed.has(url) ? { bookId: `book-${url.split('/').filter(Boolean).pop()}`, complete: true } : null,
    prefetch: (url: string) => { prefetched.push(url) },
    emit: () => {},
    saveState: async () => {},
    now: () => 0,
    ...overrides,
  }
  return { deps, started, loaded, cancelledBooks, prefetched, completed }
}

async function waitForFinish(timeoutMs = 2000): Promise<MirrorProgress> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = getMirrorState()
    if (state.last && state.last.status !== 'running') return state.last
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('mirror did not finish')
}

beforeEach(() => resetMirrorForTests())

describe('extractMirrorBookLinks', () => {
  it('keeps same-origin book links and drops nav, off-origin, anchors and duplicates', () => {
    const links = extractMirrorBookLinks(LIST_PAGE, 'https://novel.test/category/2')
    expect(links.map((link) => link.title)).toEqual(['剑来', '诡秘之主', '宿命之环'])
    expect(links.every((link) => link.url.startsWith('https://novel.test/book/'))).toBe(true)
    expect(links[0]!.url).toBe('https://novel.test/book/101/')
  })

  it('falls back to scored-less links when no path looks like a book', () => {
    const html = '<ul><li><a href="/x/1">甲书</a></li><li><a href="/x/2">乙书</a></li></ul>'
    const links = extractMirrorBookLinks(html, 'https://novel.test/list')
    expect(links.map((link) => link.url)).toEqual(['https://novel.test/x/1', 'https://novel.test/x/2'])
  })
})

describe('findMirrorNextPage', () => {
  it('finds the same-origin next page by text', () => {
    expect(findMirrorNextPage(LIST_PAGE, 'https://novel.test/category/2')).toBe('https://novel.test/category/2?page=2')
  })

  it('ignores off-origin and self links', () => {
    const html = '<a href="https://other.example/x">下一页</a>'
    expect(findMirrorNextPage(html, 'https://novel.test/category/2')).toBeNull()
  })
})

describe('clampMirrorOptions', () => {
  it('clamps books and pages into safe ranges', () => {
    expect(clampMirrorOptions({})).toEqual({ maxBooks: 10, maxPages: 3 })
    expect(clampMirrorOptions({ maxBooks: 0, maxPages: 99 })).toEqual({ maxBooks: 1, maxPages: 10 })
    expect(clampMirrorOptions({ maxBooks: 999, maxPages: 0 })).toEqual({ maxBooks: 50, maxPages: 1 })
    expect(clampMirrorOptions({ maxBooks: 2.5, maxPages: Number.NaN })).toEqual({ maxBooks: 10, maxPages: 3 })
  })
})

describe('startMirror', () => {
  it('walks pages in order and downloads each book once, recording a failure without stopping', async () => {
    const { deps, started } = makeDeps()
    setMirrorDeps(deps)
    const startedJob = await startMirror({ seedUrl: 'https://novel.test/category/2', maxBooks: 5, maxPages: 2 })
    expect(startedJob.ok).toBe(true)
    const last = await waitForFinish()
    expect(last.status).toBe('done')
    expect(last.total).toBe(4)
    expect(last.done).toBe(3)
    expect(last.failed).toBe(1)
    expect(last.skipped).toBe(0)
    expect(last.pagesScanned).toBe(2)
    expect(started).toEqual([
      'https://novel.test/book/101/',
      'https://novel.test/book/102/',
      'https://novel.test/book/103/',
      'https://novel.test/book/104/',
    ])
    expect(last.results.find((item) => item.title === '诡秘之主')).toMatchObject({
      status: 'failed',
      message: '需要登录',
    })
  })

  it('skips a book the library says is complete, without loading or downloading it', async () => {
    const { deps, started, loaded } = makeDeps({
      lookupExisting: async (url: string) =>
        url === 'https://novel.test/book/101/' ? { bookId: 'book-101', complete: true } : null,
    })
    setMirrorDeps(deps)
    await startMirror({ seedUrl: 'https://novel.test/category/2', maxBooks: 2, maxPages: 1 })
    const last = await waitForFinish()
    expect(last.skipped).toBe(1)
    expect(last.results.find((item) => item.url.endsWith('/101/'))).toMatchObject({ status: 'skipped', bookId: 'book-101' })
    expect(started).toEqual(['https://novel.test/book/102/'])
    expect(loaded).not.toContain('https://novel.test/book/101/')
  })

  it('still downloads a half-finished book so the downloader can fill missing chapters', async () => {
    const { deps, started } = makeDeps({
      lookupExisting: async (url: string) =>
        url === 'https://novel.test/book/101/' ? { bookId: 'book-101', complete: false } : null,
    })
    setMirrorDeps(deps)
    await startMirror({ seedUrl: 'https://novel.test/category/2', maxBooks: 1, maxPages: 1 })
    const last = await waitForFinish()
    expect(last.skipped).toBe(0)
    expect(started).toEqual(['https://novel.test/book/101/'])
  })

  it('isolates a failing book: waitIdle rejection does not end the batch', async () => {
    let calls = 0
    const completed = new Set<string>()
    const { deps } = makeDeps({
      startBook: async (_html: string, url: string) => {
        completed.add(url)
        return { ok: true, bookId: `book-${url.slice(-4, -1)}` }
      },
      lookupExisting: async (url: string) =>
        completed.has(url) ? { bookId: `book-${url.slice(-4, -1)}`, complete: true } : null,
      waitIdle: async () => {
        calls += 1
        if (calls === 1) throw new Error('等待下载超时')
      },
    })
    setMirrorDeps(deps)
    await startMirror({ seedUrl: 'https://novel.test/category/2', maxBooks: 2, maxPages: 1 })
    const last = await waitForFinish()
    expect(last.status).toBe('done')
    expect(last.failed).toBe(1)
    expect(last.done).toBe(1)
  })

  it('resumes a cancelled run from the same seed without redoing finished books', async () => {
    let starts = 0
    const firstStarted: string[] = []
    const firstDone = new Set<string>()
    const first = makeDeps({
      startBook: async (_html: string, url: string) => {
        firstStarted.push(url)
        starts += 1
        if (starts === 2) cancelMirror()
        firstDone.add(url)
        return { ok: true, bookId: `book-${url.split('/').filter(Boolean).pop()}` }
      },
      lookupExisting: async (url: string) =>
        firstDone.has(url) ? { bookId: `book-${url.split('/').filter(Boolean).pop()}`, complete: true } : null,
    })
    setMirrorDeps(first.deps)
    await startMirror({ seedUrl: 'https://novel.test/category/2', maxBooks: 2, maxPages: 1 })
    const cancelled = await waitForFinish()
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.done).toBe(1)
    expect(cancelled.results).toHaveLength(1)
    expect(cancelled.plan?.length).toBe(2)
    expect(firstStarted).toEqual(['https://novel.test/book/101/', 'https://novel.test/book/102/'])

    const secondStarted: string[] = []
    const secondDone = new Set<string>(['https://novel.test/book/101/'])
    const second = makeDeps({
      startBook: async (_html: string, url: string) => {
        secondStarted.push(url)
        secondDone.add(url)
        return { ok: true, bookId: `book-${url.split('/').filter(Boolean).pop()}` }
      },
      lookupExisting: async (url: string) =>
        secondDone.has(url) ? { bookId: `book-${url.split('/').filter(Boolean).pop()}`, complete: true } : null,
    })
    setMirrorDeps(second.deps)
    const resumed = await startMirror({ seedUrl: 'https://novel.test/category/2', resume: true })
    expect(resumed.ok).toBe(true)
    const last = await waitForFinish()
    expect(last.status).toBe('done')
    expect(secondStarted).toEqual(['https://novel.test/book/102/'])
    expect(last.skipped).toBe(1)
    expect(last.done).toBe(1)
  })

  it('prefetches the next book page while the current one downloads', async () => {
    const { deps, prefetched } = makeDeps()
    setMirrorDeps(deps)
    await startMirror({ seedUrl: 'https://novel.test/category/2', maxBooks: 2, maxPages: 1 })
    await waitForFinish()
    expect(prefetched).toEqual(['https://novel.test/book/102/'])
  })

  it('calls the finish hook exactly once, and also on a cancelled run', async () => {
    let finished = 0
    const { deps } = makeDeps({ onFinish: () => { finished += 1 } })
    setMirrorDeps(deps)
    await startMirror({ seedUrl: 'https://novel.test/category/2', maxBooks: 1, maxPages: 1 })
    await waitForFinish()
    expect(finished).toBe(1)

    const cancelledDeps = makeDeps({
      onFinish: () => { finished += 1 },
      startBook: async (_html: string, url: string) => {
        cancelMirror()
        return { ok: true, bookId: `book-${url.split('/').filter(Boolean).pop()}` }
      },
    })
    setMirrorDeps(cancelledDeps.deps)
    await startMirror({ seedUrl: 'https://novel.test/category/2', maxBooks: 1, maxPages: 1 })
    const cancelled = await waitForFinish()
    expect(cancelled.status).toBe('cancelled')
    expect(finished).toBe(2)
  })

  it('refuses resume from a different seed or with no pending plan', async () => {
    const { deps } = makeDeps()
    setMirrorDeps(deps)
    const noPlan = await startMirror({ seedUrl: 'https://novel.test/category/2', resume: true })
    expect(noPlan).toEqual({ ok: false, message: '没有可继续的镜像任务，请重新开始' })

    const fresh = await startMirror({ seedUrl: 'https://novel.test/category/2', maxBooks: 1, maxPages: 1 })
    expect(fresh.ok).toBe(true)
    await waitForFinish()
    const wrongSeed = await startMirror({ seedUrl: 'https://novel.test/category/3', resume: true })
    expect(wrongSeed).toEqual({ ok: false, message: '没有可继续的镜像任务，请重新开始' })
  })

  it('reports an error when the listing page yields no book links', async () => {
    setMirrorDeps(makeDeps({
      loadHtml: async () => '<ul><li><a href="/login">登录</a></li></ul>',
    }).deps)
    await startMirror({ seedUrl: 'https://novel.test/empty' })
    const last = await waitForFinish()
    expect(last.status).toBe('error')
    expect(last.message).toContain('没有找到可下载的书目链接')
  })

  it('refuses a non-http seed and a second concurrent job', async () => {
    setMirrorDeps(makeDeps().deps)
    expect(await startMirror({ seedUrl: 'file:///c:/x.html' })).toEqual({ ok: false, message: '请先打开一个分类页或作者页' })
    await startMirror({ seedUrl: 'https://novel.test/category/2', maxPages: 1 })
    const second = await startMirror({ seedUrl: 'https://novel.test/category/2' })
    expect(second.ok).toBe(false)
    await waitForFinish()
  })
})
