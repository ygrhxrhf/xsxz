/**
 * 渲染层整段尾巴净化（scheme「内置整段规则」R1–R5）。
 *
 * 只决定「这一段渲染不渲染」，绝不改写章节正文：段落索引始终是
 * `splitIntoParagraphs` 给出的原始下标，划线 / 搜索 / 听书 / 阅读进度
 * 用的都是原始坐标。
 */

type SiteTailRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5'

/** R4 的段首词。 */
const R4_PREFIXES = ['最新网址', '最新地址', '手机用户请', '本章未完'] as const

/** R5 的整段形态：纯网址或 www 开头。 */
const R5_PATTERNS = [/^https?:\/\/\S+$/, /^www\.\S+$/] as const

/**
 * 判断前删除该段内全部 Unicode 空白（含全角空格、换行、制表），再转小写。
 * 标点保留。
 */
export function normalizeTailText(text: string): string {
  if (!text) return ''
  return text.replace(/[\p{White_Space}\uFEFF]/gu, '').toLowerCase()
}

/**
 * 整段命中哪条内置规则；都不命中返回 null。
 * 判断单位是「整段」：R1–R3 看整段是否同时出现两个词，
 * 所以同一段里两句分别带「请收藏」和「本站」也算命中。
 */
export function matchSiteTailRule(text: string): SiteTailRule | null {
  const flat = normalizeTailText(text)
  if (!flat) return null
  const hasCollect = flat.includes('请收藏')
  if (hasCollect && flat.includes('本站')) return 'R1'
  if (hasCollect && flat.includes('网址')) return 'R2'
  if (hasCollect && flat.includes('地址')) return 'R3'
  if (R4_PREFIXES.some((prefix) => flat.startsWith(prefix))) return 'R4'
  if (R5_PATTERNS.some((pattern) => pattern.test(flat))) return 'R5'
  return null
}

/** 该段是否属于站点尾巴（命中任一规则即隐藏，同一段只隐藏一次）。 */
export function isSiteTailParagraph(text: string): boolean {
  return matchSiteTailRule(text) !== null
}

interface VisibleParagraphOptions {
  /** 是否隐藏尾巴段；缺省 true（默认开启净化）。 */
  hideTail?: boolean
}

/**
 * 返回要渲染的段落「原始下标」列表（升序）。
 * 净化只是从列表里去掉命中段，下标本身不变——
 * 调用方拿它当 data-p 与段落数组下标，坐标天然与原文一致。
 */
export function visibleParagraphIndexes(
  paragraphs: readonly string[],
  options: VisibleParagraphOptions = {},
): number[] {
  const hideTail = options.hideTail !== false
  const indexes: number[] = []
  for (let index = 0; index < paragraphs.length; index += 1) {
    if (hideTail && isSiteTailParagraph(paragraphs[index] ?? '')) continue
    indexes.push(index)
  }
  return indexes
}
