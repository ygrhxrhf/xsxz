/**
 * 书中原图（每本书一张整幅地图图片）。
 *
 * 只接受位图并落在书目录的 `map/original.<ext>`，用 `file://` URL 交给渲染层显示；
 * 不写进 book.json，缺图就是空态，旧书不需要迁移。文件名固定，换图时清掉旧后缀，
 * 避免同一本书出现两张原图。
 */
import { access, cp, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bookDir, getBook } from './library'

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const
const MAX_BYTES = 8 * 1024 * 1024

export function mapImageExtension(sourcePath: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(String(sourcePath || '').trim())
  const ext = match?.[1]?.toLowerCase() ?? ''
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? ext : null
}

function pathFor(bookId: string, ext: string): string {
  return join(bookDir(bookId), 'map', `original.${ext}`)
}

export async function getMapImage(bookId: string): Promise<string | null> {
  for (const ext of IMAGE_EXTENSIONS) {
    const file = pathFor(bookId, ext)
    try {
      await access(file)
      return pathToFileURL(file).href
    } catch { /* 试下一个后缀 */ }
  }
  return null
}

export async function setMapImage(
  bookId: string,
  sourcePath: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const id = String(bookId || '').trim()
  if (!id) return { ok: false, message: '缺少书籍标识' }
  const source = String(sourcePath || '').trim()
  const ext = mapImageExtension(source)
  if (!ext) return { ok: false, message: '仅支持 jpg、png、webp' }
  let info
  try {
    info = await stat(source)
  } catch {
    return { ok: false, message: '图片文件不存在' }
  }
  if (!info.isFile()) return { ok: false, message: '图片文件不存在' }
  if (info.size > MAX_BYTES) return { ok: false, message: '地图图片不能超过 8MB' }
  try {
    await getBook(id)
  } catch {
    return { ok: false, message: '书不存在' }
  }

  const dir = join(bookDir(id), 'map')
  await mkdir(dir, { recursive: true })
  const dest = pathFor(id, ext)
  await cp(source, dest)
  for (const other of IMAGE_EXTENSIONS) {
    if (other === ext) continue
    await rm(pathFor(id, other), { force: true }).catch(() => {})
  }
  return { ok: true, url: pathToFileURL(dest).href }
}
