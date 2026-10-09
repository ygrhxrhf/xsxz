import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const ss = vi.hoisted(() => ({ available: true, decryptFails: false }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/spbf-settings-test' },
  safeStorage: {
    isEncryptionAvailable: () => ss.available,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => {
      if (ss.decryptFails) throw new Error('Safe storage unable to decrypt')
      return value.toString()
    },
  },
}))

import {
  DEFAULT_AI_PLACEHOLDER,
  DEFAULT_AI_PREFS,
  DEFAULT_READER_PREFS,
} from '../shared/types'
import {
  AI_CUSTOM_SERVICE_NOTICE,
  assertTrustedAiEndpoint,
  getApiKey,
  getSettings,
  isLegacyDeepSeekModel,
  normalizeAiPrefs,
  normalizeCustomOrigin,
  normalizeReaderPrefs,
  normalizeSkin,
  normalizeSettingsUpdatePayload,
  normalizeTrustedCustomOrigins,
  resetSettingsCacheForTests,
  resolveEffectiveAiProvider,
  updateSettings,
} from './settings'
import { defaultLibraryPath } from './libraryPath'
import { setAtomicWriteBeforeCommitForTests } from './atomicFile'

const TEST_DIR = '/tmp/spbf-settings-test'
const SETTINGS_FILE = `${TEST_DIR}/settings.json`

beforeEach(async () => {
  ss.available = true
  ss.decryptFails = false
  resetSettingsCacheForTests()
  await rm(TEST_DIR, { recursive: true, force: true })
})

describe('settings atomic persistence', () => {
  it('stores the online speech key separately and never returns its plaintext', async () => {
    await updateSettings({ ttsApiKey: 'tts-secret', tts: { source: 'online', onlineEndpoint: 'https://voice.example/v1/audio/speech', onlineModel: 'model', onlineVoice: 'voice' } })
    const settings = await getSettings()
    expect(settings.tts.onlineKeyConfigured).toBe(true)
    expect(settings.tts.source).toBe('online')
    expect(JSON.stringify(settings)).not.toContain('tts-secret')
    expect(await readFile(SETTINGS_FILE, 'utf8')).not.toContain('tts-secret')
    await updateSettings({ ttsApiKey: '' })
    expect((await getSettings()).tts.onlineKeyConfigured).toBe(false)
  })

  it('refuses to save any setting when the keyring cannot hold an API Key', async () => {
    ss.available = false
    await expect(updateSettings({ libraryPath: 'D:\\books', apiKey: 'sk-1' })).rejects.toThrow(/密钥库不可用/)
    resetSettingsCacheForTests()
    const settings = await getSettings()
    expect(settings.apiKeyConfigured).toBe(false)
    expect(settings.libraryPath).not.toBe('D:\\books')
  })

  it('reports an undecryptable stored key as unconfigured instead of silently empty', async () => {
    await updateSettings({ apiKey: 'sk-on-another-machine' })
    expect((await getSettings()).apiKeyConfigured).toBe(true)
    ss.decryptFails = true
    resetSettingsCacheForTests()
    expect((await getSettings()).apiKeyConfigured).toBe(false)
    expect(await getApiKey()).toBe('')
  })

  it('re-resolves the library default instead of baking one into settings.json', async () => {
    await updateSettings({ libraryPath: 'D:\\books' })
    expect((await getSettings()).libraryPath).toBe('D:\\books')

    await updateSettings({ libraryPath: '   ' })
    resetSettingsCacheForTests()
    expect(JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))).not.toHaveProperty('libraryPath')
    expect((await getSettings()).libraryPath).toBe(defaultLibraryPath())
  })
  it('keeps automatic book overview disabled until explicitly enabled', async () => {
    expect((await getSettings()).ai?.autoBookOverview).toBe(false)
    await updateSettings({ ai: { autoBookOverview: true } })
    resetSettingsCacheForTests()
    expect((await getSettings()).ai?.autoBookOverview).toBe(true)
    await updateSettings({ ai: { autoBookOverview: false } })
    expect((await getSettings()).ai?.autoBookOverview).toBe(false)
  })

  it('自动追剧默认关闭，单次运行章数只接受正整数区间', async () => {
    expect((await getSettings()).ai?.autoReadingFollow).toBe(false)
    expect((await getSettings()).ai?.followMaxChaptersPerRun).toBe(DEFAULT_AI_PREFS.followMaxChaptersPerRun)

    await updateSettings({ ai: { autoReadingFollow: true, followMaxChaptersPerRun: 300 } })
    resetSettingsCacheForTests()
    expect((await getSettings()).ai?.autoReadingFollow).toBe(true)
    expect((await getSettings()).ai?.followMaxChaptersPerRun).toBe(50)

    await updateSettings({ ai: { followMaxChaptersPerRun: 0 } })
    expect((await getSettings()).ai?.followMaxChaptersPerRun).toBe(1)

    await updateSettings({ ai: { followMaxChaptersPerRun: '12' as unknown as number } })
    expect((await getSettings()).ai?.followMaxChaptersPerRun).toBe(DEFAULT_AI_PREFS.followMaxChaptersPerRun)
  })

  it('keeps both disk and cache at the previous value when commit fails', async () => {
    await updateSettings({ model: 'old-model' })
    const before = await readFile(SETTINGS_FILE, 'utf-8')
    setAtomicWriteBeforeCommitForTests((path) => {
      if (path === SETTINGS_FILE) throw new Error('disk full')
    })
    try {
      await expect(updateSettings({ model: 'new-model' })).rejects.toThrow('disk full')
      expect(await readFile(SETTINGS_FILE, 'utf-8')).toBe(before)
      expect((await getSettings()).model).toBe('old-model')
      expect((await import('node:fs/promises').then(({ readdir }) => readdir(TEST_DIR)))
        .filter((name) => name.endsWith('.tmp'))).toEqual([])
    } finally {
      setAtomicWriteBeforeCommitForTests(null)
    }
  })
})

