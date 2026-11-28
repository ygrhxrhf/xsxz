import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { RootContent, PhrasingContent, Definition } from 'mdast'
import type { TextRun } from './types'

export interface NoteRun extends TextRun {
  strike?: boolean
  code?: boolean
  href?: string
}
export interface NoteBlock {
  kind: 'paragraph' | 'heading' | 'code' | 'rule' | 'table'
  runs: NoteRun[]
  indent: number
  quote: number
  heading?: number
  marker?: string
  cells?: NoteRun[][]
  align?: ('left' | 'right' | 'center' | null)[]
  tableHeader?: boolean
}

const parser = unified().use(remarkParse).use(remarkGfm)

/** Notes have no base URL: only explicit, safe external links are navigable. */
export function noteLink(url: string): string | undefined {
  return /^(https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : undefined
}

/** Shared by book-page ink and the editor preview; never executes embedded HTML. */
export function parseNoteMarkdown(source: string): NoteBlock[] {
  const tree = parser.parse(source)
  const definitions = new Map<string, Definition>()
  const collect = (nodes: RootContent[]) => {
    for (const node of nodes) {
      if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node)
      if ('children' in node) collect(node.children as RootContent[])
    }
  }
  collect(tree.children)
  const inline = (nodes: PhrasingContent[], style: Omit<NoteRun, 'text'> = {}): NoteRun[] => nodes.flatMap((node): NoteRun[] => {
    switch (node.type) {
      case 'strong': return inline(node.children, { ...style, bold: true })
      case 'emphasis': return inline(node.children, { ...style, italic: true })
      case 'delete': return inline(node.children, { ...style, strike: true })
      case 'inlineCode': return [{ ...style, text: node.value, mono: true, code: true }]
      case 'break': return [{ ...style, text: '\n' }]
      case 'link': return inline(node.children, { ...style, href: noteLink(node.url) })
      case 'linkReference': return inline(node.children, { ...style, href: noteLink(definitions.get(node.identifier.toLowerCase())?.url ?? '') })
      // Image references stay readable in printed book pages, without remote requests.
      case 'image': return [{ ...style, text: node.alt || node.url, href: noteLink(node.url) }]
      case 'imageReference': return [{ ...style, text: node.alt || node.label || node.identifier, href: noteLink(definitions.get(node.identifier.toLowerCase())?.url ?? '') }]
      case 'footnoteReference': return [{ ...style, text: `[${node.label || node.identifier}]`, sup: true }]
      default:
        return 'value' in node ? [{ ...style, text: node.value }] : []
    }
  })
  const blocks: NoteBlock[] = []
  const visit = (nodes: RootContent[], indent = 0, quote = 0) => {
    for (const node of nodes) {
      const base = { indent, quote }
      switch (node.type) {
        case 'paragraph': blocks.push({ ...base, kind: 'paragraph', runs: inline(node.children) }); break
        case 'heading': blocks.push({ ...base, kind: 'heading', heading: node.depth, runs: inline(node.children, { bold: true }) }); break
        case 'blockquote': visit(node.children, indent, quote + 1); break
        case 'list':
          node.children.forEach((item, i) => {
            const start = blocks.length
            visit(item.children, indent + 1, quote)
            if (blocks.length === start) blocks.push({ ...base, indent: indent + 1, kind: 'paragraph', runs: [] })
            blocks[start].marker = item.checked != null ? (item.checked ? '☑' : '☐') : node.ordered ? `${(node.start ?? 1) + i}.` : '•'
          })
          break
        case 'code':
          for (const text of node.value.replace(/\t/g, '    ').split('\n')) blocks.push({ ...base, kind: 'code', runs: [{ text, mono: true }] })
          break
        case 'thematicBreak': blocks.push({ ...base, kind: 'rule', runs: [] }); break
        case 'table':
          node.children.forEach((row, i) => blocks.push({ ...base, kind: 'table', runs: [], cells: row.children.map(cell => inline(cell.children, { bold: i === 0 })), align: node.align ?? undefined, tableHeader: i === 0 }))
          break
        case 'footnoteDefinition': {
          const start = blocks.length
          visit(node.children as RootContent[], indent, quote)
          const labelRun: NoteRun = { text: `[${node.label || node.identifier}] `, bold: true }
          if (blocks.length === start) blocks.push({ ...base, kind: 'paragraph', runs: [labelRun] })
          else blocks[start].runs = [labelRun, ...blocks[start].runs]
          break
        }
        case 'html': blocks.push({ ...base, kind: 'paragraph', runs: [{ text: node.value }] }); break
        case 'definition': break
        default: if ('children' in node) visit(node.children as RootContent[], indent, quote)
      }
    }
  }
  visit(tree.children)
  return blocks
}

/** Plain summary for compact sidebar cards; full notes retain rich book-page rendering. */
export function noteMarkdownSummary(source: string): string {
  return parseNoteMarkdown(source).map(block => (block.marker ? block.marker + ' ' : '') +
    (block.cells ? block.cells.map(cell => cell.map(run => run.text).join('')).join(' · ') : block.runs.map(run => run.text).join(''))).join('\n')
}


