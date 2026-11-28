import type { AiModelsResult } from '../shared/types'

/**
 * 模型列表只是界面辅助：拉不到就回退内置候选，所以超时比一次对话短得多。
 */
export const AI_MODELS_TIMEOUT_MS = 10_000

type ModelsFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

function readModelId(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return ''
  const id = (entry as { id?: unknown }).id
  return typeof id === 'string' ? id.trim() : ''
}

/**
 * 从已配置端点读取可选模型名（OpenAI 兼容 `GET {baseUrl}/models`）。
 * 任何失败都返回 `{ ok: false, message }`，不抛异常——调用方是界面辅助，不该因此报错中断。
 */
export async function listAiModels(
  config: { baseUrl: string; apiKey?: string },
  fetchImpl: ModelsFetch = fetch as unknown as ModelsFetch,
  timeoutMs: number = AI_MODELS_TIMEOUT_MS,
): Promise<AiModelsResult> {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  if (!baseUrl) return { ok: false, message: '还没有配置模型接口地址' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
  try {
    const headers: Record<string, string> = {}
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    const res = await fetchImpl(`${baseUrl}/models`, { headers, signal: controller.signal })
    if (!res.ok) return { ok: false, message: `读取模型列表失败（HTTP ${res.status}）` }
    let payload: unknown
    try {
      payload = await res.json()
    } catch {
      return { ok: false, message: '模型列表不是 JSON，端点可能不是 OpenAI 兼容接口' }
    }
    const data = (payload as { data?: unknown } | null)?.data
    if (!Array.isArray(data)) return { ok: false, message: '模型列表格式无法识别' }
    const models = data.map(readModelId).filter((id) => id.length > 0)
    if (models.length === 0) return { ok: false, message: '端点没有返回任何模型' }
    return { ok: true, models }
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') return { ok: false, message: '读取模型列表超时' }
    return { ok: false, message: `读取模型列表失败：${e instanceof Error ? e.message : String(e)}` }
  } finally {
    clearTimeout(timer)
  }
}
