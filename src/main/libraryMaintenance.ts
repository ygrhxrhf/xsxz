import { AsyncLocalStorage } from 'node:async_hooks'

const restoreContext = new AsyncLocalStorage<boolean>()
let restoring = false
let activeWrites = 0

export function isLibraryRestoring(): boolean {
  return restoring
}

export function assertLibraryWritable(): void {
  if (restoring && !restoreContext.getStore()) throw new Error('书库正在恢复，请稍后再试')
}

export async function withLibraryWrite<T>(work: () => Promise<T>): Promise<T> {
  assertLibraryWritable()
  activeWrites++
  try {
    return await work()
  } finally {
    activeWrites--
  }
}

export function beginLibraryRestore(): () => void {
  if (restoring || activeWrites > 0) throw new Error('书库正在写入，请等待完成后再恢复')
  restoring = true
  return () => { restoring = false }
}

export function runAsLibraryRestore<T>(work: () => Promise<T>): Promise<T> {
  return restoreContext.run(true, work)
}
