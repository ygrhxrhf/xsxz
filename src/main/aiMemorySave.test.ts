import { describe, expect, it, vi } from 'vitest'
import type { AiMemoryUpdateResult } from '../shared/types'
import { finalizeMemoryUpdate } from './aiMemorySave'

const memoryUpdate: AiMemoryUpdateResult = {
  memory: { version: 1, characters: [], relations: [], foreshadows: [], events: [], updatedAt: '2026-01-01T00:00:00.000Z' },
  processedChapters: 3,
  changedItems: 2,
  remainingChapters: 4,
}

describe('memory update save finalization', () => {
  it('emits saving then one durable result after successful persistence', async () => {
    const events: unknown[] = []
    const save = vi.fn(async () => {})
    await finalizeMemoryUpdate('job-1', memoryUpdate, { inputTokens: 12 }, new AbortController().signal, {
      save,
      retrySave: vi.fn(),
      registerRetry: vi.fn(),
      emitStage: () => events.push('saving'),
      emitDone: (event) => events.push(event),
    })
    expect(save).toHaveBeenCalledOnce()
    expect(events).toEqual([
      'saving',
      expect.objectContaining({ jobId: 'job-1', ok: true, memoryUpdate, usage: { inputTokens: 12 } }),
    ])
  })

  it('单次章数上限截断后如实报告剩余未处理章数', async () => {
    const texts: Array<string | undefined> = []
    const emit = (remainingChapters: number) => finalizeMemoryUpdate(
      'job-cap', { ...memoryUpdate, remainingChapters }, undefined, new AbortController().signal, {
        save: vi.fn(async () => {}),
        retrySave: vi.fn(),
        registerRetry: vi.fn(),
        emitStage: vi.fn(),
        emitDone: (event) => texts.push(event.ok ? event.text : undefined),
      })
    await emit(memoryUpdate.remainingChapters)
    await emit(0)
    expect(texts[0]).toContain('剩余 4 章未处理。')
    expect(texts[1]).toBe('本次处理 3 章，新增或更新 2 条记忆。')
  })

  it('returns the complete result and a process-memory retry closure after an ordinary save failure', async () => {
    const events: unknown[] = []
    const retrySave = vi.fn(async () => {})
    let captured: (() => Promise<void>) | undefined
    await finalizeMemoryUpdate('job-2', memoryUpdate, undefined, new AbortController().signal, {
      save: vi.fn(async () => { throw new Error('/private/library') }),
      retrySave,
      registerRetry: (save) => { captured = save; return 'save-memory' },
      emitStage: vi.fn(),
      emitDone: (event) => events.push(event),
    })
    expect(events).toEqual([expect.objectContaining({
      jobId: 'job-2', ok: true, memoryUpdate, saveToken: 'save-memory',
    })])
    expect(JSON.stringify(events)).not.toContain('/private/library')
    expect(captured).toBe(retrySave)
    await captured?.()
    expect(retrySave).toHaveBeenCalledOnce()
  })

  it('reports success when cancellation arrives only after the atomic save has committed', async () => {
    const controller = new AbortController()
    const emitDone = vi.fn()
    await finalizeMemoryUpdate('job-committed', memoryUpdate, undefined, controller.signal, {
      save: vi.fn(async () => { controller.abort() }),
      retrySave: vi.fn(),
      registerRetry: vi.fn(),
      emitStage: vi.fn(),
      emitDone,
    })
    expect(emitDone).toHaveBeenCalledWith(expect.objectContaining({ ok: true, memoryUpdate }))
  })

  it('never emits an applicable result or registers retry when cancellation wins during save', async () => {
    const controller = new AbortController()
    const emitDone = vi.fn()
    const registerRetry = vi.fn()
    await expect(finalizeMemoryUpdate('job-3', memoryUpdate, undefined, controller.signal, {
      save: vi.fn(async () => {
        controller.abort()
        throw new DOMException('Aborted', 'AbortError')
      }),
      retrySave: vi.fn(),
      registerRetry,
      emitStage: vi.fn(),
      emitDone,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(emitDone).not.toHaveBeenCalled()
    expect(registerRetry).not.toHaveBeenCalled()
  })

  it('does not start saving when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const save = vi.fn()
    await expect(finalizeMemoryUpdate('job-4', memoryUpdate, undefined, controller.signal, {
      save,
      retrySave: vi.fn(),
      registerRetry: vi.fn(),
      emitStage: vi.fn(),
      emitDone: vi.fn(),
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(save).not.toHaveBeenCalled()
  })
})
