/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/book/imageFootnotes.ts，Apache-2.0。已修改：去掉 .ts 扩展名引用、内联 i18n/笔记
 * Markdown 的最小替身，以接入 spbf 的真实书籍页面纹理。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import type { Block, TextRun } from './types'

/** Layout-only reconstruction. Keep the parsed blocks/text and all stored offsets intact. */
export function inlineImageFootnotes(blocks: Block[]): Block[] {
  const result: Block[] = []
  for (let i = 0; i < blocks.length;) {
    const first = blocks[i]
    const textOrNote = (b: Block) => b.kind !== 'hr' && (b.kind !== 'img' || !!b.img?.footnote)
    let end = i + 1
    if (first.flowId !== undefined && textOrNote(first)) {
      while (end < blocks.length && blocks[end].flowId === first.flowId &&
        blocks[end].footnoteDefinition === first.footnoteDefinition && textOrNote(blocks[end])) end++
    }
    const group = blocks.slice(i, end)
    if (!group.some(b => b.img?.footnote)) result.push(...group)
    else {
      const base = group.find(b => b.kind !== 'img') ?? { ...first, kind: 'p' as const, align: undefined }
      const runs: TextRun[] = []
      let text = ''
      for (const block of group) {
        // Original block separators still consume exactly their original offsets.
        const gap = ' '.repeat(Math.max(0, block.start - first.start - text.length))
        if (gap) { runs.push({ text: gap }); text += gap }
        if (block.img?.footnote) {
          // An image has no source text. Its badge must not insert a character into
          // saved anchors, even at the very end of a chapter.
          runs.push({ text: '', footnote: block.img.footnote })
        } else { runs.push(...block.runs); text += block.text }
      }
      const literary = base.literary ? { ...base.literary, first: first.literary?.first, last: group.at(-1)?.literary?.last } : undefined
      result.push({ ...base, literary, start: first.start, text, runs, img: undefined, ids: group.flatMap(b => b.ids ?? []) })
    }
    i = end
  }
  return result
}
