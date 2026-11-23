/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/book/layout.ts，Apache-2.0。已修改：去掉 .ts 扩展名引用、内联 i18n/笔记
 * Markdown 的最小替身，以接入 spbf 的真实书籍页面纹理。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import { inlineImageFootnotes } from './imageFootnotes'
import { getLocale, t } from './i18n'
import { noteFontFamily } from './noteFontCatalog'
import type { FontAsset } from './fontCatalog'
import type { Align, Block, BlockKind, Footnote, ParsedBook } from './types'
import { isSourceQuote } from './typography'
import { noteLayoutSignature, noteTextColorOf, type Annotation, type Locator, type NoteTextColor } from './annotations'

/** 与参考站 noteMarkdown.ts 的 NoteRun/NoteBlock 同形的最小类型（笔记 Markdown 排版）。 */
interface NoteRun {
  text: string
  bold?: boolean
  italic?: boolean
  mono?: boolean
  sup?: boolean
  strike?: boolean
  code?: boolean
  href?: string
  footnote?: Footnote
}

interface NoteBlock {
  kind: 'p' | 'heading' | 'code' | 'quote' | 'list' | 'rule' | 'table'
  runs?: NoteRun[]
  text?: string
  heading?: number
  indent: number
  /** 引用深度；上游 Markdown 解析会给数字，纯文本笔记给 0。 */
  quote: number
  marker?: string
  cells?: NoteRun[][]
  align?: Align[]
  tableHeader?: boolean
}

export interface LayoutConfig {
  /** A continuous single-page sequence, without spread padding. */
  singlePage?: boolean
  pageW: number
  pageH: number
  marginTop: number
  marginBottom: number
  marginInner: number
  marginOuter: number
  fontSize: number
  lineHeight: number
  family: string
  /** Absent means source quotations inherit the body font. */
  quoteFamily?: string
}

const CJK_FAMILIES =
  '"Noto Serif SC", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "STSong", "SimSun", "Noto Serif CJK JP", "Hiragino Mincho ProN", "Noto Serif KR", "Microsoft YaHei", "WenQuanYi Micro Hei", "Droid Sans Fallback"'
const SERIF_STACK = `"EB Garamond Variable", "Iowan Old Style", Georgia, ${CJK_FAMILIES}, serif`

const DEFAULT_LAYOUT: LayoutConfig = {
  pageW: 640,
  pageH: 920,
  marginTop: 78,
  marginBottom: 100,
  marginInner: 80,
  marginOuter: 58,
  fontSize: 22,
  lineHeight: 1.5,
  family: SERIF_STACK,
}

export interface Word {
  /** Clickable tag identity for note ink; never a source-text offset. */
  noteTag?: string
  noteLink?: string
  noteStrike?: boolean
  noteCode?: boolean
  footnote?: Footnote
  text: string
  x: number
  w: number
  font: string
  /** offsets inside chapter text */
  s: number
  e: number
  sup?: boolean
  smallcaps?: boolean
  /** trailing space belongs to the word (for copy/paste) */
  space: boolean
  size: number
}

export interface NoteDecoration {
  quoteX?: number
  background?: { x: number; w: number }
  rule?: { x: number; w: number }
  cells?: { x: number; w: number }[]
  tableTop?: boolean
  tableBottom?: boolean
}

export interface Line {
  noteDecoration?: NoteDecoration
  /** Source blockquote wash/rule in page-content coordinates; does not affect text layout. */
  quoteDecoration?: { x: number; w: number }
  /** top of the line box, relative to page content top */
  y: number
  h: number
  baseline: number
  words: Word[]
  tone?: 'literary' | 'attribution'
}

export interface PlacedImage {
  path: string
  x: number
  y: number
  w: number
  h: number
  alt: string
}

/** A note fragment belongs to its annotation, never to the source chapter text. */
export interface PlacedInlineNote {
  id: string
  locator: Locator
  x: number
  y: number
  w: number
  h: number
  /** Positions are relative to this fragment, including its text inset and label. */
  lines: Line[]
  continued: boolean
  continues: boolean
  textColor: NoteTextColor
}

export interface Page {
  index: number
  chapter: number
  chapterTitle: string
  lines: Line[]
  images: PlacedImage[]
  rules: { x: number; y: number; w: number }[]
  notes?: PlacedInlineNote[]
  /** chapter text range covered by this page */
  start: number
  end: number
  chapterStart: boolean
  /** page is intentionally blank (padding) */
  blank?: boolean
  label: string
  special?: 'title' | 'blank'
}

export interface Paginated {
  /** Snapshot of the note content actually used to lay out these pages. */
  noteSignature: string
  fonts?: FontAsset[]
  pages: Page[]
  config: LayoutConfig
  chapterFirstPage: number[]
  /** page index for block (chapter, block) */
  pageForOffset(chapter: number, offset: number): number
}

interface ChapterLayout { noteSignature: string; pages: Page[] }
interface PaginationCache {
  book: ParsedBook
  configKey: string
  locale: string
  definitions: string
  chapters: ChapterLayout[]
}

// Keep reusable chapter geometry out of serializable pagination/worker payloads.
const paginationCaches = new WeakMap<Paginated, PaginationCache>()

interface Token {
  footnote?: Footnote
  text: string
  w: number
  font: string
  s: number
  e: number
  space: boolean
  spaceW: number
  sup?: boolean
  smallcaps?: boolean
  size: number
  breakAfter: boolean
  cjk: boolean
  /** extra visual gap after the token (Latin <-> CJK boundaries) that is not part of the text */
  gap: number
  hang: boolean
}

