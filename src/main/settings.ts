import { app, safeStorage } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReaderPrefs, Settings } from '../shared/types'
import { DEFAULT_LIBRARY_PATH, DEFAULT_READER_PREFS, DEFAULT_AI_PLACEHOLDER } from '../shared/types'

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
  const reader = (raw.reader as Partial<ReaderPrefs>) || {}
  return {
    libraryPath: typeof raw.libraryPath === 'string' ? raw.libraryPath : DEFAULT_LIBRARY_PATH,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : DEFAULT_AI_PLACEHOLDER.baseUrl,
    model: typeof raw.model === 'string' ? raw.model : DEFAULT_AI_PLACEHOLDER.model,
    apiKeyConfigured: typeof raw.apiKeyEnc === 'string' && raw.apiKeyEnc.length > 0,
    reader: {
      fontSize: typeof reader.fontSize === 'number' ? reader.fontSize : DEFAULT_READER_PREFS.fontSize,
      lineHeight: typeof reader.lineHeight === 'number' ? reader.lineHeight : DEFAULT_READER_PREFS.lineHeight,
      nightMode: typeof reader.nightMode === 'boolean' ? reader.nightMode : DEFAULT_READER_PREFS.nightMode,
    },
  }
}

export async function updateSettings(update: Partial<Settings> & { apiKey?: string }): Promise<Settings> {
  const raw = await loadRaw()
  if (typeof update.libraryPath === 'string') raw.libraryPath = update.libraryPath
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
    const prev = (raw.reader as Record<string, unknown>) || {}
    raw.reader = { ...prev, ...update.reader }
  }
  await saveRaw(raw)
  return getSettings()
}
