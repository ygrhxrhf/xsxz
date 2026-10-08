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

  it('shows material coverage, book usage, alias correction, and a pausable organize queue', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain('材料覆盖到')
    expect(source).toContain('缺摘要')
    expect(source).toContain('window.api.ai.correctCharacterAliases')
    expect(source).toContain('保存别名')
    expect(source).toContain('从来源章重建')
    expect(source).toContain('暂停队列')
    expect(source).toContain('继续队列')
    expect(source).toContain('本书累计')
    expect(source).toContain('接近 30000 字单次预算')
    expect(source).toContain('问 AI · 解释这段')
    expect(source).toContain('这个人物是谁')
    expect(source).toContain('这件事之前发生了什么')
  })
})
