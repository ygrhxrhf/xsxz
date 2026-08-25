import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { loadBook, readChapter } from './library'

export type ExportFormat = 'txt' | 'epub'

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

function bodyToXhtml(title: string, body: string): string {
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeXml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(title)}</title><meta charset="utf-8"/></head>
<body>
<h1>${escapeXml(title)}</h1>
${paras || '<p></p>'}
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

  await mkdir(dir, { recursive: true })
  const base = sanitizeExportName(book.title)
  if (format === 'txt') {
    const parts = [`《${book.title}》`, book.author ? `作者：${book.author}` : '', '']
    for (const ch of chunks) {
      parts.push(`## ${ch.title}`, '', ch.body.trim(), '')
    }
    const dest = join(dir, `${base}.txt`)
    await writeFile(dest, parts.join('\n'), 'utf-8')
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
  const spineItems: string[] = []
  const ncxPoints: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const id = `ch${String(i + 1).padStart(4, '0')}`
    const href = `${id}.xhtml`
    zip.file(`OEBPS/${href}`, bodyToXhtml(chunks[i].title, chunks[i].body))
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
