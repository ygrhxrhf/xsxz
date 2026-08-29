import { app, safeStorage } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AppearancePrefs,
  ReaderContentWidth,
  ReaderFontFamily,
  ReaderParagraphSpacing,
  ReaderPrefs,
  ReaderTheme,
  Settings,
  Skin,
  TtsPrefs,
} from '../shared/types'
import {
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
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cache: Record<string, unknown> | null = null

async function loadRaw(): Promise<Record<string, unknown>> {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(settingsPath(), 'utf-8'))
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
  }
}

export async function updateSettings(update: Partial<Settings> & { apiKey?: string }): Promise<Settings> {
  const raw = await loadRaw()
  if (typeof update.libraryPath === 'string') {
    raw.libraryPath = update.libraryPath.trim() || DEFAULT_LIBRARY_PATH
  }
  if (typeof update.baseUrl === 'string') raw.baseUrl = update.baseUrl
  if (typeof update.model === 'string') raw.model = update.model
  if (typeof update.apiKey === 'string') {
    if (update.apiKey) {
      raw.apiKeyEnc = safeStorage.encryptString(update.apiKey).toString('base64')
    } else {
      delete raw.apiKeyEnc
    }
  }
  if (update.reader) {
    const prev = readRecord(raw.reader)
    raw.reader = { ...prev, ...update.reader }
  }
  if (update.tts) {
    const prev = (raw.tts as Record<string, unknown>) || {}
    raw.tts = { ...prev, ...update.tts }
  }
  if (update.appearance) {
    const prev = (raw.appearance as Record<string, unknown>) || {}
    const next = { ...prev, ...update.appearance }
    if (typeof next.skin === 'string') next.skin = readSkin(next.skin)
    raw.appearance = next
  }
  await saveRaw(raw)
  return getSettings()
}
