import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getBrowseZoom, getLastBrowsePosition, setBrowsePosition, setBrowseStateDirForTests, setBrowseZoom } from './browseState'

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
})
