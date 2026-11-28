/**
 * 从「已读正文」抽取地名的数据层。
 *
 * 只做抽取与锚点校验，不做地理编码：模型只允许引用候选段落 id 并逐字给出原文引文，
 * 段落锚点由本模块按「引文在段内的真实位置」算出，模型不产出坐标，也不产出段号。
 *
 * 已读边界与 AI 其余任务一致：只读 `readFrontier` 截断后的正文，不把未读内容发出去。
 */
import { renderedParagraphs } from '../shared/aiText'
import type { AiPlace, AiPlaceKind } from '../shared/types'
import { AI_INPUT_CHARACTER_BUDGET, countTextCharacters } from './aiBudget'
import { getBook } from './library'
import { getReadFrontier, readClippedChapter } from './readFrontier'

interface PlaceCandidate {
  /** 稳定候选 id：`p-<chapterId>-<paragraphIndex>`，模型只能引用它。 */
  id: string
  chapterId: string
  chapterTitle: string
  /** 阅读器渲染段号（与跳转、标注同一坐标系）。 */
  paragraphIndex: number
  /** 段首开始的最大摘录；段落偏移都相对这段文本。 */
  text: string
  /** 段落超过摘录上限，后半段没有送去抽取。 */
  clipped: boolean
}

interface PlaceExtractionPlan {
  bookId: string
  bookTitle: string
  chapters: Array<{ id: string; title: string }>
  candidates: PlaceCandidate[]
  paragraphCount: number
  /** 因章节数 / 段落数 / 字数上限而没有扫描完全部已读正文。 */
  truncated: boolean
  system: string
  user: string
}

export const PLACE_SYSTEM_PROMPT = [
  '你是只做地名抽取的工具。只根据用户给出的已读段落抽取真实地理名称：国家、城市、地区、山川、湖泊、岛屿、地标等。',
  '不要抽人名、组织名、书名、比喻或虚构地名；没有把握就跳过。',
  '每条必须引用一个候选段落 id，并给出在该段中逐字出现的 quote（原样复制，不改写、不补全、不加省略号）。',
  '严禁输出经纬度、坐标或任何地理位置推断。',
  '只返回 JSON：{"places":[{"candidateId":"p-...","name":"洛阳","aliases":["洛城"],"kind":"city","quote":"……洛阳……"}]}。',
  'kind 只能是 city / region / landmark / other；同一段里的同一地点只输出一次，最多 200 条。',
].join('\n')

const MAX_CHAPTERS = 30
const MAX_CANDIDATES = 600
const MAX_MATERIAL_CHARS = 32_000
const MAX_PARAGRAPH_CHARS = 800
const MAX_PLACES = 200
const MAX_QUOTE_CHARS = 400
const MAX_NAME_CHARS = 40
const MAX_ALIASES = 5
const PLACE_KINDS: readonly AiPlaceKind[] = ['city', 'region', 'landmark', 'other']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function normalizedKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ')
}

/**
 * 一章正文 → 候选段落。段落文本保持原样（不 trim），这样 quote 的位置就是正文段内偏移；
 * 只有超过摘录上限时才从段首截断。
 */
export function buildPlaceCandidates(chapterId: string, chapterTitle: string, body: string): PlaceCandidate[] {
  const candidates: PlaceCandidate[] = []
  for (const [paragraphIndex, paragraph] of renderedParagraphs(body).entries()) {
    const text = paragraph.replace(/\r\n?/g, '\n')
    if (!text.trim()) continue
    const characters = Array.from(text)
    const clipped = characters.length > MAX_PARAGRAPH_CHARS
    candidates.push({
      id: `p-${chapterId}-${paragraphIndex}`,
      chapterId,
      chapterTitle,
      paragraphIndex,
      text: clipped ? characters.slice(0, MAX_PARAGRAPH_CHARS).join('') : text,
      clipped,
    })
  }
  return candidates
}

/** 至少留一条候选；系统提示 + 候选 JSON 必须塞进 30000 字硬预算。 */
export function fitPlaceCandidatesToBudget(
  candidates: readonly PlaceCandidate[],
): { candidates: PlaceCandidate[]; user: string; truncated: boolean } {
  const available = AI_INPUT_CHARACTER_BUDGET - countTextCharacters(PLACE_SYSTEM_PROMPT)
  let user = buildPlaceUserPrompt(candidates)
  if (countTextCharacters(user) <= available) return { candidates: [...candidates], user, truncated: false }
  if (!candidates.length) throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
  let low = 1
  let high = candidates.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const probe = buildPlaceUserPrompt(candidates.slice(0, middle))
    if (countTextCharacters(probe) <= available) low = middle
    else high = middle - 1
  }
  const fitted = candidates.slice(0, low)
  user = buildPlaceUserPrompt(fitted)
  if (countTextCharacters(user) > available) throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
  return { candidates: fitted, user, truncated: true }
}

export function buildPlaceUserPrompt(candidates: readonly PlaceCandidate[]): string {
  return JSON.stringify(candidates.map((candidate) => ({
    id: candidate.id,
    chapterTitle: candidate.chapterTitle,
    text: candidate.text,
  })))
}