describe('normalizeReaderPrefs', () => {
  it('returns defaults for missing or damaged reader settings', () => {
    expect(normalizeReaderPrefs(undefined)).toEqual(DEFAULT_READER_PREFS)
    expect(normalizeReaderPrefs('broken')).toEqual(DEFAULT_READER_PREFS)
  })

  it('prefers a valid new theme over the legacy nightMode field', () => {
    expect(normalizeReaderPrefs({ theme: 'sepia', nightMode: true }).theme).toBe('sepia')
    expect(normalizeReaderPrefs({ theme: 'gray', nightMode: false }).theme).toBe('gray')
  })

  it('migrates legacy nightMode only when the new theme is absent or invalid', () => {
    expect(normalizeReaderPrefs({ nightMode: true }).theme).toBe('night')
    expect(normalizeReaderPrefs({ nightMode: false }).theme).toBe('paper')
    expect(normalizeReaderPrefs({ theme: 'invalid', nightMode: true }).theme).toBe('night')
  })

  it('keeps valid enum and boolean fields while defaulting invalid fields independently', () => {
    expect(
      normalizeReaderPrefs({
        fontFamily: 'mono',
        contentWidth: 'wide',
        paragraphSpacing: 'relaxed',
        paragraphIndent: false,
      }),
    ).toMatchObject({
      fontFamily: 'mono',
      contentWidth: 'wide',
      paragraphSpacing: 'relaxed',
      paragraphIndent: false,
    })

    expect(
      normalizeReaderPrefs({
        fontFamily: 'comic',
        contentWidth: 'huge',
        paragraphSpacing: 'loose',
        paragraphIndent: 'yes',
      }),
    ).toMatchObject({
      fontFamily: DEFAULT_READER_PREFS.fontFamily,
      contentWidth: DEFAULT_READER_PREFS.contentWidth,
      paragraphSpacing: DEFAULT_READER_PREFS.paragraphSpacing,
      paragraphIndent: DEFAULT_READER_PREFS.paragraphIndent,
    })
  })

  it('clamps finite numeric fields and defaults non-finite values', () => {
    expect(normalizeReaderPrefs({ fontSize: 8, lineHeight: 0.5 })).toMatchObject({
      fontSize: 12,
      lineHeight: 1.2,
    })
    expect(normalizeReaderPrefs({ fontSize: 80, lineHeight: 9 })).toMatchObject({
      fontSize: 36,
      lineHeight: 3,
    })
    expect(normalizeReaderPrefs({ fontSize: Number.NaN, lineHeight: Number.POSITIVE_INFINITY })).toMatchObject({
      fontSize: DEFAULT_READER_PREFS.fontSize,
      lineHeight: DEFAULT_READER_PREFS.lineHeight,
    })
  })

  it('defaults missing or illegal focusMode to off while keeping legal values', () => {
    expect(normalizeReaderPrefs({ paragraphIndent: true })).toMatchObject({
      paragraphIndent: true,
      focusMode: 'off',
    })
    expect(normalizeReaderPrefs({ focusMode: 'huge', paragraphIndent: false })).toMatchObject({
      focusMode: 'off',
      paragraphIndent: false,
    })
    expect(normalizeReaderPrefs({ focusMode: 'one' }).focusMode).toBe('one')
    expect(normalizeReaderPrefs({ focusMode: 'three' }).focusMode).toBe('three')
    expect(normalizeReaderPrefs({ focusMode: 'five' }).focusMode).toBe('five')
    expect(normalizeReaderPrefs({ focusMode: 'off' }).focusMode).toBe('off')
  })

  it('defaults missing or illegal readingMode to scroll while keeping legal values', () => {
    expect(normalizeReaderPrefs({ paragraphIndent: true })).toMatchObject({
      paragraphIndent: true,
      readingMode: 'scroll',
    })
    expect(normalizeReaderPrefs({ readingMode: 'paged', focusMode: 'one' })).toMatchObject({
      readingMode: 'scroll',
      focusMode: 'one',
    })
    expect(normalizeReaderPrefs({ readingMode: 'screen' }).readingMode).toBe('screen')
    expect(normalizeReaderPrefs({ readingMode: 'scroll' }).readingMode).toBe('scroll')
  })
})

