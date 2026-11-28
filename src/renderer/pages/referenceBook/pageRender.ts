/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/book/pageRender.ts，Apache-2.0。已修改：去掉 .ts 扩展名引用、内联 i18n/笔记
 * Markdown 的最小替身，以接入 spbf 的真实书籍页面纹理。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import { t } from './i18n'
import {
    JUDOU_DEFAULT_SYMBOL,
    JUDOU_INK,
    MARK_COLORS,
    NOTE_TEXT_COLORS,
    hash,
    judouSymbolOf,
    rng,
    type Annotation,
    type MarkKind
} from './annotations'
import { fontString, glyphInk, measure, type LayoutConfig, type Line, type Page, type Word } from './layout'

export interface RenderOptions {
  cfg: LayoutConfig
  scale: number
  bookTitle: string
  author: string
  marks: Annotation[]
  images: Map<string, ImageBitmap>
  /** spbf 的主题正文色；缺省用参考站的墨色。 */
  ink?: string
  /** spbf 的主题弱色（页眉页脚）；缺省用参考站的灰。 */
  muted?: string
  /** 自定义高亮色（十六进制，如 #ffe45c）；缺省用 MARK_COLORS 的 fill。 */
  highlightColor?: string
  /** 自定义高亮透明度 0–100；缺省 35。 */
  highlightOpacity?: number
}

const INK = '#241c15'

export type PageCanvas = HTMLCanvasElement | OffscreenCanvas
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function makeCanvas(w: number, h: number): PageCanvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  return new OffscreenCanvas(w, h)
}

export function contentOrigin(page: Page, cfg: LayoutConfig) {
  const right = page.index % 2 === 0
  return { x: right ? cfg.marginInner : cfg.marginOuter, y: cfg.marginTop }
}

function wordPrefixWidth(w: Word, n: number) {
  if (n <= 0) return 0
  if (n >= w.text.length) return w.w
  return measure(w.font, w.text.slice(0, n))
}

interface MarkRect {
  x0: number
  x1: number
  line: Line
}

/**
 * Vertical span of a mark in page-content coordinates.
 * A highlight is the wash around the glyphs. An underline uses that same band and the stroke beneath it.
 * The line box is taller than this band; the cream between bars is not part of the mark.
 *
 * 上下沿取真实字形墨迹（`glyphInk`）而不是「字号 × 系数」：汉字、数字、标点的实际高度差
 * 很大，用统一系数时暖色块会在字上偏一截。留白按字号给一点余量，让色块像笔刷而不切字。
 */
export function markBand(
  line: { y: number; baseline: number; words?: Word[] },
  fontSize: number,
  kind: MarkKind = 'highlight',
  cfg?: LayoutConfig,
) {
  const sample = line.words?.map((w) => w.text).join('') ?? ''
  const family = cfg?.family || 'serif'
  const font = fontString({ ...(cfg ?? ({} as LayoutConfig)), family, fontSize }, fontSize, {})
  const ink = glyphInk(font, sample)
  // 有真实墨迹就用它；没有则退回旧的系数，保证任何调用方式都有结果。
  const ascent = ink?.ascent || fontSize * 0.84
  const descent = ink?.descent || fontSize * 0.28
  // 色带比字框收细约三成：从真实字形上下沿向内收，既贴合字身中心，又不会糊满整行显得粗重。
  const top = line.y + line.baseline - ascent * 0.76
  const washBot = line.y + line.baseline + descent * 0.55
  const bot = kind === 'underline' ? Math.max(line.y + line.baseline + descent, line.y + line.baseline + 6) : washBot
  return { top, bot }
}

/** The mark whose painted band lies under a page-content point, if any. */
export function markUnderPoint(page: Page, x: number, y: number, marks: Annotation[], cfg: LayoutConfig): Annotation | null {
  let bandHit: Annotation | null = null
  for (const mark of marks) {
    if (bandHit && mark.kind !== 'judou') continue
    if (mark.locator.chapter !== page.chapter) continue
    if (mark.locator.end <= page.start || mark.locator.start >= page.end) continue
    for (const r of rangeRects(page, mark.locator.start, mark.locator.end)) {
      // Slashes are painted over other marks. Only their own hit area takes priority.
      if (mark.kind === 'judou') {
        if (judouHit(r, cfg, x, y)) return mark
        continue
      }
      const band = markBand(r.line, cfg.fontSize, mark.kind, cfg)
      if (y < band.top - 1.25 || y > band.bot + 1.25) continue
      if (x < r.x0 - 2 || x > r.x1 + 2) continue
      bandHit = mark
      break
    }
  }
  return bandHit
}

