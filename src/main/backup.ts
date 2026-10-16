import { mkdir, mkdtemp, readdir, readFile, writeFile, rm, rename, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { getLibraryPath, rebuildIndex } from './library'
import { getSettings, updateSettings } from './settings'

const SKIP_DIRS = new Set(['__trash__', '__tmp__'])

/** 收集书库下所有文件的相对路径；顶层跳过回收站与临时目录。 */
async function collectFiles(root: string, rel = ''): Promise<string[]> {
  const entries = await readdir(join(root, rel), { withFileTypes: true })
  const files: string[] = []
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (!rel && SKIP_DIRS.has(ent.name)) continue
      files.push(...(await collectFiles(root, join(rel, ent.name))))
    } else if (ent.isFile()) {
      files.push(join(rel, ent.name))
    }
  }
  return files
}

export function backupFileName(now = new Date(), automatic = false): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `spbf-${automatic ? 'auto' : 'backup'}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.zip`
  )
}

export async function createBackup(
  destDir: string,
  automatic = false,
): Promise<{ ok: true; path: string; files: number } | { ok: false; message: string }> {
  const dir = (destDir || '').trim()
  if (!dir) return { ok: false, message: '请选择备份保存目录' }

  const lib = getLibraryPath()
  const rel = relative(resolve(lib), resolve(dir))
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return { ok: false, message: '备份目录不能位于书库内' }
  }
  if ((await rebuildIndex()).length === 0) return { ok: false, message: '书库是空的，没有可备份的内容' }
  let files: string[]
  try {
    files = await collectFiles(lib)
  } catch {
    return { ok: false, message: '无法读取书库目录' }
  }
  if (files.length === 0) return { ok: false, message: '书库是空的，没有可备份的内容' }

  const zip = new JSZip()
  for (const rel of files) {
    zip.file(rel.split('\\').join('/'), await readFile(join(lib, rel)))
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' })

  // 目录不存在就建；建不了要给可执行的下一步，而不是把 ENOENT/EACCES 直接甩给用户。
  try {
    await mkdir(dir, { recursive: true })
  } catch (e: unknown) {
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: unknown }).code) : ''
    const hint = code === 'ENOENT'
      ? '目标盘或上级目录不存在，请先在文件管理器里创建该目录'
      : code === 'ENOTDIR'
        ? '路径中间有一段是文件而不是文件夹，请改选一个目录'
        : code === 'EACCES' || code === 'EPERM'
          ? '没有写入权限，请换一个有权限的目录（如「文档」或桌面）'
          : '请检查该目录是否可用'
    return { ok: false, message: `无法写入备份目录：${hint}。` }
  }

  try {
    const dest = join(dir, backupFileName(new Date(), automatic))
    const staged = `${dest}.${randomUUID()}.tmp`
    try {
      await writeFile(staged, buf)
      await rename(staged, dest)
    } catch (error) {
      await rm(staged, { force: true }).catch(() => {})
      throw error
    }
    return { ok: true, path: dest, files: files.length }
  } catch (e: unknown) {
    return { ok: false, message: e instanceof Error ? `备份写入失败：${e.message}` : '备份写入失败' }
  }
}

/** 仅删除本应用自动备份文件；手动备份及其它文件不受影响。 */
export async function pruneAutoBackups(destDir: string, keep = 5): Promise<void> {
  const names = (await readdir(destDir)).filter((name) => /^spbf-auto-\d{8}-\d{6}\.zip$/.test(name)).sort()
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    await rm(join(destDir, name), { force: true })
  }
}

export async function runAutoBackupIfDue(now = new Date()): Promise<
  { status: 'disabled' | 'notDue' | 'created' | 'failed'; message?: string }
> {
  const prefs = (await getSettings()).autoBackup
  if (!prefs?.destDir) return { status: 'disabled' }
  const last = Date.parse(prefs.lastSuccessAt)
  if (Number.isFinite(last) && now.getTime() - last < 7 * 24 * 60 * 60_000) return { status: 'notDue' }
  let result: Awaited<ReturnType<typeof createBackup>>
  try { result = await createBackup(prefs.destDir, true) }
  catch (error) { result = { ok: false, message: error instanceof Error ? error.message : String(error) } }
  if (!result.ok) {
    await updateSettings({ autoBackup: { lastError: result.message } })
    return { status: 'failed', message: result.message }
  }
  try { await pruneAutoBackups(prefs.destDir) }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateSettings({ autoBackup: { lastSuccessAt: now.toISOString(), lastError: `备份成功，但清理旧备份失败：${message}` } })
    return { status: 'failed', message }
  }
  await updateSettings({ autoBackup: { lastSuccessAt: now.toISOString(), lastError: '' } })
  return { status: 'created', message: result.path }
}

interface RestoreOptions {
  /** 仅供故障测试模拟目录切换失败。 */
  rename?: typeof rename
  /** 仅供故障测试模拟解压写入失败。 */
  beforeExtractWrite?: (relativePath: string) => void | Promise<void>
}

function safeZipPath(name: string): string | null {
  const segments = name.replaceAll('\\', '/').split('/')
  if (!name || name.includes('\0') || name.includes(':') ||
    segments.some((part) => part === '..' || part === '.' || !part) ||
    isAbsolute(name) || win32.isAbsolute(name)) return null
  const normalized = normalize(segments.join('/'))
  return normalized === '.' ? null : normalized
}

