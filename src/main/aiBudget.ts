export const AI_INPUT_CHARACTER_BUDGET = 30_000
export const CLEAN_PARAGRAPH_SEGMENT_LIMIT = 8_000

export function countTextCharacters(text: string): number {
  return Array.from(text).length
}

export function estimateAiTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil((cjk / 1.5 + other / 4) * 1.1)
}

export function normalizeAiParagraphs(text: string): string[] {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n\s*\n+/)
  const paragraphs: string[] = []
  for (const block of blocks) {
    const normalized = block.trim()
    if (!normalized) continue
    const characters = Array.from(normalized)
    for (let offset = 0; offset < characters.length; offset += CLEAN_PARAGRAPH_SEGMENT_LIMIT) {
      paragraphs.push(characters.slice(offset, offset + CLEAN_PARAGRAPH_SEGMENT_LIMIT).join(''))
    }
  }
  return paragraphs
}