/** Rects (page content coordinates) covered by a chapter-offset range. */
function rangeRects(page: Page, start: number, end: number): MarkRect[] {
  const out: MarkRect[] = []
  for (const line of page.lines) {
    let x0 = Infinity
    let x1 = -Infinity
    for (const w of line.words) {
      if (w.s < 0 || w.e <= start || w.s >= end) continue
      const a = wordPrefixWidth(w, start - w.s)
      const b = end >= w.e ? w.w : wordPrefixWidth(w, end - w.s)
      x0 = Math.min(x0, w.x + a)
      x1 = Math.max(x1, w.x + b)
    }
    if (x1 > x0) out.push({ x0, x1, line })
  }
  return out
}

function drawFrontMatter(c: Ctx, page: Page, o: RenderOptions) {
  const { cfg } = o
  const cx = cfg.pageW / 2 + (cfg.singlePage ? 0 : page.index % 2 === 0 ? 10 : -10)
  if (page.special === 'title') {
    c.textAlign = 'center'
    c.fillStyle = o.ink ?? INK
    const words = o.bookTitle.match(/[\u2e80-\u9fff\uac00-\ud7ff\uff00-\uffef]|[^\s\u2e80-\u9fff\uac00-\ud7ff\uff00-\uffef]+/gu) ?? [o.bookTitle]
    const joiner = (a: string, b: string) => (/^[\u2e80-\u9fff\uac00-\ud7ff\uff00-\uffef]$/.test(a.slice(-1)) || /^[\u2e80-\u9fff\uac00-\ud7ff\uff00-\uffef]$/.test(b[0]) ? '' : ' ')
    const lines: string[] = []
    let cur = ''
    const titleSize = cfg.singlePage ? 30 : 46
    c.font = `500 ${titleSize}px ${cfg.family}`
    for (const w of words) {
      const t = cur ? cur + joiner(cur, w) + w : w
      if (c.measureText(t).width > cfg.pageW - (cfg.singlePage ? 64 : 200) && cur && !/^[）」』》〉】〕，。、；：！？”’]/.test(w)) {
        lines.push(cur)
        cur = w
      } else cur = t
    }
    if (cur) lines.push(cur)
    let y = cfg.pageH * 0.32
    for (const l of lines) {
      c.fillText(l, cx, y)
      y += 58
    }
    y += 18
    c.strokeStyle = 'rgba(36,28,21,0.55)'
    c.lineWidth = 1
    c.beginPath()
    c.moveTo(cx - 40, y)
    c.lineTo(cx + 40, y)
    c.stroke()
    c.beginPath()
    c.arc(cx, y, 3, 0, Math.PI * 2)
    c.fillStyle = INK
    c.fill()
    y += 54
    c.font = `italic 440 24px ${cfg.family}`
    c.fillText(o.author, cx, y)
  } else {
    c.textAlign = 'center'
    c.fillStyle = 'rgba(36,28,21,0.45)'
    c.font = `italic 440 15px ${cfg.family}`
    if (page.index === 1) c.fillText(t("Read on the desk"), cx, cfg.pageH - 70)
  }
}

/** A clause mark rides the text baseline in the seam after one character, in page-content coordinates. */
interface JudouAnchor {
    /** bottom end of the slash */
    x: number
    /** top of the slash */
    y: number
    h: number
    /** the slash leans right by this much over its height */
    lean: number
}

/**
 * Placement of one clause mark. The mark belongs to the character before it and reads inline, like
 * 秋/十月: its centre sits on the right edge of that character's cell, and only the leaning top may
 * reach about 0.1 em into the next cell, over that glyph's left bearing. A line-final mark may hang
 * at most 0.2 em into the page margin.
 */
function judouAnchor(rect: MarkRect, cfg: LayoutConfig): JudouAnchor {
    const size = cfg.fontSize
    const h = size * 0.66
    const lean = h * 0.34
    const contentW = cfg.pageW - cfg.marginInner - cfg.marginOuter
    const x = Math.min(rect.x1 - size * 0.04 - lean / 2, contentW + size * 0.2 - lean)
    return {x: Math.max(size * 0.1, x), y: rect.line.y + rect.line.baseline + size * 0.03 - h, h, lean}
}

/** Whether a page-content point falls on the painted slash, with a small finger-sized tolerance. */
function judouHit(rect: MarkRect, cfg: LayoutConfig, x: number, y: number) {
    const a = judouAnchor(rect, cfg)
    const pad = Math.max(2.5, cfg.fontSize * 0.12)
    return x >= a.x - pad && x <= a.x + a.lean + pad && y >= a.y - pad && y <= a.y + a.h + pad
}

