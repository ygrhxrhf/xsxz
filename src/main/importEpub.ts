import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import JSZip from 'jszip'
import {
  bookExists,
  bookIdFromBytes,
  copyOriginFile,
  createBookFromBootstrap,
  refreshBookStatus,
  setCover,
  writeChaptersBatch,
} from './library'
import type { ChapterFile } from '../shared/types'

/** 段落级结束标签换成空行：直接按标签切会把每段切成一行，正文结构全丢。 */
const EPUB_BLOCK_END_RE = /<\/(?:p|div|h[1-6]|li|blockquote|section|article|tr|td|dd|dt)\s*>|<br\s*\/?>/gi

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
}

function stripXhtml(html: string): string {
  const withBreaks = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(EPUB_BLOCK_END_RE, '\n\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(withBreaks)
    .replace(/[ \t]*\n[ \t]*/g, '\n')
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

/** 从一个标签串里取属性值：`<item id="x" href="y">` 这类要按整标签解析。 */
function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)
  return m ? m[1] : null
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

function parseOpf(opf: string): {
  manifest: Record<string, string>
  spine: string[]
  title: string
  creator: string
  coverHref: string | null
} {
  // 按整标签解析：分别抓 id 列表和 href 列表时，只要有一个 item 缺属性，
  // 后面所有 id 就会和错误的 href 对上。
  const manifest: Record<string, string> = {}
  const itemRe = /<item\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(opf)) !== null) {
    const tag = m[0]
    const id = attrOf(tag, 'id')
    const href = attrOf(tag, 'href')
    if (id && href) manifest[id] = href
  }
  const idrefs = xmlAttr(opf, 'itemref', 'idref')
  const title = xmlTagText(opf, 'dc:title') || xmlTagText(opf, 'title') || ''
  const creator = xmlTagText(opf, 'dc:creator') || xmlTagText(opf, 'creator') || ''

  // 封面：epub2 用 <meta name="cover" content="id">，epub3 用 properties="cover-image"
  let coverHref: string | null = null
  const metaCover =
    /<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i.exec(opf)?.[0] ??
    /<meta\b[^>]*content\s*=\s*["'][^"']+["'][^>]*name\s*=\s*["']cover["'][^>]*>/i.exec(opf)?.[0]
  const coverId = metaCover ? attrOf(metaCover, 'content') : null
  if (coverId && manifest[coverId]) coverHref = manifest[coverId]
  if (!coverHref) {
    const propItem = /<item\b[^>]*properties\s*=\s*["'][^"']*cover-image[^"']*["'][^>]*>/i.exec(opf)?.[0]
    if (propItem) coverHref = attrOf(propItem, 'href')
  }
  return { manifest, spine: idrefs, title, creator, coverHref }
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
  const { manifest, spine, title, creator, coverHref } = parseOpf(opfXml)

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
  let chapterNo = 0
  for (let i = 0; i < spine.length; i++) {
    const href = manifest[spine[i]]
    if (!href) continue
    const fullPath = opfDir + href
    const file = zip.file(fullPath) || zip.file(href)
    if (!file) continue
    const xhtml = await file.async('text')
    const body = stripXhtml(xhtml)
    // 章号按「已生成的章节数」走，不用 spine 下标：跳过的插图页/空页会让章号断号
    const fallbackTitle = `第${chapterNo + 1}章`
    if (body.length < 10) {
      // 整页插图的章节以前被直接丢掉，导致正文跳号、插图消失：留一个占位
      if (!/<img\b/i.test(xhtml)) continue
      chapterNo++
      chapters.push({ title: titleForHref(byHref, href, fallbackTitle), body: '[插图]', status: 'ready' })
      continue
    }
    chapterNo++
    chapters.push({
      title: titleForHref(byHref, href, fallbackTitle),
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
  // 一次性批量落盘：逐章写会把同一份 book.json 反复读写
  await writeChaptersBatch(
    bookId,
    book.chapters.map((ch, i) => ({ chapterId: ch.id, file: chapters[i] as ChapterFile })),
  )
  await refreshBookStatus(bookId)
  await importEpubCover(zip, opfDir, coverHref, bookId)
  return { bookId }
}

/** epub 自带封面：解到临时文件再走既有的 setCover（书库页显示的封面来源）。 */
async function importEpubCover(
  zip: JSZip,
  opfDir: string,
  coverHref: string | null,
  bookId: string,
): Promise<void> {
  if (!coverHref) return
  const ext = (coverHref.match(/\.(jpe?g|png|webp)$/i) || [])[1]?.toLowerCase()
  if (!ext) return
  let tmp: string | null = null
  try {
    const file = zip.file(opfDir + coverHref) || zip.file(coverHref)
    const data = file ? await file.async('nodebuffer') : null
    if (!data || data.length === 0) return
    tmp = join(tmpdir(), `spbf-epub-cover-${Date.now()}.${ext === 'jpeg' ? 'jpg' : ext}`)
    await writeFile(tmp, data)
    await setCover({ bookId, sourcePath: tmp })
  } catch {
    /* 封面拿不到不影响导入 */
  } finally {
    if (tmp) await rm(tmp, { force: true }).catch(() => {})
  }
}
