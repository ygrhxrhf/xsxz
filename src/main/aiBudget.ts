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

export function normalizeAiParagraphs(
  text: string,
  segmentLimit = CLEAN_PARAGRAPH_SEGMENT_LIMIT,
): string[] {
  if (!Number.isSafeInteger(segmentLimit) || segmentLimit < 1) {
    throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
  }
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n\s*\n+/)
  const paragraphs: string[] = []
  for (const block of blocks) {
    const normalized = block.trim()
    if (!normalized) continue
    const characters = Array.from(normalized)
    for (let offset = 0; offset < characters.length; offset += segmentLimit) {
      paragraphs.push(characters.slice(offset, offset + segmentLimit).join(''))
    }
  }
  return paragraphs
}
