import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/spbf-settings-autoupdate-test' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({ shouldReEncrypt: false, result: value.toString() }),
  },
}))

import {
  DEFAULT_AUTO_UPDATE_CHECK,
  getSettings,
  normalizeAutoUpdateCheckPrefs,
  resetSettingsCacheForTests,
  updateSettings,
} from './settings'

const TEST_DIR = '/tmp/spbf-settings-autoupdate-test'
const SETTINGS_FILE = `${TEST_DIR}/settings.json`

beforeEach(async () => {
  resetSettingsCacheForTests()
  await rm(TEST_DIR, { recursive: true, force: true })
})

describe('自动检查更新偏好', () => {
  it('缺字段、空对象、非对象都回到「开启、每 24 小时」', () => {
    expect(DEFAULT_AUTO_UPDATE_CHECK).toMatchObject({ enabled: true, intervalHours: 24 })
    for (const value of [undefined, {}, 'broken', null]) {
      expect(normalizeAutoUpdateCheckPrefs(value)).toMatchObject({
        enabled: true,
        intervalHours: 24,
        lastCheckedAt: '',
        lastSummary: '',
      })
    }
  })

  it('显式关闭会被保留，非布尔值不冒充关闭', () => {
    expect(normalizeAutoUpdateCheckPrefs({ enabled: false }).enabled).toBe(false)
    expect(normalizeAutoUpdateCheckPrefs({ enabled: 'off' }).enabled).toBe(true)
    expect(normalizeAutoUpdateCheckPrefs({ enabled: 0 }).enabled).toBe(true)
  })

  it('间隔夹在 1–720 小时并取整', () => {
    expect(normalizeAutoUpdateCheckPrefs({ intervalHours: 0 }).intervalHours).toBe(1)
    expect(normalizeAutoUpdateCheckPrefs({ intervalHours: 9_999 }).intervalHours).toBe(720)
    expect(normalizeAutoUpdateCheckPrefs({ intervalHours: 2.6 }).intervalHours).toBe(3)
    expect(normalizeAutoUpdateCheckPrefs({ intervalHours: '12' }).intervalHours).toBe(24)
    expect(normalizeAutoUpdateCheckPrefs({ intervalHours: Number.NaN }).intervalHours).toBe(24)
  })

  it('旧 settings.json 缺字段时补默认，不丢其他设置', async () => {
    await mkdir(TEST_DIR, { recursive: true })
    await writeFile(SETTINGS_FILE, JSON.stringify({ libraryPath: 'D:/books', downloadPace: 'fast' }))
    const settings = await getSettings()
    expect(settings.libraryPath).toBe('D:/books')
    expect(settings.downloadPace).toBe('fast')
    expect(settings.autoUpdateCheck).toEqual(DEFAULT_AUTO_UPDATE_CHECK)
  })

  it('只改开关时保留上次检查结果，只改间隔时保留开关', async () => {
    await mkdir(TEST_DIR, { recursive: true })
    await writeFile(
      SETTINGS_FILE,
      JSON.stringify({
        autoUpdateCheck: {
          enabled: true,
          intervalHours: 24,
          lastCheckedAt: '2026-11-21T00:00:00.000Z',
          lastSummary: '已检查 2 本，暂无新章',
        },
      }),
    )
    await updateSettings({ autoUpdateCheck: { enabled: false } })
    let settings = await getSettings()
    expect(settings.autoUpdateCheck).toMatchObject({
      enabled: false,
      intervalHours: 24,
      lastCheckedAt: '2026-11-21T00:00:00.000Z',
      lastSummary: '已检查 2 本，暂无新章',
    })

    await updateSettings({ autoUpdateCheck: { intervalHours: 72 } })
    settings = await getSettings()
    expect(settings.autoUpdateCheck).toMatchObject({ enabled: false, intervalHours: 72 })
  })
})
