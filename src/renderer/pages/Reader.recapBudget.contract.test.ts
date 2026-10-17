import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/** 助手面板的实现搬去了 readerAssistant.ts：这些契约断言看的是「实现里有没有这条」，
 *  所以把 Reader.vue 与该模块拼起来看（模板与接线仍在 Reader.vue 里断言）。 */
async function readReaderSurface(): Promise<string> {
  const [reader, assistant] = await Promise.all([
    readFile(new URL('./Reader.vue', import.meta.url), 'utf-8'),
    readFile(new URL('./readerAssistant.ts', import.meta.url), 'utf-8'),
  ])
  return reader + assistant
}

describe('Reader recap budget confirmation contract', () => {
  it('retries the same recap kind with explicit confirmation', async () => {
    const source = await readReaderSurface()
    expect(source).toContain("const recapBudgetConfirmKind = ref<'chapter' | 'story'>('chapter')")
    expect(source).toContain('recapBudgetConfirmKind.value = kind')
    expect(source).toContain('window.api.ai.storySoFar(book.value.id, uptoChapterId, confirmOverBudget)')
    expect(source).toContain('await startRecap(recapBudgetConfirmKind.value, true)')
  })

  it('shows material coverage and book usage, and drives the organize queue through the main process', async () => {
    const source = await readReaderSurface()
    expect(source).toContain('材料覆盖到')
    expect(source).toContain('缺摘要')
    expect(source).toContain('window.api.ai.correctCharacterAliases')
    expect(source).toContain('保存别名')
    expect(source).toContain('从来源章重建')
    expect(source).toContain('window.api.ai.chapterFinished')
    expect(source).toContain('window.api.ai.followSet')
    expect(source).toContain('window.api.ai.followRetry')
    expect(source).toContain('现在整理')
    expect(source).toContain('停止自动')
    expect(source).toContain('applyFollow(result.coverage.follow)')
    expect(source).not.toContain('spbf:reading-ai')
    expect(source).toContain('本书累计')
    expect(source).toContain('接近 30000 字单次预算')
    expect(source).toContain('问 AI · 解释这段')
    expect(source).toContain('这个人物是谁')
    expect(source).toContain('这件事之前发生了什么')
  })
})
