import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Reader selection toolbar contract', () => {
  it('positions from Range via selectionPopupPosition, not mouse client coordinates', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain('selectionPopupPosition')
    expect(source).toContain('applySelPopupPosition({ width: 360, height: 40 })')
    expect(source).toContain('applySelPopupPosition({ width: 340, height: 220 })')
    expect(source).toContain('getBoundingClientRect')
    expect(source).toContain('if (selectionOpen()) closeSelectionTools()')
    expect(source).toContain('async function openChapter')
    expect(source).toContain('closeSelectionTools()')
    const openStart = source.indexOf('async function openChapter')
    expect(openStart).toBeGreaterThanOrEqual(0)
    const openEnd = source.indexOf('\nfunction ', openStart + 1)
    const openBlock = source.slice(openStart, openEnd > openStart ? openEnd : undefined)
    expect(openBlock).toContain('closeSelectionTools()')
    expect(source).toContain("e.key === 'Escape' && selectionOpen()")
    expect(source).toContain('复制')
    expect(source).toContain('划线')
    expect(source).toContain('备注')
    expect(source).toContain('翻译')
    expect(source).toContain('问 AI')
    expect(source).not.toContain('e.clientX - 120')
    expect(source).not.toContain('e.clientY + 12')
  })
})
