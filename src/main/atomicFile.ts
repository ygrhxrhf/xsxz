import { open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withLibraryWrite } from './libraryMaintenance'

export interface AtomicWriteOptions {
  signal?: AbortSignal
  /** 仅供原子提交故障与取消测试注入；生产调用不传。 */
  hooks?: {
    beforeCommit?: () => void | Promise<void>
    rename?: (source: string, destination: string) => Promise<void>
  }
}

let beforeCommitForTests: ((filePath: string) => void | Promise<void>) | null = null

/** 仅供隔离的故障注入测试使用。 */
export function setAtomicWriteBeforeCommitForTests(hook: typeof beforeCommitForTests): void {
  beforeCommitForTests = hook
}

export async function atomicWriteText(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  return withLibraryWrite(async () => {
    const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(content, { encoding: 'utf-8' })
      await handle.sync()
      await handle.close()
      handle = undefined
      await options.hooks?.beforeCommit?.()
      await beforeCommitForTests?.(filePath)
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      await (options.hooks?.rename ?? rename)(temporaryPath, filePath)
    } catch (error: unknown) {
      await handle?.close().catch(() => {})
      await rm(temporaryPath, { force: true }).catch(() => {})
      throw error
    }
  })
}
