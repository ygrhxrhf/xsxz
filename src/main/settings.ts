import { app, safeStorage } from 'electron'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from './atomicFile'
import type {
  AiPrefs,
  AutoUpdateCheckPrefs,
  ProxyPrefs,
  AiPromptKind,
  AiProvider,
  AppearancePrefs,
  BrowseFavorite,
  DownloadPace,
  ReaderBookView,
  ReaderContentWidth,
  ReaderFocusMode,
  ReaderFontFamily,
  ReaderHandwritingFont,
  ReaderReadingMode,
  ReaderParagraphSpacing,
  ReaderSheetColumns,
  ReaderPrefs,
  ReaderTheme,
  Settings,
  SettingsUpdate,
  Skin,
  TierSensePrefs,
  TtsPrefs,
  WebReadingPrefs,
} from '../shared/types'
import {
  AI_PROMPT_KINDS,
  DEFAULT_AI_PREFS,
  DEFAULT_APPEARANCE_PREFS,
  DEFAULT_READER_PREFS,
  DEFAULT_TTS_PREFS,
  DEFAULT_WEB_READING_PREFS,
  DEFAULT_AI_PLACEHOLDER,
  DEFAULT_TIER_SENSE_PREFS,
  DEFAULT_PROXY_PREFS,
} from '../shared/types'
import { defaultLibraryPath } from './libraryPath'
import { normalizeProxyPrefs } from './proxy'

const SKINS: readonly Skin[] = ['light', 'dark']
const DOWNLOAD_PACES: readonly DownloadPace[] = ['slow', 'standard', 'fast']
const READER_THEMES: readonly ReaderTheme[] = ['paper', 'sepia', 'gray', 'night']
const READER_FONT_FAMILIES: readonly ReaderFontFamily[] = ['serif', 'system', 'mono', 'wenkai']
const READER_CONTENT_WIDTHS: readonly ReaderContentWidth[] = ['narrow', 'medium', 'wide']
const READER_PARAGRAPH_SPACINGS: readonly ReaderParagraphSpacing[] = ['compact', 'normal', 'relaxed']
const READER_FOCUS_MODES: readonly ReaderFocusMode[] = ['off', 'one', 'three', 'five']
const READER_READING_MODES: readonly ReaderReadingMode[] = ['scroll', 'screen']
const READER_BOOK_VIEWS: readonly ReaderBookView[] = ['classic', 'sheet', 'realbook']
const READER_SHEET_COLUMNS: readonly ReaderSheetColumns[] = ['single', 'double']
const READER_HANDWRITING_FONTS: readonly ReaderHandwritingFont[] = ['none', 'kai', 'xingshu']
const AI_PROVIDERS: readonly AiPrefs['provider'][] = ['deepseek', 'custom']
const AI_RECAP_LENGTHS: readonly AiPrefs['recapLength'][] = ['short', 'standard', 'detailed']
const AI_PROMPT_MODES: readonly AiPrefs['promptMode'][AiPromptKind][] = ['builtin', 'custom']
const LEGACY_DEEPSEEK_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner'])
/** 每书每月自动任务估算 token 上限的硬顶；设置页输入框的 :max 必须与之一致。 */
const AUTO_MONTHLY_TOKEN_LIMIT_MAX = 3_000_000

/** 旧界面外观迁移到明暗两套；阅读正文偏好不受影响。 */
export function normalizeSkin(value: unknown): Skin {
  if (value === 'paper' || value === 'white' || value === 'sakura' || value === 'minimal') return 'light'
  if (value === 'night') return 'dark'
  return SKINS.includes(value as Skin) ? (value as Skin) : DEFAULT_APPEARANCE_PREFS.skin
}

/** 缺省、空串与非法值一律回退 standard。 */
function readDownloadPace(value: unknown): DownloadPace {
  return readEnum(value, DOWNLOAD_PACES, 'standard')
}
function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readEnum<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback
}

