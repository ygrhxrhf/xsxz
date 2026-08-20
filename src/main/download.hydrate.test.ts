import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

type Listener = (...args: unknown[]) => void

vi.mock('electron', () => {
  class FakeWebContents {
    destroyed = false
    stopped = 0
    html = '<html><body></body></html>'
    executeCalls = 0
    loadURLHandler: (url: string) => Promise<void> = async () => {}
    private listeners = new Map<string, Listener[]>()

    isDestroyed(): boolean {
      return this.destroyed
    }
    getURL(): string {
      return 'about:blank'
    }
    stop(): void {
      this.stopped++
    }
    on(event: string, fn: Listener): this {
      const arr = this.listeners.get(event) ?? []
      arr.push(fn)
      this.listeners.set(event, arr)
      return this
    }
    removeListener(event: string, fn: Listener): this {
      const arr = this.listeners.get(event) ?? []
      this.listeners.set(
        event,
        arr.filter((x) => x !== fn),
      )
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args)
    }
    async loadURL(url: string): Promise<void> {
      return this.loadURLHandler(url)
    }
    async executeJavaScript(_script: string): Promise<string> {
      this.executeCalls++
      return this.html
    }
  }
  class WebContentsView {
    webContents = new FakeWebContents()
    webPreferences: { session?: { partition?: string } }
    visible = true
    bounds: { x: number; y: number; width: number; height: number } | null = null
    constructor(opts: { webPreferences?: { session?: { partition?: string } } } = {}) {
      this.webPreferences = opts.webPreferences ?? {}
    }
    setVisible(visible: boolean): void {
      this.visible = visible
    }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.bounds = bounds
    }
  }
  return {
    BrowserWindow: class {},
    WebContentsView,
    session: { fromPartition: (partition: string) => ({ partition }) },
    app: {
      getPath(): string {
        throw new Error('hydrate tests must inject setSiteRulesDir when they need rules')
      },
    },
  }
})

import {
  HYDRATE_POLL_MS,
  HYDRATE_TIMEOUT_MS,
  cancelDownload,
  getHiddenView,
  isHydratedHtml,
  loadAndGetHtmlForTests,
  resetDownloadStateForTests,
  setBrowseView,
  setOwnerWindow,
  setTestHtmlLoader,
  startDownload,
  startDownloadFromPage,
  waitForIdle,
  waitUntilHydrated,
} from './download'
import { setLibraryPath } from './library'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../../fixtures', name), 'utf-8')

const HASH_CATALOG = 'https://www.bqg858.cc/#/book/65/'
const HASH_CHAPTER = 'https://www.bqg858.cc/#/book/65/1.html'
const EMPTY_APP = '<!DOCTYPE html><html><body><div id="app"></div></body></html>'
const FILLER =
  '张若尘从梦中惊醒，发现自己身处一间简陋的房间之中。窗外月光如水，照在斑驳的墙壁上。他低头看了看自己的双手，年轻、有力，却不是他记忆中的样子。这个少年来自一个偏远的小城，自幼父母双亡，靠邻居接济长大。他站起身来，走到窗前，望着远处连绵的山峦。'

function hashCatalogHtml(count = 5): string {
  const items = Array.from({ length: count }, (_, i) => {
    const n = i + 1
    return `<dd><a href="#/book/65/${n}.html">第${n}章 千金攻略（${n}）</a></dd>`
  }).join('\n')
  return `<!DOCTYPE html>
<html>
<head><title>这个大佬画风不对</title></head>
<body>
<h1>这个大佬画风不对</h1>
<div id="list">
<dl>
${items}
</dl>
</div>
</body>
</html>`
}

function hashChapterHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><title>第1章 千金攻略（1）</title></head>
<body>
<div id="chaptercontent">
${FILLER}
<a href="#/book/65/">返回目录</a>
</div>
</body>
</html>`
}

function shortChapterHtml(): string {
  return `<!DOCTYPE html><html><body><div id="chaptercontent">短</div></body></html>`
}

function silentWindow(): {
  contentView: { addChildView: () => void; removeChildView: () => void }
  webContents: { send: () => void }
} {
  return {
    contentView: {
      addChildView(): void {},
      removeChildView(): void {},
    },
    webContents: { send(): void {} },
  }
}

type FakeView = {
  webContents: {
    stopped: number
    html: string
    executeCalls: number
    loadURLHandler: (url: string) => Promise<void>
    emit: (event: string, ...args: unknown[]) => void
  }
}

describe('hydrate ready predicates', () => {
  it('treats empty #app as not ready', () => {
    expect(isHydratedHtml(EMPTY_APP, HASH_CATALOG)).toBe(false)
    expect(isHydratedHtml(shortChapterHtml(), HASH_CHAPTER)).toBe(false)
  })

  it('catalog heuristic ≥5 hash links is ready; rule ≥2 is ready', () => {
    expect(isHydratedHtml(hashCatalogHtml(5), HASH_CATALOG)).toBe(true)
    expect(isHydratedHtml(hashCatalogHtml(2), HASH_CATALOG)).toBe(false)
    expect(
      isHydratedHtml(hashCatalogHtml(2), HASH_CATALOG, { host: 'www.bqg858.cc', catalog: '#list' }),
    ).toBe(true)
  })

  it('body rule / #chaptercontent effective length ≥80 is ready', () => {
    expect(isHydratedHtml(hashChapterHtml(), HASH_CHAPTER)).toBe(true)
    expect(
      isHydratedHtml(
        `<html><body><div id="spbf-body">${FILLER}</div></body></html>`,
        HASH_CHAPTER,
        { host: 'www.bqg858.cc', body: '#spbf-body' },
      ),
    ).toBe(true)
  })
})

describe('waitUntilHydrated', () => {
  afterEach(() => {
    resetDownloadStateForTests()
  })

  it('classic HTML first poll returns immediately without the 12s cap', async () => {
    expect(HYDRATE_POLL_MS).toBeGreaterThanOrEqual(200)
    expect(HYDRATE_POLL_MS).toBeLessThanOrEqual(400)
    expect(HYDRATE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
    expect(HYDRATE_TIMEOUT_MS).toBeLessThanOrEqual(15_000)

    let polls = 0
    const started = Date.now()
    const html = await waitUntilHydrated(async () => {
      polls++
      return fixture('catalog.html')
    }, 'https://example.com/book/index.html')
    expect(polls).toBe(1)
    expect(Date.now() - started).toBeLessThan(400)
    expect(html).toContain('第一章')
  })

  it('hydration empty #app then later #list succeeds within cap', async () => {
    let polls = 0
    const started = Date.now()
    const html = await waitUntilHydrated(
      async () => {
        polls++
        return polls < 3 ? EMPTY_APP : hashCatalogHtml()
      },
      HASH_CATALOG,
      { pollMs: 40, timeoutMs: 2000 },
    )
    expect(html).toContain('id="list"')
    expect(html).toContain('#/book/65/1.html')
    expect(polls).toBeGreaterThanOrEqual(3)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(Date.now() - started).toBeLessThan(HYDRATE_TIMEOUT_MS)
  })

  it('hydration empty #app then #chaptercontent ≥80 succeeds within cap', async () => {
    let polls = 0
    const html = await waitUntilHydrated(
      async () => {
        polls++
        return polls < 2 ? EMPTY_APP : hashChapterHtml()
      },
      HASH_CHAPTER,
      { pollMs: 40, timeoutMs: 2000 },
    )
    expect(html).toContain('id="chaptercontent"')
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  it('cancelDownload rejects in-flight hydrate poll with 已取消', async () => {
    const p = waitUntilHydrated(
      async () => EMPTY_APP,
      HASH_CATALOG,
      { pollMs: 40, timeoutMs: 5000 },
    )
    await new Promise((r) => setTimeout(r, 30))
    cancelDownload()
    await expect(p).rejects.toThrow('已取消')
  })
})

describe('loadAndGetHtml settle', () => {
  afterEach(() => {
    resetDownloadStateForTests()
  })

  it('hash→hash navigation settles on did-navigate-in-page without did-finish-load', async () => {
    const view = getHiddenView() as unknown as FakeView
    view.webContents.html = hashCatalogHtml()
    view.webContents.loadURLHandler = () => new Promise(() => {})
    const p = loadAndGetHtmlForTests(view as never, HASH_CHAPTER)
    await new Promise((r) => setTimeout(r, 20))
    view.webContents.emit(
      'did-navigate-in-page',
      {},
      HASH_CHAPTER,
      true,
    )
    const html = await p
    expect(html).toContain('id="list"')
    expect(view.webContents.executeCalls).toBeGreaterThanOrEqual(1)
  })

  it('settles on loadURL() promise when no load events fire', async () => {
    const view = getHiddenView() as unknown as FakeView
    view.webContents.html = hashChapterHtml()
    view.webContents.loadURLHandler = async () => {}
    const html = await loadAndGetHtmlForTests(view as never, HASH_CHAPTER)
    expect(html).toContain('id="chaptercontent"')
  })

  it('classic HTML first executeJavaScript that is ready returns without 12s sleep', async () => {
    const view = getHiddenView() as unknown as FakeView
    view.webContents.html = fixture('catalog.html')
    view.webContents.loadURLHandler = async () => {}
    const started = Date.now()
    const html = await loadAndGetHtmlForTests(view as never, 'https://example.com/book/index.html')
    expect(html).toContain('第一章')
    expect(view.webContents.executeCalls).toBe(1)
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('cancelDownload rejects in-flight load and calls webContents.stop()', async () => {
    const view = getHiddenView() as unknown as FakeView
    view.webContents.loadURLHandler = () => new Promise(() => {})
    const p = loadAndGetHtmlForTests(view as never, HASH_CHAPTER)
    await new Promise((r) => setTimeout(r, 20))
    cancelDownload()
    await expect(p).rejects.toThrow('已取消')
    expect(view.webContents.stopped).toBeGreaterThan(0)
  })
})

describe('UnknownPage hash catalog hidden reload', () => {
  let dir: string
  const loadedUrls: string[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-hydrate-'))
    await setLibraryPath(dir)
    loadedUrls.length = 0
    resetDownloadStateForTests()
    setOwnerWindow(silentWindow() as never)
  })

  afterEach(async () => {
    resetDownloadStateForTests()
    await rm(dir, { recursive: true, force: true })
  })

  it('empty guest on hash URL triggers one hidden loadPageHtml then extract', async () => {
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      if (!url.includes('.html')) return hashCatalogHtml()
      return hashChapterHtml()
    })
    const guest = {
      webContents: {
        isDestroyed: () => false,
        getURL: () => HASH_CATALOG,
        executeJavaScript: async () => EMPTY_APP,
      },
    }
    setBrowseView(guest as never)
    const result = await startDownload()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await waitForIdle()
    const catalogLoads = loadedUrls.filter((u) => u.includes('#/book/65/') && !u.includes('.html'))
    expect(catalogLoads).toHaveLength(1)
    expect(loadedUrls.some((u) => u.includes('1.html'))).toBe(true)
  })

  it('still-empty hidden snapshot does not loop a second catalog reload', async () => {
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      return EMPTY_APP
    })
    const result = await startDownloadFromPage(EMPTY_APP, HASH_CATALOG)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('UnknownPage')
    expect(loadedUrls).toEqual([HASH_CATALOG])
  })

  it('classic HTML UnknownPage does not hidden-reload', async () => {
    setTestHtmlLoader(async (url) => {
      loadedUrls.push(url)
      return EMPTY_APP
    })
    const result = await startDownloadFromPage(EMPTY_APP, 'https://example.com/book/index.html')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('UnknownPage')
    expect(loadedUrls).toEqual([])
  })
})
