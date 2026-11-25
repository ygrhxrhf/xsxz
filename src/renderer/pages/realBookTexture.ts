/**
 * 真实书籍的页面纹理层。
 *
 * Three.js 只认纹理，不认 DOM。分页器已经把每一页的段落、行和批注块算好，
 * 这里负责把这些数据画成与目标参考一致的 640×920 书页：页眉、正文、页脚、
 * 划线、搜索命中、页内批注和纸面明暗都在 Canvas 上完成。
 *
 * 这层刻意不依赖 Vue/Three，只接收纯数据，因此可以在 Node 测试里直接验证
 * 分页结果如何落到纹理坐标，而不需要 WebGL 上下文。
 */

import type { RealBookLine, RealBookNoteLine } from './realBookPager'
import type { RealBookNote } from './realBookNotes'
import { drawPlanInk } from './referenceBook/drawPlanInk'

/** 目标参考书页的逻辑尺寸；Three.js 书页几何按 6.4×9.2 等比映射。 */
export const PAGE_TEXTURE_WIDTH = 640
export const PAGE_TEXTURE_HEIGHT = 920
export const PAGE_TEXTURE_SCALE = 2
/** WebGL 书页版心：分页器与纹理绘制共用，避免两套边距导致多一行或少一行。 */
export const PAGE_TEXTURE_MARGIN_TOP = 78
export const PAGE_TEXTURE_MARGIN_BOTTOM = 100
/** 订口边距：右页（偶数页）靠书脊的一侧。 */
export const PAGE_TEXTURE_MARGIN_INNER = 80
/** 外口边距：左页（奇数页）靠书脊的一侧。 */
export const PAGE_TEXTURE_MARGIN_OUTER = 58
/** 兼容旧调用：对称版心统一按订口边距。 */
export const PAGE_TEXTURE_MARGIN_X = PAGE_TEXTURE_MARGIN_INNER

export interface RealBookTextureHighlight {
  start: number
  end: number
  color?: string
}

export interface RealBookTextureTextItem {
  kind: 'text'
  /** 完整段落文本；行区间是它内部的字符偏移 */
  text: string
  /** 原始段落下标，供后续命中/批注定位 */
  originalIndex: number
  start: number
  end: number
  continued: boolean
  lines: readonly RealBookLine[]
  highlights: readonly RealBookTextureHighlight[]
  /** 段内「注」标记的字符偏移 */
  noteMarks: readonly number[]
}

export interface RealBookTextureNoteItem {
  kind: 'note'
  note: RealBookNote
  /** 分页器为其预留的高度（含段间距） */
  height: number
  /** 上游 PlacedInlineNote 片段：是否由上一页延续而来 */
  continued: boolean
  /** 上游 PlacedInlineNote 片段：是否还有后续片段 */
  continues: boolean
  /** 片段的行级墨迹数据，交给上游 renderPage 内联绘制 */
  lines: readonly RealBookNoteLine[]
  textColor: string
  /** 分页时算好的页内 y（相对版心顶部）；缺省按流式累加 */
  y?: number
}

/** 页内图片块：正文里以 `[图]` 标记占位，纹理层按版心宽度画出来。 */
export interface RealBookTextureImageItem {
  kind: 'image'
  /** 书目录 images/ 下的文件名 */
  file: string
  /** 原图像素尺寸 */
  width: number
  height: number
  caption: string
  /** 版心里的显示高度（px），由书台按版心宽度换算 */
  displayHeight: number
}

export type RealBookTextureItem = RealBookTextureTextItem | RealBookTextureNoteItem | RealBookTextureImageItem

