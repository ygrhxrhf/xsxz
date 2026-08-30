import { describe, expect, it, vi } from 'vitest'
import { aiSaveRecoveryActive, runAiSaveRecovery } from './aiSaveRecoveryLock'

describe('renderer-wide AI save recovery lock', () => {
  it('holds the shared lock until a deferred retry settles', async () => {
    let release!: () => void
    const deferred = new Promise<void>((resolve) => { release = resolve })
    const operation = vi.fn(async () => { await deferred; return 'saved' })
    const first = runAiSaveRecovery(operation)
    expect(aiSaveRecoveryActive.value).toBe(true)
    await expect(runAiSaveRecovery(vi.fn(async () => 'second'))).resolves.toBeUndefined()
    release()
    await expect(first).resolves.toBe('saved')
    expect(aiSaveRecoveryActive.value).toBe(false)
    expect(operation).toHaveBeenCalledOnce()
  })

  it('releases the lock after failure', async () => {
    await expect(runAiSaveRecovery(async () => { throw new Error('disk') })).rejects.toThrow('disk')
    expect(aiSaveRecoveryActive.value).toBe(false)
  })
})
