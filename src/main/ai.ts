import { randomUUID } from 'node:crypto'
import type {
  AiBudgetEstimate,
  AiChatMessage,
  AiCleanResult,
  AiDoneEvent,
  AiJobStart,
  AiProvider,
  AiRequestStage,
  AiUsage,
  ChapterStatus,
} from '../shared/types'
import { BUILTIN_AI_PROMPTS } from '../shared/aiPrompts'
import type { AiExclusiveResult, AiLane } from './aiScheduler'
import { AiQueue } from './aiScheduler'
import {
  AI_INPUT_CHARACTER_BUDGET,
  CLEAN_PARAGRAPH_SEGMENT_LIMIT,
  countTextCharacters,
  estimateAiTokens,
  normalizeAiParagraphs,
} from './aiBudget'

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

export interface AiTransportHooks {
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  now?: () => number
}

export interface AiTaskOptions {
  task: AiTaskKind
  stream?: boolean
  signal?: AbortSignal
  onDelta?: (delta: string) => void
  inputTokenEstimate?: number
  recapLength?: 'short' | 'standard' | 'detailed'
  /** 仅用于无网络的确定性 transport 测试；生产调用不传。 */
  hooks?: AiTransportHooks
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

/**
 * 兼容壳：内部已换成车道队列，只保留旧构造签名供 bookOverview 与既有测试使用。
 * S6 收敛时删除，调用方应直接使用 AiQueue 并给出车道与策略。
 */
export class AiJobSlot {
  private readonly queue: AiQueue

  constructor(queue: AiQueue = new AiQueue(), private readonly lane: AiLane = 'interactive') {
    this.queue = queue
  }

  get busy(): boolean {
    return this.queue.hasInFlight()
  }

  start(run: (jobId: string, signal: AbortSignal) => Promise<void>): AiJobStart {
    return this.queue.start(run, { lane: this.lane })
  }

  runExclusive<T>(
    run: (signal: AbortSignal, jobId: string) => Promise<T>,
  ): Promise<AiExclusiveResult<T>> {
    return this.queue.runExclusive(run, { lane: this.lane })
  }

  cancel(jobId?: string): void {
    this.queue.cancel(jobId)
  }
}

export class AiPendingSaveStore {
  private readonly entries = new Map<string, () => Promise<void>>()
  private readonly inFlight = new Set<string>()

  get size(): number {
    return this.entries.size
  }

  register(save: () => Promise<void>): string {
    const token = `save-${randomUUID()}`
    this.entries.set(token, save)
    return token
  }