function readFiniteClamped(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

export function normalizeCustomOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || url.origin === 'null') return null
    return url.origin
  } catch {
    return null
  }
}

export function normalizeTrustedCustomOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized = value.map(normalizeCustomOrigin).filter((origin): origin is string => Boolean(origin))
  return [...new Set(normalized)]
}

export function isLegacyDeepSeekModel(value: unknown): boolean {
  return typeof value === 'string' && LEGACY_DEEPSEEK_MODELS.has(value.trim().toLowerCase())
}

export const AI_CUSTOM_SERVICE_NOTICE = 'API Key 和你主动选择的正文内容将发送到此接口地址。请只使用你信任的服务。'

export function resolveEffectiveAiProvider(baseUrl: string, requested: AiProvider): AiProvider {
  const origin = normalizeCustomOrigin(baseUrl)
  return origin === 'https://api.deepseek.com' && requested !== 'custom' ? 'deepseek' : 'custom'
}

export function assertTrustedAiEndpoint(baseUrl: string, ai: AiPrefs): void {
  const origin = normalizeCustomOrigin(baseUrl)
  if (!origin) throw new Error(AI_CUSTOM_SERVICE_NOTICE)
  const usesCustomTransport = resolveEffectiveAiProvider(baseUrl, ai.provider) === 'custom'
  if (usesCustomTransport && !ai.trustedCustomOrigins.includes(origin)) {
    throw new Error(AI_CUSTOM_SERVICE_NOTICE)
  }
}

export function normalizeTierSensePrefs(value: unknown): TierSensePrefs {
  const ts = readRecord(value)
  return {
    enabled: ts.enabled === true,
    baseUrl: typeof ts.baseUrl === 'string' ? ts.baseUrl.trim() : '',
    difficultyEnabled: ts.difficultyEnabled !== false,
    compressionEnabled: ts.compressionEnabled !== false,
    memoryDecideEnabled: ts.memoryDecideEnabled !== false,
    compressionMinTokens: typeof ts.compressionMinTokens === 'number' && Number.isSafeInteger(ts.compressionMinTokens)
      ? Math.max(1000, Math.min(30000, ts.compressionMinTokens))
      : DEFAULT_TIER_SENSE_PREFS.compressionMinTokens,
    difficultyThreshold: typeof ts.difficultyThreshold === 'number' && Number.isFinite(ts.difficultyThreshold)
      ? Math.max(0, Math.min(1, ts.difficultyThreshold))
      : DEFAULT_TIER_SENSE_PREFS.difficultyThreshold,
  }
}

