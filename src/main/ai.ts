import type { AiChatMessage, AiCleanResult, AiJobStart, ChapterStatus } from '../shared/types'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatResponse {
  choices: { message: { content: string } }[]
}

export const AI_REQUEST_TIMEOUT_MS = 120_000
export const AI_CHAT_HISTORY_LIMIT = 8
export const AI_BUSY_MESSAGE = '请先停止当前生成'

let nextAiJobId = 0

/** Main-process single slot for every streaming AI request. */
export class AiJobSlot {
  private current: { jobId: string; controller: AbortController } | null = null

  get busy(): boolean {
    return this.current !== null
  }

  start(run: (jobId: string, signal: AbortSignal) => Promise<void>): AiJobStart {
    if (this.current) return { ok: false, message: AI_BUSY_MESSAGE }
    const jobId = `ai-${Date.now()}-${++nextAiJobId}`
    const controller = new AbortController()
    this.current = { jobId, controller }
    void Promise.resolve().then(() => run(jobId, controller.signal)).catch(() => {}).finally(() => {
      if (this.current?.jobId === jobId) this.current = null
    })
    return { ok: true, jobId }
  }

  cancel(jobId?: string): void {
    if (!this.current || (jobId && this.current.jobId !== jobId)) return
    this.current.controller.abort()
  }
}


export function formatAiRequestError(status: number, bodyText = ''): string {
  const snippet = bodyText.slice(0, 200)
  if (status === 401 || status === 403) return 'API Key 无效或无权限，请到设置页核对'
  if (status === 429) return '请求过于频繁或额度用尽，请稍后再试'
  if (status === 408) return 'AI 请求超时，请稍后重试'
  if (status >= 500) return `模型服务暂时不可用 (${status})`
  return `AI 请求失败 (${status})${snippet ? `：${snippet}` : ''}`
}

export function clipChatMessages(messages: AiChatMessage[], limit = AI_CHAT_HISTORY_LIMIT): AiChatMessage[] {
  const usable = messages.filter((m) => m.role !== 'system')
  if (usable.length <= limit) return usable
  return usable.slice(-limit)
}

export function formatAiTransportError(e: unknown): string {
  const name = e && typeof e === 'object' && 'name' in e ? String((e as { name?: string }).name) : ''
  const msg = e instanceof Error ? e.message : String(e)
  if (name === 'AbortError' || /aborted|timeout|超时/i.test(msg)) return 'AI 请求超时，请稍后重试'
  if (/fetch|network|ECONN|ENOTFOUND|EAI_AGAIN|Failed to fetch|unable to connect/i.test(msg)) {
    return '无法连接模型服务，请检查接口地址和网络'
  }
  return msg || 'AI 请求失败'
}

async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), AI_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.3 }),
      signal: ac.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(formatAiRequestError(res.status, text))
    }
    const data: ChatResponse = await res.json()
    return data.choices?.[0]?.message?.content || ''
  } catch (e: unknown) {
    throw new Error(formatAiTransportError(e))
  } finally {
    clearTimeout(timer)
  }
}

export interface AiConfig {
  baseUrl: string
  model: string
  apiKey: string
}

/** Parse OpenAI-compatible SSE `data:` lines into deltas. */
export async function streamChatCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (delta: string) => void,
): Promise<string> {
  const timeout = AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)
  const requestSignal = AbortSignal.any([signal, timeout])
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages, temperature: 0.3, stream: true }),
      signal: requestSignal,
    })
    if (!res.ok) throw new Error(formatAiRequestError(res.status, await res.text().catch(() => '')))
    if (!res.body) throw new Error('模型服务未返回流式内容')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    let text = ''
    const consume = (line: string) => {
      const value = line.trim()
      if (!value.startsWith('data:')) return
      const data = value.slice(5).trim()
      if (!data || data === '[DONE]') return
      try {
        const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> })
          .choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta) {
          text += delta
          onDelta(delta)
        }
      } catch {
        // Ignore malformed provider frames instead of corrupting accumulated text.
      }
    }
    while (true) {
      const { done, value } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      lines.forEach(consume)
      if (done) break
    }
    if (pending) consume(pending)
    return text
  } catch (e: unknown) {
    throw new Error(formatAiTransportError(e))
  }
}

