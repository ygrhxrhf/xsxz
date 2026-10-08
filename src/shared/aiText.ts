import { paragraphRanges } from './paragraphSearch'

/**
 * AI 检索共用的文本工具。分段规则与阅读器渲染、全文搜索完全一致：
 * 段号可直接用于跳转，摘录偏移不会错位。CJK 判定与 estimateAiTokens 同一条正则。
 */

const CJK_CHARACTER = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u
const LATIN_CHARACTER = /[a-z0-9]/u

export interface SearchView {
  text: string
  originalOffsets: number[]
}

export interface ViewToken {
  term: string
  /** 原始 UTF-16 偏移，与 SearchView.originalOffsets 同一坐标系。 */
  at: number
}

/** 折叠空白并逐字小写，同时记住每个归一化字符对应的原始偏移。 */
export function normalizeSearchView(text: string): SearchView {
  let normalized = ''
  const originalOffsets: number[] = []
  let pendingWhitespaceOffset: number | null = null
  let utf16Offset = 0
  for (const character of text) {
    if (/\s/u.test(character)) {
      if (normalized && pendingWhitespaceOffset === null) pendingWhitespaceOffset = utf16Offset
      utf16Offset += character.length
      continue
    }
    if (pendingWhitespaceOffset !== null) {
      normalized += ' '
      originalOffsets.push(pendingWhitespaceOffset)
      pendingWhitespaceOffset = null
    }
    const lowered = character.toLocaleLowerCase()
    normalized += lowered
    for (let index = 0; index < lowered.length; index += 1) originalOffsets.push(utf16Offset)
    utf16Offset += character.length
  }
  return { text: normalized, originalOffsets }
}

export function normalizedTerm(text: string): string {
  return normalizeSearchView(text).text
}

/** 与渲染层 splitIntoParagraphs 等价的段落文本，段号即渲染段号。 */
export function renderedParagraphs(body: string): string[] {
  return paragraphRanges(body).map((range) => body.slice(range.start, range.end))
}

interface CharacterUnit {
  char: string
  at: number
}

function characterUnits(text: string): CharacterUnit[] {
  const units: CharacterUnit[] = []
  let utf16Offset = 0
  for (const char of text) {
    units.push({ char, at: utf16Offset })
    utf16Offset += char.length
  }
  return units
}

/**
 * 中日韩按相邻二元组切，同时保留单字：没有词典分词时，二元组给出词形、单字给出改述召回。
 * 空白和标点都是词界，其余取小写字母数字词。位置与 originalOffsets 同为 UTF-16 坐标。
 */
export function scanViewTokens(text: string): ViewToken[] {
  const units = characterUnits(text)
  const tokens: ViewToken[] = []
  let index = 0
  while (index < units.length) {
    if (CJK_CHARACTER.test(units[index]!.char)) {
      let end = index
      while (end < units.length && CJK_CHARACTER.test(units[end]!.char)) end += 1
      for (let offset = index; offset < end; offset += 1) tokens.push({ term: units[offset]!.char, at: units[offset]!.at })
      for (let offset = index; offset + 1 < end; offset += 1) {
        tokens.push({ term: units[offset]!.char + units[offset + 1]!.char, at: units[offset]!.at })
      }
      index = end
      continue
    }
    if (LATIN_CHARACTER.test(units[index]!.char)) {
      let end = index
      while (end < units.length && LATIN_CHARACTER.test(units[end]!.char)) end += 1
      tokens.push({ term: units.slice(index, end).map((unit) => unit.char).join(''), at: units[index]!.at })
      index = end
      continue
    }
    index += 1
  }
  return tokens
}

export function tokenize(text: string): string[] {
  return scanViewTokens(normalizedTerm(text)).map((token) => token.term)
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text))
}

/**
 * 剪枝索引用的词形集合：归一化视图的全部相邻二元窗，并上二元组与拉丁词。
 * 比 scanViewTokens 宽，因为正文命中走的是 `view.text.includes(term)`：
 * 「abc123」里的「c12」是字面命中却不是完整词形。二元窗保证任何长度 ≥2 的字面命中
 * 或词面重叠都至少共享一个词形，布隆过滤器判「无」时才能安全跳过读盘。
 */
export function retrievalTerms(text: string): Set<string> {
  const view = normalizedTerm(text)
  const characters = Array.from(view)
  const terms = new Set<string>()
  for (let index = 0; index + 1 < characters.length; index += 1) {
    terms.add(characters[index]! + characters[index + 1]!)
  }
  for (const token of scanViewTokens(view)) {
    if (Array.from(token.term).length >= 2) terms.add(token.term)
  }
  return terms
}
