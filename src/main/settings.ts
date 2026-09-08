import { app, safeStorage } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AiPrefs,
  AiPromptKind,
  AiProvider,
  AppearancePrefs,
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
  DEFAULT_LIBRARY_PATH,
  DEFAULT_READER_PREFS,
  DEFAULT_TTS_PREFS,
  DEFAULT_AI_PLACEHOLDER,
} from '../shared/types'

const SKINS: readonly Skin[] = ['sakura', 'minimal']
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

function readSkin(value: unknown): Skin {
  return SKINS.includes(value as Skin) ? (value as Skin) : DEFAULT_APPEARANCE_PREFS.skin
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
    trustedCustomOrigins: normalizeTrustedCustomOrigins(ai.trustedCustomOrigins),
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
  await writeFile(settingsPath(), JSON.stringify(raw, null, 2), 'utf-8')
  cache = raw
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
  return {
    libraryPath:
      typeof raw.libraryPath === 'string' && raw.libraryPath.trim()
        ? raw.libraryPath.trim()
        : DEFAULT_LIBRARY_PATH,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : DEFAULT_AI_PLACEHOLDER.baseUrl,
    model: typeof raw.model === 'string' ? raw.model : DEFAULT_AI_PLACEHOLDER.model,
    apiKeyConfigured: typeof raw.apiKeyEnc === 'string' && raw.apiKeyEnc.length > 0,
    reader: normalizeReaderPrefs(raw.reader),
    tts: {
      rate: typeof tts.rate === 'number' ? tts.rate : DEFAULT_TTS_PREFS.rate,
      autoNextChapter:
        typeof tts.autoNextChapter === 'boolean' ? tts.autoNextChapter : DEFAULT_TTS_PREFS.autoNextChapter,
    },
    appearance: {
      skin: readSkin(appearance.skin),
    },
    ai: normalizeAiPrefs(raw.ai),
  }
}

export function normalizeSettingsUpdatePayload(value: unknown): SettingsUpdate {
  return readRecord(value) as SettingsUpdate
}

export async function updateSettings(update: SettingsUpdate | null | undefined): Promise<Settings> {
  const raw = await loadRaw()
  const patch = normalizeSettingsUpdatePayload(update) as Record<string, unknown>
  if (typeof patch.libraryPath === 'string') {
    raw.libraryPath = patch.libraryPath.trim() || DEFAULT_LIBRARY_PATH
  }
  if (typeof patch.baseUrl === 'string') raw.baseUrl = patch.baseUrl
  if (typeof patch.model === 'string') raw.model = patch.model
  if (typeof patch.apiKey === 'string') {
    if (patch.apiKey) {
      raw.apiKeyEnc = safeStorage.encryptString(patch.apiKey).toString('base64')
    } else {
      delete raw.apiKeyEnc
    }
  }
  if (patch.reader) {
    raw.reader = { ...readRecord(raw.reader), ...readRecord(patch.reader) }
  }
  if (patch.tts) {
    raw.tts = { ...readRecord(raw.tts), ...readRecord(patch.tts) }
  }
  if (patch.appearance) {
    const next = { ...readRecord(raw.appearance), ...readRecord(patch.appearance) }
    if (typeof next.skin === 'string') next.skin = readSkin(next.skin)
    raw.appearance = next
  }
  if (patch.ai) raw.ai = mergeAiPrefs(raw.ai, patch.ai)
  await saveRaw(raw)
  return getSettings()
}
