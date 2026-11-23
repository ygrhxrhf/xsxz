import { app, safeStorage } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuleMarketEntry, RuleMarketSource, SiteRule, SyncAccountState, SyncBundle } from '../shared/types'
import { atomicWriteText } from './atomicFile'
import {
  localRuleToMarketEntry,
  marketEntryToSiteRule,
  mergeMarketEntries,
  parseMarketListing,
} from './ruleMarket'
import { buildSyncBundle, parseSyncBundle, stripCredentialFields } from './syncCloud'

/**
 * 规则市场与账号同步的 IPC 注册。
 *
 * 频道名与 `src/preload/index.ts` 逐字一致，形状与 `docs/ipc-contract.md` 一致：
 * `ruleMarket.list` / `apply` / `subscribe` / `unsubscribe` 与
 * `sync.status` / `signIn` / `signOut` / `run`。
 *
 * 两条硬约束在这一层兜住：
 * 1. 令牌只在本机（safeStorage 或注入的凭据存储），**绝不进同步包、不回渲染层**。
 * 2. 市场条目与同步包只含 CSS 选择器与白名单设置，凭据形状的字段在纯函数层被剔除。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 与 ipcMain.handle 的 ...args: any[] 对齐
export type IpcRegistrar = (channel: string, listener: (...args: any[]) => unknown) => void

/** 一个已订阅的规则清单来源。磁盘格式归 `ruleMarketStore.ts`，这里只当形状用。 */
export interface MarketSubscription {
  /** 清单地址（http(s) 绝对地址）。 */
  url: string
  /** 上次拉回的条目快照。 */
  entries: RuleMarketEntry[]
  /** 上次拉取时间（ISO 字符串）。 */
  updatedAt: string
}

/** 令牌等凭据的本机存储。默认实现走 safeStorage；测试可注入内存实现。 */
export interface CredentialStore {
  get(): Promise<string>
  set(token: string): Promise<void>
  clear(): Promise<void>
}

/** 登录状态（不含令牌）的本机存储。 */
export interface AccountStore {
  read(): Promise<{ account: string; endpoint: string }>
  write(value: { account: string; endpoint: string }): Promise<void>
  clear(): Promise<void>
}

/** 同步传输：把数据包交给云端并拿回云端版本。 */
export interface SyncTransport {
  (input: { endpoint: string; token: string; bundle: SyncBundle }): Promise<{
    bundle: SyncBundle | null
    message?: string
  }>
}

export interface RuleMarketIpcDeps {
  /** 本机已装的站点规则（作为市场的 local 来源）。 */
  listLocalRules(): Promise<SiteRule[]>
  /** 把规则写进本机（整条替换同 host）。 */
  applyLocalRule(rule: SiteRule): Promise<SiteRule>
  /** 已订阅的来源。 */
  listSubscriptions(): Promise<MarketSubscription[]>
  saveSubscription(subscription: MarketSubscription): Promise<void>
  removeSubscription(url: string): Promise<void>
  /** 拉取远端清单正文。 */
  fetchText(url: string): Promise<string>
  /** 设置快照（构造同步包用）。 */
  readSettings(): Promise<unknown>
  /** 把云端拉回的设置写回本机；没有就只同步规则。 */
  applyRemoteSettings?(settings: Record<string, unknown>): Promise<void>
  /** 凭据存储（令牌）。 */
  credentials: CredentialStore
  /** 登录状态存储。 */
  account: AccountStore
  /** 同步传输；缺省用内置的 HTTP 传输。 */
  transport?: SyncTransport
}

/**
 * 内置同步端点。
 *
 * 这是占位域名：本项目没有自营的同步服务，因此 `sync.run` 在它上面必然失败，
 * 并如实返回「同步端点不可达」。要真同步，用 `sync.signIn` 的 `endpoint`
 * 参数指向自己的服务端（自带 HTTP 接口即可）。
 */
export const DEFAULT_SYNC_ENDPOINT = 'https://sync.spbf.app'

const FILE_VERSION = 1

interface AccountFile {
  version: number
  account: string
  endpoint: string
  /** 令牌密文（base64）；只在主进程解，绝不下发。 */
  tokenEnc?: string
}

/** 单测注入目录；null = 用真实的 userData 目录。 */
let overrideDir: string | null = null

function userDataRoot(): string {
  return overrideDir ?? app.getPath('userData')
}

function accountPath(): string {
  return join(userDataRoot(), 'sync-account.json')
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {})
  await atomicWriteText(path, JSON.stringify(data, null, 2))
}

