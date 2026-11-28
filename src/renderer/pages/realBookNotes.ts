import { decorateText, type DecoSegment } from '@shared/paragraphSearch'
import type { Annotation } from '@shared/types'

/** 页内批注最多展示三行；完整内容在编辑浮层里看。 */
const INLINE_NOTE_LINE_CLAMP = 3
/** 卡片与上文之间的固定间距（px）。 */
export const INLINE_NOTE_GAP_PX = 8

export interface RealBookNote {
  /** Annotation.id */
  id: string
  /** 锚定段落的原始下标 */
  paragraph: number
  /** 锚定段落内的结束偏移 */
  offset: number
  text: string
  source: 'user' | 'ai'
  /** 读者给这条批注打的 #tag（已归一化、不含 #）。 */
  tags?: string[]
  createdAt: string
}

/** 段落里要插入的「注」标记：段内偏移 + 对应批注 id。 */
export interface NoteTextMark {
  id: string
  /** 原始段落内的结束偏移；等于段长时标记落在段末。 */
  offset: number
}

/** 正文片段；`noteId` 非空时这一项渲染成「注」标记，而不是文字。 */
export type NoteTextPart = DecoSegment & { noteId?: string }

/**
 * 把段落文字、搜索命中、划线与「注」标记合成模板可直接渲染的片段。
 *
 * 「注」标记不能把「注」字写进正文文本节点：`paragraphTextNodes` 会把段内所有
 * 文本节点当成原文偏移，多出来的标记字会让选区、朗读与进度锚点整体错位。
 * 所以标记只在模板里渲染成伪元素，文本节点仍与原文逐字对应。
 */
export function decorateTextWithNotes(
  text: string,
  rawQuery: string,
  hlRanges: ReadonlyArray<{ start: number; end: number; color?: string }>,
  marks: readonly NoteTextMark[],
): NoteTextPart[] {
  if (!text) return []
  const sorted = [...marks]
    .filter((mark) => Number.isFinite(mark.offset) && mark.offset >= 0 && mark.offset <= text.length)
    .sort((a, b) => a.offset - b.offset)
  if (!sorted.length) return decorateText(text, rawQuery, hlRanges as Parameters<typeof decorateText>[2])

  const out: NoteTextPart[] = []
  let cursor = 0
  const pushText = (from: number, to: number): void => {
    if (to <= from) return
    const adjusted = hlRanges
      .map((range) => ({ start: range.start - from, end: range.end - from, color: range.color }))
      .filter((range) => range.end > 0 && range.start < to - from)
    out.push(...decorateText(text.slice(from, to), rawQuery, adjusted as Parameters<typeof decorateText>[2]))
  }
  for (const mark of sorted) {
    pushText(cursor, mark.offset)
    out.push({ text: '', hit: false, hl: false, noteId: mark.id })
    cursor = mark.offset
  }
  pushText(cursor, text.length)
  return out
}

/**
 * 从本章有效标注里派生页内批注。
 *
 * 锚点取所选区间的**最后一个字符**所在段：跨段划线时，卡片落在最后一段之后；
 * 只取带 note 的划线，没有话的纯划线仍只渲染底色。
 */
export function deriveRealBookNotes(
  annotations: readonly Annotation[],
  chapterId: string,
  lostIds: ReadonlySet<string>,
  paragraphStarts: readonly number[],
): RealBookNote[] {
  if (!chapterId || !paragraphStarts.length) return []
  const out: RealBookNote[] = []
  for (const annotation of annotations) {
    if (annotation.chapterId !== chapterId || annotation.kind !== 'highlight') continue
    if (lostIds.has(annotation.id)) continue
    const text = annotation.note?.trim()
    if (!text) continue
    const probe = Math.max(annotation.start, annotation.end - 1)
    let paragraph = -1
    for (let i = paragraphStarts.length - 1; i >= 0; i -= 1) {
      if (paragraphStarts[i]! <= probe) {
        paragraph = i
        break
      }
    }
    if (paragraph < 0) continue
    const base = paragraphStarts[paragraph]!
    out.push({
      id: annotation.id,
      paragraph,
      offset: Math.max(0, annotation.end - base),
      text,
      source: annotation.noteSource === 'ai' ? 'ai' : 'user',
      tags: annotation.tags?.length ? [...annotation.tags] : [],
      createdAt: annotation.createdAt,
    })
  }
  return out.sort((a, b) =>
    a.paragraph - b.paragraph
    || a.offset - b.offset
    || a.createdAt.localeCompare(b.createdAt),
  )
}

/**
 * jsdom / 无真实排版环境下的批注卡高度估算；真实浏览器优先用 DOM 量出高度。
 * 估算只服务分页与测试，不参与实际 CSS 布局。
 */
export function estimateInlineNoteHeight(
  text: string,
  contentWidth: number,
  fontSize: number,
  tagCount = 0,
): number {
  // 与 `.real-book-note` 同一条排版比例：标签行、笔记行都从正文字号推出来。
  const noteFont = Math.max(11, fontSize * 0.92)
  const charsPerLine = Math.max(6, Math.floor(contentWidth / (noteFont * 1.05)))
  const lines = Math.min(INLINE_NOTE_LINE_CLAMP, Math.max(1, Math.ceil(text.length / charsPerLine)))
  const header = noteFont * 0.72 * 1.6
  const body = lines * noteFont * 1.65
  const tags = tagCount > 0 ? tagCount * noteFont * 0.72 * 1.55 + noteFont * 0.3 : 0
  const padding = noteFont * 0.5
  return Math.ceil(header + body + tags + padding + INLINE_NOTE_GAP_PX)
}