export function normalizeAiPrefs(value: unknown): AiPrefs {
  const ai = readRecord(value)
  const rawPrompts = readRecord(ai.customPrompts)
  const customPrompts: AiPrefs['customPrompts'] = {}
  for (const kind of AI_PROMPT_KINDS) {
    const prompt = rawPrompts[kind]
    if (typeof prompt === 'string' && prompt.trim()) customPrompts[kind] = prompt
  }

  const rawModes = readRecord(ai.promptMode)
  const promptMode = { ...DEFAULT_AI_PREFS.promptMode }
  for (const kind of AI_PROMPT_KINDS) {
    const requested = readEnum(rawModes[kind], AI_PROMPT_MODES, DEFAULT_AI_PREFS.promptMode[kind])
    promptMode[kind] = requested === 'custom' && customPrompts[kind] ? 'custom' : 'builtin'
  }

  return {
    provider: readEnum(ai.provider, AI_PROVIDERS, DEFAULT_AI_PREFS.provider),
    thinkingEnabled:
      typeof ai.thinkingEnabled === 'boolean' ? ai.thinkingEnabled : DEFAULT_AI_PREFS.thinkingEnabled,
    recapLength: readEnum(ai.recapLength, AI_RECAP_LENGTHS, DEFAULT_AI_PREFS.recapLength),
    budgetWarningTokens: typeof ai.budgetWarningTokens === 'number' && Number.isSafeInteger(ai.budgetWarningTokens)
      ? Math.max(1000, Math.min(50000, ai.budgetWarningTokens))
      : DEFAULT_AI_PREFS.budgetWarningTokens,
    trustedCustomOrigins: normalizeTrustedCustomOrigins(ai.trustedCustomOrigins),
    // 默认开启：只有用户显式保存过 false 才关掉。
    autoBookOverview: ai.autoBookOverview !== false,
    autoReadingFollow: ai.autoReadingFollow === true,
    followMaxChaptersPerRun: typeof ai.followMaxChaptersPerRun === 'number' &&
      Number.isSafeInteger(ai.followMaxChaptersPerRun)
      ? Math.max(1, Math.min(50, ai.followMaxChaptersPerRun))
      : DEFAULT_AI_PREFS.followMaxChaptersPerRun,
    autoMonthlyTokenLimit: typeof ai.autoMonthlyTokenLimit === 'number' && Number.isSafeInteger(ai.autoMonthlyTokenLimit)
      ? Math.max(10_000, Math.min(AUTO_MONTHLY_TOKEN_LIMIT_MAX, ai.autoMonthlyTokenLimit))
      : DEFAULT_AI_PREFS.autoMonthlyTokenLimit,
    overviewModel: typeof ai.overviewModel === 'string' ? ai.overviewModel.trim().slice(0, 120) : DEFAULT_AI_PREFS.overviewModel,
    promptMode,
    customPrompts,
    tierSense: normalizeTierSensePrefs(ai.tierSense),
  }
}

function mergeAiPrefs(current: unknown, patch: unknown): AiPrefs {
  const previous = readRecord(current)
  const update = readRecord(patch)
  return normalizeAiPrefs({
    ...previous,
    ...update,
    promptMode: { ...readRecord(previous.promptMode), ...readRecord(update.promptMode) },
    customPrompts: { ...readRecord(previous.customPrompts), ...readRecord(update.customPrompts) },
    tierSense: { ...readRecord(previous.tierSense), ...readRecord(update.tierSense) },
  })
}

export const DEFAULT_AUTO_UPDATE_CHECK: AutoUpdateCheckPrefs = {
  enabled: true,
  intervalHours: 24,
  lastCheckedAt: '',
  lastSummary: '',
}

/** 自动追更偏好：缺字段逐项补默认，间隔夹在 1–720 小时。 */
export function normalizeAutoUpdateCheckPrefs(value: unknown): AutoUpdateCheckPrefs {
  const prefs = readRecord(value)
  return {
    enabled: typeof prefs.enabled === 'boolean' ? prefs.enabled : DEFAULT_AUTO_UPDATE_CHECK.enabled,
    intervalHours: Math.round(
      readFiniteClamped(prefs.intervalHours, 1, 720, DEFAULT_AUTO_UPDATE_CHECK.intervalHours),
    ),
    lastCheckedAt: typeof prefs.lastCheckedAt === 'string' ? prefs.lastCheckedAt : '',
    lastSummary: typeof prefs.lastSummary === 'string' ? prefs.lastSummary : '',
  }
}

