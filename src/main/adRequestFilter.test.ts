import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADGUARD_BASE_URL, BrowserAdRequestFilter } from './adRequestFilter'

const FILTERS = [
  '! Title: AdGuard Base filter',
  '||ads.example^',
  '@@||ads.example/allowed.js$script',
].join('\n')

const browser = { id: 7, url: 'https://novels.example/book/1.html' }
const request = (overrides: Partial<Electron.OnBeforeRequestListenerDetails> = {}) => ({
  id: 1,
  url: 'https://ads.example/banner.js',
  method: 'GET',
  webContentsId: 7,
  resourceType: 'script' as const,
  referrer: browser.url,
  timestamp: Date.now(),
  uploadData: [],
  ...overrides,
}) as Electron.OnBeforeRequestListenerDetails

describe('BrowserAdRequestFilter', () => {
  let dir: string | undefined
  afterEach(async () => {
    vi.restoreAllMocks()
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('uses AdGuard network rules only for the browser view and respects exceptions and per-site off', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-ad-filter-'))
    const filter = new BrowserAdRequestFilter(dir, () => browser, vi.fn(async () => new Response(FILTERS)) as typeof fetch)
    await filter.start()
    expect(filter.ready).toBe(true)
    expect(filter.shouldBlock(request())).toBe(true)
    expect(filter.shouldBlock(request({ webContentsId: 8 }))).toBe(false)
    expect(filter.shouldBlock(request({ webContentsId: undefined }))).toBe(false)
    expect(filter.shouldBlock(request({ resourceType: 'mainFrame' }))).toBe(false)
    expect(filter.shouldBlock(request({ url: 'https://ads.example/allowed.js' }))).toBe(false)
    filter.updateSiteRule({ host: 'novels.example', body: '#chapter', adFilterEnabled: false })
    expect(filter.shouldBlock(request())).toBe(false)
    filter.removeSiteRule('novels.example')
    expect(filter.shouldBlock(request())).toBe(true)
  })

  it('registers one session listener that leaves hidden download requests untouched', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-ad-filter-'))
    const filter = new BrowserAdRequestFilter(dir, () => browser, vi.fn(async () => new Response(FILTERS)) as typeof fetch)
    await filter.start()
    let listener: ((details: Electron.OnBeforeRequestListenerDetails, callback: (response: { cancel?: boolean }) => void) => void) | undefined
    const onBeforeRequest = vi.fn((_options, handler) => { listener = handler })
    filter.install({ webRequest: { onBeforeRequest } } as unknown as Session)
    expect(onBeforeRequest).toHaveBeenCalledTimes(1)
    const callback = vi.fn()
    listener!(request({ webContentsId: 8 }), callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: false })
    listener!(request(), callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
  })

  it('reuses the local compiled cache when offline', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-ad-filter-'))
    const online = new BrowserAdRequestFilter(dir, () => browser, vi.fn(async () => new Response(FILTERS)) as typeof fetch)
    await online.start()
    const meta = JSON.parse(await readFile(join(dir, 'adguard-network.json'), 'utf-8'))
    expect(meta.source).toBe(ADGUARD_BASE_URL)
    const offlineFetch = vi.fn(async () => { throw new Error('offline') }) as typeof fetch
    const offline = new BrowserAdRequestFilter(dir, () => browser, offlineFetch)
    await offline.start()
    expect(offline.ready).toBe(true)
    expect(offline.shouldBlock(request())).toBe(true)
    expect(offlineFetch).not.toHaveBeenCalled()
  })

  it('keeps a stale cached engine when its background update fails', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-ad-filter-'))
    await new BrowserAdRequestFilter(dir, () => browser, vi.fn(async () => new Response(FILTERS)) as typeof fetch).start()
    await writeFile(join(dir, 'adguard-network.json'), JSON.stringify({ source: ADGUARD_BASE_URL, updatedAt: 0 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const offlineFetch = vi.fn(async () => { throw new Error('offline') }) as typeof fetch
    const filter = new BrowserAdRequestFilter(dir, () => browser, offlineFetch)
    await filter.start()
    expect(offlineFetch).toHaveBeenCalledTimes(1)
    expect(filter.ready).toBe(true)
    expect(filter.shouldBlock(request())).toBe(true)
    warn.mockRestore()
  })

  it('allows browsing when the list download fails and no cache exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-ad-filter-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const filter = new BrowserAdRequestFilter(dir, () => browser, vi.fn(async () => { throw new Error('offline') }) as typeof fetch)
    await filter.start()
    expect(filter.ready).toBe(false)
    expect(filter.shouldBlock(request())).toBe(false)
    warn.mockRestore()
  })
})
