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

/** Windows 上 rename 撞到占用时给的错误码：目标或源正被别的句柄打开（杀软/索引服务扫描刚写的临时文件）。 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST'])

/**
 * 改名重试：Windows 上刚写完的临时文件常被杀毒或索引服务短暂占用，rename 会抛 EPERM，
 * 于是「原子写」偶发失败——书库索引、章节、标记都可能因此丢一次保存。这类占用是瞬时的，
 * 退避几毫秒重试即可；非瞬时错误（路径不存在等）立刻抛出，不掩盖真问题。
 *
 * `renameFn` 只为测试注入。
 */
export async function renameWithRetry(
  source: string,
  destination: string,
  renameFn: (from: string, to: string) => Promise<void> = rename,
  attempts = 5,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFn(source, destination)
      return
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? ''
      if (attempt >= attempts || !TRANSIENT_RENAME_CODES.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 15 * attempt))
    }
  }
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
      if (options.hooks?.rename) await options.hooks.rename(temporaryPath, filePath)
      else await renameWithRetry(temporaryPath, filePath)
    } catch (error: unknown) {
      await handle?.close().catch(() => {})
      await rm(temporaryPath, { force: true }).catch(() => {})
      throw error
    }
  })
}
