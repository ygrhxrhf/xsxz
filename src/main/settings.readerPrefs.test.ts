import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const ss = vi.hoisted(() => ({ available: true }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/spbf-settings-readerprefs-test' },
  safeStorage: {
    isEncryptionAvailable: () => ss.available,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}))

import { DEFAULT_READER_PREFS } from '../shared/types'
import { getSettings, normalizeReaderPrefs, resetSettingsCacheForTests } from './settings'

const TEST_DIR = '/tmp/spbf-settings-readerprefs-test'
const SETTINGS_FILE = `${TEST_DIR}/settings.json`

beforeEach(async () => {
  ss.available = true
  resetSettingsCacheForTests()
  await rm(TEST_DIR, { recursive: true, force: true })
})

describe('U1.6 净化与工具常显两个偏好字段', () => {
  it('defaults hideSiteTail and hideReaderChrome to true', () => {
    expect(DEFAULT_READER_PREFS.hideSiteTail).toBe(true)
    expect(DEFAULT_READER_PREFS.hideReaderChrome).toBe(true)
    // 缺字段、空对象、非对象都回到 true：净化开、顶栏默认收起。
    expect(normalizeReaderPrefs(undefined).hideSiteTail).toBe(true)
    expect(normalizeReaderPrefs(undefined).hideReaderChrome).toBe(true)
    expect(normalizeReaderPrefs({}).hideSiteTail).toBe(true)
    expect(normalizeReaderPrefs({}).hideReaderChrome).toBe(true)
    expect(normalizeReaderPrefs('broken').hideSiteTail).toBe(true)
    expect(normalizeReaderPrefs('broken').hideReaderChrome).toBe(true)
  })

  it('keeps explicit false so the two switches can be turned off', () => {
    expect(normalizeReaderPrefs({ hideSiteTail: false }).hideSiteTail).toBe(false)
    expect(normalizeReaderPrefs({ hideReaderChrome: false }).hideReaderChrome).toBe(false)
    expect(normalizeReaderPrefs({ hideSiteTail: false, hideReaderChrome: false })).toMatchObject({
      hideSiteTail: false,
      hideReaderChrome: false,
    })
    // 非布尔值不冒充关闭：仍旧按缺省 true。
    expect(normalizeReaderPrefs({ hideSiteTail: 'off' }).hideSiteTail).toBe(true)
    expect(normalizeReaderPrefs({ hideReaderChrome: 0 }).hideReaderChrome).toBe(true)
    expect(normalizeReaderPrefs({ hideSiteTail: null }).hideSiteTail).toBe(true)
    // 不因为新增字段丢掉旧字段。
    expect(normalizeReaderPrefs({ hideSiteTail: false, fontSize: 22 })).toMatchObject({
      hideSiteTail: false,
      fontSize: 22,
    })
  })

  it('fills missing fields of a legacy settings.json with true and keeps stored false', async () => {
    await mkdir(TEST_DIR, { recursive: true })
    await writeFile(
      SETTINGS_FILE,
      JSON.stringify({ libraryPath: 'D:\\books', reader: { fontSize: 20, theme: 'sepia' } }),
      'utf-8',
    )
    resetSettingsCacheForTests()
    const legacy = await getSettings()
    expect(legacy.reader.hideSiteTail).toBe(true)
    expect(legacy.reader.hideReaderChrome).toBe(true)
    expect(legacy.reader.fontSize).toBe(20)
    expect(legacy.reader.theme).toBe('sepia')
    // 读旧文件不许偷偷改写磁盘内容。
    expect(JSON.parse(await readFile(SETTINGS_FILE, 'utf-8')).reader).toEqual({
      fontSize: 20,
      theme: 'sepia',
    })

    await writeFile(
      SETTINGS_FILE,
      JSON.stringify({ reader: { hideSiteTail: false, hideReaderChrome: false } }),
      'utf-8',
    )
    resetSettingsCacheForTests()
    const stored = await getSettings()
    expect(stored.reader.hideSiteTail).toBe(false)
    expect(stored.reader.hideReaderChrome).toBe(false)
  })
})
