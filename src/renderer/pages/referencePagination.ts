/**
 * 参考站 `layout.paginate` 到 spbf 页模型（RealBookPage）的适配层。
 *
 * 为什么需要两层：Reader 的锚点、进度、批注、AI 证据都建立在「段落下标 + 段内偏移」上，
 * 而参考站的 `Page` 用章节字符偏移。这里用参考站分页得到断行/分页/标题页/图片/笔记
 * 的真实位置，再映射回 spbf 的 `RealBookPage`，两套坐标通过章节偏移一一对应。
 *
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */

import { paginate } from './referenceBook/layout'
import type { LayoutConfig, Paginated, Page, Word } from './referenceBook/layout'
import type { Block, ParsedBook } from './referenceBook/types'
import type { Annotation } from './referenceBook/annotations'
import type { ChapterImageRef } from '@shared/chapterImages'
import { parseChapterImage } from '@shared/chapterImages'
import type {
  RealBookImageItem,
  RealBookNoteItem,
  RealBookPage,
  RealBookPageItem,
  RealBookTextItem,
} from './realBookPager'
import type { RealBookNote } from './realBookNotes'

export interface ReferencePaginationLayout {
  pageWidth: number
  pageHeight: number
  marginTop: number
  marginBottom: number
  marginInner: number
  marginOuter: number
  fontSize: number
  /** 行距倍率（1.5 等），不是像素。 */
  lineHeight: number
  family: string
  singlePage: boolean
}

export interface ReferencePaginationInput {
  chapterTitle: string
  paragraphs: readonly string[]
  paragraphIndexes: readonly number[]
  notes: readonly RealBookNote[]
  showNotes: boolean
  layout: ReferencePaginationLayout
}

interface Meta {
  kind: 'p' | 'img' | 'caption'
  /** 输入段落下标 */
  para: number
  start: number
  end: number
}

interface TextGroup {
  kind: 'text'
  y: number
  para: number
  start: number
  end: number
  lines: Array<{ start: number; end: number }>
}

interface EventImage {
  kind: 'image'
  y: number
  item: RealBookImageItem
}

interface EventNote {
  kind: 'note'
  y: number
  item: RealBookNoteItem
}

type PageEvent = TextGroup | EventImage | EventNote

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

/**
 * 把 spbf 的段落数组变成参考站 ParsedBook：图片标记拆成 img 块，图注拆成居中的短段。
 * `Meta` 记录每个块对应哪个输入段落，后面把字符偏移映射回来。
 */
function buildBook(input: ReferencePaginationInput): {
  book: ParsedBook
  metas: Meta[]
  images: Map<string, { ref: ChapterImageRef; para: number }>
} {
  const blocks: Block[] = []
  const metas: Meta[] = []
  const images = new Map<string, { ref: ChapterImageRef; para: number }>()
  let offset = 0
  input.paragraphs.forEach((raw, para) => {
    const text = raw ?? ''
    const image = parseChapterImage(text)
    if (image) {
      blocks.push({
        kind: 'img',
        runs: [],
        text: '',
        start: offset,
        img: { path: image.file, alt: image.caption, w: image.width, h: image.height },
      })
      metas.push({ kind: 'img', para, start: offset, end: offset })
      images.set(image.file, { ref: image, para })
      offset += 1
      if (image.caption) {
        blocks.push({
          kind: 'p',
          runs: [{ text: image.caption }],
          text: image.caption,
          start: offset,
          align: 'center',
          noIndent: true,
        })
        metas.push({ kind: 'caption', para, start: offset, end: offset + image.caption.length })
        offset += image.caption.length + 1
      }
      return
    }
    blocks.push({ kind: 'p', runs: [{ text }], text, start: offset })
    metas.push({ kind: 'p', para, start: offset, end: offset + text.length })
    offset += text.length + 1
  })
  const textLength = Math.max(0, offset - 1)
  const book: ParsedBook = {
    meta: { title: input.chapterTitle, author: '', language: 'zh-CN' },
    chapters: [{ index: 0, href: '', title: input.chapterTitle, blocks, textLength }],
    toc: [],
    getImage: async () => null,
  }
  return { book, metas, images }
}