/**
 * Reader clause marks. Painted after the body ink so the vermilion never mixes with the glyphs; the caller
 * has already translated the context to the page content origin.
 */
function paintJudou(c: Ctx, page: Page, marks: Annotation[], cfg: LayoutConfig) {
    c.save()
    c.strokeStyle = JUDOU_INK
    c.fillStyle = JUDOU_INK
    c.lineCap = 'round'
    c.lineJoin = 'round'
    for (const m of marks) {
        if (m.kind !== 'judou') continue
        if (m.locator.chapter !== page.chapter) continue
        if (m.locator.end <= page.start || m.locator.start >= page.end) continue
        const symbol = judouSymbolOf(m.symbol)
        const rand = rng(hash(m.id))
        for (const r of rangeRects(page, m.locator.start, m.locator.end)) {
            const a = judouAnchor(r, cfg)
            const jx = (rand() - 0.5) * 0.7
            const jy = (rand() - 0.5) * 0.5
            c.globalAlpha = 0.84 + rand() * 0.12
            if (symbol === JUDOU_DEFAULT_SYMBOL) {
                const lean = a.lean * (0.88 + rand() * 0.24)
                c.lineWidth = Math.max(1, cfg.fontSize * 0.08)
                c.beginPath()
                c.moveTo(a.x + lean + jx, a.y + jy)
                c.quadraticCurveTo(a.x + lean * 0.55, a.y + a.h * 0.56, a.x - jx * 0.4, a.y + a.h + jy)
                c.stroke()
            } else {
                // Any future symbol is typeset small, so the stroke above stays a plain slash.
                c.font = `600 ${a.h * 1.3}px ${cfg.family}`
                c.textAlign = 'center'
                c.textBaseline = 'middle'
                c.fillText(symbol, a.x + a.lean / 2, a.y + a.h / 2)
            }
        }
    }
    c.restore()
}