  async retry(saveToken: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const save = this.entries.get(saveToken)
    if (!save) return { ok: false, message: '未保存结果已过期，请重新生成' }
    if (this.inFlight.has(saveToken)) return { ok: false, message: '正在重试保存，请稍候' }
    this.inFlight.add(saveToken)
    try {
      await save()
      this.entries.delete(saveToken)
      return { ok: true }
    } catch {
      return { ok: false, message: '仍然无法保存，请检查磁盘空间和权限' }
    } finally {
      this.inFlight.delete(saveToken)
    }
  }
}

export type AiSuccessDoneEvent = Extract<AiDoneEvent, { ok: true }>

export interface AiSaveFinalizeOptions {
  signal?: AbortSignal
  stoppedEvent?: AiSuccessDoneEvent
  saveStopped?: () => Promise<void>
  /** Optional durable retry closure that must not capture the completed job's AbortSignal. */
  retrySave?: () => Promise<void>
}

export async function finalizeAiSave(
  store: AiPendingSaveStore,
  event: AiSuccessDoneEvent,
  save: () => Promise<void>,
  options: AiSaveFinalizeOptions = {},
): Promise<AiSuccessDoneEvent> {
  const savedOrToken = async (
    targetEvent: AiSuccessDoneEvent,
    targetSave: () => Promise<void>,
  ): Promise<AiSuccessDoneEvent> => {
    try {
      await targetSave()
      return targetEvent
    } catch {
      return { ...targetEvent, saveToken: store.register(targetSave) }
    }
  }
  const finishStopped = (): Promise<AiSuccessDoneEvent> | undefined => {
    if (!options.stoppedEvent) return undefined
    return options.saveStopped
      ? savedOrToken(options.stoppedEvent, options.saveStopped)
      : Promise.resolve(options.stoppedEvent)
  }
  if (options.signal?.aborted) {
    const stopped = finishStopped()
    if (stopped) return stopped
  }
  try {
    await save()
    return event
  } catch {
    if (options.signal?.aborted) {
      const stopped = finishStopped()
      if (stopped) return stopped
    }
    return { ...event, saveToken: store.register(options.retrySave ?? save) }
  }
}

export async function runAiSaveStage(
  store: AiPendingSaveStore,
  jobId: string,
  event: AiSuccessDoneEvent,
  save: () => Promise<void>,
  options: AiSaveFinalizeOptions,
  emitStage: (jobId: string, stage: AiRequestStage) => void,
  emitDone: (event: AiSuccessDoneEvent) => void,
): Promise<void> {
  emitStage(jobId, 'saving')
  emitDone(await finalizeAiSave(store, event, save, options))
}

export function formatAiRequestError(status: number, bodyText = ''): string {
  const snippet = bodyText.slice(0, 200)
  if (status === 401 || status === 403) return 'API Key 无效或无权限，请到设置页核对'
  if (status === 402) return '模型服务余额不足，请到服务商控制台检查'
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
    const officialOrigin = new URL(config.baseUrl).origin === 'https://api.deepseek.com'
    return officialOrigin && config.provider !== 'custom' ? 'deepseek' : 'custom'
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

const JSON_ESCAPES: Record<string, string> = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
}

function isHighSurrogate(unit: string): boolean {
  return unit >= '\uD800' && unit <= '\uDBFF'
}

function isLowSurrogate(unit: string): boolean {
  return unit >= '\uDC00' && unit <= '\uDFFF'
}

/**
 * 结构化任务请求的是 `response_format:{type:'json_object'}`，所以 SSE 增量是 JSON 片段而不是正文。
 * 这里只抽取指定字符串字段已解码的部分用于流式展示：不完整的转义必须挂起等待后续帧，
 * 任何无法转发的内容都只停止转发、不抛错，让调用方回退到结束时的一次性填充。
 */
export function createJsonStringFieldSink(
  field: string,
  onText: (chunk: string) => void,
): (delta: string) => void {
  const pattern = new RegExp(`"${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"`)
  let head = ''
  let open = false
  let closed = false
  let hex: string | null = null
  let escaped = false
  let high = ''

  const process = (input: string): void => {
    let out = ''
    for (let index = 0; index < input.length; index += 1) {
      const unit = input[index]!
      if (hex !== null) {
        hex += unit
        if (hex.length < 4) continue
        const code = Number.parseInt(hex, 16)
        hex = null
        if (!Number.isFinite(code)) { closed = true; break }
        if (isHighSurrogate(String.fromCharCode(code))) {
          if (high) out += high
          high = String.fromCharCode(code)
          continue
        }
        if (isLowSurrogate(String.fromCharCode(code)) && high) {
          out += high + String.fromCharCode(code)
          high = ''
          continue
        }
        if (high) { out += high; high = '' }
        out += String.fromCharCode(code)
        continue
      }
      if (escaped) {
        escaped = false
        if (unit === 'u') { hex = ''; continue }
        const mapped = JSON_ESCAPES[unit]
        if (mapped === undefined) { closed = true; break }
        out += mapped
        continue
      }
      if (high) {
        if (isLowSurrogate(unit)) { out += high + unit; high = ''; continue }
        out += high
        high = ''
      }
      if (unit === '\\') { escaped = true; continue }
      // An unescaped quote ends the field; a raw control character means this is not valid JSON.
      if (unit === '"' || unit === '\n' || unit === '\r') { closed = true; break }
      if (isHighSurrogate(unit)) { high = unit; continue }
      out += unit
    }
    if (out) onText(out)
  }

  return (delta: string): void => {
    if (closed || !delta) return
    if (open) {
      process(delta)
      return
    }
    head += delta
    const match = pattern.exec(head)
    if (!match) return
    open = true
    const rest = head.slice(match.index + match[0].length)
    head = ''
    process(rest)
  }
}

function buildRequestBody(
  config: AiConfig,
  messages: ChatMessage[],
  policy: AiTaskPolicy,
  stream: boolean,
  allowExtensions = true,
): Record<string, unknown> {
  const provider = resolveProvider(config)
  const body: Record<string, unknown> = { model: config.model, messages, stream }
  if (policy.maxTokens !== undefined) body.max_tokens = policy.maxTokens
  if (provider === 'deepseek') {
    if (policy.mode === 'fast') body.temperature = 0.3
    if (allowExtensions && policy.mode === 'high' && config.thinkingEnabled !== false) {
      body.reasoning_effort = 'high'
    }
    if (allowExtensions && policy.structured) body.response_format = { type: 'json_object' }
    if (allowExtensions && stream) body.stream_options = { include_usage: true }
  }
  return body
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

function retryDelayMs(response: Response, retryIndex: number, hooks: AiTransportHooks): number {
  const fromHeader = parseRetryAfterMs(response.headers.get('Retry-After'), (hooks.now ?? Date.now)())
  if (fromHeader !== undefined) return fromHeader
  const jitter = Math.floor(Math.max(0, Math.min(1, (hooks.random ?? Math.random)())) * 250)
  return (retryIndex === 0 ? 1_000 : 2_000) + jitter
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs)
    function done() {
      signal.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

function hasCompatibilityExtensions(body: Record<string, unknown>): boolean {
  return 'reasoning_effort' in body || 'response_format' in body || 'stream_options' in body
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 503
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
  const hooks = options.hooks ?? {}
  const signal = requestSignal(options.signal, policy.timeoutMs)
  let transientRetries = 0
  let compatibilityDowngraded = false
  try {
    while (true) {
      const body = buildRequestBody(config, messages, policy, stream, !compatibilityDowngraded)
      const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        signal,
      })
      if (response.ok) {
        if (stream) return readStreamResult(response, policy, options.onDelta ?? (() => {}))
        const data = await response.json() as Record<string, unknown>
        const choice = Array.isArray(data.choices) ? data.choices[0] as Record<string, unknown> | undefined : undefined
        const message = choice?.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : undefined
        const content = typeof message?.content === 'string' ? message.content : ''
        // reasoning_content is intentionally ignored and never returned.
        const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined
        return finishResult(content, finishReason, parseUsage(data.usage), policy)
      }

      if (
        !compatibilityDowngraded
        && (response.status === 400 || response.status === 422)
        && hasCompatibilityExtensions(body)
      ) {
        await response.body?.cancel().catch(() => {})
        compatibilityDowngraded = true
        continue
      }

      if (isTransientStatus(response.status) && transientRetries < 2) {
        const delayMs = retryDelayMs(response, transientRetries, hooks)
        transientRetries += 1
        await response.body?.cancel().catch(() => {})
        await (hooks.sleep ?? defaultSleep)(delayMs, signal)
        continue
      }

      throw new Error(formatAiRequestError(response.status, await response.text().catch(() => '')))
    }
  } catch (error: unknown) {
    throw new Error(formatAiTransportError(error))
  }
}

export function aiCompletionDoneEvent(
  jobId: string,
  result: AiCompletionResult,
  text = result.text,
): AiSuccessDoneEvent {
  return {
    jobId,
    ok: true,
    text,
    usage: result.usage,
    truncated: result.truncated,
  }
}

export function aiStoppedDoneEvent(jobId: string, text: string): AiSuccessDoneEvent {
  return { jobId, ok: true, text, stopped: true }
}

async function chatCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  taskOptions: Pick<AiTaskOptions, 'task' | 'inputTokenEstimate' | 'recapLength'> = { task: 'legacy' },
): Promise<string> {
  return (await runAiTaskCompletion(config, messages, taskOptions)).text
}