/** 一页纹理的输入数据。 */
export interface RealBookTexturePage {
  /** 1-based 页码；0 表示空页 */
  pageNumber: number
  chapterTitle: string
  /** 页眉文字；缺省用章节名。参考站左页印书名、右页印章节名。 */
  header?: string
  /** 参考站 layout 的标题页/空白页。 */
  special?: 'title' | 'blank'
  /** 参考站页码标签；缺省用 pageNumber。 */
  label?: string
  items: readonly RealBookTextureItem[]
  /** 参考站 layout 原始页：有它时墨迹层原样交给上游 renderPage。 */
  source?: import('./referenceBook/layout').Page
  /** 高亮的章内字符偏移（与 source 的 Word.s/e 同一坐标）。 */
  sourceMarks?: ReadonlyArray<{ start: number; end: number; color: string }>
}

export interface RealBookTextureStyle {
  fontSize: number
  lineHeight: number
  fontFamily: string
  paragraphGap: number
  paper: string
  ink: string
  muted: string
  /** 主题附带的荧光笔颜色；缺省用暖黄。 */
  highlightColors?: Readonly<Record<string, string>>
  searchQuery?: string
  /** 页面左右侧；影响书脊侧阴影落在哪一边。 */
  side?: 'left' | 'right'
  pageWidth?: number
  pageHeight?: number
  /** 显式对称边距；不给时按 inner/outer 与页面 side 镜像。 */
  marginX?: number
  marginInner?: number
  marginOuter?: number
  marginTop?: number
  marginBottom?: number
  headHeight?: number
  footHeight?: number
  /** 已解码的章内图片：按文件名取；缺图时画占位框。 */
  images?: ReadonlyMap<string, CanvasImageSource>
  /** 标题页需要的书名与作者。 */
  bookTitle?: string
  bookAuthor?: string
  /** 图片加载轮次：新图落下来后加一，纹理缓存据此重画。 */
  imageEpoch?: number
  /**
   * 不把正文画进纹理：静态页的正文由上层 DOM 文本层显示（更清晰、可选字）；
   * 飞页仍需要纹理里的字，所以这个开关只给静态页用。
   */
  omitBodyText?: boolean
  /**
   * 墨迹与标记交给参考站的 `pageRender` 画（默认开）；关掉时用本文件里旧版
   * 的矩形色块/描边字。分页/断行仍由 spbf 的分页器给出。
   */
  referencePageRender?: boolean
}

export interface PageTextureLine {
  text: string
  /** 相对段落的起始字符 */
  start: number
  /** 相对段落的结束字符 */
  end: number
  /** 原始段落下标：透明 DOM 文本层用它挂 data-p。 */
  paragraphIndex: number
  x: number
  y: number
  height: number
  firstLine: boolean
  continued: boolean
  /** 此行需要画在文字下方的色块；字符偏移相对本行文本。 */
  marks: Array<{ start: number; end: number; color: string }>
  noteMarks: number[]
}

export interface PageTextureNoteBox {
  note: RealBookNote
  x: number
  y: number
  width: number
  height: number
  // 与上游 PlacedInlineNote 一致的片段字段（必填）
  continued: boolean
  continues: boolean
  lines: readonly RealBookNoteLine[]
  textColor: string
}

export interface PageTexturePlan {
  width: number
  height: number
  marginX: number
  special?: 'title' | 'blank'
  marginTop: number
  marginBottom: number
  headHeight: number
  footHeight: number
  pageNumber: number
  chapterTitle: string
  /** 实际画在页眉的文本（书名/章节名由页面自己决定）。 */
  header: string
  /** 页眉字号与 alphabetic 基线：纹理与 DOM 文本层共用，两层不会错位。 */
  headerFontSize: number
  headerBaseline: number
  /** 页脚文本（空页不印页码）；字号与基线的约定同页眉。 */
  footer: string
  footerFontSize: number
  footerBaseline: number
  lines: PageTextureLine[]
  notes: PageTextureNoteBox[]
  images: PageTextureImageBox[]
  side: 'left' | 'right'
  /** 透传自 RealBookTexturePage.source。 */
  source?: import('./referenceBook/layout').Page
  sourceMarks?: ReadonlyArray<{ start: number; end: number; color: string }>
}

