/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/book/typography.ts，Apache-2.0。已修改：去掉 .ts 扩展名引用、内联 i18n/笔记
 * Markdown 的最小替身，以接入 spbf 的真实书籍页面纹理。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import type { Block, LiteraryStyle } from './types'

/** Only standalone chapter-number/title pairs, optionally preceded by one image. */
export function annotateChapterOpening(blocks: Block[]) {
  const pair = blocks[0]?.kind === 'img' ? blocks.slice(1) : blocks
  if (pair.length !== 2 || pair.some(b => !['p', 'h1', 'h2', 'h3'].includes(b.kind) || b.literary || b.footnoteDefinition)) return
  const [number, title] = pair
  if (!/^第[零〇一二三四五六七八九十百千万两兩壹贰貳叁參肆伍陆陸柒捌玖拾佰\d０-９]+章$/u.test(number.text.replace(/\s/g, ''))) return
  if (!title.text.trim() || title.text.length > 80 || title.runs.some(r => r.footnote)) return
  number.chapterHeading = 'number'
  title.chapterHeading = 'title'
}

export function isSourceQuote(b: Block): boolean {
  return b.literary?.role === 'quote' || (b.kind === 'quote' && (!b.literary || b.literary.role === 'attribution'))
}

export function literaryRole(tag: string, type: string, role: string, classes: string): LiteraryStyle['role'] | undefined {
  const tokens = new Set(`${type} ${role} ${classes}`.toLowerCase().split(/\s+/))
  if (tokens.has('epigraph') || tokens.has('doc-epigraph')) return 'epigraph'
  if (['poem', 'poetry', 'verse', 'stanza'].some((t) => tokens.has(t))) return 'verse'
  if (tag === 'blockquote') return 'quote'
}

const signature = (text: string) => /^(?:——|—|--)[^。！？!?\n]{1,48}$/u.test(text.trim())
const shortLine = (b: Block) => b.kind === 'p' && !b.literary && b.text.length > 0 &&
  b.text.length <= 64 && !/^[“「『"•●]|^\d+[.、)]/u.test(b.text)

/** Add presentation metadata only. Source strings, runs, IDs and offsets remain intact. */
export function annotateLiteraryBlocks(blocks: Block[]) {
  let group = blocks.reduce((max, b) => Math.max(max, b.literary?.group ?? 0), 0)
  for (let i = 0; i < blocks.length; i++) {
    if (!/^h[1-3]$/.test(blocks[i].kind)) continue
    let end = i + 1
    while (end < blocks.length && end - i <= 25 && shortLine(blocks[end]) && !signature(blocks[end].text)) end++
    const count = end - i - 1
    const attribution = blocks[end]
    const prose = blocks[end + 1]
    // A heading, several short lines, a brief author and following prose must agree.
    if (count < 3 || count > 24 || !attribution || attribution.kind !== 'p' || attribution.literary ||
        !signature(attribution.text) || !prose || prose.kind !== 'p' || prose.literary || prose.text.length < 80) continue
    group++
    for (let j = i + 1; j <= end; j++) blocks[j].literary = {
      role: j === end ? 'attribution' : 'epigraph', group,
    }
    i = end
  }
  blocks.forEach((b, i) => {
    const lit = b.literary
    if (!lit) return
    lit.first = blocks[i - 1]?.literary?.group !== lit.group
    lit.last = blocks[i + 1]?.literary?.group !== lit.group
    if (lit.last && !lit.first && signature(b.text)) lit.role = 'attribution'
  })
}
