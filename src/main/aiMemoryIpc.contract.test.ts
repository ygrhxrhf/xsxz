import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('memory IPC main-process contract', () => {
  it('registers every frozen channel and wires trusted orchestration dependencies', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    for (const channel of ['ai.getMemory', 'ai.updateMemory', 'ai.rebuildMemory', 'ai.markMemoryInaccurate']) {
      expect(source).toContain(`ipcMain.handle('${channel}'`)
    }
    expect(source).toContain('const { bookId } = parseMemoryBookPayload(payload)')
    expect(source).toContain('const payload = parseMemoryRunPayload(unsafePayload)')
    expect(source).toContain('const payload = parseMemoryMarkPayload(unsafePayload)')
    expect(source).toContain("aiTaskInstruction(settings, 'memory')")
    expect(source).toContain("{ task: 'memory', signal: requestSignal }")
    expect(source).toContain('selectMemoryChapterBatches(')
    expect(source).toContain("const hasReviewItems = mode === 'update'")
    expect(source).toContain('if (!selection.batches.length && !hasReviewItems)')
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

  it('按书而不是全局判断记忆写入，且不再持有单个全局任务槽', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    expect(source).toContain("const MEMORY_WRITE_CLASSES = ['memory', 'follow']")
    expect(source.match(/aiQueue\.busyFor\(payload\.bookId, MEMORY_WRITE_CLASSES\)/g)?.length).toBe(3)
    expect(source).not.toContain('const aiJobSlot')
    expect(source).not.toContain('aiJobSlot.')
    expect(source).toContain('const aiQueue = new AiQueue()')
    expect(source).toContain("new AiJobSlot(aiQueue, 'background')")
    expect(source).toContain('onCancelled: sendAiQueueCancel')
  })
})