export function normalizeReaderPrefs(value: unknown): ReaderPrefs {
  const reader = readRecord(value)
  const theme = READER_THEMES.includes(reader.theme as ReaderTheme)
    ? (reader.theme as ReaderTheme)
    : typeof reader.nightMode === 'boolean'
      ? reader.nightMode
        ? 'night'
        : 'paper'
      : DEFAULT_READER_PREFS.theme

  return {
    fontSize: readFiniteClamped(reader.fontSize, 12, 36, DEFAULT_READER_PREFS.fontSize),
    lineHeight: readFiniteClamped(reader.lineHeight, 1.2, 3, DEFAULT_READER_PREFS.lineHeight),
    theme,
    fontFamily: readEnum(
      reader.fontFamily,
      READER_FONT_FAMILIES,
      DEFAULT_READER_PREFS.fontFamily,
    ),
    bookFontFamily: readEnum(
      reader.bookFontFamily,
      READER_FONT_FAMILIES,
      DEFAULT_READER_PREFS.bookFontFamily ?? 'wenkai',
    ),
    contentWidth: readEnum(
      reader.contentWidth,
      READER_CONTENT_WIDTHS,
      DEFAULT_READER_PREFS.contentWidth,
    ),
    paragraphSpacing: readEnum(
      reader.paragraphSpacing,
      READER_PARAGRAPH_SPACINGS,
      DEFAULT_READER_PREFS.paragraphSpacing,
    ),
    paragraphIndent:
      typeof reader.paragraphIndent === 'boolean'
        ? reader.paragraphIndent
        : DEFAULT_READER_PREFS.paragraphIndent,
    focusMode: readEnum(reader.focusMode, READER_FOCUS_MODES, DEFAULT_READER_PREFS.focusMode),
    readingMode: readEnum(reader.readingMode, READER_READING_MODES, DEFAULT_READER_PREFS.readingMode),
    bookView: readEnum(reader.bookView, READER_BOOK_VIEWS, DEFAULT_READER_PREFS.bookView ?? 'classic'),
    sheetColumns: readEnum(
      reader.sheetColumns,
      READER_SHEET_COLUMNS,
      DEFAULT_READER_PREFS.sheetColumns ?? 'double',
    ),
    handwritingFont: readEnum(
      reader.handwritingFont,
      READER_HANDWRITING_FONTS,
      DEFAULT_READER_PREFS.handwritingFont ?? 'none',
    ),
    showInlineNotes:
      typeof reader.showInlineNotes === 'boolean'
        ? reader.showInlineNotes
        : DEFAULT_READER_PREFS.showInlineNotes ?? true,
    autoScrollSpeed: Math.round(readFiniteClamped(reader.autoScrollSpeed, 1, 5, DEFAULT_READER_PREFS.autoScrollSpeed!)),
    autoNextChapter: typeof reader.autoNextChapter === 'boolean' ? reader.autoNextChapter : DEFAULT_READER_PREFS.autoNextChapter!,
    dim: Math.round(readFiniteClamped(reader.dim, 0, 70, DEFAULT_READER_PREFS.dim!)),
    hideSiteTail:
      typeof reader.hideSiteTail === 'boolean' ? reader.hideSiteTail : DEFAULT_READER_PREFS.hideSiteTail!,
    hideReaderChrome:
      typeof reader.hideReaderChrome === 'boolean'
        ? reader.hideReaderChrome
        : DEFAULT_READER_PREFS.hideReaderChrome!,
  }
}

/** 网页阅读模式偏好：只做夹紧与默认，不因为单项非法丢弃其他设置。 */
export function normalizeWebReadingPrefs(value: unknown): WebReadingPrefs {  const prefs = readRecord(value)
  return {
    autoPage: typeof prefs.autoPage === 'boolean' ? prefs.autoPage : DEFAULT_WEB_READING_PREFS.autoPage,
    autoSpeed: Math.round(readFiniteClamped(prefs.autoSpeed, 1, 5, DEFAULT_WEB_READING_PREFS.autoSpeed)),
  }
}

const BROWSE_FAVORITES_LIMIT = 40
const BROWSE_FAVORITE_TITLE_LIMIT = 60

/**
 * 常用网站：只收 http(s) 绝对地址，按地址去重，最多 40 条。
 * 标题缺失或为空时退回域名，免得书签条上出现一条没有名字的空条。
 */
