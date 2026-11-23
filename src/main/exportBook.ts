import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import JSZip from 'jszip'
import { getLibraryPath, loadBook, readChapter } from './library'
import { parseChapterImage } from '../shared/chapterImages'

type ExportFormat = 'txt' | 'epub'

export function sanitizeExportName(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 80) || '未命名'
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const IMAGE_MEDIA: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

interface ExportImageEntry {
  id: string
  href: string
}

interface ExportImagesContext {
  bookId: string
  zip: JSZip
  images: Map<string, ExportImageEntry>
  manifest: string[]
}

/** TXT 导出：图片没有承载位置，退化成一行可见说明，不把内部标记漏给用户。 */
function bodyToPlainText(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const image = parseChapterImage(part)
      return image ? `［图片：${image.caption || image.file}］` : part
    })
    .join('\n\n')
}

/**
 * 章节正文 → EPUB 的 XHTML。
 *
 * `[图]` 段落导出成 `<figure><img/><figcaption/>`，图片文件按需塞进 zip 并在
 * manifest 里登记；同一张图跨章只放一份。图片文件缺失时退化成一段说明文字，
 * 不让整章导出失败。
 */
async function bodyToXhtml(
  title: string,
  body: string,
  ctx: ExportImagesContext,
): Promise<string> {
  const paragraphs = body.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  const blocks: string[] = []
  for (const paragraph of paragraphs) {
    const image = parseChapterImage(paragraph)
    if (!image) {
      blocks.push(`<p>${escapeXml(paragraph).replace(/\n/g, '<br/>')}</p>`)
      continue
    }
    const ext = extname(image.file).toLowerCase()
    const mediaType = IMAGE_MEDIA[ext]
    let entry = mediaType ? ctx.images.get(image.file) : undefined
    if (!entry && mediaType) {
      try {
        const data = await readFile(join(getLibraryPath(), ctx.bookId, 'images', image.file))
        const id = `img${String(ctx.images.size + 1).padStart(3, '0')}`
        const href = `images/${image.file}`
        ctx.zip.file(`OEBPS/${href}`, data)
        ctx.manifest.push(`<item id="${id}" href="${href}" media-type="${mediaType}"/>`)
        entry = { id, href }
        ctx.images.set(image.file, entry)
      } catch {
        entry = undefined
      }
    }
    if (!entry) {
      blocks.push(`<p>［图片缺失：${escapeXml(image.caption || image.file)}］</p>`)
      continue
    }
    const caption = image.caption ? `<figcaption>${escapeXml(image.caption)}</figcaption>` : ''
    blocks.push(`<figure><img src="${entry.href}" alt="${escapeXml(image.caption || image.file)}"/>${caption}</figure>`)
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(title)}</title><meta charset="utf-8"/></head>
<body>
<h1>${escapeXml(title)}</h1>
${blocks.join('\n') || '<p></p>'}
</body>
</html>`
}

export async function exportBook(
  bookId: string,
  format: ExportFormat,
  destDir: string,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const dir = (destDir || '').trim()
  if (!dir) return { ok: false, message: '请选择导出目录' }
  if (format !== 'txt' && format !== 'epub') return { ok: false, message: '只支持导出 txt 或 epub' }

  let book
  try {
    book = await loadBook(bookId)
  } catch {
    return { ok: false, message: '找不到这本书' }
  }

  const ready = book.chapters.filter((c) => c.status === 'ready')
  if (ready.length === 0) return { ok: false, message: '没有可导出的章节' }

  const chunks: Array<{ title: string; body: string }> = []
  for (const ch of ready) {
    try {
      const file = await readChapter(bookId, ch.id)
      if (file.body && file.body.trim()) chunks.push({ title: file.title || ch.title, body: file.body })
    } catch {
      /* skip unreadable */
    }
  }
  if (chunks.length === 0) return { ok: false, message: '没有可导出的章节' }

  // 目录不存在就建；建不了（盘不在、无权限、路径被占）要给可执行的下一步，
  // 而不是把 ENOENT/EACCES 这种系统错误直接甩给用户。
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
    return { ok: false, message: `无法写入导出目录：${hint}。` }
  }
  const base = sanitizeExportName(book.title)
  if (format === 'txt') {
    const parts = [`《${book.title}》`, book.author ? `作者：${book.author}` : '', '']
    for (const ch of chunks) {
      parts.push(`## ${ch.title}`, '', bodyToPlainText(ch.body), '')
    }
    const dest = join(dir, `${base}.txt`)
    try {
      await writeFile(dest, parts.join('\n'), 'utf-8')
    } catch {
      return { ok: false, message: '导出文件写入失败，请确认目标目录可写后重试' }
    }
    return { ok: true, path: dest }
  }

  const dest = join(dir, `${base}.epub`)
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  )

  const manifestItems: string[] = []
  const imageManifest: string[] = []
  const imageContext: ExportImagesContext = { bookId, zip, images: new Map(), manifest: imageManifest }
  const spineItems: string[] = []
  const ncxPoints: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const id = `ch${String(i + 1).padStart(4, '0')}`
    const href = `${id}.xhtml`
    zip.file(`OEBPS/${href}`, await bodyToXhtml(chunks[i].title, chunks[i].body, imageContext))
    manifestItems.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`)
    spineItems.push(`<itemref idref="${id}"/>`)
    ncxPoints.push(
      `<navPoint id="${id}" playOrder="${i + 1}"><navLabel><text>${escapeXml(chunks[i].title)}</text></navLabel><content src="${href}"/></navPoint>`,
    )
  }

  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${escapeXml(book.id)}"/></head>
  <docTitle><text>${escapeXml(book.title)}</text></docTitle>
  <navMap>
    ${ncxPoints.join('\n    ')}
  </navMap>
</ncx>`,
  )
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(book.title)}</dc:title>
    <dc:creator>${escapeXml(book.author || '未知')}</dc:creator>
    <dc:language>zh</dc:language>
    <dc:identifier id="BookId">${escapeXml(book.id)}</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${manifestItems.join('\n    ')}
    ${imageManifest.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join('\n    ')}
  </spine>
</package>`,
  )

  const buf = await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' })
  await writeFile(dest, buf)
  return { ok: true, path: dest }
}