describe('normalizeSkin', () => {
  it('keeps paper, white, and night', () => {
    expect(normalizeSkin('paper')).toBe('paper')
    expect(normalizeSkin('white')).toBe('white')
    expect(normalizeSkin('night')).toBe('night')
  })

  it('maps legacy sakura and minimal to paper and does not treat them as legal skins', () => {
    expect(normalizeSkin('sakura')).toBe('paper')
    expect(normalizeSkin('minimal')).toBe('paper')
  })

  it('uses the new-user white default for unknown strings, missing values, and non-strings', () => {
    expect(normalizeSkin('neon')).toBe('white')
    expect(normalizeSkin('')).toBe('white')
    expect(normalizeSkin(undefined)).toBe('white')
    expect(normalizeSkin(null)).toBe('white')
    expect(normalizeSkin(1)).toBe('white')
  })

  it('reads stored legacy skins as paper and writes paper instead of sakura or minimal', async () => {
    await mkdir(TEST_DIR, { recursive: true })
    await writeFile(
      SETTINGS_FILE,
      JSON.stringify({ libraryPath: 'D:\\books', model: 'keep-me', appearance: { skin: 'sakura', accent: 'rose' } }),
      'utf-8',
    )
    resetSettingsCacheForTests()
    const sakuraRead = await getSettings()
    expect(sakuraRead.appearance.skin).toBe('paper')
    expect(sakuraRead.libraryPath).toBe('D:\\books')
    expect(sakuraRead.model).toBe('keep-me')
    expect(JSON.parse(await readFile(SETTINGS_FILE, 'utf-8'))).toMatchObject({
      libraryPath: 'D:\\books',
      model: 'keep-me',
      appearance: { skin: 'sakura', accent: 'rose' },
    })

    await writeFile(
      SETTINGS_FILE,
      JSON.stringify({ libraryPath: 'D:\\keep', appearance: { skin: 'minimal' } }),
      'utf-8',
    )
    resetSettingsCacheForTests()
    const minimalRead = await getSettings()
    expect(minimalRead.appearance.skin).toBe('paper')
    expect(minimalRead.libraryPath).toBe('D:\\keep')

    await writeFile(SETTINGS_FILE, JSON.stringify({ model: 'untouched', appearance: { skin: 'mystery' } }), 'utf-8')
    resetSettingsCacheForTests()
    const unknownRead = await getSettings()
    expect(unknownRead.appearance.skin).toBe('white')
    expect(unknownRead.model).toBe('untouched')

    resetSettingsCacheForTests()
    await rm(TEST_DIR, { recursive: true, force: true })
    expect((await getSettings()).appearance.skin).toBe('white')

    const saved = await updateSettings({ appearance: { skin: 'sakura' as 'paper' } })
    expect(saved.appearance.skin).toBe('paper')
    expect(JSON.parse(await readFile(SETTINGS_FILE, 'utf-8')).appearance.skin).toBe('paper')

    for (const skin of ['paper', 'white', 'night'] as const) {
      const kept = await updateSettings({ appearance: { skin } })
      expect(kept.appearance.skin).toBe(skin)
      expect(JSON.parse(await readFile(SETTINGS_FILE, 'utf-8')).appearance.skin).toBe(skin)
    }
  })
})