const CJK_RE = /[\u2e80-\u312f\u3190-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u{20000}-\u{3134f}]/u
const CJK_QUOTES = /[\u201c\u201d\u2018\u2019\u2014\u2026\u00b7]/u
const NO_START = new Set(Array.from('，。、；：！？）」』》〉】〕］｝”’…—·ーゝゞ々！？．｡､,.;:!?)]}%‰ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ'))
const NO_END = new Set(Array.from('（「『《〈【〔［｛“‘(［[{·'))
const CLOSING = new Set(Array.from('，。、；：！？）」』》〉】〕］｝”’．'))
const HANGABLE = new Set(Array.from('，。、；：！？．｡､'))
const FW_PUNCT = /[\u3000-\u303f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/

const firstCh = (t: string) => String.fromCodePoint(t.codePointAt(0)!)
const lastCh = (t: string) => {
  const a = Array.from(t)
  return a[a.length - 1]
}

const isPunctCh = (ch: string) => NO_START.has(ch) || NO_END.has(ch) || FW_PUNCT.test(ch)

function cjkRatio(text: string) {
  let c = 0
  let n = 0
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    n++
    if (CJK_RE.test(ch)) c++
  }
  return n ? c / n : 0
}

function canBreakAfter(t: Token, nx: Token | undefined) {
  if (!nx || t.text === '\n') return true
  if (nx.footnote) return false
  if (t.space || t.breakAfter) return true
  if (!t.cjk && !nx.cjk) return false
  if (NO_START.has(firstCh(nx.text))) return false
  if (NO_END.has(lastCh(t.text))) return false
  if (t.cjk && nx.cjk && t.text === nx.text && (t.text === '—' || t.text === '…')) return false
  return true
}

type MeasureCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
let measureCtx: MeasureCtx | null = null
function ctx2d() {
  if (!measureCtx) {
    measureCtx =
      typeof document !== 'undefined'
        ? document.createElement('canvas').getContext('2d')!
        : (new OffscreenCanvas(1, 1).getContext('2d') as OffscreenCanvasRenderingContext2D)
  }
  return measureCtx
}

const widthCache = new Map<string, number>()
export function measure(font: string, text: string) {
  const key = font + '|' + text
  let w = widthCache.get(key)
  if (w === undefined) {
    const c = ctx2d()
    c.font = font
    w = c.measureText(text).width
    if (widthCache.size > 60000) widthCache.clear()
    widthCache.set(key, w)
  }
  return w
}

function fontString(cfg: LayoutConfig, size: number, run: { bold?: boolean; italic?: boolean; mono?: boolean; weight?: number }) {
  const weight = run.weight ?? (run.bold ? 650 : 440)
  const fam = run.mono ? 'ui-monospace, "SF Mono", Menlo, monospace' : cfg.family
  return `${run.italic ? 'italic ' : ''}${weight} ${size}px ${fam}`
}

interface BlockStyle {
  size: number
  weight?: number
  italic?: boolean
  align: Align
  before: number
  after: number
  indentFirst: number
  leftPad: number
  rightPad: number
  lineH: number
  letterCase?: 'upper'
}

function styleFor(kind: BlockKind, b: Block, cfg: LayoutConfig, prevKind: BlockKind | null, firstInChapter: boolean, cjk: boolean): BlockStyle {
  const fs = cfg.fontSize
  const lh = fs * cfg.lineHeight * (cjk ? 1.16 : 1)
  if (b.chapterHeading) {
    const title = b.chapterHeading === 'title'
    return { size: fs * (title ? 1.5 : 0.85), weight: title ? 560 : 440, align: 'center',
      before: title ? 0 : fs * 0.8, after: fs * (title ? 1.2 : 0.45),
      indentFirst: 0, leftPad: fs * 0.5, rightPad: fs * 0.5, lineH: fs * (title ? 2 : 1.2) }
  }
  if (b.literary) {
    const { role, first, last } = b.literary
    const attribution = role === 'attribution'
    return {
      size: fs * (attribution ? 0.84 : role === 'quote' ? 0.9 : 0.95),
      align: attribution ? 'right' : b.align ?? 'left',
      before: attribution ? fs * 0.45 : first ? fs * 0.7 : 0,
      after: last ? fs * 1.2 : 0,
      indentFirst: 0, leftPad: fs * 1.5, rightPad: fs * 1.5,
      lineH: lh * (attribution ? 0.88 : role === 'quote' ? 0.84 : 0.98),
    }
  }
  switch (kind) {
    case 'h1':
      return { size: fs * 1.75, weight: 520, align: b.align ?? 'center', before: firstInChapter ? 70 : 40, after: 34, indentFirst: 0, leftPad: 0, rightPad: 0, lineH: fs * 1.75 * 1.25 }
    case 'h2':
      return { size: fs * 1.45, weight: 520, align: b.align ?? 'center', before: firstInChapter ? 64 : 34, after: 28, indentFirst: 0, leftPad: 0, rightPad: 0, lineH: fs * 1.45 * 1.3 }
    case 'h3':
      return { size: fs * 1.12, weight: 560, italic: true, align: b.align ?? 'center', before: 22, after: 14, indentFirst: 0, leftPad: 0, rightPad: 0, lineH: lh }
    case 'quote':
      return { size: fs * 0.9, italic: false, align: b.align ?? 'justify', before: prevKind === 'quote' ? 0 : 8, after: 8, indentFirst: 0, leftPad: fs * 1.6, rightPad: fs * 0.8, lineH: lh * 0.84 }
    case 'li':
      return { size: fs, align: b.align ?? 'left', before: 0, after: 4, indentFirst: 0, leftPad: fs * 1.6, rightPad: 0, lineH: lh }
    case 'pre':
      return { size: fs * 0.82, align: 'left', before: 8, after: 8, indentFirst: 0, leftPad: 0, rightPad: 0, lineH: lh * 0.9 }
    default: {
      if (prevKind === 'img' && b.text.length < 90 && b.align !== 'left') {
        return { size: fs * 0.8, align: 'center', before: 0, after: 14, indentFirst: 0, leftPad: fs * 1.2, rightPad: fs * 1.2, lineH: lh * 0.92 }
      }
      if (cjk) {
        const noIndent = b.noIndent || b.align === 'center' || b.align === 'right'
        return { size: fs, align: b.align ?? 'justify', before: 0, after: 0, indentFirst: noIndent ? 0 : fs * 2, leftPad: 0, rightPad: 0, lineH: lh }
      }
      const noIndent = b.noIndent || firstInChapter || prevKind === null || /^h[1-3]$/.test(prevKind) || prevKind === 'hr' || prevKind === 'img'
      return { size: fs, align: b.align ?? 'justify', before: 0, after: 0, indentFirst: b.align === 'center' || noIndent ? 0 : fs * 1.5, leftPad: 0, rightPad: 0, lineH: lh }
    }
  }
}

