import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('assistant budget transparency IPC contract', () => {
  it('publishes recap, memory, and evidence budgets without prompt text', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const budgetHelper = await readFile(new URL('./aiBudget.ts', import.meta.url), 'utf-8')
    expect(source).toContain("webContents.send('ai.budget', { jobId, task, budget })")
    expect(source.match(/sendAiBudget\(jobId, 'recap', plan\.budget\)/g)).toHaveLength(1)
    expect(source.match(/sendAiBudget\(jobId, 'chapterSummary', plan\.budget\)/g)).toHaveLength(1)
    expect(source.match(/sendAiBudget\(jobId, 'chapterNote', plan\.budget\)/g)).toHaveLength(1)
    expect(source).toContain("sendAiBudget(jobId, 'memory', memoryBudget)")
    expect(source).toContain("sendAiBudget(jobId, 'qa', promptBudget(")
    expect(source).toContain("onRewriteStarted: (messages) => sendAiBudget(jobId, 'qa', promptBudget(")
    expect(source).toContain('buildEvidenceQueryRewriteMessages(question)')
    expect(source).toContain("import { aiBudgetWarning, promptBudget } from './aiBudget'")
    expect(budgetHelper).toContain('batchCount: requestGroups.length')
    expect(source).toContain("'仅发送查询改写；0 条本地证据，未请求最终回答'")
    expect(source).toContain("memoryRequests.length ? undefined : '无模型请求'")
    expect(source).toContain('.sort((left, right) => left.index - right.index)')
    expect(source).not.toMatch(/webContents\.send\('ai\.budget'[^\n]*(?:prompt|apiKey)/)
  })

  it('exposes a typed additive event and renders the fixed range copy', async () => {
    const [preload, reader, types] = await Promise.all([
      readFile(new URL('../preload/index.ts', import.meta.url), 'utf-8'),
      readFile(new URL('../renderer/pages/Reader.vue', import.meta.url), 'utf-8').then((s) => s.replace(/\r\n/g, '\n')),
      readFile(new URL('../shared/types.ts', import.meta.url), 'utf-8'),
    ])
    expect(types).toContain('export interface AiBudgetEvent')
    expect(preload).toContain("onBudget: (handler: (payload: AiBudgetEvent) => void) => on('ai.budget', handler)")
    expect(reader).toContain('window.api.ai.onBudget(({ task, budget }) =>')
    expect(reader).toContain('async function loadBook(bookId: string) {\n  assistantBudgets.value = {}')
    expect(reader).toContain('<strong>本次发送范围</strong>')
    expect(reader).toContain('currentAssistantBudget.sentCharacters')
    expect(reader).toContain('currentAssistantBudget.estimatedTokens')
    expect(reader).toContain('currentAssistantBudget.range')
  })
})
