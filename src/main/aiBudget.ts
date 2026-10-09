import type { AiBudgetEstimate } from '../shared/types'

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

export function aiBudgetWarning(budget: AiBudgetEstimate, warningTokens: number): string | null {
  if (budget.estimatedTokens < warningTokens) return null
  return `本次预计输入约 ${budget.estimatedTokens} tokens，达到设置的 ${warningTokens} tokens 提醒阈值。是否继续？`
}

/** 按将要发送的提示词组装用量估算；追剧与交互任务共用同一口径，避免两套预算数字。 */
export function promptBudget(
  requestGroups: readonly (readonly string[])[],
  chapters: readonly { id: string; title: string }[],
  paragraphCount: number,
  range?: string,
): AiBudgetEstimate {
  const prompts = requestGroups.flat()
  const sentCharacters = prompts.reduce((total, prompt) => total + countTextCharacters(prompt), 0)
  const unique = [...new Map(chapters.map((chapter) => [chapter.id, chapter])).values()]
  return {
    originalCharacters: sentCharacters,
    sentCharacters,
    estimatedTokens: prompts.reduce((total, prompt) => total + estimateAiTokens(prompt), 0),
    chapterCount: unique.length,
    paragraphCount,
    batchCount: requestGroups.length,
    range: range ?? (unique.length ? `${unique[0]!.title} → ${unique.at(-1)!.title}` : '0 条本地证据'),
  }
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
