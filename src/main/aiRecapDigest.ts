import type { AiMemoryFile } from '../shared/types'
import { countTextCharacters } from './aiBudget'

/**
 * 旧章摘要节选：当已存摘要多到装不进 30000 字预算时，从**已有摘要原句**里给被丢掉的旧章留一句。
 *
 * 为什么不用模型重写：那会把「零成本」变成又一次调用；而摘要原句本来就是用户已经付过费的信息，
 * 摘一句出来只是排版，没有新事实进入提示词。
 */

/** 一节摘要窗口。`start` / `end` 是传入数组的下标（`end` 含），不是章节 index。 */
export interface RecapSummaryWindow<T> {
  start: number
  end: number
  items: T[]
}

/** 参与节选的摘要：只用到标题与正文，章节 id 用来回溯。 */
export interface RecapSummaryLike {
  chapterId: string
  title: string
  text: string
}

export interface RecapDigestHighlight {
  chapterId: string
  title: string
  excerpt: string
}

export interface RecapDigest {
  text: string
  windows: number
  chapters: number
}

/** 节选原句上限：超过就截断，避免一条摘要吃掉整块预算。 */
const EXCERPT_CHARACTER_LIMIT = 80
/** 断句符：中文正式摘要里这四类标点基本覆盖了句子边界。 */
const SENTENCE_BREAK = /[。！？；\n]/
/** 词表上限：线索太多等于没有重点，命中打分会被拉平。 */
const MAX_TERMS = 80
/** 只取最近的若干条事件：更早的事件多半已经被更新的进展覆盖。 */
const RECENT_EVENT_COUNT = 10

/**
 * 按传入顺序切窗，末窗不足也保留。
 *
 * 窗口的用途是「一次只给旧章一小块版面」：整本旧章一次性拼进去，节选会挤掉新内容，
 * 而且读者也看不出这些碎片来自哪个阶段。
 */
export function groupSummaryWindows<T>(
  summaries: readonly T[],
  windowSize = 20,
): Array<RecapSummaryWindow<T>> {
  if (!Number.isSafeInteger(windowSize) || windowSize < 1) {
    throw new Error('摘要窗口大小必须是正整数')
  }
  const windows: Array<RecapSummaryWindow<T>> = []
  for (let start = 0; start < summaries.length; start += windowSize) {
    const end = Math.min(start + windowSize, summaries.length) - 1
    windows.push({ start, end, items: summaries.slice(start, end + 1) })
  }
  return windows
}

/**
 * 取「当前还活着的线索」：人物正式名与别名、未回收的伏笔、最近事件的标题与参与者。
 *
 * 旧章节选要是真的有用，就得指向读者还需要记住的东西。已经解决掉的伏笔、
 * 单字词（「她」「它」这类）都只会让命中打分失真，所以在词表层面就滤掉。
 */
export function activeEntityTerms(memory: AiMemoryFile | null): string[] {
  if (!memory) return []
  const raw: string[] = []
  for (const character of memory.characters) {
    raw.push(character.name, ...character.aliases)
  }
  for (const foreshadow of memory.foreshadows) {
    if (foreshadow.status === 'resolved') continue
    raw.push(foreshadow.desc)
  }
  const recentEvents = [...memory.events]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, RECENT_EVENT_COUNT)
  for (const event of recentEvents) {
    raw.push(event.title, ...event.participants)
  }
  const seen = new Set<string>()
  const terms: string[] = []
  for (const term of raw) {
    const normalized = term.trim()
    if (countTextCharacters(normalized) < 2) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    terms.push(normalized)
    if (terms.length >= MAX_TERMS) break
  }
  return terms
}

/** 同一句里同一个词只算一次命中：摘要反复提同一个人不该把这一章顶到最前面。 */
function countTermHits(text: string, terms: readonly string[]): number {
  let hits = 0
  for (const term of new Set(terms)) {
    if (text.includes(term)) hits += 1
  }
  return hits
}

/**
 * 摘要原句：取第一句并截到 80 字。
 *
 * 只摘第一句而不是「命中词附近那句」，是因为按词找句子会把摘要从中间切断，
 * 读者看到的就成了半句话；第一句至少是这一章摘要自己写下的开头。
 */
function excerptOf(text: string): string {
  const sentences = text.split(SENTENCE_BREAK)
  const first = sentences.find((sentence) => sentence.trim()) ?? ''
  const characters = Array.from(first.trim())
  if (characters.length <= EXCERPT_CHARACTER_LIMIT) return characters.join('')
  return `${characters.slice(0, EXCERPT_CHARACTER_LIMIT).join('')}…`
}

/**
 * 给窗内每章摘要按线索命中打分，取前 N 章；没有命中的窗返回空数组。
 *
 * 打分规则：命中词数，且命中多个词额外 +1（说明这一章同时牵动多条线索，比只提到一个名字更有价值）。
 * 同分按原顺序——旧章本来就该按章节先后读，节选顺序不能因为排序抖动而变。
 */
export function pickWindowHighlights(
  window: RecapSummaryWindow<RecapSummaryLike>,
  terms: readonly string[],
  perWindow = 3,
): RecapDigestHighlight[] {
  if (perWindow < 1 || !terms.length) return []
  // 没有任何命中就返回空：旧章节选必须指向还活着的线索，硬凑出来的碎片只会误导。
  const scored = window.items
    .map((item, position) => ({ item, position, hits: countTermHits(item.text, terms) }))
    .filter((entry) => entry.hits > 0)
    .map((entry) => ({ ...entry, score: entry.hits + (entry.hits > 1 ? 1 : 0) }))
  if (!scored.length) return []
  scored.sort((left, right) => right.score - left.score || left.position - right.position)
  return scored.slice(0, perWindow).map(({ item }) => ({
    chapterId: item.chapterId,
    title: item.title,
    excerpt: excerptOf(item.text),
  }))
}

/**
 * 从最旧的窗开始拼节选，累计字符不超过预算；某一窗装不下就停在上一窗。
 *
 * 从最旧的窗开始，是因为被预算丢掉的正是最旧的那些章：新章本来就以完整摘要进了提示词。
 * 装不下时整窗放弃而不是截半窗，半块节选读起来更像「这一章就是这样」，比没有更糟。
 */
export function buildRecapDigest(
  windows: ReadonlyArray<RecapSummaryWindow<RecapSummaryLike>>,
  terms: readonly string[],
  budgetCharacters: number,
): RecapDigest {
  const blocks: string[] = []
  let acceptedWindows = 0
  let chapters = 0
  for (const window of windows) {
    const highlights = pickWindowHighlights(window, terms)
    if (!highlights.length) continue
    const block = highlights.map((highlight) => `【${highlight.title}】${highlight.excerpt}`).join('\n\n')
    const text = [...blocks, block].join('\n\n')
    if (countTextCharacters(text) > budgetCharacters) break
    blocks.push(block)
    acceptedWindows += 1
    chapters += highlights.length
  }
  return { text: blocks.join('\n\n'), windows: acceptedWindows, chapters }
}
