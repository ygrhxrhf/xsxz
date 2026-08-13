import { readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { bookIdFromBytes, createBookFromBootstrap, writeChapterFile, markChapterReady } from './library'
import type { ChapterFile, ChapterStatus } from '../shared/types'

function stripXhtml(html: string): string {
  // strip scripts/styles
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text
}

function xmlAttr(xml: string, tag: string, attr: string): string[] {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}\\s*=\\s*["']([^"']+)["'][^>]*/?>`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1])
  }
  return out
}

function xmlTagText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(xml)
  return m ? m[1].trim() : null
}

async function findOpfPath(zip: JSZip): Promise<string> {
  const container = await zip.file('META-INF/container.xml')?.async('text')
  if (container) {
    const m = /full-path\s*=\s*"([^"]+)"/i.exec(container)
    if (m) return m[1]
  }
  // fallback: find first .opf
  const opf = zip.file(/\.opf$/i)[0]
  if (opf) return opf.name
  throw new Error('无法解析 epub：找不到 OPF')
}

function parseOpf(opf: string): { manifest: Record<string, string>; spine: string[]; title: string; creator: string } {
  const items = xmlAttr(opf, 'item', 'href')
  const ids = xmlAttr(opf, 'item', 'id')
  const medias = xmlAttr(opf, 'item', 'media-type')
  const manifest: Record<string, string> = {}
  for (let i = 0; i < ids.length; i++) {
    manifest[ids[i]] = items[i] || ''
  }
  const idrefs = xmlAttr(opf, 'itemref', 'idref')
  const title = xmlTagText(opf, 'dc:title') || xmlTagText(opf, 'title') || ''
  const creator = xmlTagText(opf, 'dc:creator') || xmlTagText(opf, 'creator') || ''
  return { manifest, spine: idrefs, title, creator }
}

function parseNcx(ncx: string): { title: string; href: string }[] {
  const out: { title: string; href: string }[] = []
  const re = /<navPoint[^>]*>[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content\s+src\s*=\s*"([^"]+)"[\s\S]*?<\/navPoint>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(ncx)) !== null) {
    out.push({ title: m[1].trim(), href: m[2].split('#')[0] })
  }
  return out
}

export async function importEpub(filePath: string): Promise<{ bookId: string }> {
  const buf = await readFile(filePath)
  const bytes = new Uint8Array(buf)
  const bookId = bookIdFromBytes(bytes)
  const zip = await JSZip.loadAsync(buf)

  const opfPath = await findOpfPath(zip)
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : ''
  const opfXml = (await zip.file(opfPath)?.async('text')) || ''
  const { manifest, spine, title, creator } = parseOpf(opfXml)

  // Try toc/nav/ncx for chapter titles
  let chapterTitles: string[] = []
  const tocEntry = Object.entries(manifest).find(([, href]) => href.includes('toc') || href.includes('nav'))
  if (tocEntry) {
    const tocFile = zip.file(opfDir + tocEntry[1])
    if (tocFile) {
      const tocText = await tocFile.async('text')
      if (tocText.includes('<navPoint')) {
        const ncx = parseNcx(tocText)
        chapterTitles = ncx.map((n) => n.title)
      }
      // nav.xhtml with <ol><li><a href=...>
      const navLinks = /<a[^>]+href\s*=\s*"([^"]+)"[^>]*>([^<]+)<\/a>/gi
      let nm: RegExpExecArray | null
      while ((nm = navLinks.exec(tocText)) !== null) {
        if (chapterTitles.length < spine.length) chapterTitles.push(nm[2].trim())
      }
    }
  }

  const chapters: ChapterFile[] = []
  for (let i = 0; i < spine.length; i++) {
    const idref = spine[i]
    const href = manifest[idref]
    if (!href) continue
    const fullPath = opfDir + href
    const file = zip.file(fullPath)
    if (!file) continue
    const xhtml = await file.async('text')
    const body = stripXhtml(xhtml)
    if (body.length < 10) continue
    const chTitle = chapterTitles[i] || `第${i + 1}章`
    chapters.push({ title: chTitle, body, status: 'ready' })
  }

  if (chapters.length === 0) throw new Error('epub 无可用章节')

  const book = await createBookFromBootstrap({
    bookId,
    title: title || basename(filePath, extname(filePath)),
    author: creator,
    importType: 'epub',
    chapterTitles: chapters.map((c) => c.title),
  })

  for (let i = 0; i < chapters.length; i++) {
    const ch = book.chapters[i]
    await writeChapterFile(bookId, ch.id, chapters[i])
    await markChapterReady(bookId, ch.id, 'ready')
  }

  return { bookId }
}
