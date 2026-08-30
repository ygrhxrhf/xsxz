import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Reader recap budget confirmation contract', () => {
  it('retries the same recap kind with explicit confirmation', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain("const recapBudgetConfirmKind = ref<'chapter' | 'story'>('chapter')")
    expect(source).toContain('recapBudgetConfirmKind.value = kind')
    expect(source).toContain('window.api.ai.storySoFar(book.value.id, uptoChapterId, confirmOverBudget)')
    expect(source).toContain('await startRecap(recapBudgetConfirmKind.value, true)')
  })
})
