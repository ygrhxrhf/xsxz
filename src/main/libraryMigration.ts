import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getLibraryPath, rebuildIndex, setLibraryPath } from './library'
import { updateSettings } from './settings'
import { validateStagedLibrary } from './backup'

async function filesUnder(root: string, rel = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    if (!rel && entry.name === '__tmp__') continue
    if (entry.isSymbolicLink()) throw new Error('书库包含符号链接，无法安全搬迁')
    const path = join(rel, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(root, path))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** 调用方须持有书库维护锁；旧目录始终保留。 */
export async function migrateLibrary(targetPath: string): Promise<
  { ok: true; oldPath: string; newPath: string; files: number } | { ok: false; message: string }
> {
  const oldPath = resolve(getLibraryPath())
  const newPath = resolve((targetPath || '').trim())
  if (!targetPath?.trim() || oldPath === newPath) return { ok: false, message: '请选择不同的目标目录' }
  const relativeToOld = relative(oldPath, newPath)
  const relativeToNew = relative(newPath, oldPath)
  if ((!relativeToOld.startsWith('..') && !isAbsolute(relativeToOld)) ||
      (!relativeToNew.startsWith('..') && !isAbsolute(relativeToNew))) {
    return { ok: false, message: '目标目录不能位于原书库内，原书库也不能位于目标目录内' }
  }
  let targetExists = false
  try {
    const target = await lstat(newPath)
    if (!target.isDirectory() || target.isSymbolicLink()) return { ok: false, message: '目标必须是普通空目录' }
    if ((await readdir(newPath)).length) return { ok: false, message: '目标目录必须为空' }
    targetExists = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, message: '目标目录不存在，请先选择空目录' }
    }
    return { ok: false, message: String(error) }
  }

  await rebuildIndex()
  const stage = join(dirname(newPath), `.spbf-migrate-${randomUUID()}`)
  let promoted = false
  try {
    await mkdir(dirname(newPath), { recursive: true })
    const sourceFiles = await filesUnder(oldPath)
    await cp(oldPath, stage, { recursive: true, force: false,
      filter: (path) => path === oldPath || relative(oldPath, path).split(/[\\/]/)[0] !== '__tmp__' })
    const stagedFiles = await filesUnder(stage)
    if (sourceFiles.length !== stagedFiles.length || sourceFiles.some((file, i) => file !== stagedFiles[i])) {
      throw new Error('复制后的文件列表不一致')
    }
    for (const file of sourceFiles) {
      if (await fileHash(join(oldPath, file)) !== await fileHash(join(stage, file))) {
        throw new Error(`文件校验失败：${file}`)
      }
    }
    await validateStagedLibrary(stage, true)
    if (targetExists) await rmdir(newPath)
    await rename(stage, newPath)
    promoted = true
    await setLibraryPath(newPath)
    await updateSettings({ libraryPath: newPath })
    return { ok: true, oldPath, newPath, files: sourceFiles.length }
  } catch (error) {
    if (promoted) {
      await setLibraryPath(oldPath).catch(() => {})
      await rm(newPath, { recursive: true, force: true }).catch(() => {})
    }
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    if (targetExists) await mkdir(newPath, { recursive: true }).catch(() => {})
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
