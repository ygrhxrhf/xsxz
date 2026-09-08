import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
describe('Reader dual progress bars', () => {
  it('shows book and chapter fills without leaving the flow', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain(':style="{ width: `${bookPercent}%` }"')
    expect(source).toContain(':style="{ width: `${chapterPercent}%` }"')
    expect(source).toContain('class="reader-progress-fill book"')
    expect(source).toContain('class="reader-progress-fill chapter"')
    expect(source).toContain(':title="bookProgressDetail"')
    expect(source).toContain(':aria-label="bookProgressDetail"')
    expect(source).toContain('全书 ${bookPercent.value}% · 本章 ${chapterPercent.value}%')
    expect(source).toContain('position: absolute')
    expect(source).toContain('pointer-events: none')
  })
})