async function readAccountFile(): Promise<AccountFile> {
  try {
    const raw = JSON.parse(await readFile(accountPath(), 'utf-8'))
    if (!raw || typeof raw !== 'object') throw new Error('bad')
    const source = raw as Record<string, unknown>
    return {
      version: FILE_VERSION,
      account: typeof source.account === 'string' ? source.account : '',
      endpoint: typeof source.endpoint === 'string' ? source.endpoint : '',
      tokenEnc: typeof source.tokenEnc === 'string' ? source.tokenEnc : undefined,
    }
  } catch {
    return { version: FILE_VERSION, account: '', endpoint: '' }
  }
}

/** safeStorage 凭据存储：令牌加密后与登录状态同文件落盘。 */
export function createSafeStorageCredentialStore(): CredentialStore {
  return {
    async get() {
      const file = await readAccountFile()
      if (!file.tokenEnc) return ''
      try {
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(file.tokenEnc, 'base64'))
        return decrypted.result
      } catch {
        return ''
      }
    },
    async set(token) {
      const available = await safeStorage.isAsyncEncryptionAvailable().catch(() => false)
      if (!available) throw new Error('本机密钥库不可用，无法安全保存令牌')
      const file = await readAccountFile()
      const encrypted = await safeStorage.encryptStringAsync(token)
      await writeJson(accountPath(), { ...file, tokenEnc: encrypted.toString('base64') })
    },
    async clear() {
      const file = await readAccountFile()
      await writeJson(accountPath(), { ...file, tokenEnc: undefined })
    },
  }
}

/** 登录状态存储：只存账号标识与端点，不含令牌。 */
export function createAccountStore(): AccountStore {
  return {
    async read() {
      const file = await readAccountFile()
      return { account: file.account, endpoint: file.endpoint }
    },
    async write(value) {
      const file = await readAccountFile()
      await writeJson(accountPath(), {
        ...file,
        account: value.account,
        endpoint: value.endpoint,
      })
    },
    async clear() {
      const file = await readAccountFile()
      await writeJson(accountPath(), { ...file, account: '', endpoint: '' })
    },
  }
}

