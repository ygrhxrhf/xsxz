import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/spbf-settings-test' },
  safeStorage: {
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
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
  getSettings,
  isLegacyDeepSeekModel,
  normalizeAiPrefs,
  normalizeCustomOrigin,
  normalizeReaderPrefs,
  normalizeSettingsUpdatePayload,
  normalizeTrustedCustomOrigins,
  resetSettingsCacheForTests,
  resolveEffectiveAiProvider,
  updateSettings,
} from './settings'

const TEST_DIR = '/tmp/spbf-settings-test'
const SETTINGS_FILE = `${TEST_DIR}/settings.json`

beforeEach(async () => {
  resetSettingsCacheForTests()
  await rm(TEST_DIR, { recursive: true, force: true })
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
      trustedCustomOrigins: ['https://example.com', 'http://example.com:8080'],
      promptMode: {
        clean: 'custom',
        translate: 'builtin',
        chapterSummary: 'builtin',
        recap: 'builtin',
        memory: 'builtin',
        evidenceQa: 'builtin',
      },
      customPrompts: { clean: '保留正文段落' },
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
})
