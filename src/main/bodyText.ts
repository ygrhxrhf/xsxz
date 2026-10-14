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
  // CJK + 字母数字计数；忽略空白、标点、控制符与私用区（PUA 是字形替换的载体，不能算字数）
  return text.replace(/[\s\p{P}\p{Co}\p{Cc}]/gu, '').length
}

/** CJK 字数：判断一段串到底是正文还是站点脚本噪声。 */
export function cjkLength(text: string): number {
  const hits = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)
  return hits ? hits.length : 0
}

/** 私用区（PUA）码点：站点拿自定义字体把字换成这批码点时，正文在 DOM 里就是乱码。 */
const PUA_RE = /[\ue000-\uf8ff]/g

export function looksFontObfuscated(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  if (compact.length < 40) return false
  const hits = compact.match(PUA_RE)
  return Boolean(hits) && hits!.length / compact.length > 0.3
}

/**
 * 编码错解留下的特征字符：GBK / Big5 被当 latin1（或反过来）读时，正文里会密集出现
 * 这批「正常中文/越南语正文几乎不用」的字母与符号。
 */
const MOJIBAKE_CHARS_RE = /[æçåãïðµ¶§®»½¾¼¤œšž]/g
/** 中文站乱码的固定产物，出现即可判定。 */
const MOJIBAKE_WORDS_RE = /锟斤拷|烫烫|屯屯|燙燙/

/** 抽到的正文是不是「读不出人话」的乱码，或字形替换的私用区码点。 */
export function looksGarbled(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  if (compact.length < 60) return false
  if (looksFontObfuscated(text)) return true
  if (MOJIBAKE_WORDS_RE.test(compact)) return true
  const replaced = (compact.match(/\uFFFD/g) || []).length
  if (replaced / compact.length > 0.03) return true
  // 拉丁扩展区里的乱码特征字符密集、且几乎没有汉字：按乱码处理（越南语正文不会命中这批字符）
  const mojibake = (compact.match(MOJIBAKE_CHARS_RE) || []).length
  if (mojibake / compact.length > 0.02 && cjkLength(compact) / compact.length < 0.05) return true
  return false
}

/** linkDensity：链接字数占比，用来挡掉导航/广告块。 */
export function linkDensity(el: Element): number {
  const total = visibleText(el).length || 1
  const linkLen = [...el.querySelectorAll('a')].reduce((s, a) => s + visibleText(a).length, 0)
  return linkLen / total
}
