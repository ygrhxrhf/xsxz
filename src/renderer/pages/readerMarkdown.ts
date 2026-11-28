/**
 * AI 回答的 Markdown 渲染：把模型返回的 Markdown 转成可安全插入 DOM 的 HTML 片段。
 *
 * 为什么要自己渲染而不是直接 v-html 原始文本：
 * 模型经常返回 `**用法**`、`- 例：…`、``code`` 这类 Markdown，直接当纯文本显示就会露出星号；
 * 而把模型输出直接塞进 v-html 又等于让远端内容决定页面结构。
 *
 * 安全边界（本文件唯一的职责）：
 * - 只认 Markdown 语法，内嵌 HTML 一律按文本转义，不执行；
 * - 链接只放行 http(s) 与 mailto，其余丢弃链接只留文字；
 * - 产出的标签全部由这里生成，不来自输入。
 */
import { defineComponent, h, type VNodeChild } from 'vue'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, RootContent, PhrasingContent, Definition } from 'mdast'

const parser = unified().use(remarkParse).use(remarkGfm)

interface MarkdownRenderContext {
  definitions: Map<string, Definition>
}

function collectDefinitions(root: Root): MarkdownRenderContext {
  const definitions = new Map<string, Definition>()
  const visit = (nodes: RootContent[]) => {
    for (const node of nodes) {
      if (node.type === 'definition') {
        definitions.set(node.identifier.toLowerCase(), node)
      }
      if ('children' in node && Array.isArray(node.children)) {
        visit(node.children as RootContent[])
      }
    }
  }
  visit(root.children)
  return { definitions }
}

/** HTML 文本转义：内容一律先转义再拼标签，顺序不能反。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 只放行可安全跳转的协议；其余返回 null，调用方降级成纯文本。 */
export function safeLinkHref(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed
  return null
}

function renderInline(nodes: PhrasingContent[], ctx: MarkdownRenderContext): string {
  return nodes.map((node): string => {
    switch (node.type) {
      case 'text':
        return escapeHtml(node.value).replace(/\r?\n/g, '<br>')
      case 'strong':
        return `<strong>${renderInline(node.children, ctx)}</strong>`
      case 'emphasis':
        return `<em>${renderInline(node.children, ctx)}</em>`
      case 'delete':
        return `<del>${renderInline(node.children, ctx)}</del>`
      case 'inlineCode':
        return `<code>${escapeHtml(node.value)}</code>`
      case 'break':
        return '<br>'
      case 'link': {
        const href = safeLinkHref(node.url)
        const inner = renderInline(node.children, ctx)
        const titleAttr = node.title ? ` title="${escapeHtml(node.title)}"` : ''
        return href
          ? `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noreferrer noopener">${inner}</a>`
          : inner
      }
      case 'linkReference': {
        const def = ctx.definitions.get(node.identifier.toLowerCase())
        const href = def ? safeLinkHref(def.url) : null
        const inner = renderInline(node.children, ctx)
        const titleAttr = def?.title ? ` title="${escapeHtml(def.title)}"` : ''
        return href
          ? `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noreferrer noopener">${inner}</a>`
          : inner
      }
      case 'image':
        // 图片不外链加载：只保留替代文字，避免回答里出现第三方请求。
        return `<span class="md-image-alt">${escapeHtml(node.alt || node.title || node.url)}</span>`
      case 'imageReference': {
        const def = ctx.definitions.get(node.identifier.toLowerCase())
        const label = node.alt || def?.title || node.label || node.identifier || def?.url || ''
        return `<span class="md-image-alt">${escapeHtml(label)}</span>`
      }
      case 'footnoteReference': {
        const label = node.label || node.identifier
        return `<sup class="md-footnote-ref">[${escapeHtml(label)}]</sup>`
      }
      default:
        if ('value' in node && typeof node.value === 'string') return escapeHtml(node.value)
        if ('children' in node) return renderInline(node.children as PhrasingContent[], ctx)
        return ''
    }
  }).join('')
}

