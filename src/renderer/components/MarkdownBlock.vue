<script lang="ts">
/**
 * 模型回答的轻量 Markdown 渲染。
 *
 * 为什么不用 v-html：项目有一条硬约束——远端内容不得决定页面结构。
 * 这里只把 **粗体**、*斜体*、`代码`、标题、列表、引用和代码块认出来，
 * 全部用 VNode 拼出来；其余字符一律按文本渲染，天然不执行任何 HTML。
 */
import { defineComponent, h, type VNode } from 'vue'

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g

function inline(text: string): Array<VNode | string> {
  const out: Array<VNode | string> = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const token = match[0]
    const at = match.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    if (token.startsWith('**')) out.push(h('strong', token.slice(2, -2)))
    else if (token.startsWith('`')) out.push(h('code', token.slice(1, -1)))
    else out.push(h('em', token.slice(1, -1)))
    last = at + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default defineComponent({
  name: 'MarkdownBlock',
  props: { source: { type: String, default: '' } },
  setup(props) {
    return () => {
      const lines = props.source.replace(/\r\n/g, '\n').split('\n')
      const blocks: VNode[] = []
      let paragraph: string[] = []
      let list: { ordered: boolean; items: string[] } | null = null
      let quote: string[] = []

      const flushParagraph = (): void => {
        if (!paragraph.length) return
        blocks.push(h('p', inline(paragraph.join(' '))))
        paragraph = []
      }
      const flushList = (): void => {
        if (!list) return
        blocks.push(h(list.ordered ? 'ol' : 'ul', list.items.map((item) => h('li', inline(item)))))
        list = null
      }
      const flushQuote = (): void => {
        if (!quote.length) return
        blocks.push(h('blockquote', inline(quote.join(' '))))
        quote = []
      }
      const flushAll = (): void => { flushParagraph(); flushList(); flushQuote() }

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!.trimEnd()
        const trimmed = line.trim()
        if (!trimmed) { flushAll(); continue }
        // 代码块：整段原样保留，不做任何行内解析。
        if (trimmed.startsWith('```')) {
          flushAll()
          const code: string[] = []
          for (index += 1; index < lines.length && !lines[index]!.trim().startsWith('```'); index += 1) code.push(lines[index]!)
          blocks.push(h('pre', [h('code', code.join('\n'))]))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
        if (heading) {
          flushAll()
          blocks.push(h(`h${Math.min(6, heading[1]!.length + 2)}`, inline(heading[2]!)))
          continue
        }
        const bullet = /^[-*+]\s+(.*)$/.exec(trimmed)
        if (bullet) {
          flushParagraph(); flushQuote()
          if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] } }
          list.items.push(bullet[1]!)
          continue
        }
        const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed)
        if (ordered) {
          flushParagraph(); flushQuote()
          if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] } }
          list.items.push(ordered[1]!)
          continue
        }
        if (trimmed.startsWith('>')) {
          flushParagraph(); flushList()
          quote.push(trimmed.replace(/^>\s?/, ''))
          continue
        }
        flushList(); flushQuote()
        paragraph.push(trimmed)
      }
      flushAll()
      return h('div', { class: 'md-body' }, blocks)
    }
  },
})
</script>