export function buildChapterSummaryPrompt(bookTitle: string, chapterTitle: string, body: string): string {
  const clipped = body.slice(0, 8000)
  const truncated = body.length > clipped.length
  return `你是一个小说阅读助手。请只根据以下当前章节内容，写出 80–150 字的本章摘要。不要剧透后续章节，不要补充章节外信息，只返回摘要正文。

书名：《${bookTitle}》
章节：${chapterTitle}
${truncated ? '提示：正文过长，以下内容已截断。\n' : ''}
正文：
${clipped}`
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
    ...clipChatMessages(messages).map((m) => ({ role: m.role, content: m.content })),
  ]

  return chatCompletion(config.baseUrl, config.apiKey, config.model, apiMessages)
}

export async function testConnection(config: AiConfig): Promise<string> {
  return chatCompletion(config.baseUrl, config.apiKey, config.model, [
    { role: 'user', content: '只回复 ok' },
  ])
}

// ---------------------------------------------------------------------------
// 人物卡 / 伏笔追踪
// ---------------------------------------------------------------------------

export interface CharacterMaterial {
  bookTitle: string
  uptoChapterTitle: string
  /** 截至当前章的目录标题（不含未读） */
  catalogTitles: string[]
  /** 已读章节摘要（chapterId → text 中已保存的部分） */
  chapterSummaries: Array<{ title: string; text: string }>
  /** 最近几章已读正文节选 */
  recentBodies: Array<{ title: string; body: string }>
}

export function buildCharacterCardPrompt(m: CharacterMaterial): string {
  const catalog = m.catalogTitles.join('、')
  const summaries = m.chapterSummaries.map((s) => `【${s.title}】${s.text}`).join('\n')
  const bodies = m.recentBodies
    .map((b) => `【${b.title}】\n${b.body.slice(0, 1200)}`)
    .join('\n\n')

  return `你是小说阅读助手。请根据以下**已读部分**的材料整理「人物卡 + 伏笔追踪」，帮助读者回忆并跟进剧情。只使用已读内容，不要猜测或引用未读章节。

书名：《${m.bookTitle}》
已读到：${m.uptoChapterTitle}
截至当前的目录：${catalog}
${summaries ? `\n已读章摘要：\n${summaries}\n` : ''}
${bodies ? `\n最近几章正文节选：\n${bodies}\n` : ''}
请只返回一个 JSON 对象，不要用 markdown 代码块包裹，格式：
{"characters":[{"name":"人名","role":"主角/配角/反派等","relations":"与其他人物的关系","status":"目前状态"}],"foreshadows":[{"desc":"伏笔描述","where":"首次出现的章节标题","open":true}]}
characters 按重要程度排序；foreshadows 里 open=true 表示尚未回收。某类为空就给空数组。`
}

export interface ParsedCharacterCard {
  characters: Array<{ name: string; role?: string; relations?: string; status?: string }>
  foreshadows: Array<{ desc: string; where?: string; open?: boolean }>
}

/** 解析模型返回；JSON 不合法时返回 null（调用方保留 raw 兜底展示）。 */
export function parseCharacterCard(text: string): ParsedCharacterCard | null {
  const raw = text.trim()
  if (!raw) return null
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()

  const candidates = [stripped]
  const s = raw.indexOf('{')
  const e = raw.lastIndexOf('}')
  if (s >= 0 && e > s) candidates.push(raw.slice(s, e + 1))

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>
      const characters = normalizeEntries(obj.characters, (x) => ({
        name: String(x.name ?? '').trim(),
        role: optStr(x.role),
        relations: optStr(x.relations),
        status: optStr(x.status),
      })).filter((x) => x.name)
      const foreshadows = normalizeEntries(obj.foreshadows, (x) => ({
        desc: String(x.desc ?? x.description ?? '').trim(),
        where: optStr(x.where),
        open: typeof x.open === 'boolean' ? x.open : true,
      })).filter((x) => x.desc)
      if (!Array.isArray(obj.characters) && !Array.isArray(obj.foreshadows)) continue
      return { characters, foreshadows }
    } catch {
      /* try next candidate */
    }
  }
  return null
}

function optStr(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : ''
  return s || undefined
}

function normalizeEntries<T>(value: unknown, map: (x: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) return []
  return value.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object').map(map)
}

export async function generateCharacterCard(
  config: AiConfig,
  material: CharacterMaterial,
): Promise<string> {
  return chatCompletion(config.baseUrl, config.apiKey, config.model, [
    { role: 'user', content: buildCharacterCardPrompt(material) },
  ])
}
