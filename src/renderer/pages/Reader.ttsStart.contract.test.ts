import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Reader paragraph TTS wiring', () => {
  it('wires the explicit paragraph control to the requested index without a paragraph click binding', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain('function startTtsFromParagraph(index: number)')
    expect(source).toContain('ttsStart(index)')
    expect(source).toContain('@mouseup.stop @click.stop="startTtsFromParagraph(i)"')
    expect(source).not.toContain('@click="startTtsFromParagraph(i)"')
  })
})
