import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('assistant budget transparency IPC contract', () => {
  it('publishes recap, memory, and evidence budgets without prompt text', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    expect(source).toContain("webContents.send('ai.budget', { jobId, task, budget })")
    expect(source).toContain("sendAiBudget(jobId, 'recap', plan.budget)")
    expect(source).toContain("sendAiBudget(jobId, 'memory', memoryBudget)")
    expect(source).toContain("sendAiBudget(jobId, 'qa', promptBudget(")
    expect(source).toContain("'0 条本地证据'")
    expect(source).not.toMatch(/webContents\.send\('ai\.budget'[^\n]*(?:prompt|apiKey)/)
  })

  it('exposes a typed additive event and renders the fixed range copy', async () => {
    const [preload, reader, types] = await Promise.all([
      readFile(new URL('../preload/index.ts', import.meta.url), 'utf-8'),
      readFile(new URL('../renderer/pages/Reader.vue', import.meta.url), 'utf-8'),
      readFile(new URL('../shared/types.ts', import.meta.url), 'utf-8'),
    ])
    expect(types).toContain('export interface AiBudgetEvent')
    expect(preload).toContain("onBudget: (handler: (payload: AiBudgetEvent) => void) => on('ai.budget', handler)")
    expect(reader).toContain('window.api.ai.onBudget(({ task, budget }) =>')
    expect(reader).toContain('<strong>本次发送范围</strong>')
    expect(reader).toContain('currentAssistantBudget.sentCharacters')
    expect(reader).toContain('currentAssistantBudget.estimatedTokens')
    expect(reader).toContain('currentAssistantBudget.range')
  })
})
