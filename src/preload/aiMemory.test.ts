import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
let exposed: Record<string, unknown> | undefined

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, unknown>) => { exposed = api } },
  ipcRenderer: {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))

describe('preload memory IPC contract', () => {
  beforeEach(async () => {
    invoke.mockReset()
    exposed = undefined
    vi.resetModules()
    await import('./index')
  })

  it('exposes the four frozen memory channels with exact payload fields', async () => {
    const ai = (exposed?.ai ?? {}) as Record<string, (...args: never[]) => Promise<unknown>>
    await ai.storySoFar?.('book-1', 'c0003', true)
    await ai.getMemory?.('book-1')
    await ai.updateMemory?.('book-1', 'c0005')
    await ai.rebuildMemory?.('book-1', 'c0010')
    await ai.markMemoryInaccurate?.('book-1', 'foreshadow', 'foreshadow-1')
    expect(invoke.mock.calls).toEqual([
      ['ai.storySoFar', { bookId: 'book-1', uptoChapterId: 'c0003', confirmOverBudget: true }],
      ['ai.getMemory', { bookId: 'book-1' }],
      ['ai.updateMemory', { bookId: 'book-1', uptoChapterId: 'c0005' }],
      ['ai.rebuildMemory', { bookId: 'book-1', uptoChapterId: 'c0010' }],
      ['ai.markMemoryInaccurate', { bookId: 'book-1', kind: 'foreshadow', itemId: 'foreshadow-1' }],
    ])
  })
})