export interface PageTextureImageBox {
  file: string
  caption: string
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_HIGHLIGHT = 'rgba(240, 185, 90, 0.34)'
const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: 'rgba(240, 185, 90, 0.34)',
  pink: 'rgba(206, 110, 141, 0.28)',
  green: 'rgba(101, 156, 111, 0.28)',
  blue: 'rgba(97, 143, 193, 0.27)',
  orange: 'rgba(216, 132, 71, 0.28)',
  violet: 'rgba(143, 113, 193, 0.28)',
  // 与 readerMarks.MARK_COLORS 的白名单对齐；否则红/紫划线会回落到默认黄色。
  red: 'rgba(206, 82, 82, 0.3)',
  purple: 'rgba(143, 113, 193, 0.3)',
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function highlightMarks(
  line: RealBookLine,
  highlights: readonly RealBookTextureHighlight[],
  colors: Readonly<Record<string, string>> | undefined,
): Array<{ start: number; end: number; color: string }> {
  const marks: Array<{ start: number; end: number; color: string }> = []
  for (const highlight of highlights) {
    const start = Math.max(line.start, highlight.start)
    const end = Math.min(line.end, highlight.end)
    if (end <= start) continue
    const palette = colors?.[highlight.color ?? ''] ?? HIGHLIGHT_COLORS[highlight.color ?? ''] ?? DEFAULT_HIGHLIGHT
    marks.push({ start: start - line.start, end: end - line.start, color: palette })
  }
  return marks
}

/**
 * 把分页结果转成纹理坐标。
 *
 * 行距、页眉页脚和段间距必须与 `RealBookStage` 的版心一致；否则文字会在纸上
 * 多一行或少一行。所有数值都是逻辑像素，真正栅格化时再乘 `scale`。
 */
export function buildPageTexturePlan(
  page: RealBookTexturePage,
  style: RealBookTextureStyle,
): PageTexturePlan {
  const width = Math.max(240, Math.round(style.pageWidth ?? PAGE_TEXTURE_WIDTH))
  const height = Math.max(320, Math.round(style.pageHeight ?? PAGE_TEXTURE_HEIGHT))
  const side = style.side ?? (page.pageNumber % 2 === 0 ? 'right' : 'left')
  const explicitMargin = style.marginX
  const marginInner = Math.max(16, Math.round(explicitMargin ?? style.marginInner ?? PAGE_TEXTURE_MARGIN_INNER))
  const marginOuter = Math.max(16, Math.round(explicitMargin ?? style.marginOuter ?? PAGE_TEXTURE_MARGIN_OUTER))
  const marginX = side === 'right' ? marginInner : marginOuter
  const marginTop = Math.max(16, Math.round(style.marginTop ?? PAGE_TEXTURE_MARGIN_TOP))
  const marginBottom = Math.max(16, Math.round(style.marginBottom ?? PAGE_TEXTURE_MARGIN_BOTTOM))
  const headHeight = Math.max(12, Math.round(style.headHeight ?? style.fontSize * 1.8))
  const footHeight = Math.max(12, Math.round(style.footHeight ?? style.fontSize * 1.6))
  // 页眉页脚的字号/基线只在这里算一次：纹理（非 DOM 路径）与 DOM 文本层都读它。
  const chromeFontSize = Math.max(8, style.fontSize)
  const headerFontSize = Math.max(10, chromeFontSize * 0.62)
  const footerFontSize = Math.max(9, chromeFontSize * 0.62)
  const lineHeight = Math.max(1, style.lineHeight)
  const paragraphGap = Math.max(0, style.paragraphGap)
  const contentWidth = Math.max(80, width - marginInner - marginOuter)
  // 参考站把页码画在下边距里，正文一直排到 pageH - marginBottom；旧绘制器仍给页脚留高。
  const contentBottom = height - marginBottom - (style.referencePageRender === false ? footHeight : 0)
  const lines: PageTextureLine[] = []
  const notes: PageTextureNoteBox[] = []
  const images: PageTextureImageBox[] = []
  let y = marginTop
  let firstItem = true

  for (const item of page.items) {
    if (item.kind === 'image') {
      const captionHeight = item.caption ? lineHeight : 0
      const boxHeight = Math.max(24, item.displayHeight)
      if (y + boxHeight + captionHeight > contentBottom + 0.5) break
      if (!firstItem) y += paragraphGap
      images.push({
        file: item.file,
        caption: item.caption,
        x: marginX,
        y,
        width: contentWidth,
        height: boxHeight,
      })
      y += boxHeight + captionHeight
      firstItem = false
      continue
    }
    if (item.kind === 'note') {
      // 高度与位置沿用分页器按上游 placeNote 算好的值，不再二次推算。
      const noteHeight = item.height
      if (y + noteHeight > height - marginBottom + 0.5) break
      notes.push({
        note: item.note,
        x: marginX,
        y,
        width: contentWidth,
        height: noteHeight,
        continued: item.continued,
        continues: item.continues,
        lines: item.lines,
        textColor: item.textColor,
      })
      y += noteHeight
      firstItem = false
      continue
    }

    if (!firstItem && !item.continued) y += paragraphGap
    const itemLines = item.lines.length
      ? item.lines
      : [{ start: item.start, end: item.end } as RealBookLine]
    for (let index = 0; index < itemLines.length; index += 1) {
      const line = itemLines[index]!
      const text = item.text.slice(line.start, line.end)
      if (y + lineHeight > contentBottom + 0.5) break
      const firstLine = index === 0 && !item.continued
      const lineInfo = lineMarksWithText(line, text, item, style)
      lines.push({
        text,
        start: line.start,
        end: line.end,
        paragraphIndex: item.originalIndex,
        x: marginX + (firstLine ? Math.min(style.fontSize * 2, contentWidth * 0.18) : 0),
        y,
        height: lineHeight,
        firstLine,
        continued: item.continued,
        marks: lineInfo.marks,
        noteMarks: lineInfo.noteMarks,
      })
      y += lineHeight
    }
    firstItem = false
  }

  return {
    width,
    height,
    marginX,
    special: page.special,
    source: page.source,
    sourceMarks: page.sourceMarks,
    marginTop,
    marginBottom,
    headHeight,
    footHeight,
    pageNumber: page.pageNumber,
    chapterTitle: page.chapterTitle,
    header: page.header ?? page.chapterTitle,
    headerFontSize,
    headerBaseline: marginTop - 10,
    footer: page.special ? '' : (page.label ?? (page.pageNumber > 0 ? String(page.pageNumber) : '')),
    footerFontSize,
    footerBaseline: height - marginBottom + chromeFontSize * 0.8,
    lines,
    notes,
    images,
    side,
  }
}

function lineMarksWithText(
  line: RealBookLine,
  text: string,
  item: RealBookTextureTextItem,
  style: RealBookTextureStyle,
): { marks: Array<{ start: number; end: number; color: string }>; noteMarks: number[] } {
  const marks = highlightMarks(line, item.highlights, style.highlightColors)
  const query = (style.searchQuery ?? '').trim()
  if (query && text && query.length <= 80) {
    const lower = text.toLocaleLowerCase()
    const needle = query.toLocaleLowerCase()
    let from = 0
    while (from < lower.length) {
      const at = lower.indexOf(needle, from)
      if (at < 0) break
      marks.push({ start: at, end: at + needle.length, color: 'rgba(240, 185, 90, 0.42)' })
      from = at + Math.max(1, needle.length)
    }
  }
  return {
    marks,
    noteMarks: item.noteMarks
      .filter((offset) => offset >= line.start && offset <= line.end)
      .map((offset) => offset - line.start),
  }
}

/**
 * 按当前 canvas 字体断行。导出给 DOM 层：批注卡的换行必须和纹理里一模一样，
 * 否则同一张卡在两种渲染路径里会排成不同的行数。
 */
export function wrapTextureText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const source = text.replace(/\s+/g, ' ').trim()
  if (!source) return []
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
    const parts = [...segmenter.segment(source)].map((part) => part.segment)
    const out: string[] = []
    let line = ''
    for (const part of parts) {
      if (line && ctx.measureText(line + part).width > maxWidth) {
        out.push(line)
        line = part.trimStart()
      } else {
        line += part
      }
    }
    if (line) out.push(line)
    return out
  }
  const out: string[] = []
  let line = ''
  for (const char of source) {
    if (line && ctx.measureText(line + char).width > maxWidth) {
      out.push(line)
      line = char
    } else {
      line += char
    }
  }
  if (line) out.push(line)
  return out
}

