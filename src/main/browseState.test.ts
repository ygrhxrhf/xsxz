import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getBrowseZoom,
  getLastBrowsePosition,
  getReadingPos,
  setBrowsePosition,
  setBrowseStateDirForTests,
  setBrowseZoom,
  setReadingPos,
  READING_POSITION_LIMIT,
  ZOOM_HOST_LIMIT,
} from './browseState'

let dir = ''
afterEach(async () => { setBrowseStateDirForTests(null); if (dir) await rm(dir, { recursive: true, force: true }); dir = '' })

describe('browse state persistence', () => {
  it('persists only valid URLs and normalized host zoom', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-browse-'))
    setBrowseStateDirForTests(dir)
    await setBrowseZoom('https://www.example.com/chapter', 1.3)
    await setBrowsePosition('https://www.example.com/chapter', 0.42)
    await setBrowsePosition('javascript:bad()', 0.9)
    setBrowseStateDirForTests(dir)
    expect(await getBrowseZoom('https://example.com/other')).toBe(1.3)
    expect((await getLastBrowsePosition())?.ratio).toBe(0.42)
    expect(JSON.parse(await readFile(join(dir, 'browse-state.json'), 'utf-8')).zoomByHost['example.com']).toBe(1.3)
  })

  it('封顶缩放偏好：访问很多站也不会让 zoomByHost 无界增长', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-browse-zoom-'))
    setBrowseStateDirForTests(dir)
    for (let i = 0; i < ZOOM_HOST_LIMIT + 20; i++) {
      await setBrowseZoom(`https://host${i}.example.com/`, 1.5)
    }
    const saved = JSON.parse(await readFile(join(dir, 'browse-state.json'), 'utf-8')) as { zoomByHost: Record<string, number> }
    expect(Object.keys(saved.zoomByHost)).toHaveLength(ZOOM_HOST_LIMIT)
    // 最近用的那个还在，最旧的被淘汰
    expect(await getBrowseZoom(`https://host${ZOOM_HOST_LIMIT + 19}.example.com/`)).toBe(1.5)
    expect(await getBrowseZoom('https://host0.example.com/')).toBe(1)
  })
})

describe('reading position persistence', () => {
  it('remembers a paragraph anchor per chapter and reloads it from disk', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-browse-reading-'))
    setBrowseStateDirForTests(dir)
    await setReadingPos('https://www.example.com/book/1/c2.html', 37, 0.62)
    setBrowseStateDirForTests(dir)
    const saved = await getReadingPos('https://www.example.com/book/1/c2.html')
    expect(saved).toMatchObject({ paragraphIndex: 37, scrollRatio: 0.62 })
    expect(await getReadingPos('https://www.example.com/book/1/c9.html')).toBeNull()
  })

  it('stores the position under a canonical url and clamps bad numbers', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-browse-reading-'))
    setBrowseStateDirForTests(dir)
    await setReadingPos('https://www.example.com/book/1/c2.html?utm_source=x#top', 12.7, 3)
    const saved = await getReadingPos('https://www.example.com/book/1/c2.html?utm_source=y')
    expect(saved?.paragraphIndex).toBe(12)
    expect(saved?.scrollRatio).toBe(1)
    expect((await getReadingPos('not-a-url'))).toBeNull()
    expect(await setReadingPos('about:blank', 1, 0.5)).toBeNull()
  })

  it('keeps zoom, last page and reading positions side by side', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-browse-mixed-'))
    setBrowseStateDirForTests(dir)
    await setBrowseZoom('https://example.com/x', 1.2)
    await setBrowsePosition('https://example.com/x', 0.3)
    await setReadingPos('https://example.com/x', 4, 0.1)
    const raw = JSON.parse(await readFile(join(dir, 'browse-state.json'), 'utf-8'))
    expect(raw.version).toBe(1)
    expect(raw.zoomByHost['example.com']).toBe(1.2)
    expect(raw.last.ratio).toBe(0.3)
    expect(Object.keys(raw.readingByUrl)).toHaveLength(1)
  })

  it('drops the oldest reading positions beyond the cap', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-browse-cap-'))
    setBrowseStateDirForTests(dir)
    for (let i = 0; i < READING_POSITION_LIMIT + 12; i++) {
      await setReadingPos(`https://example.com/book/1/c${i}.html`, i, 0.01)
    }
    const raw = JSON.parse(await readFile(join(dir, 'browse-state.json'), 'utf-8'))
    expect(Object.keys(raw.readingByUrl)).toHaveLength(READING_POSITION_LIMIT)
    expect(raw.readingByUrl['https://example.com/book/1/c0.html']).toBeUndefined()
  })

  it('ignores damaged reading entries without losing the valid ones', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-browse-damaged-'))
    await writeFile(join(dir, 'browse-state.json'), JSON.stringify({
      version: 1,
      zoomByHost: { 'example.com': 1.1 },
      readingByUrl: {
        'https://example.com/book/1/c1.html': { paragraphIndex: 5, scrollRatio: 0.2, updatedAt: '2026-10-01T00:00:00.000Z' },
        'javascript:bad()': { paragraphIndex: 1, scrollRatio: 0.1, updatedAt: '2026-10-01T00:00:00.000Z' },
        'https://example.com/book/1/c2.html': 'nonsense',
      },
    }), 'utf-8')
    setBrowseStateDirForTests(dir)
    expect((await getReadingPos('https://example.com/book/1/c1.html'))?.paragraphIndex).toBe(5)
    expect(await getReadingPos('https://example.com/book/1/c2.html')).toBeNull()
    expect(await getBrowseZoom('https://example.com/any')).toBe(1.1)
  })
})
