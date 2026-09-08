import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const EXISTING_API_CHANNELS = new Set([
  'window.api.annotations.add',
  'window.api.annotations.list',
  'window.api.annotations.remove',
  'window.api.annotations.update',
  'window.api.ai.cancel',
  'window.api.ai.characterCard',
  'window.api.ai.chatStream',
  'window.api.ai.clean',
  'window.api.ai.clearChat',
  'window.api.ai.getCharacterCard',
  'window.api.ai.getChat',
  'window.api.ai.getMemory',
  'window.api.ai.getSummaries',
  'window.api.ai.markMemoryInaccurate',
  'window.api.ai.onBudget',
  'window.api.ai.onChunk',
  'window.api.ai.onDone',
  'window.api.ai.onStage',
  'window.api.ai.rebuildMemory',
  'window.api.ai.retrySave',
  'window.api.ai.storySoFar',
  'window.api.ai.summarize',
  'window.api.ai.summarizeChapter',
  'window.api.ai.translateStream',
  'window.api.ai.updateMemory',
  'window.api.download.onProgress',
  'window.api.download.retryFailed',
  'window.api.library.get',
  'window.api.library.readChapter',
  'window.api.library.searchInBook',
  'window.api.library.setProgress',
  'window.api.library.updateChapterBody',
  'window.api.settings.get',
  'window.api.settings.set',
])

describe('Reader P3.3 visual pagination wrap-up', () => {
  it('wires readerPager helpers into the screen-page path and keeps scroll paging', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain("from './readerPager'")
    expect(source).toContain('visualPageCount')
    expect(source).toContain('adjacentVisualPage')
    expect(source).toContain('scrollTopForVisualPage')
    expect(source).toContain('visualPageLabel')
    expect(source).toContain("readingMode.value === 'screen'")
    expect(source).toContain('el.scrollTo({ top: scrollTopForVisualPage')
    expect(source).toContain('el.clientHeight * 0.9')
    expect(source).toContain('reader-page-indicator')
    expect(source.includes('「第') || source.includes('visualPageLabel(')).toBe(true)
    expect(source).toContain('chapterScrollRatio(el.scrollTop, el.scrollHeight, el.clientHeight)')
  })

  it('does not use html, css columns, ipcRenderer, or new window.api channels', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).not.toContain('v-html')
    expect(source).not.toContain('column-count')
    expect(source).not.toMatch(/(?<![-\w])columns\s*:/)
    expect(source).not.toContain('ipcRenderer')
    const used = [...source.matchAll(/window\.api\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?/g)].map((m) => m[0])
    expect(used).toContain('window.api.library.setProgress')
    for (const channel of used) {
      expect(EXISTING_API_CHANNELS.has(channel), channel).toBe(true)
    }
  })
})
