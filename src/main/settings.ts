import { app, safeStorage } from 'electron'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from './atomicFile'
import type {
  AiPrefs,
  AiPromptKind,
  AiProvider,
  AppearancePrefs,
  DownloadPace,
  ReaderContentWidth,
  ReaderFocusMode,
  ReaderFontFamily,
  ReaderReadingMode,
  ReaderParagraphSpacing,
  ReaderPrefs,
  ReaderTheme,
  Settings,
  SettingsUpdate,
  Skin,
  TtsPrefs,
} from '../shared/types'
import {
  AI_PROMPT_KINDS,
  DEFAULT_AI_PREFS,
  DEFAULT_APPEARANCE_PREFS,
  DEFAULT_READER_PREFS,
  DEFAULT_TTS_PREFS,
  DEFAULT_AI_PLACEHOLDER,
} from '../shared/types'
import { defaultLibraryPath } from './libraryPath'

const SKINS: readonly Skin[] = ['paper', 'white', 'night']
const DOWNLOAD_PACES: readonly DownloadPace[] = ['slow', 'standard', 'fast']
const READER_THEMES: readonly ReaderTheme[] = ['paper', 'sepia', 'gray', 'night']
const READER_FONT_FAMILIES: readonly ReaderFontFamily[] = ['serif', 'system', 'mono']
const READER_CONTENT_WIDTHS: readonly ReaderContentWidth[] = ['narrow', 'medium', 'wide']
const READER_PARAGRAPH_SPACINGS: readonly ReaderParagraphSpacing[] = ['compact', 'normal', 'relaxed']
const READER_FOCUS_MODES: readonly ReaderFocusMode[] = ['off', 'one', 'three', 'five']
const READER_READING_MODES: readonly ReaderReadingMode[] = ['scroll', 'screen']
const AI_PROVIDERS: readonly AiPrefs['provider'][] = ['deepseek', 'custom']
const AI_RECAP_LENGTHS: readonly AiPrefs['recapLength'][] = ['short', 'standard', 'detailed']
const AI_PROMPT_MODES: readonly AiPrefs['promptMode'][AiPromptKind][] = ['builtin', 'custom']
const LEGACY_DEEPSEEK_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner'])

/** 已保存的三种外观原样保留；旧 sakura、minimal 回退暖纸，其余无效值使用新用户默认外观。 */
export function normalizeSkin(value: unknown): Skin {
  if (value === 'sakura' || value === 'minimal') return 'paper'
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
    autoBookOverview: ai.autoBookOverview === true,
    promptMode,
    customPrompts,
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
  })
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
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cache: Record<string, unknown> | null = null

/** 仅供隔离的设置契约测试模拟应用重启。 */
export function resetSettingsCacheForTests(): void {
  cache = null
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
function requireEncryptionAvailable(): void {
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch {
    available = false
  }
  if (!available) {
    throw new Error('无法加密保存 API Key：系统密钥库不可用。Windows 请确认已登录当前账户且凭据管理器可用；Linux 请先安装并解锁 libsecret 钥匙串。')
  }
}

/** 「有密文」不等于「能用」：换机或密钥库重置后解密会失败，此时应显示为未配置。 */
function hasUsableEncryptedKey(ciphertext: unknown): boolean {
  if (typeof ciphertext !== 'string' || !ciphertext) return false
  try {
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64')).length > 0
  } catch {
    return false
  }
}

export async function getApiKey(): Promise<string> {
  const raw = await loadRaw()
  if (typeof raw.apiKeyEnc !== 'string' || !raw.apiKeyEnc) return ''
  try {
    return safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'))
  } catch {
    return ''
  }
}

export async function getSettings(): Promise<Settings> {
  const raw = await loadRaw()
  const tts = (raw.tts as Partial<TtsPrefs>) || {}
  const appearance = (raw.appearance as Partial<AppearancePrefs>) || {}
  const backup = readRecord(raw.autoBackup)
  return {
    libraryPath:
      typeof raw.libraryPath === 'string' && raw.libraryPath.trim()
        ? raw.libraryPath.trim()
        : defaultLibraryPath(),
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : DEFAULT_AI_PLACEHOLDER.baseUrl,
    model: typeof raw.model === 'string' ? raw.model : DEFAULT_AI_PLACEHOLDER.model,
    apiKeyConfigured: hasUsableEncryptedKey(raw.apiKeyEnc),
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
      onlineKeyConfigured: hasUsableEncryptedKey(raw.ttsApiKeyEnc),
    },
    appearance: {
      skin: normalizeSkin(appearance.skin),
    },
    ai: normalizeAiPrefs(raw.ai),
    downloadPace: readDownloadPace(raw.downloadPace),
    autoBackup: {
      destDir: typeof backup.destDir === 'string' ? backup.destDir.trim() : '',
      lastSuccessAt: typeof backup.lastSuccessAt === 'string' ? backup.lastSuccessAt : '',
      lastError: typeof backup.lastError === 'string' ? backup.lastError : '',
    },
  }
}

export async function getTtsApiKey(): Promise<string> {
  const raw = await loadRaw()
  if (typeof raw.ttsApiKeyEnc !== 'string' || !raw.ttsApiKeyEnc) return ''
  try {
    return safeStorage.decryptString(Buffer.from(raw.ttsApiKeyEnc, 'base64'))
  } catch {
    return ''
  }
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
      requireEncryptionAvailable()
      raw.apiKeyEnc = safeStorage.encryptString(patch.apiKey).toString('base64')
    } else {
      delete raw.apiKeyEnc
    }
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
      requireEncryptionAvailable()
      raw.ttsApiKeyEnc = safeStorage.encryptString(patch.ttsApiKey).toString('base64')
    } else delete raw.ttsApiKeyEnc
  }
  if (patch.appearance) {
    const next = { ...readRecord(raw.appearance), ...readRecord(patch.appearance) }
    if ('skin' in next) next.skin = normalizeSkin(next.skin)
    raw.appearance = next
  }
  if (patch.ai) raw.ai = mergeAiPrefs(raw.ai, patch.ai)
  if ('downloadPace' in patch) raw.downloadPace = readDownloadPace(patch.downloadPace)
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
  await saveRaw(raw)
  return getSettings()
}