export async function streamAiTaskCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  taskOptions: Pick<AiTaskOptions, 'task' | 'inputTokenEstimate' | 'recapLength'> = { task: 'legacy' },
): Promise<AiCompletionResult> {
  return runAiTaskCompletion(config, messages, {
    ...taskOptions,
    stream: true,
    signal,
    onDelta,
  })
}

/** Backward-compatible text-only stream wrapper. */
export async function streamChatCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  taskOptions: Pick<AiTaskOptions, 'task' | 'inputTokenEstimate' | 'recapLength'> = { task: 'legacy' },
): Promise<string> {
  return (await streamAiTaskCompletion(config, messages, signal, onDelta, taskOptions)).text
}

export function buildStorySoFarPrompt(
  bookTitle: string,
  summaries: Array<{ title: string; text: string }>,
  taskInstruction = BUILTIN_AI_PROMPTS.recap,
): string {
  const context = summaries.map((item) => `【${item.title}】\n${item.text}`).join('\n\n')
  return `用户任务要求：\n${taskInstruction}\n\n固定规则：只能使用下方已经保存的已读摘要；不得推测或剧透未读内容；控制在 400 字以内；只返回前情正文。\n\n书名：《${bookTitle}》\n已读摘要：\n${context}`
}

export function buildChapterSummaryPrompt(
  bookTitle: string,
  chapterTitle: string,
  body: string,
  taskInstruction = BUILTIN_AI_PROMPTS.chapterSummary,
  bodyCharacterLimit = 8_000,
): string {
  const clipped = Array.from(body).slice(0, bodyCharacterLimit).join('')
  const truncated = countTextCharacters(body) > bodyCharacterLimit
  return `用户任务要求：\n${taskInstruction}\n\n固定规则：只能使用下方当前章节内容；不要剧透后续章节；不得补充章节外或未读信息；控制在 80–150 字；只返回摘要正文。

书名：《${bookTitle}》
章节：${chapterTitle}
${truncated ? '提示：正文过长，以下内容已截断。\n' : ''}
正文：
${clipped}`
}

