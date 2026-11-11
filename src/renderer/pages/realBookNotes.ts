import type { Annotation } from '@shared/types'

/** 页内批注最多展示三行；完整内容在编辑浮层里看。 */
export const INLINE_NOTE_LINE_CLAMP = 3
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
  createdAt: string
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
): number {
  const noteFont = Math.max(11, fontSize * 0.8)
  const charsPerLine = Math.max(6, Math.floor(contentWidth / (noteFont * 1.05)))
  const lines = Math.min(INLINE_NOTE_LINE_CLAMP, Math.max(1, Math.ceil(text.length / charsPerLine)))
  const header = noteFont * 1.6
  const body = lines * noteFont * 1.5
  const padding = noteFont * 1.4
  return Math.ceil(header + body + padding + INLINE_NOTE_GAP_PX)
}