describe('AI endpoint trust guard', () => {
  it('allows official DeepSeek but blocks untrusted custom endpoints and malformed URLs', () => {
    expect(() => assertTrustedAiEndpoint('https://api.deepseek.com/v1', DEFAULT_AI_PREFS)).not.toThrow()
    expect(() => assertTrustedAiEndpoint('https://custom.example/v1', DEFAULT_AI_PREFS)).toThrow(AI_CUSTOM_SERVICE_NOTICE)
    expect(() => assertTrustedAiEndpoint('http://api.deepseek.com/v1', DEFAULT_AI_PREFS)).toThrow(AI_CUSTOM_SERVICE_NOTICE)
    expect(() => assertTrustedAiEndpoint('https://api.deepseek.com:8443/v1', DEFAULT_AI_PREFS)).toThrow(AI_CUSTOM_SERVICE_NOTICE)
    expect(() => assertTrustedAiEndpoint('not a URL', DEFAULT_AI_PREFS)).toThrow(AI_CUSTOM_SERVICE_NOTICE)
  })

  it('uses normalized origins so paths reuse trust while protocol and port changes do not', () => {
    const ai = { ...DEFAULT_AI_PREFS, provider: 'custom' as const, trustedCustomOrigins: ['https://custom.example'] }
    expect(() => assertTrustedAiEndpoint('https://custom.example/v2/chat', ai)).not.toThrow()
    expect(() => assertTrustedAiEndpoint('http://custom.example/v2', ai)).toThrow(AI_CUSTOM_SERVICE_NOTICE)
    expect(() => assertTrustedAiEndpoint('https://custom.example:8443/v2', ai)).toThrow(AI_CUSTOM_SERVICE_NOTICE)
  })

  it('forces every non-official protocol or port to custom transport after trust', () => {
    const ai = {
      ...DEFAULT_AI_PREFS,
      trustedCustomOrigins: ['http://api.deepseek.com', 'https://api.deepseek.com:8443'],
    }
    expect(() => assertTrustedAiEndpoint('http://api.deepseek.com/v1', ai)).not.toThrow()
    expect(() => assertTrustedAiEndpoint('https://api.deepseek.com:8443/v1', ai)).not.toThrow()
    expect(resolveEffectiveAiProvider('http://api.deepseek.com/v1', 'deepseek')).toBe('custom')
    expect(resolveEffectiveAiProvider('https://api.deepseek.com:8443/v1', 'deepseek')).toBe('custom')
    expect(resolveEffectiveAiProvider('https://api.deepseek.com/v1', 'deepseek')).toBe('deepseek')
  })

  it('requires confirmation when custom mode explicitly targets the official host', () => {
    const custom = { ...DEFAULT_AI_PREFS, provider: 'custom' as const }
    expect(() => assertTrustedAiEndpoint('https://api.deepseek.com/v1', custom)).toThrow(AI_CUSTOM_SERVICE_NOTICE)
    expect(resolveEffectiveAiProvider('https://api.deepseek.com/v1', 'custom')).toBe('custom')
  })
})