/** 内置 HTTP 传输：POST 数据包，拿回云端版本。 */
export const defaultSyncTransport: SyncTransport = async ({ endpoint, token, bundle }) => {
  const base = endpoint.replace(/\/+$/, '')
  let response: Response
  try {
    response = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(bundle),
    })
  } catch (error) {
    return { bundle: null, message: `同步端点不可达：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) {
    return { bundle: null, message: `同步端点返回 ${response.status}` }
  }
  try {
    const raw = (await response.json()) as unknown
    const candidate =
      raw && typeof raw === 'object' && 'bundle' in (raw as Record<string, unknown>)
        ? (raw as Record<string, unknown>).bundle
        : raw
    return { bundle: parseSyncBundle(candidate), message: '' }
  } catch (error) {
    return { bundle: null, message: `同步端点返回的不是合法数据包：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 清单地址必须是 http(s) 绝对地址。 */
export function assertMarketUrl(url: unknown): string {
  const text = typeof url === 'string' ? url.trim() : ''
  if (!text) throw new Error('清单地址不能为空')
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new Error('清单地址必须是 http(s) 绝对地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('清单地址必须是 http(s) 绝对地址')
  }
  return parsed.toString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 账号状态：登录态由「有令牌」决定，端点与账号来自账号文件。 */
async function readAccountState(deps: RuleMarketIpcDeps): Promise<SyncAccountState> {
  const token = await deps.credentials.get().catch(() => '')
  const { account, endpoint } = await deps.account.read().catch(() => ({ account: '', endpoint: '' }))
  return { signedIn: Boolean(token), account, endpoint }
}

/**
 * 注册规则市场与账号同步的 8 个 handler。
 *
 * 依赖全部注入：磁盘、磁盘路径、网络与凭据存储都不在模块里硬连，
 * 单测与主进程接线都走同一条路。
 */
export function registerRuleMarketIpc(register: IpcRegistrar, deps: RuleMarketIpcDeps): void {
  const transport = deps.transport ?? defaultSyncTransport

  /** 汇总市场条目：远端订阅 + 本机自建。 */
  async function buildListing(): Promise<{ entries: RuleMarketEntry[]; sources: Record<string, RuleMarketSource> }> {
    const subscriptions = await deps.listSubscriptions()
    const remoteEntries = subscriptions.flatMap((subscription) => subscription.entries)
    const localRules = await deps.listLocalRules().catch(() => [])
    const localEntries = localRules
      .map((rule) => localRuleToMarketEntry(rule))
      .filter((entry): entry is RuleMarketEntry => entry !== null)
    const listing = mergeMarketEntries([
      { source: 'remote', entries: remoteEntries },
      { source: 'local', entries: localEntries },
    ])
    return { entries: listing.entries, sources: listing.sources }
  }

  register('ruleMarket.list', async () => {
    try {
      return await buildListing()
    } catch {
      // 列表频道没有失败分支（见契约）：读不到来源时给空列表，界面据此显示「暂无条目」。
      return { entries: [], sources: {} }
    }
  })

  register('ruleMarket.apply', async (_e, payload: { id?: string }) => {
    try {
      const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
      if (!id) return { ok: false, message: '市场条目 ID 不能为空' }
      const listing = await buildListing()
      const entry = listing.entries.find((item) => item.id === id || item.host === id)
      if (!entry) return { ok: false, message: `市场里没有这条规则：${id}` }
      const rule = await deps.applyLocalRule(marketEntryToSiteRule(entry))
      return { ok: true, rule }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  register('ruleMarket.subscribe', async (_e, payload: { url?: string }) => {
    try {
      const url = assertMarketUrl(payload?.url)
      const text = await deps.fetchText(url)
      const entries = parseMarketListing(parseJsonMaybe(text))
      const subscription: MarketSubscription = {
        url,
        entries,
        updatedAt: new Date().toISOString(),
      }
      await deps.saveSubscription(subscription)
      return { ok: true, entries }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  register('ruleMarket.unsubscribe', async (_e, payload: { url?: string }) => {
    try {
      const url = assertMarketUrl(payload?.url)
      await deps.removeSubscription(url)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  register('sync.status', async () => {
    // 契约里这条频道没有失败分支：读不到就报未登录，不抛错。
    return { ok: true, state: await readAccountState(deps) }
  })

  register('sync.signIn', async (_e, payload: { token?: string; endpoint?: string; account?: string }) => {
    try {
      const token = typeof payload?.token === 'string' ? payload.token.trim() : ''
      if (!token) return { ok: false, message: '令牌不能为空' }
      const endpoint = (typeof payload?.endpoint === 'string' ? payload.endpoint.trim() : '') || DEFAULT_SYNC_ENDPOINT
      const account = typeof payload?.account === 'string' ? payload.account.trim() : ''
      await deps.credentials.set(token)
      await deps.account.write({ account, endpoint })
      return { ok: true, state: await readAccountState(deps) }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  register('sync.signOut', async () => {
    // 契约里这条频道也没有失败分支：只清本机令牌，返回清完之后的状态。
    // 云端已存的数据不动。
    await deps.credentials.clear().catch(() => {})
    await deps.account.clear().catch(() => {})
    return { ok: true, state: await readAccountState(deps) }
  })

  register('sync.run', async () => {
    try {
      const token = await deps.credentials.get().catch(() => '')
      if (!token) return { ok: false, message: '未登录，请先登录同步账号' }
      const { endpoint } = await deps.account.read().catch(() => ({ account: '', endpoint: '' }))
      const target = endpoint || DEFAULT_SYNC_ENDPOINT

      const settings = await deps.readSettings()
      const rules = await deps.listLocalRules().catch(() => [])
      const bundle = buildSyncBundle(settings, rules)

      // 兜底再剔一次凭据形状：同步包是唯一出境的数据，不能带任何 Key 或令牌。
      const safeBundle: SyncBundle = {
        ...bundle,
        settings: stripCredentialFields(bundle.settings),
      }

      const response = await transport({ endpoint: target, token, bundle: safeBundle })
      if (!response.bundle) {
        return { ok: false, message: response.message || '同步失败' }
      }

      const remote = response.bundle
      if (deps.applyRemoteSettings) {
        await deps.applyRemoteSettings(stripCredentialFields(remote.settings)).catch(() => {})
      }
      for (const rule of remote.rules) {
        await deps.applyLocalRule(rule).catch(() => {})
      }

      const pulled = remote.rules.length + Object.keys(remote.settings).length
      const pushed = safeBundle.rules.length + Object.keys(safeBundle.settings).length
      return {
        ok: true,
        result: {
          ok: true,
          updatedAt: remote.updatedAt,
          pushed,
          pulled,
          message: '',
        },
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })
}

/** 清单正文可能是 JSON，也可能是一段 HTML 里的 JSON 片段；只认 JSON。 */
function parseJsonMaybe(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  return null
}