function tokenize(b: Block, st: BlockStyle, cfg: LayoutConfig, avail: number, cjkBlock: boolean): Token[] {
  const quote = isSourceQuote(b) && b.kind !== 'pre'
  if (cfg.quoteFamily && quote) cfg = { ...cfg, family: cfg.quoteFamily }
  const tokens: Token[] = []
  let offset = b.start
  const baseItalic = st.italic
  const isCjkCh = (ch: string) => CJK_RE.test(ch) || (cjkBlock && CJK_QUOTES.test(ch))
  for (const run of b.runs) {
    if (run.footnote) {
      const size = st.size * 0.82
      tokens.push({ text: run.text, footnote: run.footnote, w: size + 4, font: fontString(cfg, size, {}), s: offset, e: offset + run.text.length, space: false, spaceW: 0, size, breakAfter: true, cjk: true, gap: 0, hang: false })
      offset += run.text.length
      continue
    }
    const size = run.sup ? st.size * 0.62 : st.size
    const smallcaps = run.smallcaps
    const font = fontString(cfg, size, { bold: run.bold, italic: run.italic || baseItalic || (quote && !run.mono), mono: run.mono, weight: run.bold ? 660 : st.weight })
    const text = run.text
    const f = smallcaps ? font.replace(/(\d+(\.\d+)?)px/, (_, n) => `${(parseFloat(n) * 0.82).toFixed(2)}px`) : font
    const push = (display: string, s: number, e: number, cjk: boolean, breakAfter: boolean) => {
      const shown = smallcaps ? display.toUpperCase() : display
      const w = measure(f, shown)
      // a lone token wider than the column is chopped so nothing can ever spill out of the page box
      if (w > avail && !cjk && shown.length > 1) {
        let from = 0
        let po = s
        const chars = Array.from(shown)
        while (from < chars.length) {
          let to = from + 1
          while (to < chars.length && measure(f, chars.slice(from, to + 1).join('')) <= avail) to++
          const chunk = chars.slice(from, to).join('')
          const last = to >= chars.length
          tokens.push({ text: chunk, w: measure(f, chunk), font: f, s: po, e: po + chunk.length, space: false, spaceW: 0, sup: run.sup, smallcaps, size, breakAfter: last ? breakAfter : true, cjk: false, gap: 0, hang: false })
          po += chunk.length
          from = to
        }
        return
      }
      tokens.push({ text: shown, w, font: f, s, e, space: false, spaceW: 0, sup: run.sup, smallcaps, size, breakAfter, cjk, gap: 0, hang: cjk && HANGABLE.has(shown) })
    }
    const breaks = new Map<number, number>()
    for (const at of run.breaks ?? []) breaks.set(at, (breaks.get(at) ?? 0) + 1)
    const hardBreak = (at: number) => tokens.push({
      text: '\n', w: 0, font: f, s: at, e: at, space: false, spaceW: 0,
      size, breakAfter: true, cjk: false, gap: 0, hang: false,
    })
    let i = 0
    while (i < text.length) {
      for (let k = 0; k < (breaks.get(i) ?? 0); k++) hardBreak(offset + i)
      const cp = text.codePointAt(i)!
      const ch = String.fromCodePoint(cp)
      const start = offset + i
      if (b.kind === 'pre' && ch === '\n') {
        hardBreak(start)
        i++
        continue
      }
      if (/\s/.test(ch)) {
        let j = i
        while (j < text.length && /\s/.test(text[j]) && (j === i || !breaks.has(j)) && !(b.kind === 'pre' && text[j] === '\n')) j++
        const prev = tokens[tokens.length - 1]
        if (prev && prev.text !== '\n' && !prev.space) {
          prev.space = true
          prev.spaceW = measure(prev.font, ' ')
          prev.e = Math.min(prev.e + (j - i), offset + j)
        }
        i = j
        continue
      }
      if (isCjkCh(ch)) {
        push(ch, start, start + ch.length, true, false)
        i += ch.length
        continue
      }
      let j = i
      while (j < text.length) {
        const c2 = String.fromCodePoint(text.codePointAt(j)!)
        if (/\s/.test(c2) || isCjkCh(c2) || (j > i && breaks.has(j))) break
        j += c2.length
      }
      const piece = text.slice(i, j)
      // split long words after hyphens / dashes so they can wrap
      const long = piece.length > 28
      const parts = (long ? piece.match(/[^-–—/._?&=]+[-–—/._?&=]?|[-–—/._?&=]+/g) : piece.match(/[^-–—]+[-–—]?|[-–—]+/g)) || [piece]
      let po = start
      for (let k = 0; k < parts.length; k++) {
        push(parts[k], po, po + parts[k].length, false, k < parts.length - 1)
        po += parts[k].length
      }
      i = j
    }
    for (let k = 0; k < (breaks.get(text.length) ?? 0); k++) hardBreak(offset + text.length)
    offset += text.length
  }
  // thin optical gap where Latin/numerals meet ideographs without a space
  for (let k = 0; k < tokens.length - 1; k++) {
    const a = tokens[k]
    const n = tokens[k + 1]
    if (a.text === '\n' || n.text === '\n' || a.space || a.cjk === n.cjk) continue
    const cjkSide = a.cjk ? a : n
    if (isPunctCh(firstCh(cjkSide.text))) continue
    const latinEdge = a.cjk ? firstCh(n.text) : lastCh(a.text)
    if (/[A-Za-z0-9%]/.test(latinEdge)) a.gap = Math.min(a.size, n.size) * 0.2
  }
  return tokens
}

