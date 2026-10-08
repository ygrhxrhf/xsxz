import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Reader dual progress bars', () => {
  it('shows book and chapter fills without leaving the flow', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain(':style="{ width: `${bookPercent}%` }"')
    expect(source).toContain(':style="{ width: `${chapterPercent}%` }"')
    expect(source).toContain('`${bookPercent}%`')
    expect(source).toContain('`${chapterPercent}%`')
    expect(source).toContain('class="reader-progress-fill book"')
    expect(source).toContain('class="reader-progress-fill chapter"')
    expect(source).toContain('bookProgressDetail')
    expect(source).toContain('全书')
    expect(source).toContain('本章')
    expect(source).toContain(':title="bookProgressDetail"')
    expect(source).toContain(':aria-label="bookProgressDetail"')
    expect(source).toContain('全书约 ${bookPercent.value}% · 本章 ${chapterPercent.value}%')
    expect(source).toContain('position: absolute')
    expect(source).toContain('pointer-events: none')
    expect(source.includes('height: 4px') || source.includes('reader-progress-row')).toBe(true)
  })

  it('keeps the chapter scroll formula and does not require new IPC', async () => {
    const helpers = await readFile(new URL('./readerHelpers.ts', import.meta.url), 'utf-8')
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(helpers).toContain('return clampRatio(scrollTop / distance)')
    expect(helpers).not.toContain('window.api')
    expect(helpers).not.toContain('ipcRenderer')
    expect(helpers).not.toContain('ipcMain')

    const progressComputed = source.slice(
      source.indexOf('const bookProgressRatio'),
      source.indexOf('const progressSummary'),
    )
    expect(progressComputed).toContain('bookProgressDetail')
    expect(progressComputed).toContain('全书')
    expect(progressComputed).toContain('本章')
    expect(progressComputed).not.toContain('window.api')
    expect(progressComputed).not.toContain('ipcRenderer')

    const trackStart = source.indexOf('class="reader-progress-track"')
    const trackEnd = source.indexOf('<!-- Chapter drawer -->', trackStart)
    expect(trackStart).toBeGreaterThan(-1)
    expect(trackEnd).toBeGreaterThan(trackStart)
    const track = source.slice(trackStart, trackEnd)
    expect(track).toContain('class="reader-progress-fill book"')
    expect(track).toContain('class="reader-progress-fill chapter"')
    expect(track).not.toContain('window.api')
    expect(track).not.toContain('ipcRenderer')
  })
})
