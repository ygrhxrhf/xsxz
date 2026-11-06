import { rm } from 'node:fs/promises'

/**
 * 删测试用的临时目录，带重试。
 *
 * Windows 上后台任务（原子写 + rename）落盘期间删目录会撞 ENOTEMPTY / EBUSY / EPERM，
 * 全量并行时更容易撞上：断言已经通过，清理却偶发红。删失败就等一会儿再删，
 * 别的错误码照旧抛出去——那说明是真有问题，不该被吞掉。
 */
export async function removeTempDir(directory: string, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const locked = code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM'
      if (!locked || attempt === attempts - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}