export function renderPage(page: Page, o: RenderOptions): PageCanvas {
  const { cfg, scale } = o
  const canvas = makeCanvas(Math.round(cfg.pageW * scale), Math.round(cfg.pageH * scale))
  const c = canvas.getContext('2d') as Ctx
  c.scale(scale, scale)
  c.fillStyle = '#fff'
  c.fillRect(0, 0, cfg.pageW, cfg.pageH)
  c.textBaseline = 'alphabetic'

  if (page.special) {
    drawFrontMatter(c, page, o)
    return canvas
  }

  const origin = contentOrigin(page, cfg)

  // Paint source quotes before reader highlights. Each line owns its decoration so
  // page breaks and inline-note insertions never leave a rule across unrelated text.
  c.save()
  c.translate(origin.x, origin.y)
  for (const line of page.lines) {
    const quote = line.quoteDecoration
    if (!quote) continue
    c.fillStyle = 'rgba(74, 65, 47, 0.045)'
    c.fillRect(quote.x, line.y, quote.w, line.h)
    c.fillStyle = 'rgba(91, 103, 79, 0.48)'
    c.fillRect(quote.x, line.y, Math.max(1.5, cfg.fontSize * 0.09), line.h)
  }
  c.restore()

  // marks (multiply over the paper, below ink)
  c.save()
  c.translate(origin.x, origin.y)
  c.globalCompositeOperation = 'multiply'
  for (const m of o.marks) {
      if (m.kind === 'judou') continue
    if (m.locator.chapter !== page.chapter) continue
    if (m.locator.end <= page.start || m.locator.start >= page.end) continue
    const rects = rangeRects(page, m.locator.start, m.locator.end)
    const col = MARK_COLORS[m.color]
    const rand = rng(hash(m.id))
    for (const r of rects) {
      const l = r.line
      const size = cfg.fontSize
      if (m.kind === 'highlight') {
        const { top, bot } = markBand(l, size, 'highlight', cfg)
        const h = bot - top
        // 横向留白按字号走、且有上限：原来是固定 1.8px + 0.8px 抖动，
        // 小字号时会显得色块比字宽出一截，开始/结束也不是同一行字的边界。
        const padX = Math.min(1.1, size * 0.05)
        const jitterX = Math.min(0.6, size * 0.028)
        const x0 = r.x0 - padX + (rand() - 0.5) * jitterX
        const x1 = r.x1 + padX + (rand() - 0.5) * jitterX
        const tilt = (rand() - 0.5) * 0.6
        const wob = () => (rand() - 0.5) * 0.45
        const body = () => {
          c.beginPath()
          c.moveTo(x0 + 2, top + wob())
          c.bezierCurveTo(x0 + (x1 - x0) * 0.33, top + wob(), x0 + (x1 - x0) * 0.66, top + tilt + wob(), x1 - 2, top + tilt + wob())
          c.quadraticCurveTo(x1 + 1.4, top + h * 0.5, x1 - 1.5, bot + tilt + wob())
          c.bezierCurveTo(x0 + (x1 - x0) * 0.66, bot + tilt + wob(), x0 + (x1 - x0) * 0.33, bot + wob(), x0 + 1.5, bot + wob())
          c.quadraticCurveTo(x0 - 1.6, top + h * 0.5, x0 + 2, top)
          c.closePath()
        }
        c.save()
        c.filter = 'blur(0.55px)'
        // 使用自定义高亮色与透明度；未自定义时回退到 MARK_COLORS 的渐变。
        const customColor = o.highlightColor
        const customOpacity = o.highlightOpacity ?? 35
        if (customColor) {
          const r = parseInt(customColor.slice(1, 3), 16)
          const g = parseInt(customColor.slice(3, 5), 16)
          const b = parseInt(customColor.slice(5, 7), 16)
          const alpha = customOpacity / 100
          const wash = c.createLinearGradient(0, top, 0, bot)
          wash.addColorStop(0, `rgba(${r},${g},${b},${Math.min(alpha * 0.6, 1)})`)
          wash.addColorStop(0.48, `rgba(${r},${g},${b},${Math.min(alpha * 0.7, 1)})`)
          wash.addColorStop(1, `rgba(${r},${g},${b},${Math.min(alpha * 0.64, 1)})`)
          c.fillStyle = wash
        } else {
          // One continuous wash: a soft vertical gradient without pooled ink or overlapping passes.
          const wash = c.createLinearGradient(0, top, 0, bot)
          wash.addColorStop(0, col.fill + '99')
          wash.addColorStop(0.48, col.fill + 'b3')
          wash.addColorStop(1, col.fill + 'a3')
          c.fillStyle = wash
        }
        body()
        c.fill()
        c.restore()
      } else {
        const y = l.y + l.baseline + 4.4
        c.save()
        c.strokeStyle = col.ink
        c.lineCap = 'round'
        c.lineJoin = 'round'
        for (let pass = 0; pass < 2; pass++) {
          c.globalAlpha = pass === 0 ? 0.85 : 0.28
          c.lineWidth = pass === 0 ? 1.6 : 1.1
          c.beginPath()
          const ph = rand() * 6
          const steps = Math.max(3, Math.round((r.x1 - r.x0) / 9))
          c.moveTo(r.x0 + 0.5, y + (rand() - 0.5) * 0.6)
          for (let i = 1; i <= steps; i++) {
            const x = r.x0 + ((r.x1 - r.x0) * i) / steps
            c.lineTo(x, y + Math.sin(i * 0.7 + ph) * 0.55 + (rand() - 0.5) * (pass === 0 ? 0.5 : 0.9) + i * 0.002 * (r.x1 - r.x0) * 0.01)
          }
          c.stroke()
        }
        c.restore()
      }
    }
  }
  c.restore()

  // ink
  c.save()
  c.translate(origin.x, origin.y)
  c.fillStyle = o.ink ?? INK
  for (const line of page.lines) {
    c.fillStyle = line.tone === 'attribution' ? '#514637' : line.tone === 'literary' ? '#342a20' : (o.ink ?? INK)
    for (const w of line.words) {
      c.font = w.font
      const y = line.y + line.baseline - (w.sup ? w.size * 0.55 : 0)
      if (w.footnote) {
        c.save()
        const cx = w.x + w.w / 2, cy = y - w.size * 0.39
        c.fillStyle = '#ba7039'
        c.beginPath()
        c.arc(cx, cy, w.size / 2, 0, Math.PI * 2)
        c.fill()
        c.fillStyle = '#fff9ef'
        c.font = `${w.size * 0.72}px sans-serif`
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText(t("注"), cx, cy)
        c.restore()
      } else c.fillText(w.text, w.x, y)
    }
  }
    // The reader's clause marks sit on top of the ink: a pen added to the setting, not part of it.
    paintJudou(c, page, o.marks, cfg)
  // Reader notes live in the paper's text flow, with a quote rule instead of a separate card.
  for (const note of page.notes ?? []) {
    c.save()
    c.translate(note.x, note.y)
    c.strokeStyle = NOTE_TEXT_COLORS[note.textColor].ink
    c.globalAlpha = 0.55
    c.lineWidth = 1.4
    c.beginPath()
    c.moveTo(0, 2)
    c.lineTo(0, note.h - 2)
    c.stroke()
    c.globalAlpha = 1
    c.fillStyle = '#84776a'
    c.font = `500 ${cfg.fontSize * 0.53}px ${cfg.family}`
    c.fillText(note.continued ? t("笔记 · 续") : t("笔记"), cfg.fontSize * 0.65, cfg.fontSize * 0.65)
    c.fillStyle = NOTE_TEXT_COLORS[note.textColor].ink
    for (const line of note.lines) {
      const decoration = line.noteDecoration
      c.strokeStyle = NOTE_TEXT_COLORS[note.textColor].ink
      c.lineWidth = 1
      if (decoration?.background) {
        c.globalAlpha = 0.07
        c.fillRect(decoration.background.x, line.y, decoration.background.w, line.h)
        c.globalAlpha = 1
      }
      if (decoration?.quoteX != null) {
        c.globalAlpha = 0.4
        c.fillRect(decoration.quoteX, line.y, 2, line.h)
        c.globalAlpha = 1
      }
      if (decoration?.rule) {
        c.globalAlpha = 0.35
        c.fillRect(decoration.rule.x, line.y + line.h / 2, decoration.rule.w, 1)
        c.globalAlpha = 1
      }
      if (decoration?.cells) {
        c.globalAlpha = 0.25
        c.beginPath()
        for (const cell of decoration.cells) {
          c.moveTo(cell.x, line.y); c.lineTo(cell.x, line.y + line.h)
          c.moveTo(cell.x + cell.w, line.y); c.lineTo(cell.x + cell.w, line.y + line.h)
          if (decoration.tableTop) { c.moveTo(cell.x, line.y); c.lineTo(cell.x + cell.w, line.y) }
          if (decoration.tableBottom) { c.moveTo(cell.x, line.y + line.h); c.lineTo(cell.x + cell.w, line.y + line.h) }
        }
        c.stroke()
        c.globalAlpha = 1
      }
      for (const word of line.words) {
        if (word.noteCode) {
          c.globalAlpha = 0.08
          c.fillRect(word.x - 1, line.y + 2, word.w + 2, line.h - 4)
          c.globalAlpha = 1
        }
        c.font = word.font
        const baseline = line.y + line.baseline
        c.fillText(word.text, word.x, baseline)
        if (word.noteStrike) c.fillRect(word.x, baseline - word.size * 0.3, word.w, 1)
        if (word.noteLink) c.fillRect(word.x, baseline + 2, word.w, 0.8)
      }
    }
    c.restore()
  }
  c.strokeStyle = 'rgba(36,28,21,0.6)'
  c.lineWidth = 1
  for (const r of page.rules) {
    c.beginPath()
    c.moveTo(r.x, r.y)
    c.lineTo(r.x + r.w, r.y)
    c.stroke()
  }
  for (const im of page.images) {
    const bmp = o.images.get(im.path)
    if (bmp) {
      c.save()
      c.globalCompositeOperation = 'multiply'
      c.drawImage(bmp, im.x, im.y, im.w, im.h)
      c.restore()
    }
  }
  c.restore()

  // running head & folio
  c.textAlign = 'center'
  c.fillStyle = o.muted ?? 'rgba(36,28,21,0.52)'
  if (!page.chapterStart || cfg.singlePage) {
    c.font = cfg.singlePage ? '12px system-ui, sans-serif' : `italic 440 15px ${cfg.family}`
    const head = cfg.singlePage ? page.chapterTitle : page.index % 2 === 0 ? page.chapterTitle : o.bookTitle
    const maxHead = cfg.pageW - cfg.marginInner - cfg.marginOuter - 24
    let shown = head
    while (shown.length > 1 && c.measureText(shown).width > maxHead) shown = shown.slice(0, -2).trimEnd() + '…'
    if (cfg.singlePage) c.textAlign = 'left'
    c.fillText(shown, cfg.singlePage ? origin.x : origin.x + (cfg.pageW - cfg.marginInner - cfg.marginOuter) / 2, cfg.marginTop - (cfg.singlePage ? 24 : 34))
  }
  if (page.label && !cfg.singlePage) {
    c.font = `440 16px ${cfg.family}`
    c.fillText(page.label, origin.x + (cfg.pageW - cfg.marginInner - cfg.marginOuter) / 2, cfg.pageH - cfg.marginBottom * 0.5 - 4)
  }
  return canvas
}
