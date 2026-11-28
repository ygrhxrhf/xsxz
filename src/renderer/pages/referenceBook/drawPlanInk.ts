/**
 * 把 spbf 的纹理页计划交给参考站 `pageRender` 画墨迹与标记。
 * 参考站 `pageRender` 只认它自己的 `Page` / `Line` / `Word` 模型；这里把
 * `PageTexturePlan` 的行、标记和图片映射成同形对象，再原样调用上游的
 * `renderPage`。分页、断行仍由 spbf 的分页器给出（layout 单独再换）。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */

import {
  contentOrigin,
  renderPage,
  type PageCanvas,
  type RenderOptions,
} from './pageRender'
import { measure, type Line, type Page, type Word, type PlacedInlineNote, type NoteDecoration } from './layout'
import { noteTextColorOf } from './annotations'
import { MARK_COLORS, type Annotation, type MarkColor } from './annotations'
import type { PageTexturePlan, RealBookTextureStyle, PageTextureLine, PageTextureNoteBox } from '../realBookTexture'

function markColor(value: string | undefined): MarkColor {
  if (value && Object.hasOwn(MARK_COLORS, value)) return value as MarkColor
  // spbf 的划线色白名单（yellow/green/blue/red/purple）与参考站不同名，
  // red/purple 找不到就会退化成黄色；映射到观感最近的参考站色。
  if (value === 'red') return 'pink'
  if (value === 'purple') return 'violet'
  const hex = String(value ?? '').toLowerCase()
  const hit = (Object.entries(MARK_COLORS) as Array<[MarkColor, { fill: string }]>)
    .find(([, color]) => color.fill.toLowerCase() === hex)
  return hit?.[0] ?? 'yellow'
}

/**
 * 把一页纹理计划映射成参考站 Page 并画到白色画布上。
 * 调用方用 `multiply` 把这张白底墨迹叠到纸色纹理上：白色区域保持纸色，
 * 墨迹/荧光笔按参考站的形状与透明度压深。
 */
export function drawPlanInk(plan: PageTexturePlan, style: RealBookTextureStyle, scale = 2): PageCanvas | null {
  if (plan.source) return drawSourcePage(plan, style, scale)
  return drawMappedPage(plan, style, scale)
}

function layoutCfg(plan: PageTexturePlan, style: RealBookTextureStyle) {
  return {
    pageW: plan.width,
    pageH: plan.height,
    marginTop: plan.marginTop,
    marginBottom: plan.marginBottom,
    marginInner: style.marginInner ?? 80,
    marginOuter: style.marginOuter ?? 58,
    fontSize: Math.max(8, style.fontSize),
    lineHeight: Math.max(0.8, style.lineHeight / Math.max(1, style.fontSize)),
    family: style.fontFamily || 'serif',
  }
}

/**
 * 参考站 layout 原始页直通：Word 的 noteTag/footnote/sup/smallcaps、Line 的
 * quoteDecoration/tone、page.rules、chapterStart/blank/special、notes 全部来自
 * 上游 paginate 本身，不做任何反推。仅把 spbf 高亮换成上游 Annotation。
 */
function drawSourcePage(plan: PageTexturePlan, style: RealBookTextureStyle, scale: number): PageCanvas | null {
  const source = plan.source!
  const cfg = layoutCfg(plan, style)
  const page: Page = { ...source, label: plan.special ? '' : source.label }
  const marks: Annotation[] = (plan.sourceMarks ?? []).map((mark, index) => ({
    id: `spbf-${source.index}-${index}`,
    bookId: 'spbf',
    locator: { chapter: source.chapter, start: mark.start, end: mark.end },
    quote: '',
    kind: 'highlight',
    color: markColor(mark.color),
    createdAt: 0,
    updatedAt: 0,
  }))
  const images = new Map<string, ImageBitmap>()
  for (const image of source.images) {
    const bitmap = style.images?.get(image.path)
    if (bitmap) images.set(image.path, bitmap as unknown as ImageBitmap)
  }
  const options: RenderOptions & { ink?: string } = {
    cfg,
    scale,
    bookTitle: style.bookTitle || plan.header || plan.chapterTitle,
    author: style.bookAuthor || '',
    marks,
    images,
    ink: style.ink,
    muted: style.muted,
    highlightColor: style.highlightColors ? Object.keys(style.highlightColors)[0] : undefined,
    highlightOpacity: style.highlightColors
      ? Math.round((Number(Object.values(style.highlightColors)[0].match(/rgba?\([^,]+,[^,]+,[^,]+,([^)]+)\)/)?.[1] ?? 0.35) * 100))
      : undefined,
  }
  return renderPage(page, options)
}

