import type { AiDoneEvent, AiMemoryUpdateResult, AiUsage } from '../shared/types'

export interface MemorySaveDependencies {
  save: (signal?: AbortSignal) => Promise<void>
  retrySave: () => Promise<void>
  registerRetry: (save: () => Promise<void>) => string
  emitStage: () => void
  emitDone: (event: AiDoneEvent) => void
}

export async function finalizeMemoryUpdate(
  jobId: string,
  memoryUpdate: AiMemoryUpdateResult,
  usage: AiUsage | undefined,
  signal: AbortSignal,
  dependencies: MemorySaveDependencies,
): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const event: Extract<AiDoneEvent, { ok: true }> = {
    jobId,
    ok: true,
    text: `本次处理 ${memoryUpdate.processedChapters} 章，新增或更新 ${memoryUpdate.changedItems} 条记忆。`,
    memoryUpdate,
    ...(usage ? { usage } : {}),
  }
  dependencies.emitStage()
  try {
    await dependencies.save(signal)
    dependencies.emitDone(event)
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new DOMException('Aborted', 'AbortError')
    }
    const saveToken = dependencies.registerRetry(dependencies.retrySave)
    dependencies.emitDone({ ...event, saveToken })
  }
}
