import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { app, safeStorage } from 'electron'

import type { CraftPushResult, CraftState } from '../shared/types'
import { atomicWriteText } from './atomicFile'

/**
 * Crafty 联动：把一本书的读书笔记推到 Crafty 的 `POST /api/v1/import/markdown`。
 *
 * 三件事在这里：
 * 1. 连接配置（地址 + 写入令牌）落 `userData/craft-push.json`，令牌走 safeStorage——
 *    与云同步的账号令牌同规格：明文只在本机、只在主进程内存里，渲染层永远拿不到。
 * 2. 每本书的幂等键落 `<bookDir>/ai/craft-link.json`（上一版推出来的文档 id）。
 *    Crafty 那边没有外部 id 列，所以「同一本书更新同一篇」靠本地记住这个 id。
 * 3. 推送本身。`documentId` 万一在 Crafty 里被删了（404 `not_found`），自动退回新建一次，
 *    不让读者看到一次无解的错误。
 *
 * 网络层可注入（`fetchJson`），单测不碰真 HTTP；`bookDirOf` 同理，单测不碰真书库。
 */

export const CRAFT_LINK_FILE = 'craft-link.json'
export const DEFAULT_CRAFT_FOLDER = '阅读笔记'
const MAX_NOTE_CHARS = 450_000

export class CraftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CraftError'
  }
}

interface ConfigFile {
  version: 1
  endpoint: string
  tokenEnc?: string
}

/** 每本书的推送记录：记住上一版的文档 id 与内容指纹。 */
export interface CraftLink {
  version: 1
  docId: string
  endpoint: string
  contentHash: string
  pushedAt: string
}

export interface CraftStore {
  read(): Promise<CraftState>
  getToken(): Promise<string>
  save(input: { endpoint?: string; token?: string }): Promise<CraftState>
  clear(): Promise<CraftState>
}

/** 单测注入目录；null = 用真实的 userData 目录。 */
let overrideDir: string | null = null

export function setCraftDir(dir: string | null): void {
  overrideDir = dir
}

function configPath(): string {
  return join(overrideDir ?? app.getPath('userData'), 'craft-push.json')
}

async function readConfig(): Promise<ConfigFile> {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf-8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') throw new Error('bad')
    return {
      version: 1,
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
      tokenEnc: typeof raw.tokenEnc === 'string' ? raw.tokenEnc : undefined,
    }
  } catch {
    return { version: 1, endpoint: '' }
  }
}

async function writeConfig(config: ConfigFile): Promise<void> {
  await mkdir(join(configPath(), '..'), { recursive: true }).catch(() => {})
  await atomicWriteText(configPath(), JSON.stringify(config, null, 2))
}

async function decryptToken(tokenEnc: string | undefined): Promise<{ token: string; unreadable: boolean }> {
  if (!tokenEnc) return { token: '', unreadable: false }
  try {
    const result = await safeStorage.decryptStringAsync(Buffer.from(tokenEnc, 'base64'))
    return { token: result.result, unreadable: false }
  } catch {
    return { token: '', unreadable: true }
  }
}

