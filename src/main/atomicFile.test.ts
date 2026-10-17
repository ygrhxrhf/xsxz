import { describe, expect, it } from 'vitest'
import { renameWithRetry } from './atomicFile'

/** 按次序制造 rename 失败：`null` 表示这次成功。 */
function stubRename(failures: Array<string | null>) {
  const state = {
    calls: 0,
    async rename(): Promise<void> {
      const failure = failures[state.calls] ?? null
      state.calls += 1
      if (failure) {
        const error = new Error(failure) as NodeJS.ErrnoException
        error.code = failure
        throw error
      }
    },
  }
  return state
}

describe('renameWithRetry（Windows 上 rename 被短暂占用）', () => {
  it('瞬时占用（EPERM / EBUSY）重试后成功', async () => {
    const stub = stubRename(['EPERM', 'EBUSY'])
    await renameWithRetry('a', 'b', stub.rename)
    expect(stub.calls).toBe(3)
  })

  it('一直占用就重试到上限再抛，不无限拖住写入', async () => {
    const stub = stubRename(['EPERM', 'EPERM', 'EPERM'])
    await expect(renameWithRetry('a', 'b', stub.rename, 3)).rejects.toThrow('EPERM')
    expect(stub.calls).toBe(3)
  })

  it('非瞬时错误立刻抛出，不重试也不掩盖真问题', async () => {
    const stub = stubRename(['ENOENT'])
    await expect(renameWithRetry('a', 'b', stub.rename)).rejects.toThrow('ENOENT')
    expect(stub.calls).toBe(1)
  })
})
