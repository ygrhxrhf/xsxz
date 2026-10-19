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
  events: MirrorProgress[]
  saved: MirrorProgress[]
  started: string[]
  cancelledBooks: string[]
} {
  const events: MirrorProgress[] = []
  const saved: MirrorProgress[] = []
  const started: string[] = []
  const cancelledBooks: string[] = []
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
      const html = pages[url]
      if (!html) throw new Error(`no fixture for ${url}`)
      return html
    },
    startBook: async (_html: string, url: string) => {
      started.push(url)
      if (url.endsWith('/102/')) return { ok: false, message: '需要登录' }
      return { ok: true, bookId: `book-${url.split('/').filter(Boolean).pop()}` }
    },
    waitIdle: async () => {},
    cancelBook: (bookId: string) => { cancelledBooks.push(bookId) },
    emit: (progress) => { events.push(progress) },
    saveState: async (progress) => { saved.push(progress) },
    now: () => 0,
    ...overrides,
  }
  return { deps, events, saved, started, cancelledBooks }
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
    expect(last.results.filter((item) => item.status === 'downloaded')).toHaveLength(3)
  })

  it('honors maxBooks and stops discovering further books', async () => {
    const { deps, started } = makeDeps()
    setMirrorDeps(deps)
    await startMirror({ seedUrl: 'https://novel.test/category/2', maxBooks: 3, maxPages: 1 })
    const last = await waitForFinish()
    expect(last.total).toBe(3)
    expect(last.done).toBe(2)
    expect(last.failed).toBe(1)
    expect(started).toHaveLength(3)
    expect(last.pagesScanned).toBe(1)
  })

  it('cancels between books and keeps what already landed', async () => {
    const cancelledBooks: string[] = []
    const { deps } = makeDeps({
      waitIdle: async () => { cancelMirror() },
      cancelBook: (bookId: string) => { cancelledBooks.push(bookId) },
    })
    setMirrorDeps(deps)
    await startMirror({ seedUrl: 'https://novel.test/category/2', maxBooks: 5, maxPages: 1 })
    const last = await waitForFinish()
    expect(last.status).toBe('cancelled')
    expect(last.done).toBe(1)
    expect(last.results).toHaveLength(1)
    expect(cancelledBooks).toEqual(['book-101'])
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