/** 汇总已读正文：按书序扫描，到上限就停，并明确标记「没有看完」。 */
export async function placeExtractionPlan(bookId: string): Promise<PlaceExtractionPlan> {
  const [book, frontier] = await Promise.all([getBook(bookId), getReadFrontier(bookId)])
  const ordered = [...book.chapters].sort((left, right) => left.index - right.index)
  const chapters: Array<{ id: string; title: string }> = []
  const candidates: PlaceCandidate[] = []
  let characters = 0
  let truncated = false

  for (const chapter of ordered) {
    if (chapter.status !== 'ready' || !frontier.chapters[chapter.id]) continue
    if (chapters.length >= MAX_CHAPTERS || candidates.length >= MAX_CANDIDATES || characters >= MAX_MATERIAL_CHARS) {
      truncated = true
      break
    }
    const clipped = await readClippedChapter(bookId, chapter.id, frontier).catch(() => ({ body: '', full: false }))
    if (!clipped.body) continue
    const all = buildPlaceCandidates(chapter.id, chapter.title, clipped.body)
    if (!all.length) continue
    const selected: PlaceCandidate[] = []
    for (const candidate of all) {
      if (candidates.length + selected.length >= MAX_CANDIDATES || characters + candidate.text.length > MAX_MATERIAL_CHARS) {
        truncated = true
        break
      }
      selected.push(candidate)
      characters += candidate.text.length
      if (candidate.clipped) truncated = true
    }
    if (!selected.length) continue
    chapters.push({ id: chapter.id, title: chapter.title })
    candidates.push(...selected)
  }

  const fitted = fitPlaceCandidatesToBudget(candidates)
  const keptChapterIds = new Set(fitted.candidates.map((candidate) => candidate.chapterId))
  return {
    bookId,
    bookTitle: book.title,
    chapters: chapters.filter((chapter) => keptChapterIds.has(chapter.id)),
    candidates: fitted.candidates,
    paragraphCount: fitted.candidates.length,
    truncated: truncated || fitted.truncated,
    system: PLACE_SYSTEM_PROMPT,
    user: fitted.user,
  }
}

/**
 * 校验模型输出并算出真实锚点。
 *
 * - candidateId 必须来自本次候选；quote 必须逐字出现在该段里。
 * - 地点名（或别名）必须出现在 quote 里，偏移 = quote 段内起点 + 名称在 quote 里的位置。
 * - 不合法条目直接丢弃：宁可少标，也不把编造的地点放进书里。
 */
export function parsePlaceExtraction(
  raw: Record<string, unknown>,
  candidates: readonly PlaceCandidate[],
): AiPlace[] {
  if (!Array.isArray(raw.places)) throw new Error('模型返回的地名 JSON 无法识别')
  const allowed = new Map(candidates.map((candidate, index) => [candidate.id, { candidate, index }]))
  const places: AiPlace[] = []
  const seen = new Set<string>()

  for (const entry of raw.places) {
    if (places.length >= MAX_PLACES) break
    if (!isRecord(entry)) continue
    const candidateId = stringValue(entry.candidateId)
    const name = stringValue(entry.name)
    const quote = stringValue(entry.quote)
    if (!candidateId || !name || !quote) continue
    if (Array.from(name).length > MAX_NAME_CHARS || Array.from(quote).length > MAX_QUOTE_CHARS) continue
    const hit = allowed.get(candidateId)
    if (!hit) continue
    if (!hit.candidate.text.includes(quote)) continue

    const aliases: string[] = []
    if (Array.isArray(entry.aliases)) {
      for (const value of entry.aliases) {
        const alias = stringValue(value)
        if (!alias || Array.from(alias).length > MAX_NAME_CHARS) continue
        if (normalizedKey(alias) === normalizedKey(name)) continue
        if (aliases.some((item) => normalizedKey(item) === normalizedKey(alias))) continue
        aliases.push(alias)
        if (aliases.length >= MAX_ALIASES) break
      }
    }

    const quoteStart = hit.candidate.text.indexOf(quote)
    if (quoteStart < 0) continue
    // 优先用正名定位；正名没在引文里出现时退到别名，但锚点仍指向这处提及。
    let nameAt = quote.indexOf(name)
    if (nameAt < 0) {
      for (const alias of aliases) {
        const at = quote.indexOf(alias)
        if (at >= 0) { nameAt = at; break }
      }
    }
    if (nameAt < 0) continue

    const kind = PLACE_KINDS.includes(entry.kind as AiPlaceKind) ? entry.kind as AiPlaceKind : 'other'
    const paragraphOffset = quoteStart + nameAt
    const id = `place-${hit.candidate.chapterId}-${hit.candidate.paragraphIndex}-${paragraphOffset}`
    if (seen.has(id)) continue
    seen.add(id)
    places.push({
      id,
      name,
      aliases,
      kind,
      chapterId: hit.candidate.chapterId,
      chapterTitle: hit.candidate.chapterTitle,
      paragraphIndex: hit.candidate.paragraphIndex,
      paragraphOffset,
      excerpt: quote,
    })
  }

  return places.sort((left, right) => {
    const a = allowed.get(`p-${left.chapterId}-${left.paragraphIndex}`)?.index ?? 0
    const b = allowed.get(`p-${right.chapterId}-${right.paragraphIndex}`)?.index ?? 0
    return a - b || left.paragraphOffset - right.paragraphOffset
  })
}