export function planChapterSummaryRequest(
  bookTitle: string,
  chapterTitle: string,
  body: string,
  taskInstruction = BUILTIN_AI_PROMPTS.chapterSummary,
): { prompt: string; budget: AiBudgetEstimate; requiresConfirmation: boolean } {
  const fullPrompt = buildChapterSummaryPrompt(
    bookTitle,
    chapterTitle,
    body,
    taskInstruction,
    Number.POSITIVE_INFINITY,
  )
  const bodyCharacters = countTextCharacters(body)
  let bodyLimit = Math.min(8_000, bodyCharacters)
  let prompt = buildChapterSummaryPrompt(bookTitle, chapterTitle, body, taskInstruction, bodyLimit)
  while (countTextCharacters(prompt) > AI_INPUT_CHARACTER_BUDGET && bodyLimit > 0) {
    const overflow = countTextCharacters(prompt) - AI_INPUT_CHARACTER_BUDGET
    bodyLimit = Math.max(0, bodyLimit - Math.max(1, overflow))
    prompt = buildChapterSummaryPrompt(bookTitle, chapterTitle, body, taskInstruction, bodyLimit)
  }
  if (bodyLimit < 1 || countTextCharacters(prompt) > AI_INPUT_CHARACTER_BUDGET) {
    throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
  }
  return {
    prompt,
    requiresConfirmation: countTextCharacters(fullPrompt) > AI_INPUT_CHARACTER_BUDGET,
    budget: {
      originalCharacters: countTextCharacters(fullPrompt),
      sentCharacters: countTextCharacters(prompt),
      estimatedTokens: estimateAiTokens(prompt),
      chapterCount: 1,
      paragraphCount: normalizeAiParagraphs(body).length,
      batchCount: 1,
      range: bodyLimit < bodyCharacters
        ? `当前章节正文前 ${bodyLimit} 字，用于生成本章摘要；其余正文本次不发送。`
        : '当前章节全文，用于生成本章摘要。',
    },
  }
}

export interface AiCleanBatch {
  targetParagraphs: string[]
  prompt: string
}

export interface AiCleanPlan {
  batches: AiCleanBatch[]
  budget: AiBudgetEstimate
  requiresConfirmation: boolean
}

export function buildCleanPrompt(
  chapterTitle: string,
  body: string,
  taskInstruction = BUILTIN_AI_PROMPTS.clean,
): string {
  return `用户任务要求：\n${taskInstruction}\n\n固定规则：只能删除非正文内容；不得改写、续写或概括小说正文；保持段落顺序；只返回清理后的正文，不加解释。

章节标题：${chapterTitle}

原文：
${body}`
}

export function buildCleanBatchPrompt(
  chapterTitle: string,
  previousParagraph: string | undefined,
  targetParagraphs: string[],
  nextParagraph: string | undefined,
  taskInstruction = BUILTIN_AI_PROMPTS.clean,
): string {
  return `用户任务要求：\n${taskInstruction}\n\n固定规则：只清理“目标段落”；前后文仅供判断边界，绝不能出现在输出；只能删除非正文内容；不得改写、续写或概括小说正文；保持目标段落顺序；只返回清理后的目标段落，不加解释。

章节标题：${chapterTitle}

只读前文：
${previousParagraph ?? '（无）'}

目标段落：
${targetParagraphs.join('\n\n')}

只读后文：
${nextParagraph ?? '（无）'}`
}