interface LaidLine {
  noteDecoration?: NoteDecoration
  words: Word[]
  h: number
  baseline: number
  gap: number
}

function gapWeight(t: Token, nx: Token) {
  if (nx.footnote) return 0
  if (NO_START.has(firstCh(nx.text)) && (t.cjk || nx.cjk)) return 0
  if (NO_END.has(lastCh(t.text)) && (t.cjk || nx.cjk)) return 0
  if (t.cjk && nx.cjk && t.text === nx.text && (t.text === '—' || t.text === '…')) return 0
  if (t.space) return 1
  if (t.cjk && CLOSING.has(t.text)) return 0
  if (t.cjk || nx.cjk) return 1
  return 0
}

function breakLines(tokens: Token[], st: BlockStyle, maxW: number, cfg: LayoutConfig, marker?: string): LaidLine[] {
  const lines: LaidLine[] = []
  const n = tokens.length
  const canBreak = tokens.map((t, idx) => canBreakAfter(t, tokens[idx + 1]))
  let i = 0
  let first = true
  const indentX = st.leftPad
  while (i < n) {
    const avail = maxW - st.leftPad - st.rightPad - (first ? st.indentFirst : 0)
    let width = 0
    let j = i
    let lastBreak = -1
    let hung = false
    while (j < n) {
      const t = tokens[j]
      if (j > i && width + t.w > avail + 0.01) {
        // closing punctuation may hang past the measure into the margin
        if (t.hang && width <= avail + 0.01) {
          width += t.w
          j++
          hung = true
        }
        break
      }
      width += t.w + (t.space ? t.spaceW : 0) + t.gap
      if (canBreak[j]) lastBreak = j
      j++
      if (t.text === '\n') break
    }
    let end: number
    if (j >= n) end = n
    else if (hung && canBreak[j - 1]) end = j
    else {
      hung = false
      end = canBreak[j - 1] ? j : lastBreak >= i ? lastBreak + 1 : j
    }
    if (end === i) end = i + 1
    const hardEnd = tokens[end - 1].text === '\n'
    const slice = tokens.slice(i, hardEnd ? end - 1 : end)
    const m = slice.length
    const lastOfPara = end >= n || hardEnd
    const hungTok = hung && end === j ? slice[m - 1] : null
    let natural = 0
    let units = 0
    const weights: number[] = []
    for (let k = 0; k < m; k++) {
      const t = slice[k]
      natural += t.w
      if (k < m - 1) {
        natural += (t.space ? t.spaceW : 0) + t.gap
        const wgt = hungTok && k === m - 2 ? 0 : gapWeight(t, slice[k + 1])
        weights.push(wgt)
        units += wgt
      }
    }
    const fitW = natural - (hungTok ? hungTok.w : 0)
    let extra = 0
    let startX = indentX + (first ? st.indentFirst : 0)
    if (st.align === 'justify' && !lastOfPara && units > 0) {
      extra = Math.min((avail - fitW) / units, st.size * 0.55)
      if (extra < -2) extra = -2
    } else if (st.align === 'center') startX += Math.max(0, (avail - fitW) / 2)
    else if (st.align === 'right') startX += Math.max(0, avail - fitW)
    const words: Word[] = []
    let x = startX
    if (marker && first) {
      words.push({ text: marker, x: indentX - cfg.fontSize * 1.3, w: measure(fontString(cfg, st.size, {}), marker), font: fontString(cfg, st.size, {}), s: -1, e: -1, space: false, size: st.size })
    }
    slice.forEach((t, idx) => {
      const isLast = idx === m - 1
      if (t.text !== '\n') {
        words.push({ footnote: t.footnote, text: t.text, x, w: t.w, font: t.font, s: t.s, e: t.e, sup: t.sup, smallcaps: t.smallcaps, space: t.space && !isLast, size: t.size })
      }
      if (!isLast) x += t.w + (t.space ? t.spaceW : 0) + t.gap + weights[idx] * extra
    })
    lines.push({ words, h: st.lineH, baseline: st.lineH * 0.5 + st.size * 0.32, gap: 0 })
    i = end
    first = false
  }
  return lines
}

