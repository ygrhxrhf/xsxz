import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Reader selection toolbar contract', () => {
  it('positions from Range via selectionPopupPosition, not mouse client coordinates', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain('selectionPopupPosition')
    expect(source).not.toContain('e.clientX - 120')
    expect(source).not.toContain('e.clientY + 12')
    expect(source).toContain('if (selectionOpen()) closeSelectionTools()')
    expect(source).toContain('复制')
    expect(source).toContain('划线')
    expect(source).toContain('备注')
    expect(source).toContain('翻译')
    expect(source).toContain('问 AI')
  })
})