/** 列表用真实 <ol>/<ul> 输出，嵌套与有序编号都由 DOM 负责。 */
function renderList(node: Extract<RootContent, { type: 'list' }>, ctx: MarkdownRenderContext): string {
  const tag = node.ordered ? 'ol' : 'ul'
  const start = node.ordered && node.start && node.start !== 1 ? ` start="${node.start}"` : ''
  const items = node.children.map((item) => {
    const checkbox = item.checked == null ? '' : `<span class="md-check">${item.checked ? '☑' : '☐'}</span> `
    // 首段保持内联以免单段列表项行距过大；多段列表项从第二段起保留 <p> 分隔。
    let paragraphCount = 0
    const inner = item.children.map((child): string => {
      if (child.type === 'paragraph') {
        paragraphCount += 1
        const content = renderInline(child.children, ctx)
        return paragraphCount === 1 ? content : `<p>${content}</p>`
      }
      return renderBlock(child, ctx)
    }).join('')
    return `<li>${checkbox}${inner}</li>`
  }).join('')
  return `<${tag}${start}>${items}</${tag}>`
}

function renderBlock(node: RootContent, ctx: MarkdownRenderContext): string {
  switch (node.type) {
    case 'paragraph':
      return `<p>${renderInline(node.children, ctx)}</p>`
    case 'heading': {
      const depth = Math.min(6, Math.max(1, node.depth))
      return `<h${depth}>${renderInline(node.children, ctx)}</h${depth}>`
    }
    case 'list':
      return renderList(node, ctx)
    case 'blockquote':
      return `<blockquote>${node.children.map((child) => renderBlock(child, ctx)).join('')}</blockquote>`
    case 'code': {
      const lang = node.lang?.trim() || ''
      const preAttr = lang ? ` class="md-pre" data-lang="${escapeHtml(lang)}"` : ' class="md-pre"'
      const codeAttr = lang ? ` class="language-${escapeHtml(lang)}"` : ''
      return `<pre${preAttr}><code${codeAttr}>${escapeHtml(node.value)}</code></pre>`
    }
    case 'thematicBreak':
      return '<hr>'
    case 'table': {
      const head = node.children[0]
      const body = node.children.slice(1)
      const aligns = node.align ?? []
      const cell = (cellNode: PhrasingContent[], tag: 'th' | 'td', colIndex: number): string => {
        const align = aligns[colIndex]
        const styleAttr =
          align === 'left' || align === 'center' || align === 'right'
            ? ` style="text-align: ${align}"`
            : ''
        return `<${tag}${styleAttr}>${renderInline(cellNode, ctx)}</${tag}>`
      }
      return [
        '<div class="md-table-wrap"><table>',
        head ? `<thead><tr>${head.children.map((c, idx) => cell(c.children, 'th', idx)).join('')}</tr></thead>` : '',
        body.length
          ? `<tbody>${body.map((row) => `<tr>${row.children.map((c, idx) => cell(c.children, 'td', idx)).join('')}</tr>`).join('')}</tbody>`
          : '',
        '</table></div>',
      ].join('')
    }
    case 'footnoteDefinition': {
      const label = node.label || node.identifier
      let paragraphCount = 0
      const bodyHtml = node.children
        .map((child): string => {
          if (child.type === 'paragraph') {
            paragraphCount += 1
            const content = renderInline(child.children, ctx)
            return paragraphCount === 1 ? content : `<br>${content}`
          }
          return renderBlock(child, ctx)
        })
        .join('')
      return `<div class="md-footnote-def" data-footnote-id="${escapeHtml(node.identifier)}"><span class="md-footnote-label">[${escapeHtml(label)}]</span><span class="md-footnote-body">${bodyHtml}</span></div>`
    }
    case 'definition':
      return ''
    case 'html':
      // 不执行内嵌 HTML：原样转义后作为段落文本。
      return `<p>${escapeHtml(node.value)}</p>`
    default:
      if ('children' in node) return (node.children as RootContent[]).map((child) => renderBlock(child, ctx)).join('')
      return ''
  }
}