/**
 * 主线程用 document 建 canvas，Worker 里没有 document，用 OffscreenCanvas。
 * 两者都拿不到时返回 null（Node/jsdom 测试只验计划，不画）。
 */
function createTextureCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  return null
}

/**
 * 将计划绘制成 2× 页面纹理。没有 Canvas（Node/jsdom 测试）时返回 null，
 * 调用方仍可单独测试 `buildPageTexturePlan`。
 */
export function drawPageTexture(
  plan: PageTexturePlan,
  style: RealBookTextureStyle,
  scale = PAGE_TEXTURE_SCALE,
): HTMLCanvasElement | OffscreenCanvas | null {
  const canvas = createTextureCanvas(Math.round(plan.width * scale), Math.round(plan.height * scale))
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)
  const fontSize = Math.max(8, style.fontSize)
  const lineHeight = Math.max(1, style.lineHeight)
  const family = style.fontFamily || 'serif'
  const ink = style.ink || '#241c15'
  const muted = style.muted || 'rgba(36,28,21,0.52)'
  const useReference = style.referencePageRender !== false

  ctx.fillStyle = style.paper || '#f4ecd8'
  ctx.fillRect(0, 0, plan.width, plan.height)

  // 纸纤维：确定性噪点，不依赖随机种子，翻页时不会闪烁。
  for (let i = 0; i < 430; i += 1) {
    const x = (i * 73.13 + (i % 17) * 19.7) % plan.width
    const y = (i * 41.77 + (i % 23) * 11.3) % plan.height
    ctx.fillStyle = i % 3 === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(84,68,42,0.035)'
    ctx.fillRect(x, y, 1, i % 5 === 0 ? 2 : 1)
  }

  // 书脊侧的柔和压暗：左页阴影在右边，右页阴影在左边。
  const gutter = ctx.createLinearGradient(plan.side === 'right' ? 0 : plan.width, 0, plan.side === 'right' ? plan.marginX * 1.9 : plan.width - plan.marginX * 1.9, 0)
  gutter.addColorStop(0, 'rgba(52,37,20,0.17)')
  gutter.addColorStop(0.48, 'rgba(52,37,20,0.045)')
  gutter.addColorStop(1, 'rgba(52,37,20,0)')
  ctx.fillStyle = gutter
  ctx.fillRect(0, 0, plan.width, plan.height)

  // 页眉页脚：参考站是正体小字，不用斜体；两侧由页面自己决定印书名还是章节名。
  // 走 DOM 的页面（静态页、顶层飞页）不再画进纹理，否则纹理里会留下一层糊字。
  if (!useReference && !style.omitBodyText) {
    ctx.fillStyle = muted
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.font = `400 ${plan.headerFontSize}px ${family}`
    ctx.fillText(plan.header || '', plan.width / 2, plan.headerBaseline)
    if (plan.footer) {
      ctx.font = `440 ${plan.footerFontSize}px ${family}`
      ctx.fillText(plan.footer, plan.width / 2, plan.footerBaseline)
    }
  }

  // 正文：先铺标记，再压字，避免半透明色块盖住笔画。
  // 走 DOM 的页面把划线与「注」点也交给文本层，纹理里只留纸面。
  ctx.textAlign = 'left'
  for (const line of plan.lines) {
    ctx.font = `440 ${fontSize}px ${family}`
    const baseline = line.y + line.height * 0.76
    if (!useReference && !style.omitBodyText) {
      for (const mark of line.marks) {
        const before = ctx.measureText(line.text.slice(0, mark.start)).width
        const width = ctx.measureText(line.text.slice(mark.start, mark.end)).width
        ctx.fillStyle = mark.color
        ctx.fillRect(line.x + before - 1, line.y + line.height * 0.18, Math.max(1, width + 2), line.height * 0.74)
      }
      ctx.fillStyle = ink
      ctx.fillText(line.text, line.x, baseline)
      // 纹理在屏幕上是缩小的：22px 的字映射到 12px 左右，细笔画经 mipmap 采样后会被纸色冲淡。
      // 沿字形描一条极细的边补回笔画重量；线宽按字号走，放大字号时不会变成粗体。
      ctx.strokeStyle = ink
      ctx.lineWidth = Math.max(0.3, fontSize * 0.02)
      ctx.strokeText(line.text, line.x, baseline)
      for (const offset of line.noteMarks) {
        const before = ctx.measureText(line.text.slice(0, offset)).width
        ctx.fillStyle = 'rgba(186,112,57,0.9)'
        ctx.beginPath()
        ctx.arc(line.x + before + Math.max(2, fontSize * 0.34), baseline - fontSize * 0.28, Math.max(3, fontSize * 0.18), 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#fff9ef'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.font = `500 ${Math.max(5, fontSize * 0.22)}px sans-serif`
        ctx.fillText('注', line.x + before + Math.max(2, fontSize * 0.34), baseline - fontSize * 0.28)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.font = `440 ${fontSize}px ${family}`
      }
    }
  }

  // 参考站 pageRender：白底墨迹整体 multiply 到纸色上；图片也由它画。
  if (useReference && !style.omitBodyText) {
    const inkLayer = drawPlanInk(plan, style, scale)
    if (inkLayer) {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'multiply'
      ctx.drawImage(inkLayer as CanvasImageSource, 0, 0)
      ctx.restore()
    }
    // 「注」点跟着行的位置，参考站不带这个标记，仍由这里补。
    for (const line of plan.lines) {
      ctx.font = `440 ${fontSize}px ${family}`
      const baseline = line.y + line.height * 0.76
      for (const offset of line.noteMarks) {
        const before = ctx.measureText(line.text.slice(0, offset)).width
        ctx.fillStyle = 'rgba(186,112,57,0.9)'
        ctx.beginPath()
        ctx.arc(line.x + before + Math.max(2, fontSize * 0.34), baseline - fontSize * 0.28, Math.max(3, fontSize * 0.18), 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  // 页内图片与批注卡：走 DOM 的页面（静态页、顶层飞页）交给文本层，
  // 纹理里只留纸面；仍用纹理带字的飞页照旧画在这里。
  if (!style.omitBodyText) {
  // 页内图片：按 contain 装进版心块；还没解码时画一个占位框，图注始终照画。
  for (const box of plan.images) {
    const source = style.images?.get(box.file)
    let sourceWidth = 0
    let sourceHeight = 0
    if (source) {
      sourceWidth = Number((source as { naturalWidth?: number }).naturalWidth ?? 0)
        || Number((source as { width?: number }).width ?? 0)
      sourceHeight = Number((source as { naturalHeight?: number }).naturalHeight ?? 0)
        || Number((source as { height?: number }).height ?? 0)
    }
    if (source && sourceWidth > 0 && sourceHeight > 0) {
      if (!useReference) {
        const imageScale = Math.min(box.width / sourceWidth, box.height / sourceHeight)
        const drawWidth = sourceWidth * imageScale
        const drawHeight = sourceHeight * imageScale
        ctx.drawImage(
          source,
          box.x + (box.width - drawWidth) / 2,
          box.y + (box.height - drawHeight) / 2,
          drawWidth,
          drawHeight,
        )
      }
    } else {
      ctx.fillStyle = 'rgba(83, 67, 42, 0.06)'
      ctx.fillRect(box.x, box.y, box.width, box.height)
      ctx.strokeStyle = 'rgba(120, 90, 50, 0.28)'
      ctx.lineWidth = 1
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1)
      ctx.fillStyle = muted
      ctx.font = `${Math.max(10, fontSize * 0.62)}px ${family}`
      ctx.textAlign = 'center'
      ctx.fillText('图片', box.x + box.width / 2, box.y + box.height / 2)
      ctx.textAlign = 'left'
    }
    if (box.caption) {
      ctx.fillStyle = muted
      ctx.textAlign = 'center'
      ctx.font = `${Math.max(9, fontSize * 0.6)}px ${family}`
      ctx.fillText(box.caption, box.x + box.width / 2, box.y + box.height + lineHeight * 0.72)
      ctx.textAlign = 'left'
    }
  }

  // 便签不在这里画：统一由 drawPlanInk 交给上游 renderPage 内联绘制（含跨页片段与「笔记 · 续」）。
  }

  // 页脚页码也由 DOM 文本层画（见上方页眉页脚段），这里不再重复。

  // 纸边轻微压暗，模拟裁切后的纸口。
  const edge = ctx.createLinearGradient(0, 0, 0, plan.height)
  edge.addColorStop(0, 'rgba(80,62,36,0.035)')
  edge.addColorStop(0.08, 'rgba(80,62,36,0)')
  edge.addColorStop(0.92, 'rgba(80,62,36,0)')
  edge.addColorStop(1, 'rgba(80,62,36,0.045)')
  ctx.fillStyle = edge
  ctx.fillRect(0, 0, plan.width, plan.height)

  return canvas
}

export function textureStyleSignature(page: RealBookTexturePage, style: RealBookTextureStyle): string {
  return JSON.stringify({
    pageNumber: page.pageNumber,
    chapterTitle: page.chapterTitle,
    header: page.header ?? page.chapterTitle,
    items: page.items.map((item) => {
      if (item.kind === 'text') {
        return [
          'text',
          item.originalIndex,
          item.start,
          item.end,
          item.continued,
          item.text,
          item.lines.map((line) => [line.start, line.end]),
          item.highlights.map((highlight) => [highlight.start, highlight.end, highlight.color ?? '']),
          item.noteMarks,
        ]
      }
      if (item.kind === 'image') {
        return ['image', item.file, item.width, item.height, item.caption, Math.round(item.displayHeight)]
      }
      return [
        'note',
        item.note.id,
        item.note.text,
        item.note.tags ?? [],
        item.height,
        item.continued,
        item.continues,
        item.textColor,
        item.lines.map((line) => [
          Math.round(line.y),
          Math.round(line.h),
          line.words.map((word) => word.text).join(''),
        ]),
      ]
    }),
    imageEpoch: style.imageEpoch ?? 0,
    bookTitle: style.bookTitle,
    bookAuthor: style.bookAuthor,
    omitBodyText: style.omitBodyText === true,
    referencePageRender: style.referencePageRender !== false,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    fontFamily: style.fontFamily,
    paragraphGap: clamp(style.paragraphGap, 0, 1000),
    paper: style.paper,
    ink: style.ink,
    muted: style.muted,
    searchQuery: style.searchQuery,
    side: style.side,
    pageWidth: style.pageWidth,
    pageHeight: style.pageHeight,
    marginX: style.marginX,
    marginInner: style.marginInner,
    marginOuter: style.marginOuter,
    marginTop: style.marginTop,
    marginBottom: style.marginBottom,
    highlightColors: style.highlightColors,
  })
}