export function normalizeBrowseFavorites(value: unknown): BrowseFavorite[] {
  if (!Array.isArray(value)) return []
  const items: BrowseFavorite[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const record = readRecord(entry)
    const rawUrl = typeof record.url === 'string' ? record.url.trim() : ''
    if (!rawUrl) continue
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    // toString() 会补上末尾斜杠并规范化大小写，同一地址不会再存成两条。
    const normalizedUrl = url.toString()
    if (seen.has(normalizedUrl)) continue
    seen.add(normalizedUrl)
    const title = typeof record.title === 'string' && record.title.trim()
      ? record.title.trim().slice(0, BROWSE_FAVORITE_TITLE_LIMIT)
      : url.hostname.replace(/^www\./i, '')
    items.push({
      url: normalizedUrl,
      title: title || url.hostname,
      addedAt: typeof record.addedAt === 'string' ? record.addedAt : '',
    })
    if (items.length >= BROWSE_FAVORITES_LIMIT) break
  }
  return items
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cache: Record<string, unknown> | null = null

/** 仅供隔离的设置契约测试模拟应用重启。 */
export function resetSettingsCacheForTests(): void {
  cache = null
}

/**
 * 读代理配置。`passwordConfigured` 只由密文实际可解与否决定——
 * 让渲染层提交的布尔值直接落盘，等于允许伪造「已配密码」。
 */
function readProxyPrefs(value: unknown, passwordStored: boolean): ProxyPrefs {
  return { ...normalizeProxyPrefs(value), passwordConfigured: passwordStored }
}

/** 取已保存的代理密码明文，供 session 的认证回调使用；没有则空串。 */
export async function getProxyPassword(): Promise<string> {
  const raw = await loadRaw()
  if (typeof raw.proxyPasswordEnc !== 'string' || !raw.proxyPasswordEnc) return ''
  return decryptCipher(raw.proxyPasswordEnc)
}

async function loadRaw(): Promise<Record<string, unknown>> {
  if (cache) return cache
  try {
    cache = readRecord(JSON.parse(await readFile(settingsPath(), 'utf-8')))
  } catch {
    cache = {}
  }
  return cache!
}

async function saveRaw(raw: Record<string, unknown>): Promise<void> {
  await mkdir(join(settingsPath(), '..'), { recursive: true }).catch(() => {})
  await atomicWriteText(settingsPath(), JSON.stringify(raw, null, 2))
  cache = raw
}

/** 密钥库不可用时 Electron 只给一句英文内部错误，这里换成能照做的提示。 */
async function requireEncryptionAvailable(): Promise<void> {
  let available = false
  try {
    available = await safeStorage.isAsyncEncryptionAvailable()
  } catch {
    available = false
  }
  if (!available) {
    throw new Error('无法加密保存 API Key：系统密钥库不可用。Windows 请确认已登录当前账户且凭据管理器可用；Linux 请先安装并解锁 libsecret 钥匙串。')
  }
}

/**
 * 解开一条密文。换机或密钥库重置后解密会失败，返回空串。
 * 密钥轮换时 Electron 要求再解一次才算拿到轮换后的明文，只重试一次。
 */
async function decryptCipher(ciphertext: string): Promise<string> {
  try {
    let decrypted = await safeStorage.decryptStringAsync(Buffer.from(ciphertext, 'base64'))
    if (decrypted.shouldReEncrypt) decrypted = await safeStorage.decryptStringAsync(Buffer.from(ciphertext, 'base64'))
    return decrypted.result
  } catch {
    return ''
  }
}

/** 「有密文」不等于「能用」：换机或密钥库重置后解密会失败，此时应显示为未配置。 */
async function hasUsableEncryptedKey(ciphertext: unknown): Promise<boolean> {
  if (typeof ciphertext !== 'string' || !ciphertext) return false
  return (await decryptCipher(ciphertext)).length > 0
}

/** 存过密文没有（不代表解不开）。用来把「从没填过」和「填过但本机解不开」分开告诉用户。 */
function hasEncryptedKey(ciphertext: unknown): boolean {
  return typeof ciphertext === 'string' && ciphertext.length > 0
}

export async function getApiKey(): Promise<string> {
  const raw = await loadRaw()
  if (typeof raw.apiKeyEnc !== 'string' || !raw.apiKeyEnc) return ''
  return decryptCipher(raw.apiKeyEnc)
}

export async function getEmbeddingApiKey(): Promise<string> {
  const raw = await loadRaw()
  if (typeof raw.embeddingApiKeyEnc !== 'string' || !raw.embeddingApiKeyEnc) return ''
  return decryptCipher(raw.embeddingApiKeyEnc)
}

export async function getSettings(): Promise<Settings> {
  const raw = await loadRaw()
  const tts = (raw.tts as Partial<TtsPrefs>) || {}
  const appearance = (raw.appearance as Partial<AppearancePrefs>) || {}
  const backup = readRecord(raw.autoBackup)
  // 每把 Key 只解一次：getSettings 在主进程里被高频调用，重复解密会把 DPAPI 往返翻倍。
  const [apiKeyUsable, embeddingKeyUsable, tierSenseKeyUsable, ttsKeyUsable, tencentMapKeyUsable] = await Promise.all([
    hasUsableEncryptedKey(raw.apiKeyEnc),
    hasUsableEncryptedKey(raw.embeddingApiKeyEnc),
    hasUsableEncryptedKey(raw.tierSenseApiKeyEnc),
    hasUsableEncryptedKey(raw.ttsApiKeyEnc),
    hasUsableEncryptedKey(raw.tencentMapKeyEnc),
  ])
  return {
    libraryPath:
      typeof raw.libraryPath === 'string' && raw.libraryPath.trim()
        ? raw.libraryPath.trim()
        : defaultLibraryPath(),
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : DEFAULT_AI_PLACEHOLDER.baseUrl,
    model: typeof raw.model === 'string' ? raw.model : DEFAULT_AI_PLACEHOLDER.model,
    apiKeyConfigured: apiKeyUsable,
    apiKeyUnreadable: hasEncryptedKey(raw.apiKeyEnc) && !apiKeyUsable,
    embedding: {
      baseUrl: typeof readRecord(raw.embedding).baseUrl === 'string' ? String(readRecord(raw.embedding).baseUrl).trim() : '',
      model: typeof readRecord(raw.embedding).model === 'string' ? String(readRecord(raw.embedding).model).trim() : '',
      keyConfigured: embeddingKeyUsable,
    },
    tierSenseKeyConfigured: tierSenseKeyUsable,
    tencentMapKeyConfigured: tencentMapKeyUsable,
    tencentMapKeyUnreadable: hasEncryptedKey(raw.tencentMapKeyEnc) && !tencentMapKeyUsable,
    reader: normalizeReaderPrefs(raw.reader),
    tts: {
      rate: readFiniteClamped(tts.rate, 0.5, 2, DEFAULT_TTS_PREFS.rate),
      autoNextChapter:
        typeof tts.autoNextChapter === 'boolean' ? tts.autoNextChapter : DEFAULT_TTS_PREFS.autoNextChapter,
      source: tts.source === 'online' ? 'online' : 'system',
      systemVoiceURI: typeof tts.systemVoiceURI === 'string' ? tts.systemVoiceURI : '',
      onlineEndpoint: typeof tts.onlineEndpoint === 'string' ? tts.onlineEndpoint : '',
      onlineModel: typeof tts.onlineModel === 'string' ? tts.onlineModel : '',
      onlineVoice: typeof tts.onlineVoice === 'string' ? tts.onlineVoice : '',
      onlineKeyConfigured: ttsKeyUsable,
    },
    appearance: {
      skin: normalizeSkin(appearance.skin),
    },
    webReading: normalizeWebReadingPrefs(raw.webReading),
    browseFavorites: normalizeBrowseFavorites(raw.browseFavorites),    ai: normalizeAiPrefs(raw.ai),
    downloadPace: readDownloadPace(raw.downloadPace),
    proxy: readProxyPrefs(raw.proxy, hasEncryptedKey(raw.proxyPasswordEnc)),
    autoBackup: {
      destDir: typeof backup.destDir === 'string' ? backup.destDir.trim() : '',
      lastSuccessAt: typeof backup.lastSuccessAt === 'string' ? backup.lastSuccessAt : '',
      lastError: typeof backup.lastError === 'string' ? backup.lastError : '',
    },
    autoUpdateCheck: normalizeAutoUpdateCheckPrefs(raw.autoUpdateCheck),
  }
}

export async function getTtsApiKey(): Promise<string> {
  const raw = await loadRaw()
  if (typeof raw.ttsApiKeyEnc !== 'string' || !raw.ttsApiKeyEnc) return ''
  return decryptCipher(raw.ttsApiKeyEnc)
}

export async function getTierSenseApiKey(): Promise<string> {
  const raw = await loadRaw()
  if (typeof raw.tierSenseApiKeyEnc !== 'string' || !raw.tierSenseApiKeyEnc) return ''
  return decryptCipher(raw.tierSenseApiKeyEnc)
}

/** 腾讯地图 Key 明文只供打开地图页时按需取用；不在 getSettings 里下发。 */
export async function getTencentMapKey(): Promise<string> {
  const raw = await loadRaw()
  if (typeof raw.tencentMapKeyEnc !== 'string' || !raw.tencentMapKeyEnc) return ''
  return decryptCipher(raw.tencentMapKeyEnc)
}

export function normalizeSettingsUpdatePayload(value: unknown): SettingsUpdate {
  return readRecord(value) as SettingsUpdate
}

export async function updateSettings(update: SettingsUpdate | null | undefined): Promise<Settings> {
  const raw = { ...await loadRaw() }
  const patch = normalizeSettingsUpdatePayload(update) as Record<string, unknown>
  if (typeof patch.libraryPath === 'string') {
    const trimmed = patch.libraryPath.trim()
    // 清空时不写死某个系统的默认目录，交给 getSettings 按当前系统解析
    if (trimmed) raw.libraryPath = trimmed
    else delete raw.libraryPath
  }
  if (typeof patch.baseUrl === 'string') raw.baseUrl = patch.baseUrl
  if (typeof patch.model === 'string') raw.model = patch.model
  if (typeof patch.apiKey === 'string') {
    if (patch.apiKey) {
      await requireEncryptionAvailable()
      raw.apiKeyEnc = (await safeStorage.encryptStringAsync(patch.apiKey)).toString('base64')
    } else {
      delete raw.apiKeyEnc
    }
  }
  if (patch.embedding) {
    const next = { ...readRecord(raw.embedding) }
    const incoming = readRecord(patch.embedding)
    if (typeof incoming.baseUrl === 'string') next.baseUrl = incoming.baseUrl.trim()
    if (typeof incoming.model === 'string') next.model = incoming.model.trim()
    raw.embedding = next
  }
  if (typeof patch.embeddingApiKey === 'string') {
    if (patch.embeddingApiKey) {
      await requireEncryptionAvailable()
      raw.embeddingApiKeyEnc = (await safeStorage.encryptStringAsync(patch.embeddingApiKey)).toString('base64')
    } else delete raw.embeddingApiKeyEnc
  }
  if (patch.reader) {
    raw.reader = { ...readRecord(raw.reader), ...readRecord(patch.reader) }
  }
  if (patch.tts) {
    const incoming = readRecord(patch.tts)
    const next = { ...readRecord(raw.tts) }
    if ('rate' in incoming) next.rate = readFiniteClamped(incoming.rate, 0.5, 2, 1)
    if (typeof incoming.autoNextChapter === 'boolean') next.autoNextChapter = incoming.autoNextChapter
    if (incoming.source === 'system' || incoming.source === 'online') next.source = incoming.source
    for (const field of ['systemVoiceURI', 'onlineEndpoint', 'onlineModel', 'onlineVoice'] as const) {
      if (typeof incoming[field] === 'string') next[field] = incoming[field].trim()
    }
    raw.tts = next
  }
  if (typeof patch.ttsApiKey === 'string') {
    if (patch.ttsApiKey) {
      await requireEncryptionAvailable()
      raw.ttsApiKeyEnc = (await safeStorage.encryptStringAsync(patch.ttsApiKey)).toString('base64')
    } else delete raw.ttsApiKeyEnc
  }
  if (typeof patch.tierSenseApiKey === 'string') {
    if (patch.tierSenseApiKey) {
      await requireEncryptionAvailable()
      raw.tierSenseApiKeyEnc = (await safeStorage.encryptStringAsync(patch.tierSenseApiKey)).toString('base64')
    } else delete raw.tierSenseApiKeyEnc
  }
  if (typeof patch.tencentMapKey === 'string') {
    const mapKey = patch.tencentMapKey.trim()
    if (mapKey) {
      await requireEncryptionAvailable()
      raw.tencentMapKeyEnc = (await safeStorage.encryptStringAsync(mapKey)).toString('base64')
    } else delete raw.tencentMapKeyEnc
  }
  if (patch.appearance) {
    const next = { ...readRecord(raw.appearance), ...readRecord(patch.appearance) }
    if ('skin' in next) next.skin = normalizeSkin(next.skin)
    raw.appearance = next
  }
  if (patch.ai) raw.ai = mergeAiPrefs(raw.ai, patch.ai)
  if (patch.webReading) {
    raw.webReading = normalizeWebReadingPrefs({ ...readRecord(raw.webReading), ...readRecord(patch.webReading) })
  }
  if (Array.isArray(patch.browseFavorites)) {
    raw.browseFavorites = normalizeBrowseFavorites(patch.browseFavorites)
  }
  if ('downloadPace' in patch) raw.downloadPace = readDownloadPace(patch.downloadPace)
  if (patch.proxy) {
    const merged = normalizeProxyPrefs({
      ...readRecord(raw.proxy),
      ...readRecord(patch.proxy),
      // passwordConfigured 由主进程根据密文实际存在与否决定，不接受渲染层伪造
      passwordConfigured: false,
    })
    raw.proxy = merged
  }
  if (typeof patch.proxyPassword === 'string') {
    if (patch.proxyPassword) {
      await requireEncryptionAvailable()
      raw.proxyPasswordEnc = (await safeStorage.encryptStringAsync(patch.proxyPassword)).toString('base64')
    } else {
      delete raw.proxyPasswordEnc
    }
  }
  if (patch.autoBackup) {
    const previous = readRecord(raw.autoBackup)
    const backupPatch = readRecord(patch.autoBackup)
    raw.autoBackup = {
      destDir: typeof backupPatch.destDir === 'string' ? backupPatch.destDir.trim() : previous.destDir,
      lastSuccessAt: typeof backupPatch.lastSuccessAt === 'string' ? backupPatch.lastSuccessAt
        : typeof backupPatch.destDir === 'string' && backupPatch.destDir.trim() !== previous.destDir ? '' : previous.lastSuccessAt,
      lastError: typeof backupPatch.lastError === 'string' ? backupPatch.lastError : previous.lastError,
    }
  }
  if (patch.autoUpdateCheck) {
    const previous = normalizeAutoUpdateCheckPrefs(raw.autoUpdateCheck)
    const incoming = readRecord(patch.autoUpdateCheck)
    raw.autoUpdateCheck = {
      enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : previous.enabled,
      intervalHours:
        'intervalHours' in incoming
          ? Math.round(readFiniteClamped(incoming.intervalHours, 1, 720, previous.intervalHours))
          : previous.intervalHours,
      lastCheckedAt: typeof incoming.lastCheckedAt === 'string' ? incoming.lastCheckedAt : previous.lastCheckedAt,
      lastSummary: typeof incoming.lastSummary === 'string' ? incoming.lastSummary : previous.lastSummary,
    }
  }
  await saveRaw(raw)
  return getSettings()
}
