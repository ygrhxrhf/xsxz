import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import JSZip from 'jszip'
import {
  bookExists,
  bookIdFromBytes,
  copyOriginFile,
  createBookFromBootstrap,
  markChapterStatus,
  refreshBookStatus,
  writeChapterFile,
} from './library'
import type { ChapterFile } from '../shared/types'

function stripXhtml(html: string): string {
  return html
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

function normalizeHref(href: string): string {
  return href.split('#')[0].replace(/^\.\//, '').replace(/\\/g, '/')
}

async function findOpfPath(zip: JSZip): Promise<string> {
  const container = await zip.file('META-INF/container.xml')?.async('text')
  if (container) {
    const m = /full-path\s*=\s*"([^"]+)"/i.exec(container)
    if (m) return m[1]
  }
  const opf = zip.file(/\.opf$/i)[0]
  if (opf) return opf.name
  throw new Error('无法解析 epub：找不到 OPF')
}

function parseOpf(opf: string): { manifest: Record<string, string>; spine: string[]; title: string; creator: string } {
  const items = xmlAttr(opf, 'item', 'href')
  const ids = xmlAttr(opf, 'item', 'id')
  const manifest: Record<string, string> = {}
  for (let i = 0; i < ids.length; i++) {
    manifest[ids[i]] = items[i] || ''
  }
  const idrefs = xmlAttr(opf, 'itemref', 'idref')
  const title = xmlTagText(opf, 'dc:title') || xmlTagText(opf, 'title') || ''
  const creator = xmlTagText(opf, 'dc:creator') || xmlTagText(opf, 'creator') || ''
  return { manifest, spine: idrefs, title, creator }
}

function parseTocTitles(tocText: string): Map<string, string> {
  const byHref = new Map<string, string>()
  const ncx = /<navPoint[^>]*>[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content\s+src\s*=\s*"([^"]+)"[\s\S]*?<\/navPoint>/gi
  let m: RegExpExecArray | null
  while ((m = ncx.exec(tocText)) !== null) {
    const href = normalizeHref(m[2])
    if (href && !byHref.has(href)) byHref.set(href, m[1].trim())
  }
  const nav = /<a[^>]+href\s*=\s*"([^"]+)"[^>]*>([^<]+)<\/a>/gi
  while ((m = nav.exec(tocText)) !== null) {
    const href = normalizeHref(m[1])
    if (href && !byHref.has(href)) byHref.set(href, m[2].trim())
  }
  return byHref
}

function titleForHref(byHref: Map<string, string>, href: string, fallback: string): string {
  const key = normalizeHref(href)
  if (byHref.has(key)) return byHref.get(key)!
  const base = key.split('/').pop() || key
  for (const [h, title] of byHref) {
    if (h === base || h.endsWith('/' + base) || base === (h.split('/').pop() || h)) return title
  }
  return fallback
}

export async function importEpub(filePath: string): Promise<{ bookId: string }> {
  const buf = await readFile(filePath)
  const bytes = new Uint8Array(buf)
  const bookId = bookIdFromBytes(bytes)
  if (await bookExists(bookId)) {
    return { bookId }
  }

  const zip = await JSZip.loadAsync(buf)
  const opfPath = await findOpfPath(zip)
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : ''
  const opfXml = (await zip.file(opfPath)?.async('text')) || ''
  const { manifest, spine, title, creator } = parseOpf(opfXml)

  const byHref = new Map<string, string>()
  for (const href of Object.values(manifest)) {
    if (!/toc|nav|ncx/i.test(href)) continue
    const tocFile = zip.file(opfDir + href) || zip.file(href)
    if (!tocFile) continue
    const tocText = await tocFile.async('text')
    for (const [k, v] of parseTocTitles(tocText)) {
      if (!byHref.has(k)) byHref.set(k, v)
    }
  }

  const chapters: ChapterFile[] = []
  for (let i = 0; i < spine.length; i++) {
    const href = manifest[spine[i]]
    if (!href) continue
    const fullPath = opfDir + href
    const file = zip.file(fullPath) || zip.file(href)
    if (!file) continue
    const xhtml = await file.async('text')
    const body = stripXhtml(xhtml)
    if (body.length < 10) continue
    chapters.push({
      title: titleForHref(byHref, href, `第${i + 1}章`),
      body,
      status: 'ready',
    })
  }

  if (chapters.length === 0) throw new Error('epub 无可用章节')

  const book = await createBookFromBootstrap({
    bookId,
    title: title || basename(filePath, extname(filePath)),
    author: creator,
    importType: 'epub',
    chapterTitles: chapters.map((c) => c.title),
  })
  await copyOriginFile(bookId, filePath)
  for (let i = 0; i < chapters.length; i++) {
    const ch = book.chapters[i]
    await writeChapterFile(bookId, ch.id, chapters[i])
    await markChapterStatus(bookId, ch.id, 'ready')
  }
  await refreshBookStatus(bookId)
  return { bookId }
}