/** 无参考站原始页时（旧分页器）的兜底映射。 */
function drawMappedPage(plan: PageTexturePlan, style: RealBookTextureStyle, scale: number): PageCanvas | null {
  const cfg = {
    pageW: plan.width,
    pageH: plan.height,
    marginTop: plan.marginTop,
    marginBottom: plan.marginBottom,
    marginInner: style.marginInner ?? 80,
    marginOuter: style.marginOuter ?? 58,
    fontSize: Math.max(8, style.fontSize),
    lineHeight: Math.max(0.8, style.lineHeight / Math.max(1, style.fontSize)),
    family: style.fontFamily || 'serif',
  }

  const pageNumber = Math.max(1, plan.pageNumber)
  const page: Page = {
    index: pageNumber - 1,
    chapter: 0,
    chapterTitle: plan.header || plan.chapterTitle,
    lines: [],
    images: [],
    rules: [],
    start: 0,
    end: 0,
    chapterStart: !plan.header,
    label: plan.footer || '',
    special: plan.special,
  }

  const origin = contentOrigin(page, cfg)
  const annotations: Annotation[] = []
  const font = `440 ${cfg.fontSize}px ${cfg.family}`
  let cursor = 0

  // Track quote blocks for quoteDecoration
  let inQuoteBlock = false
  let quoteBlockStartX = 0

  plan.lines.forEach((line, lineIndex) => {
    const text = line.text
    const lineX = line.x - origin.x
    const lineY = line.y - origin.y
    const lineHeight = line.height
    const baseline = lineHeight * 0.76

    // Detect quote block boundaries (simplified: lines with quoteDecoration in upstream)
    // In spbf, quote blocks are marked by having a left rule/wash
    const isQuoteLine = line.marks.some(m => m.color === 'quote') || false

    // Build words for this line by splitting on spaces/punctuation boundaries
    // to match upstream's multi-word-per-line structure
    const words: Word[] = []
    let wordCursor = cursor

    if (text.length > 0) {
      // Split text into words while preserving character offsets
      // This mimics upstream tokenization: each "word" is a continuous run
      const segments = splitIntoWords(text, font)
      for (const segment of segments) {
        const segmentText = segment.text
        const segmentWidth = Math.max(0, measure(font, segmentText))
        const word: Word = {
          text: segmentText,
          x: lineX + segment.offset,
          w: segmentWidth,
          font,
          s: wordCursor + segment.start,
          e: wordCursor + segment.end,
          space: segment.space,
          size: cfg.fontSize,
        }
        words.push(word)
      }
    } else {
      // Empty line - still need a placeholder word for marks to attach to
      const word: Word = {
        text: '',
        x: lineX,
        w: 0,
        font,
        s: cursor,
        e: cursor,
        space: false,
        size: cfg.fontSize,
      }
      words.push(word)
    }

    // Build quoteDecoration for source blockquotes
    let quoteDecoration: Line['quoteDecoration'] | undefined
    if (isQuoteLine) {
      const quoteX = Math.max(0, lineX - cfg.fontSize * 0.65)
      const quoteW = Math.min(cfg.pageW - cfg.marginInner - cfg.marginOuter, cfg.pageW - cfg.marginOuter + cfg.fontSize * 0.45) - quoteX
      quoteDecoration = { x: quoteX, w: Math.max(0, quoteW) }
    }

    // Determine tone for literary blocks
    let tone: Line['tone'] | undefined
    // In spbf, literary blocks would be marked differently; for now we don't have this info
    // but we keep the field for upstream compatibility

    const refLine: Line = {
      y: lineY,
      h: lineHeight,
      baseline,
      words,
      quoteDecoration,
      tone,
    }

    // Convert marks to annotations
    line.marks.forEach((mark, markIndex) => {
      annotations.push({
        id: `spbf-${pageNumber}-${lineIndex}-${markIndex}`,
        bookId: 'spbf',
        locator: {
          chapter: 0,
          start: cursor + Math.max(0, Math.min(text.length, mark.start)),
          end: cursor + Math.max(0, Math.min(text.length, mark.end)),
        },
        quote: '',
        kind: 'highlight',
        color: markColor(mark.color),
        createdAt: 0,
        updatedAt: 0,
      })
    })

    page.lines.push(refLine)
    cursor += text.length + 1 // +1 for paragraph break
  })

  page.end = Math.max(0, cursor - 1)

  // Images
  const images = new Map<string, ImageBitmap>()
  for (const image of plan.images) {
    const source = style.images?.get(image.file)
    if (source) images.set(image.file, source as unknown as ImageBitmap)
    page.images.push({
      path: image.file,
      x: image.x,
      y: image.y,
      w: image.width,
      h: image.height,
      alt: image.caption,
    })
  }

  // Rules (horizontal rules)
  // In spbf, rules are not explicitly in PageTexturePlan; we skip for now
  // page.rules = plan.rules?.map(r => ({ x: r.x, y: r.y, w: r.w })) ?? []

  // Map note fragments to upstream PlacedInlineNote
  const notes: PlacedInlineNote[] = (plan.notes ?? []).map((noteBox: PageTextureNoteBox) => {
    const noteLines: Line[] = (noteBox.lines ?? []).map(noteLine => {
      // Build noteDecoration from the note line's decoration info
      const decoration: NoteDecoration = {}
      const nd = noteLine.noteDecoration
      if (nd?.quoteX != null) decoration.quoteX = nd.quoteX
      if (nd?.background) decoration.background = nd.background
      if (nd?.rule) decoration.rule = nd.rule
      if (nd?.cells) decoration.cells = [...nd.cells]
      if (nd?.tableTop) decoration.tableTop = nd.tableTop
      if (nd?.tableBottom) decoration.tableBottom = nd.tableBottom

      // Convert note words to upstream Word format
      const noteWords: Word[] = (noteLine.words ?? []).map(w => ({
        text: w.text,
        x: w.x,
        w: w.w,
        font: w.font,
        s: -1, // note words don't have chapter offsets
        e: -1,
        space: w.space ?? false,
        size: w.size ?? cfg.fontSize,
        noteLink: w.noteLink,
        noteStrike: w.noteStrike,
        noteCode: w.noteCode,
      }))

      return {
        y: noteLine.y,
        h: noteLine.h,
        baseline: noteLine.baseline ?? noteLine.h * 0.76,
        words: noteWords,
        noteDecoration: decoration,
      }
    })

    return {
      id: noteBox.note.id,
      locator: { chapter: 0, start: noteBox.note.paragraph, end: noteBox.note.paragraph },
      x: noteBox.x,
      y: noteBox.y,
      w: noteBox.width,
      h: noteBox.height,
      lines: noteLines,
      continued: noteBox.continued ?? false,
      continues: noteBox.continues ?? false,
      textColor: noteTextColorOf(noteBox.textColor),
    }
  })
  page.notes = notes

  const options: RenderOptions & { ink?: string } = {
    cfg,
    scale,
    bookTitle: style.bookTitle || plan.header || plan.chapterTitle,
    author: style.bookAuthor || '',
    marks: annotations,
    images,
    ink: style.ink,
    muted: style.muted,
    highlightColor: style.highlightColors ? Object.keys(style.highlightColors)[0] : undefined,
    highlightOpacity: style.highlightColors
      ? Math.round((Number(Object.values(style.highlightColors)[0].match(/rgba?\([^,]+,[^,]+,[^,]+,([^)]+)\)/)?.[1] ?? 0.35) * 100))
      : undefined,
  }

  return renderPage(page, options)
}

/**
 * Split text into word segments with character offsets.
 * Mimics upstream tokenization: each segment is a "word" for rendering purposes.
 */
function splitIntoWords(text: string, font: string): Array<{ text: string; start: number; end: number; offset: number; space: boolean }> {
  const segments: Array<{ text: string; start: number; end: number; offset: number; space: boolean }> = []
  let current = 0
  let offset = 0

  while (current < text.length) {
    // Skip leading spaces
    while (current < text.length && text[current] === ' ') current++

    if (current >= text.length) break

    const start = current
    // Find end of word (next space or punctuation boundary)
    while (current < text.length && text[current] !== ' ') {
      current++
    }
    const end = current

    const segmentText = text.slice(start, end)
    const segmentWidth = measure(font, text.slice(offset, start))
    segments.push({
      text: segmentText,
      start,
      end,
      offset: segmentWidth,
      space: current < text.length && text[current] === ' ',
    })

    if (current < text.length && text[current] === ' ') {
      current++ // skip the space
    }
    offset = end
  }

  return segments
}