describe('AI settings compatibility', () => {
  it('uses the DeepSeek v4 preset and complete AI defaults for a new install', async () => {
    const settings = await getSettings()
    expect(settings.baseUrl).toBe(DEFAULT_AI_PLACEHOLDER.baseUrl)
    expect(settings.model).toBe('deepseek-v4-flash')
    expect(settings.ai).toEqual(DEFAULT_AI_PREFS)
  })

  it.each([null, [], 'broken-root', 42])(
    'treats a non-object JSON settings root as empty settings: %j',
    async (root) => {
      await mkdir(TEST_DIR, { recursive: true })
      await writeFile(SETTINGS_FILE, JSON.stringify(root), 'utf-8')
      resetSettingsCacheForTests()

      const settings = await getSettings()
      expect(settings.model).toBe('deepseek-v4-flash')
      expect(settings.ai).toEqual(DEFAULT_AI_PREFS)
    },
  )

  it('normalizes the untrusted settings.set IPC payload before any property access', async () => {
    expect(normalizeSettingsUpdatePayload(null)).toEqual({})
    expect(normalizeSettingsUpdatePayload(undefined)).toEqual({})
    expect(normalizeSettingsUpdatePayload([])).toEqual({})
    expect(normalizeSettingsUpdatePayload({ libraryPath: 'D:\\safe' })).toEqual({ libraryPath: 'D:\\safe' })
    await expect(updateSettings(normalizeSettingsUpdatePayload(null))).resolves.toMatchObject({
      model: 'deepseek-v4-flash',
      ai: DEFAULT_AI_PREFS,
    })
  })

  it('normalizes damaged fields independently without changing existing baseURL, model, or key state', async () => {
    await mkdir(TEST_DIR, { recursive: true })
    await writeFile(
      SETTINGS_FILE,
      JSON.stringify({
        baseUrl: 'https://legacy.example/v1',
        model: 'deepseek-chat',
        apiKeyEnc: Buffer.from('existing-key').toString('base64'),
        ai: {
          provider: 'custom',
          thinkingEnabled: 'yes',
          recapLength: 'detailed',
          trustedCustomOrigins: [
            'https://Example.com/v1',
            'https://example.com:443/other',
            'http://example.com:8080/path',
            'file:///tmp/nope',
            'https://user:secret@example.com',
          ],
          promptMode: { clean: 'custom', translate: 'broken', memory: 'custom' },
          customPrompts: { clean: '保留正文段落', memory: '   ', unexpected: 'ignore' },
        },
      }),
      'utf-8',
    )
    resetSettingsCacheForTests()

    const settings = await getSettings()
    expect(settings.baseUrl).toBe('https://legacy.example/v1')
    expect(settings.model).toBe('deepseek-chat')
    expect(settings.apiKeyConfigured).toBe(true)
    expect(settings.ai).toEqual({
      provider: 'custom',
      thinkingEnabled: true,
      recapLength: 'detailed',
      budgetWarningTokens: DEFAULT_AI_PREFS.budgetWarningTokens,
      trustedCustomOrigins: ['https://example.com', 'http://example.com:8080'],
      autoBookOverview: false,
      autoMonthlyTokenLimit: DEFAULT_AI_PREFS.autoMonthlyTokenLimit,
      autoReadingFollow: false,
      followMaxChaptersPerRun: DEFAULT_AI_PREFS.followMaxChaptersPerRun,
      promptMode: {
        clean: 'custom',
        translate: 'builtin',
        chapterSummary: 'builtin',
        chapterNote: 'builtin',
        recap: 'builtin',
        memory: 'builtin',
        evidenceQa: 'builtin',
      },
      customPrompts: { clean: '保留正文段落' },
      tierSense: {
        enabled: false,
        baseUrl: '',
        difficultyEnabled: true,
        compressionEnabled: true,
        memoryDecideEnabled: true,
        compressionMinTokens: 6000,
        difficultyThreshold: 0.6,
      },
    })
  })

  it('merges nested prompt settings and persists normalized values across a simulated restart', async () => {
    const saved = await updateSettings({
      baseUrl: 'https://custom.example/api/v1',
      model: 'my-model',
      apiKey: 'secret-value',
      ai: {
        provider: 'custom',
        thinkingEnabled: false,
        recapLength: 'short',
        trustedCustomOrigins: ['https://custom.example/path', 'https://CUSTOM.example:443/other'],
        promptMode: { ...DEFAULT_AI_PREFS.promptMode, evidenceQa: 'custom' },
        customPrompts: { evidenceQa: '仅根据证据回答。' },
      },
    })

    expect(saved.ai).toMatchObject({
      provider: 'custom',
      thinkingEnabled: false,
      recapLength: 'short',
      trustedCustomOrigins: ['https://custom.example'],
      promptMode: { evidenceQa: 'custom' },
      customPrompts: { evidenceQa: '仅根据证据回答。' },
    })
    expect(saved.apiKeyConfigured).toBe(true)

    const raw = await readFile(SETTINGS_FILE, 'utf-8')
    expect(raw).not.toContain('secret-value')
    expect(JSON.parse(raw).model).toBe('my-model')

    resetSettingsCacheForTests()
    const restarted = await getSettings()
    expect(restarted.baseUrl).toBe('https://custom.example/api/v1')
    expect(restarted.model).toBe('my-model')
    expect(restarted.ai).toEqual(saved.ai)
  })

  it('normalizes trusted HTTP(S) origins and rejects credentials or unsupported protocols', () => {
    expect(normalizeCustomOrigin(' HTTPS://Example.COM:443/v1?q=1#x ')).toBe('https://example.com')
    expect(normalizeCustomOrigin('http://Example.COM:80/v1')).toBe('http://example.com')
    expect(normalizeCustomOrigin('https://example.com:8443/v1')).toBe('https://example.com:8443')
    expect(normalizeCustomOrigin('https://user:pass@example.com')).toBeNull()
    expect(normalizeCustomOrigin('file:///tmp/model')).toBeNull()
    expect(normalizeCustomOrigin('not a url')).toBeNull()
    expect(normalizeTrustedCustomOrigins(['https://a.example/x', 'https://A.example:443/y'])).toEqual([
      'https://a.example',
    ])
  })

  it('detects only the retired DeepSeek model names for explicit migration UI', () => {
    expect(isLegacyDeepSeekModel(' deepseek-chat ')).toBe(true)
    expect(isLegacyDeepSeekModel('DEEPSEEK-REASONER')).toBe(true)
    expect(isLegacyDeepSeekModel('deepseek-v4-flash')).toBe(false)
    expect(isLegacyDeepSeekModel('custom-chat')).toBe(false)
  })

  it('defaults a missing downloadPace to standard and rejects stored illegal values', async () => {
    await mkdir(TEST_DIR, { recursive: true })
    await writeFile(SETTINGS_FILE, JSON.stringify({ libraryPath: 'D:\\books' }), 'utf-8')
    resetSettingsCacheForTests()
    expect((await getSettings()).downloadPace).toBe('standard')

    for (const downloadPace of ['turbo', 1, null, '']) {
      await writeFile(SETTINGS_FILE, JSON.stringify({ downloadPace }), 'utf-8')
      resetSettingsCacheForTests()
      expect((await getSettings()).downloadPace).toBe('standard')
    }
  })

  it('persists a legal downloadPace and stores standard for an illegal write', async () => {
    const saved = await updateSettings({ downloadPace: 'fast' })
    expect(saved.downloadPace).toBe('fast')
    expect(JSON.parse(await readFile(SETTINGS_FILE, 'utf-8')).downloadPace).toBe('fast')
    resetSettingsCacheForTests()
    expect((await getSettings()).downloadPace).toBe('fast')

    const rejected = await updateSettings({ downloadPace: 'turbo' as 'fast' })
    expect(rejected.downloadPace).toBe('standard')
    expect(JSON.parse(await readFile(SETTINGS_FILE, 'utf-8')).downloadPace).toBe('standard')
    resetSettingsCacheForTests()
    expect((await getSettings()).downloadPace).toBe('standard')
  })

  it('returns independent default objects instead of sharing mutable arrays or maps', () => {
    const first = normalizeAiPrefs(undefined)
    first.trustedCustomOrigins.push('https://mutated.example')
    first.promptMode.clean = 'custom'
    first.customPrompts.clean = 'mutated'

    expect(normalizeAiPrefs(undefined)).toEqual(DEFAULT_AI_PREFS)
  })

  it('normalizes the per-request token reminder', () => {
    expect(normalizeAiPrefs({ budgetWarningTokens: 9000 }).budgetWarningTokens).toBe(9000)
    expect(normalizeAiPrefs({ budgetWarningTokens: 100 }).budgetWarningTokens).toBe(1000)
    expect(normalizeAiPrefs({ budgetWarningTokens: 100000 }).budgetWarningTokens).toBe(50000)
    expect(normalizeAiPrefs({ budgetWarningTokens: 'bad' }).budgetWarningTokens).toBe(DEFAULT_AI_PREFS.budgetWarningTokens)
  })
})