/**
 * Markdown → 安全 HTML。流式生成期间也可直接调用：不完整的语法按普通文本渲染，
 * 不会抛错，下一帧重新渲染即可。
 */
export function renderMarkdownHtml(source: string): string {
  if (!source.trim()) return ''
  let tree: Root
  try {
    tree = parser.parse(source)
  } catch {
    return `<p>${escapeHtml(source)}</p>`
  }
  const ctx = collectDefinitions(tree)
  return tree.children.map((node) => renderBlock(node, ctx)).join('')
}

function renderTextWithSoftBreaks(text: string): VNodeChild[] {
  const parts = text.split(/\r?\n/)
  if (parts.length === 1) return [text]
  const out: VNodeChild[] = []
  parts.forEach((part, index) => {
    if (index > 0) out.push(h('br'))
    if (part) out.push(part)
  })
  return out
}

function renderInlineVNodes(nodes: PhrasingContent[], ctx: MarkdownRenderContext): VNodeChild[] {
  return nodes.flatMap((node): VNodeChild[] => {
    switch (node.type) {
      case 'text':
        return renderTextWithSoftBreaks(node.value)
      case 'strong':
        return [h('strong', renderInlineVNodes(node.children, ctx))]
      case 'emphasis':
        return [h('em', renderInlineVNodes(node.children, ctx))]
      case 'delete':
        return [h('del', renderInlineVNodes(node.children, ctx))]
      case 'inlineCode':
        return [h('code', node.value)]
      case 'break':
        return [h('br')]
      case 'link': {
        const href = safeLinkHref(node.url)
        const inner = renderInlineVNodes(node.children, ctx)
        return href
          ? [
              h(
                'a',
                {
                  href,
                  ...(node.title ? { title: node.title } : {}),
                  target: '_blank',
                  rel: 'noreferrer noopener',
                },
                inner,
              ),
            ]
          : inner
      }
      case 'linkReference': {
        const def = ctx.definitions.get(node.identifier.toLowerCase())
        const href = def ? safeLinkHref(def.url) : null
        const inner = renderInlineVNodes(node.children, ctx)
        return href
          ? [
              h(
                'a',
                {
                  href,
                  ...(def?.title ? { title: def.title } : {}),
                  target: '_blank',
                  rel: 'noreferrer noopener',
                },
                inner,
              ),
            ]
          : inner
      }
      case 'image':
        return [h('span', { class: 'md-image-alt' }, node.alt || node.title || node.url)]
      case 'imageReference': {
        const def = ctx.definitions.get(node.identifier.toLowerCase())
        const label = node.alt || def?.title || node.label || node.identifier || def?.url || ''
        return [h('span', { class: 'md-image-alt' }, label)]
      }
      case 'footnoteReference': {
        const label = node.label || node.identifier
        return [h('sup', { class: 'md-footnote-ref' }, `[${label}]`)]
      }
      default:
        if ('value' in node && typeof node.value === 'string') return [node.value]
        if ('children' in node) return renderInlineVNodes(node.children as PhrasingContent[], ctx)
        return []
    }
  })
}

function renderListVNode(node: Extract<RootContent, { type: 'list' }>, ctx: MarkdownRenderContext): VNodeChild {
  const tag = node.ordered ? 'ol' : 'ul'
  const props = node.ordered && node.start && node.start !== 1 ? { start: node.start } : undefined
  const items = node.children.map((item) => {
    const children: VNodeChild[] = []
    if (item.checked != null) {
      children.push(h('span', { class: 'md-check' }, item.checked ? '☑' : '☐'), ' ')
    }
    let paragraphCount = 0
    for (const child of item.children) {
      if (child.type === 'paragraph') {
        paragraphCount += 1
        const content = renderInlineVNodes(child.children, ctx)
        if (paragraphCount === 1) children.push(...content)
        else children.push(h('p', content))
      } else {
        children.push(renderBlockVNode(child, ctx))
      }
    }
    return h('li', children)
  })
  return h(tag, props, items)
}