export async function paginate(
  book: ParsedBook,
  cfg: LayoutConfig = DEFAULT_LAYOUT,
  onProgress?: (p: number) => void,
  annotations: readonly Annotation[] = [],
  previous?: Paginated,
): Promise<Paginated> {
  const contentW = cfg.pageW - cfg.marginInner - cfg.marginOuter
  const contentH = cfg.pageH - cfg.marginTop - cfg.marginBottom
  const pages: Page[] = []
  const chapterFirstPage: number[] = []
  const imageSizes = new Map<string, { w: number; h: number }>()
  const configKey = JSON.stringify(cfg), locale = getLocale()
  const prior = previous && paginationCaches.get(previous)
  const reusable = prior?.book === book && prior.configKey === configKey && prior.locale === locale ? prior : undefined
  const chapters: ChapterLayout[] = []
  const notes = annotations.filter((a) => a.note && Number.isInteger(a.locator.chapter) &&
    Number.isInteger(a.locator.start) && Number.isInteger(a.locator.end) && a.locator.start >= 0 &&
    a.locator.end > a.locator.start && a.locator.end <= (book.chapters[a.locator.chapter]?.textLength ?? 0))
    .slice().sort((a, b) => a.locator.start - b.locator.start || a.createdAt - b.createdAt || a.id.localeCompare(b.id))

  const notesByChapter = new Map<number, Annotation[]>()
  for (const note of notes) {
    const group = notesByChapter.get(note.locator.chapter) ?? []
    group.push(note)
    notesByChapter.set(note.locator.chapter, group)
  }

  // The paint worker imports layout metrics but must not load DOM-based Markdown dependencies.
  // spbf 的批注正文按纯文本排版：不解析 Markdown，只按空行分段落、段内保留换行。
  const markdown = (source: string): NoteBlock[] => source
    .split(/\n{2,}/)
    .map((paragraph) => ({
      kind: 'p' as const,
      runs: [{ text: paragraph.replace(/\n/g, ' ') }],
      text: paragraph.replace(/\n/g, ' '),
      indent: 0,
      quote: 0,
    }))
    .filter((block) => block.text.length > 0)

  let page: Page | null = null
  let cursor = 0

  const newPage = (chapter: number, start: number, chapterStart: boolean) => {
    page = {
      index: pages.length,
      chapter,
      chapterTitle: book.chapters[chapter].title,
      lines: [],
      images: [],
      rules: [],
      start,
      end: start,
      chapterStart,
      label: '',
    }
    pages.push(page)
    cursor = 0
    return page
  }

  const front = (special: 'title' | 'blank'): Page => ({
    index: pages.length, chapter: 0, chapterTitle: '', lines: [], images: [], rules: [], start: 0, end: 0,
    chapterStart: false, label: '', special,
  })
  pages.push(front('title'))
  if (!cfg.singlePage) pages.push(front('blank'))
  const contentStart = pages.length

  const placeNote = (a: Annotation) => {
    const noteConfig = { ...cfg, family: noteFontFamily(a.note!.font, cfg.family) }
    const inset = cfg.fontSize * 0.65
    const width = contentW - inset * 2
    const padding = cfg.fontSize * 0.65
    const header = cfg.fontSize * 1.05
    const footer = cfg.fontSize * 0.35
    const gap = cfg.fontSize * 0.5
    const noteStyle: BlockStyle = {
      size: cfg.fontSize * 0.84, align: 'left', before: 0, after: 0,
      indentFirst: 0, leftPad: padding, rightPad: padding,
      lineH: cfg.fontSize * 1.38,
    }
    const rows: LaidLine[] = []
    const layRuns = (runs: NoteRun[], st: BlockStyle, code = false): LaidLine[] => {
      const text = runs.map(run => run.text).join('')
      const block: Block = { kind: 'pre', text, start: 0, runs }
      const available = Math.max(st.size, width - st.leftPad - st.rightPad)
      const leading = code ? /^ */.exec(text)![0].length : 0
      const codeIndent = Math.min(measure(fontString(noteConfig, st.size, { mono: true }), ' '.repeat(leading)), available / 2)
      const tokens = tokenize(block, st, noteConfig, available - codeIndent, cjkRatio(text) >= 0.2)
      for (const token of tokens) token.hang = false
      if (code) {
        // Preserve code indentation and repeated spaces, unlike prose typography.
        st = { ...st, indentFirst: codeIndent }
        for (const token of tokens) if (token.space) {
          const whitespace = / +$/.exec(text.slice(token.s, token.e))?.[0] ?? ' '
          token.spaceW = measure(token.font, whitespace)
        }
      }
      const lines = breakLines(tokens, st, width, noteConfig)
      if (!lines.length) lines.push({ words: [], h: st.lineH, baseline: st.lineH * 0.8, gap: 0 })
      let offset = 0
      const spans = runs.map(run => { const start = offset; offset += run.text.length; return { run, start, end: offset } })
      return lines.map(line => ({ ...line, words: line.words.map(word => {
        const run = spans.find(span => word.s >= span.start && word.s < span.end)?.run
        return { ...word, noteLink: run?.href, noteStrike: run?.strike, noteCode: run?.code, s: -1, e: -1 }
      }) }))
    }
    const appendBlock = (block: NoteBlock) => {
      const indent = Math.min((block.indent + block.quote) * noteStyle.size * 1.25, (width - padding * 2) * 0.4)
      const markerWidth = block.marker ? measure(fontString(noteConfig, noteStyle.size, {}), block.marker) + noteStyle.size * 0.3 : 0
      const left = padding + Math.max(indent, markerWidth)
      const size = noteStyle.size * (block.kind === 'heading' ? [1.45, 1.3, 1.15, 1.05, 1, 1][(block.heading ?? 1) - 1] : block.kind === 'code' ? 0.86 : 1)
      const st = { ...noteStyle, size, leftPad: left, lineH: size * 1.65 }
      const decoration: NoteDecoration = block.quote ? { quoteX: left - noteStyle.size * 0.65 } : {}
      if (block.kind === 'code') decoration.background = { x: left - 3, w: width - padding - left + 6 }
      if (block.kind === 'rule') decoration.rule = { x: left, w: width - padding - left }
      if (block.cells) {
        const cellWidth = (width - padding - left) / block.cells.length
        if (cellWidth < size * 3) {
          // Very wide tables become stacked cells so even a narrow book page loses no text.
          for (const cell of block.cells) {
            const lines = layRuns(cell, st)
            for (const [i, line] of lines.entries()) rows.push({ ...line, noteDecoration: { ...decoration, cells: [{ x: left - 3, w: width - padding - left + 6 }], tableTop: i === 0, tableBottom: i === lines.length - 1 } })
          }
          return
        }
        const cells = block.cells.map((runs, i) => layRuns(runs, { ...st, leftPad: left + i * cellWidth + 4, rightPad: width - left - (i + 1) * cellWidth + 4, align: block.align?.[i] ?? 'left' }))
        const count = Math.max(...cells.map(lines => lines.length))
        for (let i = 0; i < count; i++) rows.push({
          words: cells.flatMap(lines => lines[i]?.words ?? []), h: st.lineH, baseline: cells[0][0].baseline, gap: 0,
          noteDecoration: { ...decoration, tableTop: i === 0, tableBottom: i === count - 1, cells: cells.map((_, i) => ({ x: left + i * cellWidth, w: cellWidth })), ...(block.tableHeader ? { background: { x: left, w: width - padding - left } } : {}) },
        })
        return
      }
      const lines = layRuns(block.runs ?? [], st, block.kind === 'code')
      if (block.marker) {
        const font = fontString(noteConfig, size, {})
        const w = measure(font, block.marker)
        lines[0].words.unshift({ text: block.marker, font, size, x: Math.max(padding, left - w - size * 0.3), w, s: -1, e: -1, space: true })
      }
      for (const line of lines) rows.push({ ...line, noteDecoration: decoration })
      if (block.kind !== 'code') rows[rows.length - 1].h += size * 0.25
    }
    const appendText = (text: string, st = noteStyle, tags: { start: number; end: number; tag: string }[] = []) => {
      // Tag tokens need their source positions before note offsets are removed.
      if (tags.length) {
        const block: Block = { kind: 'p', text, start: 0, runs: [{ text }] }
        const tokens = tokenize(block, st, noteConfig, width - padding * 2, cjkRatio(text) >= 0.2)
        for (const token of tokens) token.hang = false
        for (const line of breakLines(tokens, st, width, noteConfig)) rows.push({ ...line, words: line.words.map(word => ({ ...word, noteTag: tags.find(tag => word.s >= tag.start && word.s < tag.end)?.tag, s: -1, e: -1 })) })
      } else rows.push(...layRuns([{ text }], st))
    }
    if (a.note!.text.trim()) {
      const blocks = markdown!(a.note!.text)
      for (const block of blocks) appendBlock(block)
      // A definitions-only document still leaves an editable note target.
      if (!blocks.length && !a.note!.tags?.length) appendText('')
    } else if (!a.note!.tags?.length) appendText(t("写下你的想法…"))
    if (a.note!.tags?.length) {
      let text = ''
      const tags = a.note!.tags.map(tag => {
        if (text) text += '  '
        const start = text.length
        text += `#${tag}`
        return { tag, start, end: text.length }
      })
      appendText(text, { ...noteStyle, size: cfg.fontSize * 0.66, lineH: cfg.fontSize * 1.05 }, tags)
    }
    let at = 0
    while (at < rows.length) {
      let top = cursor > 0 ? gap : 0
      const remainingHeight = rows.slice(at).reduce((sum, row) => sum + row.h, 0)
      const totalHeight = header + remainingHeight + footer
      // Keep a short note together when it can fit on one fresh page.
      if (cursor > 0 && totalHeight <= contentH && cursor + top + totalHeight > contentH) {
        newPage(a.locator.chapter, a.locator.end, false)
        top = 0
      }
      let used = header
      let end = at
      while (end < rows.length && cursor + top + used + rows[end].h + footer <= contentH + 0.01) {
        used += rows[end++].h
      }
      if (end === at) {
        if (cursor > 0) { newPage(a.locator.chapter, a.locator.end, false); continue }
        // Valid reader configurations always fit one row; avoid looping for a malformed one.
        throw new Error(t("The page is too short to display a reading note."))
      }
      let y = header
      const lines: Line[] = rows.slice(at, end).map((row) => {
        const line = { y, h: row.h, baseline: row.baseline, words: row.words, noteDecoration: row.noteDecoration }
        y += row.h
        return line
      })
      const fragment: PlacedInlineNote = {
        id: a.id, locator: { ...a.locator }, x: inset, y: cursor + top,
        w: width, h: used + footer, lines, continued: at > 0, continues: end < rows.length, textColor: noteTextColorOf(a.note!.textColor),
      }
      const p = page as unknown as Page
      ;(p.notes ??= []).push(fragment)
      cursor = fragment.y + fragment.h + gap
      at = end
      if (at < rows.length) newPage(a.locator.chapter, a.locator.end, false)
    }
  }

  // Keep definitions containing reader notes visible so their notes remain editable.
  const annotatedDefinitions = new Set<string>()
  for (const chapter of book.chapters) for (const b of chapter.blocks) {
    if (b.footnoteDefinition && notes.some(a => a.locator.chapter === chapter.index && a.locator.start < b.start + b.text.length && a.locator.end > b.start)) annotatedDefinitions.add(b.footnoteDefinition)
  }
  const hiddenDefinition = (b: Block) => !!b.footnoteDefinition && !annotatedDefinitions.has(b.footnoteDefinition)

  const definitions = JSON.stringify([...annotatedDefinitions].sort())
  for (let ci = 0; ci < book.chapters.length; ci++) {
    const chapter = book.chapters[ci]
    chapterFirstPage.push(pages.length)
    const startPage = pages.length
    const signature = noteLayoutSignature(notesByChapter.get(ci) ?? [])
    const cached = reusable?.definitions === definitions ? reusable.chapters[ci] : undefined
    if (cached?.noteSignature === signature) {
      // Chapters start on new pages, so a note cannot alter another chapter's
      // line breaks. Copy page shells before renumbering; keep old snapshots intact.
      chapters[ci] = cached
      for (const page of cached.pages) pages.push({ ...page })
      continue
    }
    const visibleBlocks = inlineImageFootnotes(chapter.blocks.filter(b => !hiddenDefinition(b)))
    if (!visibleBlocks.length) {
      chapters[ci] = { noteSignature: signature, pages: [] }
      continue
    }
    newPage(ci, 0, true)
    let prevKind: BlockKind | null = null
    let firstInChapter = true

    for (let bi = 0; bi < visibleBlocks.length; bi++) {
      const b = visibleBlocks[bi]

      if (b.kind === 'img') {
        let sz = imageSizes.get(b.img!.path)
        if (!sz) {
          // spbf 的分页输入已经带原图像素尺寸；有就先用，缺失时再问 getImage。
          sz = { w: b.img!.w ?? 600, h: b.img!.h ?? 400 }
          if (b.img!.w === undefined || b.img!.h === undefined) {
            const blob = await book.getImage(b.img!.path)
            if (blob) {
              try {
                const bmp = await createImageBitmap(blob)
                sz = { w: bmp.width, h: bmp.height }
                bmp.close()
              } catch {
                /* ignore undecodable images */
              }
            }
          }
          imageSizes.set(b.img!.path, sz)
        }
        const nextB = visibleBlocks[bi + 1]
        let capReserve = nextB && nextB.kind === 'p' && nextB.text.length < 90 ? cfg.fontSize * 2.4 : 0
        if (nextB?.chapterHeading === 'number') {
          capReserve = 0
          for (const heading of visibleBlocks.slice(bi + 1, bi + 3)) {
            const cjkHeading = cjkRatio(heading.text) >= 0.2
            const headingStyle = styleFor(heading.kind, heading, cfg, 'img', false, cjkHeading)
            const headingLines = breakLines(tokenize(heading, headingStyle, cfg, contentW - headingStyle.leftPad - headingStyle.rightPad, cjkHeading), headingStyle, contentW, cfg)
            capReserve += headingStyle.before + headingLines.reduce((h, line) => h + line.h, 0) + headingStyle.after
          }
        }
        const maxH = nextB?.chapterHeading === 'number' ? Math.max(1, Math.min(contentH * 0.78, contentH - capReserve - 24)) : contentH * 0.78
        const scale = Math.min(contentW / sz.w, maxH / sz.h, 1.25)
        const w = sz.w * scale
        const h = sz.h * scale
        if (cursor + h + 24 + capReserve > contentH && cursor > 0) newPage(ci, b.start, false)
        const p = page as unknown as Page
        p.images.push({ path: b.img!.path, x: (contentW - w) / 2, y: cursor + 12, w, h, alt: b.img!.alt })
        cursor += h + 24
        p.end = b.start + 1
        prevKind = 'img'
        firstInChapter = false
        continue
      }
      if (b.kind === 'hr') {
        const p = page as unknown as Page
        if (cursor + 40 < contentH) {
          p.rules.push({ x: contentW * 0.4, y: cursor + 20, w: contentW * 0.2 })
          cursor += 40
        }
        prevKind = 'hr'
        continue
      }

      const cjk = cjkRatio(b.text) >= 0.2
      const st = styleFor(b.kind, b, cfg, prevKind, firstInChapter, cjk)
      const isQuote = isSourceQuote(b)
      // Some EPUBs wrap each quoted sentence in a separate blockquote. Avoid
      // stacking the full trailing and leading margins between those blocks.
      if (isQuote && b.literary?.role !== 'attribution') {
        const previous = visibleBlocks[bi - 1], next = visibleBlocks[bi + 1]
        if (previous && isSourceQuote(previous) && previous.literary?.role !== 'attribution') st.before = Math.min(st.before, cfg.fontSize * 0.16)
        if (next && isSourceQuote(next) && next.literary?.role !== 'attribution') st.after = 0
      }
      const quoteX = Math.max(0, st.leftPad - cfg.fontSize * 0.65)
      const quoteDecoration = isQuote ? { x: quoteX, w: Math.min(contentW, contentW - st.rightPad + cfg.fontSize * 0.45) - quoteX } : undefined
      const tokens = tokenize(b, st, cfg, contentW - st.leftPad - st.rightPad, cjk)
      if (!tokens.length) continue
      const lines = breakLines(tokens, st, contentW, cfg, b.marker)
      const total = lines.length
      const notesAfter = new Map<number, Annotation[]>()
      for (const annotation of notes) {
        const anchor = annotation.locator.end - 1
        if (annotation.locator.chapter !== ci || anchor < b.start || anchor > b.start + b.text.length) continue
        const target = Math.min(annotation.locator.end, b.start + b.text.length)
        let row = lines.findIndex((line) => line.words.some((word) => word.e >= target))
        if (row < 0) row = lines.length - 1
        notesAfter.set(row, [...(notesAfter.get(row) ?? []), annotation])
      }
      let signatureReserve = 0
      if (b.literary && b.literary.role !== 'attribution') {
        let preceding: BlockKind = b.kind
        for (let j = bi + 1; j <= bi + 2 && j < visibleBlocks.length; j++) {
          const next = visibleBlocks[j]
          if (next.literary?.group !== b.literary.group) break
          const cjkNext = cjkRatio(next.text) >= 0.2
          const nextStyle = styleFor(next.kind, next, cfg, preceding, false, cjkNext)
          const nextLines = breakLines(tokenize(next, nextStyle, cfg, contentW - nextStyle.leftPad - nextStyle.rightPad, cjkNext), nextStyle, contentW, cfg)
          signatureReserve += nextStyle.before + nextLines.length * nextStyle.lineH + nextStyle.after
          if (next.literary.role === 'attribution') break
          if (j === bi + 2 || nextLines.length > 1) { signatureReserve = 0; break }
          preceding = next.kind
        }
        // Reserve only when the lookahead actually ends in an attribution.
        if (![1, 2].some((d) => visibleBlocks[bi + d]?.literary?.group === b.literary?.group && visibleBlocks[bi + d]?.literary?.role === 'attribution')) signatureReserve = 0
      }
      let li = 0
      let before = cursor === 0 ? (firstInChapter ? st.before : 0) : st.before
      while (li < total) {
        const p = page as unknown as Page
        const room = contentH - cursor - before
        let fit = Math.floor((room + 0.5) / lines[li].h)
        let remaining = total - li
        if (fit >= remaining) fit = remaining
        else {
          // keep widows/orphans together
          if (remaining - fit < 2 && fit > 2) fit -= 1
          if (li === 0 && fit < 2 && total > 2) fit = 0
          if (/^h[1-3]$/.test(b.kind) && fit < remaining) fit = 0
        }
        if (signatureReserve && fit === remaining && cursor > 0 &&
            room < remaining * lines[li].h + st.after + signatureReserve &&
            Math.min(2, remaining) * lines[li].h + st.after + signatureReserve <= contentH) {
          fit = Math.max(0, remaining - 2)
        }
        if (fit <= 0) {
          if (p.lines.length === 0 && p.images.length === 0 && !p.notes?.length) fit = Math.max(1, Math.min(remaining, 1))
          else {
            newPage(ci, lines[li].words.find((w) => w.s >= 0)?.s ?? b.start, false)
            before = 0
            continue
          }
        }
        // Pause at the selected line so its notes can take space before subsequent source lines.
        for (let row = li; row < li + fit; row++) {
          if (notesAfter.has(row)) { fit = row - li + 1; break }
        }
        cursor += before
        before = 0
        for (let k = 0; k < fit; k++) {
          const l = lines[li + k]
          p.lines.push({ y: cursor, h: l.h, baseline: l.baseline, words: l.words, quoteDecoration, tone: b.literary ? b.literary.role === 'attribution' ? 'attribution' : 'literary' : undefined })
          cursor += l.h
        }
        const lastWord = lines[li + fit - 1].words.filter((w) => w.e >= 0).pop()
        if (lastWord) p.end = lastWord.e
        li += fit
        const inserted = notesAfter.get(li - 1)
        if (inserted) for (const annotation of inserted) placeNote(annotation)
        if (li < total && !inserted) {
          newPage(ci, lines[li].words.find((w) => w.s >= 0)?.s ?? b.start, false)
          before = 0
        }
      }
      cursor += st.after
      prevKind = b.kind
      firstInChapter = false
    }
    chapters[ci] = { noteSignature: signature, pages: pages.slice(startPage) }
    onProgress?.((ci + 1) / book.chapters.length)
    if (ci % 2 === 1) await new Promise((r) => setTimeout(r, 0))
  }

  // drop trailing empty pages
  while (pages.length > 1 && !pages[pages.length - 1].lines.length && !pages[pages.length - 1].images.length && !pages[pages.length - 1].notes?.length) pages.pop()

  // chapters start on a right-hand (even index) page when cheap? keep continuous; just number pages
  if (!cfg.singlePage && pages.length % 2 === 1) pages.push(front('blank'))
  pages.forEach((p, i) => {
    p.index = i
    p.label = i >= contentStart && !p.special ? String(i - contentStart + 1) : ''
  })

  const referencePages = new Map<string, number>()
  for (const p of pages) for (const line of p.lines) for (const w of line.words) {
    if (w.footnote && !referencePages.has(w.footnote.id)) referencePages.set(w.footnote.id, p.index)
  }
  for (const chapter of book.chapters) {
    if (chapter.blocks.every(hiddenDefinition)) chapterFirstPage[chapter.index] = referencePages.get(chapter.blocks[0]?.footnoteDefinition ?? '') ?? 0
  }
  const pageForOffset = (chapter: number, offset: number) => {
    const definition = book.chapters[chapter]?.blocks.find(b => hiddenDefinition(b) && b.start <= offset && offset < b.start + b.text.length + 1)
    const referencePage = definition?.footnoteDefinition ? referencePages.get(definition.footnoteDefinition) : undefined
    if (referencePage !== undefined) return referencePage
    const first = chapterFirstPage[chapter] ?? 0
    let found = first
    for (let i = first; i < pages.length && pages[i].chapter === chapter; i++) {
      const p = pages[i]
      if (p.special || p.blank || (!p.lines.length && !p.images.length)) continue
      // Note-only continuation pages share an anchor but never own any original text.
      if (p.lines.some((line) => line.words.some((word) => word.s >= 0 && word.s <= offset && word.e > offset))) return i
      if (p.start <= offset) found = i
      else break
    }
    return found
  }

  const result = { pages, config: cfg, chapterFirstPage, pageForOffset, noteSignature: noteLayoutSignature(annotations) }
  paginationCaches.set(result, { book, configKey, locale, definitions, chapters })
  return result
}
