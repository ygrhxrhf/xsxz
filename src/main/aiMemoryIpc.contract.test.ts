import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('memory IPC main-process contract', () => {
  it('registers every frozen channel and wires trusted orchestration dependencies', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    for (const channel of ['ai.getMemory', 'ai.updateMemory', 'ai.rebuildMemory', 'ai.markMemoryInaccurate']) {
      expect(source).toContain(`ipcMain.handle('${channel}'`)
    }
    expect(source).toContain("aiTaskInstruction(settings, 'memory')")
    expect(source).toContain("{ task: 'memory', signal: requestSignal }")
    expect(source).toContain('selectMemoryChapterBatches(')
    expect(source).toContain('executeMemoryOrchestration(')
    expect(source).toContain('finalizeMemoryUpdate(')
    expect(source).toContain("markAiMemoryAccuracy(payload.bookId, collection, payload.itemId, 'review')")
  })

  it('keeps model failure/cancellation terminal events free of applicable memory results', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const start = source.indexOf("const startMemoryUpdate = async")
    const end = source.indexOf("ipcMain.handle('ai.retrySave'", start)
    const block = source.slice(start, end)
    expect(block).toContain("ok: false")
    expect(block).toContain("signal.aborted ? '已停止生成'")
    expect(block).not.toMatch(/ok:\s*false[^}]*memoryUpdate/s)
  })
})
