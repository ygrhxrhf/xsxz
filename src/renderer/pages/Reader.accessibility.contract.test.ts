import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Reader P2.1 accessibility contract', () => {
  it('keeps paragraph TTS opt-in, named, and isolated from selection mouseup', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain('function startTtsFromParagraph(index: number)')
    expect(source).toContain('ttsStart(index)')
    expect(source).toContain(':aria-label="`从第 ${i + 1} 段开始朗读`"')
    expect(source).toContain('@mouseup.stop @click.stop="startTtsFromParagraph(i)"')
    expect(source).toContain('v-if="ttsSupported && chapterReady"')
    expect(source).toContain('.para-tts-start:focus-visible')
  })

  it('publishes the complete approved shortcut map in an accessible toolbar panel', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain('title="快捷键说明" aria-label="快捷键说明"')
    expect(source).toContain("toggleToolPanel('shortcuts')")
    expect(source).toContain("activeToolPanel === 'shortcuts'")
    expect(source).toContain('Space / Shift+Space，J / K')
    expect(source).toContain('Ctrl+F，+ / -')
  })
})