export function planCleanChapterRequest(
  chapterTitle: string,
  body: string,
  taskInstruction = BUILTIN_AI_PROMPTS.clean,
): AiCleanPlan {
  const emptyBatchPrompt = buildCleanBatchPrompt(
    chapterTitle,
    undefined,
    [''],
    undefined,
    taskInstruction,
  )
  const segmentBudget = Math.floor(
    (AI_INPUT_CHARACTER_BUDGET - countTextCharacters(emptyBatchPrompt)) / 3,
  )
  const segmentLimit = Math.min(CLEAN_PARAGRAPH_SEGMENT_LIMIT, segmentBudget)
  const paragraphs = normalizeAiParagraphs(body, segmentLimit)
  const originalPrompt = buildCleanPrompt(chapterTitle, body, taskInstruction)
  const batches: AiCleanBatch[] = []
  let start = 0
  while (start < paragraphs.length) {
    let end = start
    let selectedPrompt = ''
    while (end < paragraphs.length) {
      const candidate = buildCleanBatchPrompt(
        chapterTitle,
        start > 0 ? paragraphs[start - 1] : undefined,
        paragraphs.slice(start, end + 1),
        end + 1 < paragraphs.length ? paragraphs[end + 1] : undefined,
        taskInstruction,
      )
      if (countTextCharacters(candidate) > AI_INPUT_CHARACTER_BUDGET) {
        if (end === start) throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
        break
      }
      selectedPrompt = candidate
      end += 1
    }
    const targetEnd = Math.max(start + 1, end)
    batches.push({
      targetParagraphs: paragraphs.slice(start, targetEnd),
      prompt: selectedPrompt || buildCleanBatchPrompt(
        chapterTitle,
        start > 0 ? paragraphs[start - 1] : undefined,
        [paragraphs[start]!],
        start + 1 < paragraphs.length ? paragraphs[start + 1] : undefined,
        taskInstruction,
      ),
    })
    start = targetEnd
  }
  if (batches.some((batch) => countTextCharacters(batch.prompt) > AI_INPUT_CHARACTER_BUDGET)) {
    throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
  }
  const sentCharacters = batches.reduce((total, batch) => total + countTextCharacters(batch.prompt), 0)
  return {
    batches,
    requiresConfirmation: countTextCharacters(originalPrompt) > AI_INPUT_CHARACTER_BUDGET,
    budget: {
      originalCharacters: countTextCharacters(originalPrompt),
      sentCharacters,
      estimatedTokens: batches.reduce((total, batch) => total + estimateAiTokens(batch.prompt), 0),
      chapterCount: 1,
      paragraphCount: paragraphs.length,
      batchCount: batches.length,
      range: `当前章节全文，按 ${batches.length} 批清理；每批仅携带目标前后各一段只读上下文。`,
    },
  }
}

export async function cleanChapterBody(
  config: AiConfig,
  chapterTitle: string,
  body: string,
  taskInstruction = BUILTIN_AI_PROMPTS.clean,
  signal?: AbortSignal,
  plan = planCleanChapterRequest(chapterTitle, body, taskInstruction),
  onUsage?: (usage: AiUsage | undefined) => Promise<void>,
): Promise<AiCleanResult> {
  const cleanedBatches: string[] = []
  for (const batch of plan.batches) {
    const result = await runAiTaskCompletion(
      config,
      [{ role: 'user', content: batch.prompt }],
      {
        task: 'clean',
        inputTokenEstimate: estimateAiTokens(batch.prompt),
        signal,
      },
    )
    await onUsage?.(result.usage)
    if (result.truncated) throw new Error('模型输出被截断，未生成可应用的清理预览')
    cleanedBatches.push(result.text.trim())
  }
  return { original: body, cleaned: cleanedBatches.join('\n\n') }
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
  taskInstruction = BUILTIN_AI_PROMPTS.recap,
): string {
  const context = chapterSummaries
    .map((c) => `【${c.title}】\n${(c.body ?? '').slice(0, 500)}`)
    .join('\n\n')

  return `用户任务要求：\n${taskInstruction}\n\n固定规则：只能使用下方已读章节；不得推测或剧透后续内容；控制在 300 字以内；只返回前情正文。

书名：《${bookTitle}》

已读章节：
${context}`
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
  taskInstruction = BUILTIN_AI_PROMPTS.recap,
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

  const prompt = buildSummarizePrompt(bookTitle, selected, taskInstruction)
  return chatCompletion(config, [
    { role: 'user', content: prompt },
  ], { task: 'recap' })
}

export function buildTranslatePrompt(
  text: string,
  taskInstruction = BUILTIN_AI_PROMPTS.translate,
): string {
  return `用户任务要求：\n${taskInstruction}\n\n固定规则：只能处理下方选中文字；不得补充小说其他内容；只返回译文或释义，不加解释。

原文：
${text}`
}

export async function translateText(
  config: AiConfig,
  text: string,
  taskInstruction = BUILTIN_AI_PROMPTS.translate,
): Promise<string> {
  const prompt = buildTranslatePrompt(text, taskInstruction)
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
