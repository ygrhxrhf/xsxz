import type {
  AiChatMessage,
  AiCleanResult,
  AiJobStart,
  AiProvider,
  AiUsage,
  ChapterStatus,
} from '../shared/types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export const AI_REQUEST_TIMEOUT_MS = 120_000
export const AI_DEEP_REQUEST_TIMEOUT_MS = 300_000

export type AiTaskKind =
  | 'legacy'
  | 'clean'
  | 'translate'
  | 'chapterSummary'
  | 'characterCard'
  | 'queryRewrite'
  | 'recap'
  | 'memory'
  | 'evidenceQa'

export interface AiTaskPolicy {
  timeoutMs: number
  maxTokens?: number
  mode: 'fast' | 'high'
  structured: boolean
}

export interface AiTaskOptions {
  task: AiTaskKind
  stream?: boolean
  signal?: AbortSignal
  onDelta?: (delta: string) => void
  inputTokenEstimate?: number
  recapLength?: 'short' | 'standard' | 'detailed'
}

export interface AiCompletionResult {
  text: string
  usage?: AiUsage
  finishReason?: string
  truncated: boolean
  json?: Record<string, unknown>
}

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

  async runExclusive<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
    if (this.current) return { ok: false, message: AI_BUSY_MESSAGE }
    const jobId = `ai-${Date.now()}-${++nextAiJobId}`
    this.current = { jobId, controller: new AbortController() }
    try {
      return { ok: true, value: await run() }
    } finally {
      if (this.current?.jobId === jobId) this.current = null
    }
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

export interface AiConfig {
  baseUrl: string
  model: string
  apiKey: string
  provider?: AiProvider
  thinkingEnabled?: boolean
}

function clampOutputTokens(estimate: number, max: number): number {
  return Math.min(max, Math.max(512, Math.ceil(Math.max(0, estimate) * 1.2)))
}

export function getAiTaskPolicy(
  task: AiTaskKind,
  options: Pick<AiTaskOptions, 'inputTokenEstimate' | 'recapLength'> = {},
): AiTaskPolicy {
  const estimate = options.inputTokenEstimate ?? 0
  switch (task) {
    case 'clean':
      return { timeoutMs: AI_REQUEST_TIMEOUT_MS, maxTokens: clampOutputTokens(estimate, 12_000), mode: 'fast', structured: false }
    case 'translate':
      return { timeoutMs: AI_REQUEST_TIMEOUT_MS, maxTokens: clampOutputTokens(estimate, 6_000), mode: 'fast', structured: false }
    case 'chapterSummary':
      return { timeoutMs: AI_REQUEST_TIMEOUT_MS, maxTokens: 300, mode: 'fast', structured: false }
    case 'characterCard':
      return { timeoutMs: AI_DEEP_REQUEST_TIMEOUT_MS, maxTokens: 3_000, mode: 'high', structured: false }
    case 'queryRewrite':
      return { timeoutMs: AI_REQUEST_TIMEOUT_MS, maxTokens: 200, mode: 'fast', structured: true }
    case 'recap': {
      const maxTokens = options.recapLength === 'short' ? 400 : options.recapLength === 'detailed' ? 1_600 : 900
      return { timeoutMs: AI_DEEP_REQUEST_TIMEOUT_MS, maxTokens, mode: 'high', structured: false }
    }
    case 'memory':
      return { timeoutMs: AI_DEEP_REQUEST_TIMEOUT_MS, maxTokens: 3_000, mode: 'high', structured: true }
    case 'evidenceQa':
      return { timeoutMs: AI_DEEP_REQUEST_TIMEOUT_MS, maxTokens: 2_000, mode: 'high', structured: true }
    default:
      return { timeoutMs: AI_REQUEST_TIMEOUT_MS, mode: 'fast', structured: false }
  }
}

function resolveProvider(config: AiConfig): AiProvider {
  try {
    const officialHost = new URL(config.baseUrl).hostname.toLowerCase() === 'api.deepseek.com'
    return officialHost && config.provider !== 'custom' ? 'deepseek' : 'custom'
  } catch {
    return 'custom'
  }
}

function readToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function parseUsage(value: unknown): AiUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const usage = value as Record<string, unknown>
  const parsed: AiUsage = {
    inputTokens: readToken(usage.prompt_tokens),
    outputTokens: readToken(usage.completion_tokens),
    cacheHitTokens: readToken(usage.prompt_cache_hit_tokens),
    cacheMissTokens: readToken(usage.prompt_cache_miss_tokens),
  }
  return Object.values(parsed).some((item) => item !== undefined) ? parsed : undefined
}

export function parseAiJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const candidates = [stripped]
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(stripped.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next bounded candidate.
    }
  }
  throw new Error('模型返回的结构化内容无法识别，原有数据未改变')
}

