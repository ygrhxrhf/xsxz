import type { AiTaskKind } from './ai'
import type { Settings, TierSensePrefs } from '../shared/types'

export interface TierSenseDifficulty {
  score: number
  suggestedThinking?: boolean
}

export interface TierSenseCompression {
  compressed: string
  savedRatio?: number
}

export interface TierSenseDecision {
  action: 'proceed' | 'skip'
  reason?: string
}

export interface TierSenseClient {
  difficulty(text: string, task: AiTaskKind, signal?: AbortSignal): Promise<TierSenseDifficulty | null>
  compress(text: string, task: AiTaskKind, signal?: AbortSignal): Promise<TierSenseCompression | null>
  memoryDecide(input: { bookTitle: string; batchCharacters: number; candidateCount: number },
               signal?: AbortSignal): Promise<TierSenseDecision | null>
  ping(signal?: AbortSignal): Promise<string | null>
}

export interface AiRequestAdvisor {
  consult?(params: {
    prompt: string
    task: AiTaskKind
    signal?: AbortSignal
  }): Promise<{
    messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    maxTokensOverride?: number
    thinkingOverride?: boolean
    skip?: { result: Record<string, unknown>; reason: string }
  } | null>
  observe?(params: {
    task: AiTaskKind
    truncated: boolean
    usage?: { inputTokens?: number; outputTokens?: number }
  }): void
}

export const TIER_SENSE_TASKS: ReadonlySet<AiTaskKind> = new Set([
  'evidenceQa',
  'chapterNote',
  'recap',
  'memory',
])

const TIER_SENSE_TIMEOUT_MS = 8000

interface TierSenseClientConfig {
  baseUrl: string
  apiKey: string
  prefs: TierSensePrefs
}

interface TierSenseClientHooks {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export function createTierSenseClient(
  config: TierSenseClientConfig,
  hooks?: TierSenseClientHooks,
): TierSenseClient {
  const fetchImpl = hooks?.fetch ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = hooks?.timeoutMs ?? TIER_SENSE_TIMEOUT_MS
  const disabledApis = new Set<string>()

  async function call<T>(
    api: string,
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    if (!config.prefs.enabled || !config.baseUrl || !config.apiKey) return null
    if (disabledApis.has(api)) return null

    const timeout = AbortSignal.timeout(timeoutMs)
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout

    try {
      const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      })

      if (response.status === 401 || response.status === 403 || response.status === 400 || response.status === 422) {
        disabledApis.add(api)
        return null
      }

      if (!response.ok) return null

      const data = await response.json() as Record<string, unknown>
      return data as T
    } catch {
      return null
    }
  }

  return {
    async difficulty(text, task, signal) {
      if (!config.prefs.difficultyEnabled) return null
      const result = await call<{ score: number; suggested_thinking?: boolean }>(
        'difficulty',
        '/v1/score',
        { text, task },
        signal,
      )
      if (!result || typeof result.score !== 'number') return null
      return {
        score: result.score,
        suggestedThinking: result.suggested_thinking === true ? true : undefined,
      }
    },

    async compress(text, task, signal) {
      if (!config.prefs.compressionEnabled) return null
      const result = await call<{ compressed: string; saved_ratio?: number }>(
        'compress',
        '/v1/compress',
        { text, task },
        signal,
      )
      if (!result || typeof result.compressed !== 'string') return null
      return {
        compressed: result.compressed,
        savedRatio: typeof result.saved_ratio === 'number' ? result.saved_ratio : undefined,
      }
    },

    async memoryDecide(input, signal) {
      if (!config.prefs.memoryDecideEnabled) return null
      const result = await call<{ action: string; reason?: string }>(
        'memoryDecide',
        '/v1/memory/decide',
        {
          book_title: input.bookTitle,
          batch_characters: input.batchCharacters,
          candidate_count: input.candidateCount,
        },
        signal,
      )
      if (!result || (result.action !== 'proceed' && result.action !== 'skip')) return null
      return {
        action: result.action,
        reason: typeof result.reason === 'string' ? result.reason : undefined,
      }
    },

    async ping(signal) {
      const timeout = AbortSignal.timeout(timeoutMs)
      const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      try {
        const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/health`, {
          method: 'GET',
          signal: combinedSignal,
        })
        if (!response.ok) return null
        return 'ok'
      } catch {
        return null
      }
    },
  }
}

export function splitCompressibleBody(prompt: string): { head: string; body: string } | null {
  const markers = ['当前章节内容：', '章节内容：', '正文：', '内容：']
  for (const marker of markers) {
    const idx = prompt.indexOf(marker)
    if (idx >= 0) {
      const head = prompt.slice(0, idx + marker.length)
      const body = prompt.slice(idx + marker.length)
      if (body.trim().length > 100) return { head, body }
    }
  }
  return null
}

export function createTierSenseAdvisor(
  client: TierSenseClient | null,
  task: AiTaskKind,
  report: (logLine: string, uiDetail?: string) => void,
): AiRequestAdvisor | undefined {
  if (!client || !TIER_SENSE_TASKS.has(task)) return undefined

  return {
    async consult({ prompt, signal }) {
      let difficultyResult: TierSenseDifficulty | null = null
      let compressionResult: TierSenseCompression | null = null

      difficultyResult = await client.difficulty(prompt, task, signal)
      if (difficultyResult) {
        report(
          `[TierSense] task=${task} score=${difficultyResult.score.toFixed(2)}`,
          `难度评分: ${difficultyResult.score.toFixed(2)}`,
        )
      }

      const split = splitCompressibleBody(prompt)
      if (split) {
        compressionResult = await client.compress(split.body, task, signal)
        if (compressionResult) {
          report(
            `[TierSense] task=${task} compressed savedRatio=${compressionResult.savedRatio?.toFixed(2) ?? 'N/A'}`,
            `压缩率: ${compressionResult.savedRatio !== undefined ? `${(compressionResult.savedRatio * 100).toFixed(0)}%` : '已完成'}`,
          )
        }
      }

      if (!difficultyResult && !compressionResult) return null

      const result: {
        messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
        maxTokensOverride?: number
        thinkingOverride?: boolean
      } = {}

      if (difficultyResult) {
        if (difficultyResult.score >= 0.6) {
          result.thinkingOverride = true
          result.maxTokensOverride = undefined
        } else {
          result.thinkingOverride = false
        }
      }

      if (compressionResult && split) {
        result.messages = [{ role: 'user', content: split.head + compressionResult.compressed }]
      }

      return result
    },

    observe({ task: observedTask, truncated, usage }) {
      report(
        `[TierSense] observe task=${observedTask} truncated=${truncated} input=${usage?.inputTokens ?? 0} output=${usage?.outputTokens ?? 0}`,
      )
    },
  }
}

export async function tierSenseAdvisorFor(
  settings: Settings,
  apiKey: string | undefined,
  task: AiTaskKind,
  report: (logLine: string, uiDetail?: string) => void,
): Promise<AiRequestAdvisor | undefined> {
  const tierSense = settings.ai?.tierSense
  if (!tierSense?.enabled || !tierSense.baseUrl || !apiKey) return undefined

  const client = createTierSenseClient({
    baseUrl: tierSense.baseUrl,
    apiKey,
    prefs: tierSense,
  })

  return createTierSenseAdvisor(client, task, report)
}
