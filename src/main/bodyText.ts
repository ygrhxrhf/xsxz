/**
 * 正文取文本的公共工具：extract 与 paywallUnlock 共用同一套「什么算正文」的口径。
 *
 * 关键点：这里走 `textContent` 递归，**不看 CSS**——付费墙站点常把全文留在 DOM 里
 * 只用样式挡住，因此取文本必须能穿过 `display:none`。
 */

export function visibleText(el: Element): string {
  return (el.textContent || '').replace(/\s+/g, ' ').trim()
}

const BODY_BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DIV', 'H1', 'H2', 'H3', 'H4', 'LI', 'P', 'SECTION'])
const BODY_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'])

/** 保留段落边界，便于安全识别站点公告段。 */
export function bodyText(el: Element): string {
  const chunks: string[] = []
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      chunks.push(node.textContent ?? '')
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    if (BODY_SKIP.has(element.tagName)) return
    if (element.tagName === 'BR') {
      chunks.push('\n\n')
      return
    }
    const block = BODY_BLOCKS.has(element.tagName)
    if (block) chunks.push('\n\n')
    for (const child of element.childNodes) walk(child)
    if (block) chunks.push('\n\n')
  }
  walk(el)
  return chunks.join('')
    .replace(/\u00a0/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const NAV_LINE_RE = /(?:^|\s).{0,10}(?:上一[章节页]|下一[章节页]|返回目录|回目录|返回书页|目录).{0,10}(?=\s|$)/g

export function cleanBodyText(text: string): string {
  return text
    .replace(NAV_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function effectiveLength(text: string): number {
  // CJK + 字母数字计数，忽略空白与标点
  return text.replace(/[\s\p{P}]/gu, '').length
}

/** CJK 字数：判断一段串到底是正文还是站点脚本噪声。 */
export function cjkLength(text: string): number {
  const hits = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)
  return hits ? hits.length : 0
}

/** linkDensity：链接字数占比，用来挡掉导航/广告块。 */
export function linkDensity(el: Element): number {
  const total = visibleText(el).length || 1
  const linkLen = [...el.querySelectorAll('a')].reduce((s, a) => s + visibleText(a).length, 0)
  return linkLen / total
}