function buildRequestBody(
  config: AiConfig,
  messages: ChatMessage[],
  policy: AiTaskPolicy,
  stream: boolean,
): Record<string, unknown> {
  const provider = resolveProvider(config)
  const body: Record<string, unknown> = { model: config.model, messages, stream }
  if (policy.maxTokens !== undefined) body.max_tokens = policy.maxTokens
  if (provider === 'deepseek') {
    if (policy.mode === 'fast') body.temperature = 0.3
    if (policy.mode === 'high' && config.thinkingEnabled !== false) body.reasoning_effort = 'high'
    if (policy.structured) body.response_format = { type: 'json_object' }
    if (stream) body.stream_options = { include_usage: true }
  }
  return body
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function finishResult(
  text: string,
  finishReason: string | undefined,
  usage: AiUsage | undefined,
  policy: AiTaskPolicy,
): AiCompletionResult {
  if (!text.trim()) throw new Error('模型服务未返回有效内容，请重试')
  const truncated = finishReason === 'length'
  if (policy.structured && truncated) throw new Error('结构化结果因输出上限而截断，原有数据未改变')
  return {
    text,
    usage,
    finishReason,
    truncated,
    json: policy.structured ? parseAiJsonObject(text) : undefined,
  }
}

async function readStreamResult(
  response: Response,
  policy: AiTaskPolicy,
  onDelta: (delta: string) => void,
): Promise<AiCompletionResult> {
  if (!response.body) throw new Error('模型服务未返回流式内容')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let text = ''
  let finishReason: string | undefined
  let usage: AiUsage | undefined
  const consume = (line: string) => {
    const value = line.trim()
    if (!value.startsWith('data:')) return
    const raw = value.slice(5).trim()
    if (!raw || raw === '[DONE]') return
    try {
      const frame = JSON.parse(raw) as Record<string, unknown>
      usage = parseUsage(frame.usage) ?? usage
      const choice = Array.isArray(frame.choices) ? frame.choices[0] as Record<string, unknown> | undefined : undefined
      if (choice && typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
      const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta as Record<string, unknown> : undefined
      const content = delta?.content
      // reasoning_content is intentionally ignored and never forwarded or persisted.
      if (typeof content === 'string' && content) {
        text += content
        onDelta(content)
      }
    } catch {
      // Bad provider frames are ignored without corrupting accumulated content.
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
  return finishResult(text, finishReason, usage, policy)
}

export async function runAiTaskCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  options: AiTaskOptions,
): Promise<AiCompletionResult> {
  const policy = getAiTaskPolicy(options.task, options)
  const stream = options.stream === true
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(buildRequestBody(config, messages, policy, stream)),
      signal: requestSignal(options.signal, policy.timeoutMs),
    })
    if (!response.ok) {
      throw new Error(formatAiRequestError(response.status, await response.text().catch(() => '')))
    }
    if (stream) return readStreamResult(response, policy, options.onDelta ?? (() => {}))

    const data = await response.json() as Record<string, unknown>
    const choice = Array.isArray(data.choices) ? data.choices[0] as Record<string, unknown> | undefined : undefined
    const message = choice?.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : undefined
    const content = typeof message?.content === 'string' ? message.content : ''
    // reasoning_content is intentionally ignored and never returned.
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined
    return finishResult(content, finishReason, parseUsage(data.usage), policy)
  } catch (error: unknown) {
    throw new Error(formatAiTransportError(error))
  }
}

async function chatCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  taskOptions: Pick<AiTaskOptions, 'task' | 'inputTokenEstimate' | 'recapLength'> = { task: 'legacy' },
): Promise<string> {
  return (await runAiTaskCompletion(config, messages, taskOptions)).text
}

/** Backward-compatible text-only stream wrapper; task-aware callers use runAiTaskCompletion. */
export async function streamChatCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  taskOptions: Pick<AiTaskOptions, 'task' | 'inputTokenEstimate' | 'recapLength'> = { task: 'legacy' },
): Promise<string> {
  return (await runAiTaskCompletion(config, messages, {
    ...taskOptions,
    stream: true,
    signal,
    onDelta,
  })).text
}

export function buildStorySoFarPrompt(bookTitle: string, summaries: Array<{ title: string; text: string }>): string {
  const context = summaries.map((item) => `【${item.title}】\n${item.text}`).join('\n\n')
  return `你是一个小说阅读助手。请只根据以下已读章节摘要，合成为不超过 400 字的前情提要。不要剧透后续内容，只返回前情正文。\n\n书名：《${bookTitle}》\n已读摘要：\n${context}`
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

  const cleaned = await chatCompletion(config, [
    { role: 'user', content: prompt },
  ], { task: 'clean', inputTokenEstimate: Math.ceil(prompt.length / 2) })

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
  return chatCompletion(config, [
    { role: 'user', content: prompt },
  ], { task: 'recap' })
}

export function buildTranslatePrompt(text: string): string {
  return `请把下面这段文字译成通顺的现代汉语。若原文已经是现代白话，只做简短释义，不要译成外文。只返回译文或释义，不要解释。

原文：
${text}`
}

export async function translateText(config: AiConfig, text: string): Promise<string> {
  const prompt = buildTranslatePrompt(text)
  return chatCompletion(config, [
    { role: 'user', content: prompt },
  ], { task: 'translate', inputTokenEstimate: Math.ceil(prompt.length / 2) })
}

export function buildBookChatMessages(
  bookTitle: string,
  currentChapterTitle: string,
  currentChapterBody: string,
  catalogSummary: string,
  readSummary: string,
  messages: AiChatMessage[],
): ChatMessage[] {
  const systemPrompt = `你是一个小说阅读助手。你正在帮读者阅读《${bookTitle}》。

当前章节：${currentChapterTitle}

已读到当前章为止的目录：
${catalogSummary}

${readSummary ? `已读摘要：\n${readSummary}` : '这是读者刚开始阅读。'}

当前章节内容（前2000字）：
${currentChapterBody.slice(0, 2000)}

请基于以上内容回答读者的问题。只使用当前章及之前的信息。如果问题涉及未读内容，请说明你只知道到当前章节为止的内容。`

  return [
    { role: 'system', content: systemPrompt },
    ...clipChatMessages(messages).map((m) => ({ role: m.role, content: m.content })),
  ]
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
  return chatCompletion(
    config,
    buildBookChatMessages(bookTitle, currentChapterTitle, currentChapterBody, catalogSummary, readSummary, messages),
  )
}

export async function testConnection(config: AiConfig): Promise<string> {
  return chatCompletion(config, [
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
  return chatCompletion(config, [
    { role: 'user', content: buildCharacterCardPrompt(material) },
  ], { task: 'characterCard' })
}
