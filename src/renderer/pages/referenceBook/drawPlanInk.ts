/**
 * 把 spbf 的纹理页计划交给参考站的 `pageRender` 画墨迹与标记。
 *
 * 参考站的 pageRender 只认它自己的 `Page` / `Line` / `Word` 模型；这里把
 * `PageTexturePlan` 的行、标记和图片映射成同形对象，再原样调用上游的
 * `renderPage`。分页/断行仍由 spbf 的分页器给出（layout 单独再换）。
 *
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */

import {
  contentOrigin,
  renderPage,
  type PageCanvas,
  type RenderOptions,
} from './pageRender'
import { measure, type Line, type Page, type Word } from './layout'
import { MARK_COLORS, type Annotation, type MarkColor } from './annotations'
import type { PageTexturePlan, RealBookTextureStyle } from '../realBookTexture'

function markColor(value: string | undefined): MarkColor {
  if (value && Object.hasOwn(MARK_COLORS, value)) return value as MarkColor
  const hex = String(value ?? '').toLowerCase()
  const hit = (Object.entries(MARK_COLORS) as Array<[MarkColor, { fill: string }]>)
    .find(([, color]) => color.fill.toLowerCase() === hex)
  return hit?.[0] ?? 'yellow'
}

/**
 * 把一页纹理计划映射成参考站 Page 并画到白色画布上。
 *
 * 调用方用 `multiply` 把这张白底墨迹叠到纸色纹理上：白色区域保持纸色，
 * 墨迹/荧光笔按参考站的形状与透明度压深。
 */
export function drawPlanInk(plan: PageTexturePlan, style: RealBookTextureStyle, scale = 2): PageCanvas | null {
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
  const side = plan.side
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
  plan.lines.forEach((line, lineIndex) => {
    const text = line.text
    const width = Math.max(0, measure(font, text))
    const word: Word = {
      text,
      x: line.x - origin.x,
      w: width,
      font,
      s: cursor,
      e: cursor + text.length,
      space: false,
      size: cfg.fontSize,
    }
    const refLine: Line = {
      y: line.y - origin.y,
      h: line.height,
      baseline: line.height * 0.76,
      words: [word],
    }
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
    cursor += text.length
  })
  page.end = cursor

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

  const options: RenderOptions & { ink?: string } = {
    cfg,
    scale,
    bookTitle: style.bookTitle || plan.header || plan.chapterTitle,
    author: style.bookAuthor || '',
    marks: annotations,
    images,
    ink: style.ink,
    muted: style.muted,
  }
  void side
  return renderPage(page, options)
}