function renderBlockVNode(node: RootContent, ctx: MarkdownRenderContext): VNodeChild {
  switch (node.type) {
    case 'paragraph':
      return h('p', renderInlineVNodes(node.children, ctx))
    case 'heading': {
      const depth = Math.min(6, Math.max(1, node.depth))
      return h(`h${depth}`, renderInlineVNodes(node.children, ctx))
    }
    case 'list':
      return renderListVNode(node, ctx)
    case 'blockquote':
      return h('blockquote', node.children.map((child) => renderBlockVNode(child, ctx)))
    case 'code': {
      const lang = node.lang?.trim() || ''
      const preProps: Record<string, string> = { class: 'md-pre' }
      if (lang) preProps['data-lang'] = lang
      const codeProps = lang ? { class: `language-${lang}` } : undefined
      return h('pre', preProps, [h('code', codeProps, node.value)])
    }
    case 'thematicBreak':
      return h('hr')
    case 'table': {
      const head = node.children[0]
      const body = node.children.slice(1)
      const aligns = node.align ?? []
      const cellVNode = (cellNode: PhrasingContent[], tag: 'th' | 'td', colIndex: number): VNodeChild => {
        const align = aligns[colIndex]
        const props =
          align === 'left' || align === 'center' || align === 'right'
            ? { style: { textAlign: align } }
            : undefined
        return h(tag, props, renderInlineVNodes(cellNode, ctx))
      }
      return h('div', { class: 'md-table-wrap' }, [
        h('table', [
          head ? h('thead', [h('tr', head.children.map((c, idx) => cellVNode(c.children, 'th', idx)))]) : null,
          body.length
            ? h(
                'tbody',
                body.map((row) => h('tr', row.children.map((c, idx) => cellVNode(c.children, 'td', idx)))),
              )
            : null,
        ]),
      ])
    }
    case 'footnoteDefinition': {
      const label = node.label || node.identifier
      const bodyChildren: VNodeChild[] = []
      let paragraphCount = 0
      for (const child of node.children) {
        if (child.type === 'paragraph') {
          paragraphCount += 1
          if (paragraphCount > 1) bodyChildren.push(h('br'))
          bodyChildren.push(...renderInlineVNodes(child.children, ctx))
        } else {
          bodyChildren.push(renderBlockVNode(child, ctx))
        }
      }
      return h('div', { class: 'md-footnote-def', 'data-footnote-id': node.identifier }, [
        h('span', { class: 'md-footnote-label' }, `[${label}]`),
        h('span', { class: 'md-footnote-body' }, bodyChildren),
      ])
    }
    case 'definition':
      return null
    case 'html':
      return h('p', node.value)
    default:
      if ('children' in node) return (node.children as RootContent[]).map((child) => renderBlockVNode(child, ctx))
      return null
  }
}

export function renderMarkdownVNodes(source: string): VNodeChild[] {
  if (!source.trim()) return []
  let tree: Root
  try {
    tree = parser.parse(source)
  } catch {
    return [h('p', source)]
  }
  const ctx = collectDefinitions(tree)
  return tree.children.map((node) => renderBlockVNode(node, ctx)).filter((vnode) => vnode != null && vnode !== '')
}

/**
 * 用 Vue VNode 树直接渲染 Markdown AST，不经过 innerHTML，
 * 既能渲染加粗、列表、代码块、表格，也满足阅读器组件禁用原始 HTML 注入的契约。
 */
export const ReaderMarkdown = defineComponent({
  name: 'ReaderMarkdown',
  props: {
    source: { type: String, required: true },
  },
  setup(props) {
    return () => h('div', renderMarkdownVNodes(props.source))
  },
})
