import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
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

const MIGRATE_STAGE_PREFIX = '.spbf-migrate-'
/** 搬迁进行中记录：写在旧库 __tmp__ 下（不进备份、不进搬迁副本），供崩溃后清理暂存目录。 */
const MIGRATION_MARKER = 'migration-stage.json'

function markerPath(libPath: string): string {
  return join(libPath, '__tmp__', MIGRATION_MARKER)
}

async function writeMigrationMarker(libPath: string, stage: string): Promise<void> {
  try {
    await mkdir(join(libPath, '__tmp__'), { recursive: true })
    await writeFile(markerPath(libPath), JSON.stringify({ stage }))
  } catch {
    /* 记不下就算了：这只影响崩溃后能否自动清理暂存目录，不影响搬迁本身 */
  }
}

async function clearMigrationMarker(libPath: string): Promise<void> {
  await rm(markerPath(libPath), { force: true }).catch(() => {})
}

/**
 * 启动兜底：搬迁若在 `rmdir(目标)` 与 `rename(暂存, 目标)` 之间被杀，会在暂存目录原地留下
 * 一个 `.spbf-migrate-*`。旧库始终完好（settings 尚未切换），这里按旧库里记下的暂存路径清残留，
 * 不动任何书库。找不到记录就什么也不做。返回清理掉的目录数。
 */
export async function cleanupInterruptedMigration(libPath = getLibraryPath()): Promise<number> {
  let stage = ''
  try {
    const raw = JSON.parse(await readFile(markerPath(libPath), 'utf-8')) as { stage?: unknown }
    if (typeof raw.stage === 'string' && basename(raw.stage).startsWith(MIGRATE_STAGE_PREFIX)) stage = raw.stage
  } catch {
    return 0
  }
  await clearMigrationMarker(libPath)
  if (!stage) return 0
  try {
    await rm(stage, { recursive: true, force: true })
    return 1
  } catch {
    return 0
  }
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
    // 记下暂存路径：万一在下一步 rmdir/rename 之间被杀，启动时能据此清理残留。
    await writeMigrationMarker(oldPath, stage)
    if (targetExists) await rmdir(newPath)
    await rename(stage, newPath)
    promoted = true
    await setLibraryPath(newPath)
    await updateSettings({ libraryPath: newPath })
    await clearMigrationMarker(oldPath)
    return { ok: true, oldPath, newPath, files: sourceFiles.length }
  } catch (error) {
    if (promoted) {
      await setLibraryPath(oldPath).catch(() => {})
      await rm(newPath, { recursive: true, force: true }).catch(() => {})
    }
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    if (targetExists) await mkdir(newPath, { recursive: true }).catch(() => {})
    await clearMigrationMarker(oldPath)
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
