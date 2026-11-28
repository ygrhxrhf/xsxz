import type { CraftPushResult } from '../shared/types'
import { buildCraftNoteMarkdown, craftNoteTitle } from './craftMarkdown'
import type { CraftMaterials } from './craftMaterials'
import {
  CraftError,
  pushCraftNote,
  type CraftHttpResponse,
  type CraftStore,
} from './craftPush'

/**
 * Crafty 联动的三个频道：`craft.status` / `craft.configure` / `craft.push`。
 *
 * 与 `ruleMarketIpc` 同构：注册器与全部依赖都由调用方注入，因此这一层不 import electron，
 * 单测直接拿假 store、假书、假 fetch 跑；真实接线在 `index.ts`。
 *
 * 分级上刻意分开：`configure` 能改推送目标，对 agent 是破坏性操作（要令牌确认）；
 * `push` 只往「本人已经配好的那个站点」发送，故按普通写入。
 */

type Register = (channel: string, listener: (event: unknown, payload?: any) => Promise<unknown>) => void

export interface CraftIpcDeps {
  store: CraftStore
  bookDirOf: (bookId: string) => string
  loadMaterials: (bookId: string) => Promise<CraftMaterials>
  fetchJson: (url: string, init: { body: string; headers: Record<string, string> }) => Promise<CraftHttpResponse>
  now?: () => string
}

function messageOf(error: unknown): string {
  if (error instanceof CraftError) return error.message
  if (error instanceof Error && error.message) return error.message
  return '推送失败，请稍后重试'
}

export function registerCraftIpc(register: Register, deps: CraftIpcDeps): void {
  const now = () => deps.now?.() ?? new Date().toISOString()

  register('craft.status', async () => {
    return { ok: true, state: await deps.store.read() }
  })

  register('craft.configure', async (_event, payload?: { endpoint?: unknown; token?: unknown }) => {
    const endpoint = typeof payload?.endpoint === 'string' ? payload.endpoint : undefined
    const token = typeof payload?.token === 'string' ? payload.token : undefined
    if (endpoint !== undefined && endpoint.trim() && !/^https?:\/\//i.test(endpoint.trim())) {
      return { ok: false, message: '地址要以 http:// 或 https:// 开头' }
    }
    try {
      return { ok: true, state: await deps.store.save({ endpoint, token }) }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  })

  register('craft.push', async (_event, payload?: { bookId?: unknown }) => {
    const bookId = typeof payload?.bookId === 'string' ? payload.bookId.trim() : ''
    if (!bookId) return { ok: false, message: '请先选择一本书' }
    try {
      const materials = await deps.loadMaterials(bookId)
      const at = now()
      const title = craftNoteTitle(materials.book.title)
      const markdown = buildCraftNoteMarkdown({ ...materials, pushedAt: at })
      const result: CraftPushResult = await pushCraftNote(
        {
          store: deps.store,
          bookDirOf: deps.bookDirOf,
          fetchJson: deps.fetchJson,
          now: () => at,
        },
        { bookId, title, markdown },
      )
      return { ok: true, result }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  })
}

/**
 * 真实网络层：POST 一帧 JSON，20s 超时。连不上与超时都翻成能照着做的中文，
 * 其余状态码原样交回 `craftPush` 解释。
 */
export function createCraftFetch(timeoutMs = 20_000): CraftIpcDeps['fetchJson'] {
  return async (url, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      })
      const text = await response.text()
      let body: unknown = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = { message: text.slice(0, 200) }
      }
      return { status: response.status, body }
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError'
      throw new CraftError(
        aborted ? '连接 Crafty 超时：检查地址与本机网络，或服务是否在运行' : `连不上 Crafty：${messageOf(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