/** 规范化站点地址：去尾斜杠；允许直接粘对端的完整导入地址。 */
export function normalizeCraftEndpoint(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (!/^https?:\/\//i.test(trimmed)) return ''
  return trimmed
}

export function craftImportUrl(endpoint: string): string {
  const base = normalizeCraftEndpoint(endpoint)
  return /\/api\/v1\/import\/markdown$/i.test(base) ? base : `${base}/api/v1/import/markdown`
}

export function createCraftStore(): CraftStore {
  async function state(): Promise<CraftState> {
    const config = await readConfig()
    const { token, unreadable } = await decryptToken(config.tokenEnc)
    const endpoint = normalizeCraftEndpoint(config.endpoint)
    const state: CraftState = {
      configured: Boolean(endpoint && token),
      endpoint,
      tokenConfigured: Boolean(token),
    }
    if (unreadable) state.tokenUnreadable = true
    return state
  }

  return {
    read: state,
    async getToken() {
      return (await decryptToken((await readConfig()).tokenEnc)).token
    },
    async save(input) {
      const config = await readConfig()
      const next: ConfigFile = { ...config }
      if (typeof input.endpoint === 'string') next.endpoint = normalizeCraftEndpoint(input.endpoint)
      if (typeof input.token === 'string') {
        const token = input.token.trim()
        if (!token) {
          next.tokenEnc = undefined
        } else {
          const available = await safeStorage.isAsyncEncryptionAvailable().catch(() => false)
          if (!available) throw new CraftError('本机密钥库不可用，无法安全保存令牌')
          next.tokenEnc = (await safeStorage.encryptStringAsync(token)).toString('base64')
        }
      }
      await writeConfig(next)
      return state()
    },
    async clear() {
      await writeConfig({ version: 1, endpoint: '' })
      return state()
    },
  }
}

/** `ai/craft-link.json`；坏文件与缺文件一样视为没有推过。 */
export async function readCraftLink(bookDir: string): Promise<CraftLink | null> {
  try {
    const raw = JSON.parse(await readFile(join(bookDir, 'ai', CRAFT_LINK_FILE), 'utf-8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || typeof raw.docId !== 'string' || !raw.docId) return null
    return {
      version: 1,
      docId: raw.docId,
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
      contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : '',
      pushedAt: typeof raw.pushedAt === 'string' ? raw.pushedAt : '',
    }
  } catch {
    return null
  }
}

export async function writeCraftLink(bookDir: string, link: CraftLink): Promise<void> {
  const dir = join(bookDir, 'ai')
  await mkdir(dir, { recursive: true }).catch(() => {})
  await atomicWriteText(join(dir, CRAFT_LINK_FILE), JSON.stringify(link, null, 2))
}

export interface CraftHttpResponse {
  status: number
  body: unknown
}

export interface CraftPushDeps {
  store: CraftStore
  bookDirOf: (bookId: string) => string
  fetchJson: (url: string, init: { body: string; headers: Record<string, string> }) => Promise<CraftHttpResponse>
  now?: () => string
}

export interface CraftPushInput {
  bookId: string
  title: string
  markdown: string
}

function errorMessageOf(body: unknown): string {
  if (body && typeof body === 'object') {
    const message = (body as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return ''
}

function firstDocument(body: unknown): { id: string; title: string; created: boolean } | null {
  if (!body || typeof body !== 'object') return null
  const documents = (body as Record<string, unknown>).documents
  if (!Array.isArray(documents) || !documents.length) return null
  const first = documents[0] as Record<string, unknown>
  if (typeof first.id !== 'string' || !first.id) return null
  return {
    id: first.id,
    title: typeof first.title === 'string' ? first.title : '',
    created: Boolean(first.created),
  }
}

function statusMessage(status: number, body: unknown): string {
  const detail = errorMessageOf(body)
  if (status === 401) return 'Crafty 令牌无效或已被吊销，请到连接页重新复制写入令牌'
  if (status === 403) return '这个令牌是只读的：推送笔记要用连接页「阅读笔记导入」里的写入令牌'
  if (status === 404) return detail || 'Crafty 上找不到目标文档'
  if (status === 413) return detail || '这篇笔记超过了 Crafty 的单篇上限'
  return detail || `推送失败：HTTP ${status}`
}

/**
 * 推一本书。成功返回文档 id 与是否新建；失败抛 `CraftError`，消息是给人看的中文。
 */
export async function pushCraftNote(deps: CraftPushDeps, input: CraftPushInput): Promise<CraftPushResult> {
  if (input.markdown.length > MAX_NOTE_CHARS) {
    throw new CraftError(`这本书的笔记太长了（${input.markdown.length} 字），超过了单篇上限 ${MAX_NOTE_CHARS}`)
  }

  const state = await deps.store.read()
  const token = await deps.store.getToken()
  if (!state.endpoint) throw new CraftError('还没有填 Crafty 地址，先到设置里填上')
  if (!token) {
    throw new CraftError(
      state.tokenUnreadable ? '令牌在本机解不开，请重新粘贴一次' : '还没有填 Crafty 写入令牌，先到设置里填上',
    )
  }

  const bookDir = deps.bookDirOf(input.bookId)
  const previous = await readCraftLink(bookDir)
  const reusableDocId = previous && previous.endpoint === state.endpoint ? previous.docId : undefined
  const url = craftImportUrl(state.endpoint)
  const now = deps.now?.() ?? new Date().toISOString()

  const send = async (documentId?: string) => {
    const file: Record<string, unknown> = { name: `${input.title}.md`, text: input.markdown }
    if (documentId) file.documentId = documentId
    return deps.fetchJson(url, {
      body: JSON.stringify({ folder: DEFAULT_CRAFT_FOLDER, files: [file] }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    })
  }

  let response = await send(reusableDocId)
  // 上次推出来的那篇在 Crafty 里被删了：清掉旧映射，按新建再试一次。
  if (response.status === 404 && reusableDocId) response = await send()

  if (response.status < 200 || response.status >= 300) {
    throw new CraftError(statusMessage(response.status, response.body))
  }
  const document = firstDocument(response.body)
  if (!document) throw new CraftError('Crafty 没有返回文档 id，推送结果不确定，请到 Crafty 里核对一下')

  await writeCraftLink(bookDir, {
    version: 1,
    docId: document.id,
    endpoint: state.endpoint,
    contentHash: createHash('sha256').update(input.markdown, 'utf8').digest('hex'),
    pushedAt: now,
  })

  return {
    docId: document.id,
    title: document.title || input.title,
    created: document.created,
    bytes: Buffer.byteLength(input.markdown, 'utf8'),
    pushedAt: now,
    endpoint: state.endpoint,
  }
}
