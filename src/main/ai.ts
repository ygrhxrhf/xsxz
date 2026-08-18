import type { AiChatMessage, AiCleanResult, ChapterStatus } from '../shared/types'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatResponse {
  choices: { message: { content: string } }[]
}

async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature: 0.3 }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AI 请求失败 (${res.status}): ${text.slice(0, 200)}`)
  }
  const data: ChatResponse = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

export interface AiConfig {
  baseUrl: string
  model: string
  apiKey: string
}

export async function cleanChapterBody(
  config: AiConfig,
  chapterTitle: string,
  body: string,
): Promise<AiCleanResult> {
  const prompt = `你是一个小说正文清理助手。请清理以下小说章节正文，去掉残留的导航文字（如"上一章"、"下一章"、"返回目录"）、广告推荐、网站水印、推荐阅读等内容，只保留小说正文本身。不要修改正文内容，不要添加内容，只删除非正文内容。

章节标题：${chapterTitle}

原文：
${body}

请直接返回清理后的正文，不要加任何解释。`

  const cleaned = await chatCompletion(config.baseUrl, config.apiKey, config.model, [
    { role: 'user', content: prompt },
  ])

  return { original: body, cleaned: cleaned.trim() }
}

/** Chapter row used to clamp summarize input. Compatible with Book.chapters + optional body. */
export interface SummarizeChapterInput {
  id: string
  index: number
  title: string
  status: ChapterStatus | string
  body?: string
}

export interface SummarizeClampOptions {
  uptoChapterId?: string
  progressChapterId?: string | null
}

const SUMMARIZE_WINDOW = 10

/**
 * Clamp summarize chapters to saved reading progress, then the last 10 ready
 * chapters inside that cutoff. Unread bodies must never enter the model.
 *
 * Contract-worker MUST use this in `src/main/index.ts` `ai.summarize`:
 *
 *   const progressChapterId = book.progress?.chapterId ?? null
 *   const cutoff = clampSummarizeChapters(book.chapters, uptoChapterId, progressChapterId)
 *   // read bodies only for `cutoff` (already ready + last-10)
 *   await summarizeUpTo(config, book.title, withBodies, { uptoChapterId, progressChapterId })
 *
 * `summarizeUpTo` reclamps when options + chapter ids are provided, so a
 * too-large list from a stale handler still cannot leak unread bodies.
 */
export function clampSummarizeChapters<T extends SummarizeChapterInput>(
  chapters: T[],
  uptoChapterId: string,
  progressChapterId?: string | null,
): T[] {
  if (!chapters.length) return []

  const uptoIdx = uptoChapterId ? chapters.findIndex((c) => c.id === uptoChapterId) : -1
  const progressIdx = progressChapterId
    ? chapters.findIndex((c) => c.id === progressChapterId)
    : -1

  let cutoffIdx: number
  if (uptoIdx >= 0 && progressIdx >= 0) cutoffIdx = Math.min(uptoIdx, progressIdx)
  else if (progressIdx >= 0) cutoffIdx = progressIdx
  else if (uptoIdx >= 0) cutoffIdx = uptoIdx
  else return []

  const cutoffIndex = chapters[cutoffIdx]?.index
  const ready = chapters.filter((c, i) => {
    if (i > cutoffIdx) return false
    if (typeof cutoffIndex === 'number' && typeof c.index === 'number' && c.index > cutoffIndex) {
      return false
    }
    return c.status === 'ready'
  })
  return ready.slice(-SUMMARIZE_WINDOW)
}

export function buildSummarizePrompt(
  bookTitle: string,
  chapterSummaries: { title: string; body?: string }[],
): string {
  const context = chapterSummaries
    .map((c) => `【${c.title}】\n${(c.body ?? '').slice(0, 500)}`)
    .join('\n\n')

  return `你是一个小说追剧摘要助手。请根据以下已读章节内容，生成一份简洁的前情提要，帮助读者回忆剧情。不要剧透后续内容。控制在300字以内。

书名：《${bookTitle}》

已读章节：
${context}

请生成前情提要：`
}

export async function summarizeUpTo(
  config: AiConfig,
  bookTitle: string,
  chapterSummaries: Array<{
    id?: string
    index?: number
    title: string
    status?: ChapterStatus | string
    body: string
  }>,
  clamp?: SummarizeClampOptions,
): Promise<string> {
  let selected = chapterSummaries
  const canClamp = Boolean(
    clamp &&
      (clamp.uptoChapterId || clamp.progressChapterId) &&
      chapterSummaries.length > 0 &&
      chapterSummaries.every((c) => typeof c.id === 'string' && c.id.length > 0),
  )
  if (canClamp) {
    const fallbackUpto = clamp!.uptoChapterId || chapterSummaries[chapterSummaries.length - 1]!.id!
    selected = clampSummarizeChapters(
      chapterSummaries.map((c, i) => ({
        id: c.id!,
        index: typeof c.index === 'number' ? c.index : i + 1,
        title: c.title,
        status: c.status ?? 'ready',
        body: c.body,
      })),
      fallbackUpto,
      clamp!.progressChapterId ?? null,
    )
  }

  const prompt = buildSummarizePrompt(bookTitle, selected)
  return chatCompletion(config.baseUrl, config.apiKey, config.model, [
    { role: 'user', content: prompt },
  ])
}

export async function translateText(config: AiConfig, text: string): Promise<string> {
  const prompt = `请把下面这段文字译成通顺的现代汉语。若原文已经是现代白话，只做简短释义，不要译成外文。只返回译文或释义，不要解释。

原文：
${text}`

  return chatCompletion(config.baseUrl, config.apiKey, config.model, [
    { role: 'user', content: prompt },
  ])
}

export async function chatAboutBook(
  config: AiConfig,
  bookTitle: string,
  currentChapterTitle: string,
  currentChapterBody: string,
  catalogSummary: string,
  readSummary: string,
  messages: AiChatMessage[],
): Promise<string> {
  const systemPrompt = `你是一个小说阅读助手。你正在帮读者阅读《${bookTitle}》。

当前章节：${currentChapterTitle}

已读到当前章为止的目录：
${catalogSummary}

${readSummary ? `已读摘要：\n${readSummary}` : '这是读者刚开始阅读。'}

当前章节内容（前2000字）：
${currentChapterBody.slice(0, 2000)}

请基于以上内容回答读者的问题。只使用当前章及之前的信息。如果问题涉及未读内容，请说明你只知道到当前章节为止的内容。`

  const apiMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ]

  return chatCompletion(config.baseUrl, config.apiKey, config.model, apiMessages)
}