export async function validateStagedLibrary(root: string, allowEmpty = false): Promise<number> {
  const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf-8')) as unknown
  if (!index || typeof index !== 'object' || !('version' in index) || index.version !== 1 ||
    !('books' in index) || !Array.isArray(index.books)) throw new Error('索引格式无效')
  const entries = await readdir(root, { withFileTypes: true })
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('__'))
  if (directories.length === 0 && !allowEmpty) throw new Error('备份中没有书籍')
  const indexedIds = new Set<string>()
  for (const item of index.books as unknown[]) {
    if (!item || typeof item !== 'object' || !('id' in item) ||
      typeof item.id !== 'string' || indexedIds.has(item.id)) {
      throw new Error('索引中的书籍信息无效')
    }
    indexedIds.add(item.id)
  }
  if (indexedIds.size !== directories.length || directories.some((entry) => !indexedIds.has(entry.name))) {
    throw new Error('索引与书籍目录不一致')
  }
  for (const entry of directories) {
    const book = JSON.parse(await readFile(join(root, entry.name, 'book.json'), 'utf-8')) as unknown
    if (!book || typeof book !== 'object' || !('id' in book) || book.id !== entry.name ||
      !('title' in book) || typeof book.title !== 'string' ||
      !('chapters' in book) || !Array.isArray(book.chapters)) throw new Error(`书籍 ${entry.name} 的元数据无效`)
    const chapterIds = new Set<string>()
    for (const chapter of book.chapters as unknown[]) {
      if (!chapter || typeof chapter !== 'object' || !('id' in chapter) || !('file' in chapter) ||
        !('status' in chapter) || typeof chapter.id !== 'string' ||
        chapterIds.has(chapter.id) || typeof chapter.file !== 'string' ||
        !safeZipPath(chapter.file) || !chapter.file.startsWith('chapters/')) {
        throw new Error(`书籍 ${entry.name} 的章节路径无效`)
      }
      chapterIds.add(chapter.id)
      if (chapter.status !== 'ready') continue
      const file = JSON.parse(await readFile(join(root, entry.name, chapter.file), 'utf-8')) as unknown
      if (!file || typeof file !== 'object' || !('body' in file) || typeof file.body !== 'string') {
        throw new Error(`书籍 ${entry.name} 的章节正文无效`)
      }
    }
  }
  return directories.length
}

export async function restoreBackup(
  zipPath: string,
  options: RestoreOptions = {},
): Promise<{ ok: true; books: number; files: number } | { ok: false; message: string }> {
  if (!zipPath || !zipPath.toLowerCase().endsWith('.zip')) {
    return { ok: false, message: '请选择 .zip 备份文件' }
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(await readFile(zipPath))
  } catch {
    return { ok: false, message: '无法读取备份文件，请确认选择的是本软件导出的 zip' }
  }
  if (!zip.file('index.json')) {
    return { ok: false, message: '这不是有效的书库备份（缺少 index.json）' }
  }
  const lib = getLibraryPath()
  const parent = dirname(lib)
  const previous = join(parent, `.spbf-previous-${randomUUID()}`)
  let staged = ''
  let movedOld = false
  let switched = false
  const move = options.rename ?? rename
  try {
    await mkdir(parent, { recursive: true })
    staged = await mkdtemp(join(parent, '.spbf-restore-'))
    const entries = Object.values(zip.files).filter((file) => !file.dir)
    for (const file of entries) {
      const originalName = 'unsafeOriginalName' in file && typeof file.unsafeOriginalName === 'string'
        ? file.unsafeOriginalName : file.name
      const rel = safeZipPath(originalName)
      const topLevel = rel?.split(/[\\/]/)[0]
      if (!rel || !safeZipPath(file.name) || rel !== safeZipPath(file.name) ||
        topLevel === '__trash__' || topLevel === '__tmp__') {
        throw new Error('备份包含不安全的文件路径')
      }
      const dest = join(staged, rel)
      await options.beforeExtractWrite?.(rel)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, await file.async('nodebuffer'))
    }
    const count = await validateStagedLibrary(staged)
    await mkdir(join(staged, '__tmp__'), { recursive: true })
    try {
      await stat(lib)
      await move(lib, previous)
      movedOld = true
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await move(staged, lib)
    switched = true
    await rebuildIndex()
    if (movedOld) {
      await rm(previous, { recursive: true, force: true }).catch((error: unknown) => {
        console.warn('恢复已完成，但旧书库临时目录清理失败：', previous, error)
      })
    }
    return { ok: true, books: count, files: entries.length }
  } catch (error: unknown) {
    if (movedOld) {
      try {
        if (switched) await move(lib, staged)
        await move(previous, lib)
      } catch {
        return { ok: false, message: `恢复失败且自动回滚未完成；原书库保存在 ${previous}` }
      }
    } else if (switched) {
      await rm(lib, { recursive: true, force: true }).catch(() => {})
    }
    return { ok: false, message: `恢复失败，原书库未改动：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    if (staged) await rm(staged, { recursive: true, force: true }).catch(() => {})
  }
}