function metaAt(metas: readonly Meta[], offset: number): Meta | null {
  let lo = 0
  let hi = metas.length - 1
  let hit: Meta | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const meta = metas[mid]!
    if (meta.start <= offset) {
      hit = meta
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (!hit) return null
  if (hit.kind === 'img') return offset === hit.start ? hit : null
  return offset <= hit.end ? hit : null
}

function noteAnnotations(input: ReferencePaginationInput, metas: readonly Meta[]): Annotation[] {
  if (!input.showNotes) return []
  const out: Annotation[] = []
  for (const note of input.notes) {
    const para = input.paragraphIndexes.indexOf(note.paragraph)
    if (para < 0) continue
    const meta = metas.find((item) => item.para === para && item.kind === 'p')
    if (!meta) continue
    const length = meta.end - meta.start
    const end = meta.start + clamp(note.offset, 1, Math.max(1, length))
    const start = Math.max(meta.start, end - 1)
    if (end <= start) continue
    out.push({
      id: note.id,
      bookId: 'spbf',
      locator: { chapter: 0, start, end },
      quote: '',
      kind: 'highlight',
      color: 'yellow',
      note: {
        text: note.text,
        textColor: 'default',
        // 上游 placeNote 用 noteFontFamily(a.note.font, cfg.family) 定便签字体；
        // 缺字段会落到 noteFontIdOf(undefined) = 'inherit'，便签就与正文同体，
        // 手写感全丢。spbf 没有字体选择 UI，沿用上游默认的霞鹜文楷。
        font: 'wenkai',
        tags: note.tags?.slice(0, 5),
        x: 0,
        y: 0,
        rot: 0,
      },
      createdAt: Date.parse(note.createdAt) || 0,
      updatedAt: 0,
    })
  }
  return out
}

/** 一行里按「段落 → 首尾字符偏移」切出的连续词块。 */
function lineRuns(line: { words: Word[] }, metas: readonly Meta[]): Array<{ para: number; start: number; end: number; first: number }> {
  const runs: Array<{ para: number; start: number; end: number; first: number }> = []
  for (const word of line.words) {
    if (word.s < 0) continue
    const meta = metaAt(metas, word.s)
    if (!meta || meta.kind !== 'p') continue
    const start = word.s - meta.start
    const end = Math.max(start, word.e - meta.start)
    const last = runs[runs.length - 1]
    if (last && last.para === meta.para) last.end = end
    else runs.push({ para: meta.para, start, end, first: word.s })
  }
  return runs
}

function convertPage(
  page: Page,
  metas: readonly Meta[],
  input: ReferencePaginationInput,
  images: Map<string, { ref: ChapterImageRef; para: number }>,
  seen: Set<number>,
): RealBookPage {
  if (page.special) {
    return { items: [], paragraph: 0, offset: 0, special: page.special, label: page.label, source: page }
  }
  const paragraphStarts = new Map<number, number>()
  for (const line of page.lines) {
    for (const word of line.words) {
      if (word.s < 0) continue
      const meta = metaAt(metas, word.s)
      if (meta && meta.kind === 'p' && !paragraphStarts.has(meta.para)) paragraphStarts.set(meta.para, meta.start)
    }
  }
  const events: PageEvent[] = []
  // 同一段落在连续行里合并成一个文本块；遇到图片/换段/空行就断开。
  let previousLine: TextGroup[] = []
  for (const line of page.lines) {
    const runs = lineRuns(line, metas)
    if (!runs.length) {
      previousLine = []
      continue
    }
    const lineGroups: TextGroup[] = []
    for (const run of runs) {
      const previous = previousLine.find((group) => group.para === run.para)
      if (previous) {
        previous.start = Math.min(previous.start, run.start)
        previous.end = Math.max(previous.end, run.end)
        previous.lines.push({ start: run.start, end: run.end })
        lineGroups.push(previous)
      } else {
        const group: TextGroup = {
          kind: 'text',
          y: line.y,
          para: run.para,
          start: run.start,
          end: run.end,
          lines: [{ start: run.start, end: run.end }],
        }
        events.push(group)
        lineGroups.push(group)
      }
    }
    previousLine = lineGroups
  }
  // 换段时 lineRuns 会另起；上面的 current 只在同段连续行里合并。
  for (const image of page.images) {
    const info = images.get(image.path)
    if (!info) continue
    events.push({
      kind: 'image',
      y: image.y,
      item: {
        kind: 'image',
        file: image.path,
        width: info.ref.width,
        height: info.ref.height,
        caption: info.ref.caption,
        displayHeight: image.h,
        paragraph: info.para,
        anchorOffset: 0,
      },
    })
  }
  for (const note of page.notes ?? []) {
    // 对照上游 book/layout.ts placeNote（:667-705）：便签只由 locator 决定落点，不看块类型。
    // 本地 noteAnnotations 已把锚点限定在段落块内，这里只需定位到该段；
    // 不再额外丢弃 kind !== 'p' 的命中，避免便签在块边界上消失。
    const meta = metaAt(metas, note.locator.start)
    if (!meta) continue
    events.push({
      kind: 'note',
      y: note.y,
      item: {
        kind: 'note',
        noteId: note.id,
        paragraph: meta.para,
        anchorOffset: clamp(note.locator.end - meta.start, 0, meta.end - meta.start),
        height: note.h,
        // Preserve upstream fragment structure for inline note rendering
        continued: note.continued,
        continues: note.continues,
        lines: note.lines,
        textColor: note.textColor,
      },
    })
  }
  events.sort((a, b) => a.y - b.y)
  const items: RealBookPageItem[] = []
  let firstText: RealBookTextItem | null = null
  for (const event of events) {
    if (event.kind === 'text') {
      const item: RealBookTextItem = {
        kind: 'text',
        paragraph: event.para,
        start: event.start,
        end: event.end,
        continued: seen.has(event.para),
        lines: event.lines,
      }
      if (!firstText) firstText = item
      items.push(item)
      seen.add(event.para)
    } else {
      items.push(event.item)
    }
  }
  const paragraph = firstText?.paragraph ?? 0
  const offset = firstText?.start ?? 0
  return { items, paragraph, offset, label: page.label, source: page, paragraphStarts }
}

/** 分页 + 映射成 spbf 的页模型。 */
export async function paginateReferenceChapter(input: ReferencePaginationInput): Promise<{
  pages: RealBookPage[]
  paginated: Paginated
}> {
  const { book, metas, images } = buildBook(input)
  const cfg: LayoutConfig = {
    singlePage: input.layout.singlePage,
    pageW: input.layout.pageWidth,
    pageH: input.layout.pageHeight,
    marginTop: input.layout.marginTop,
    marginBottom: input.layout.marginBottom,
    marginInner: input.layout.marginInner,
    marginOuter: input.layout.marginOuter,
    fontSize: input.layout.fontSize,
    lineHeight: input.layout.lineHeight,
    family: input.layout.family,
  }
  const annotations = noteAnnotations(input, metas)
  const paginated = await paginate(book, cfg, undefined, annotations)
  const seen = new Set<number>()
  const pages = paginated.pages.map((page) => convertPage(page, metas, input, images, seen))
  return { pages, paginated }
}
