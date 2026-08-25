import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import JSZip from 'jszip'
import { ensureLibrary, getLibraryPath, rebuildIndex } from './library'

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

export function backupFileName(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `spbf-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.zip`
  )
}

export async function createBackup(
  destDir: string,
): Promise<{ ok: true; path: string; files: number } | { ok: false; message: string }> {
  const dir = (destDir || '').trim()
  if (!dir) return { ok: false, message: '请选择备份保存目录' }

  const lib = getLibraryPath()
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

  try {
    await mkdir(dir, { recursive: true })
    const dest = join(dir, backupFileName())
    await writeFile(dest, buf)
    return { ok: true, path: dest, files: files.length }
  } catch (e: unknown) {
    return { ok: false, message: e instanceof Error ? `备份写入失败：${e.message}` : '备份写入失败' }
  }
}

export async function restoreBackup(
  zipPath: string,
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
  // 整库覆盖：先清空现有内容（__tmp__ 由 ensureLibrary 重建）
  try {
    for (const ent of await readdir(lib, { withFileTypes: true })) {
      if (ent.name === '__tmp__') continue
      await rm(join(lib, ent.name), { recursive: true, force: true })
    }
  } catch {
    /* 书库目录可能还不存在，交给后面的 mkdir */
  }

  let restored = 0
  const entries = Object.values(zip.files).filter((f) => !f.dir)
  for (const f of entries) {
    const norm = normalize(f.name).split('\\').join('/')
    if (norm.startsWith('..') || isAbsolute(norm)) continue
    const dest = join(lib, norm)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, await f.async('nodebuffer'))
    restored++
  }

  await ensureLibrary()
  const books = await rebuildIndex()
  return { ok: true, books: books.length, files: restored }
}
