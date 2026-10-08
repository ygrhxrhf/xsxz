import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('storySoFar trusted recap contract', () => {
  it('uses saved recap materials without reading chapter bodies', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const start = source.indexOf("ipcMain.handle('ai.storySoFar'")
    const end = source.indexOf("ipcMain.handle('ai.summarizeChapter'", start)
    const block = source.slice(start, end)
    expect(block).toContain('parseMemoryRunPayload(unsafePayload)')
    expect(block).toContain('readSummaries(payload.bookId)')
    expect(block).toContain('readAiMemory(payload.bookId)')
    expect(block).toContain('selectRecapMaterials(')
    expect(block).toContain('planAiRecap(')
    expect(block).not.toContain('readChapter(')
    expect(block).not.toContain('buildStorySoFarPrompt')
  })

  it('gates over-budget work before Key and slot, then validates before saving', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const start = source.indexOf("ipcMain.handle('ai.storySoFar'")
    const end = source.indexOf("ipcMain.handle('ai.summarizeChapter'", start)
    const block = source.slice(start, end)
    expect(block.indexOf('plan.requiresConfirmation')).toBeLessThan(block.indexOf('getApiKey()'))
    expect(block.indexOf('getApiKey()')).toBeLessThan(block.indexOf('aiStart('))
    expect(block).toContain("{ task: 'recap', recapLength }")
    expect(block.indexOf('result.truncated')).toBeLessThan(block.indexOf('validateAiRecapOutput'))
    expect(block.indexOf('validateAiRecapOutput')).toBeLessThan(block.indexOf('writeStorySoFar'))
    expect(block).toContain('plan.uptoChapterId')
  })
})
