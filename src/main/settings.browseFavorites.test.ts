import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/spbf-settings-browsefavorites-test' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({ shouldReEncrypt: false, result: value.toString() }),
  },
}))

import { getSettings, normalizeBrowseFavorites, resetSettingsCacheForTests, updateSettings } from './settings'

const TEST_DIR = '/tmp/spbf-settings-browsefavorites-test'

beforeEach(async () => {
  resetSettingsCacheForTests()
  await rm(TEST_DIR, { recursive: true, force: true })
})

describe('浏览页常用网站（settings.browseFavorites）', () => {
  it('只收 http(s) 地址，按地址去重，标题退回域名', () => {
    const items = normalizeBrowseFavorites([
      { url: ' https://example.com/book/1 ', title: '  ' },
      { url: 'https://example.com/book/1', title: '同地址第二条' },
      { url: 'javascript:alert(1)', title: '危险协议' },
      { url: '不是网址', title: '坏地址' },
      { url: 'https://www.foo.com/a', title: ' 站点 A ' },
    ])
    expect(items.map((item) => item.url)).toEqual(['https://example.com/book/1', 'https://www.foo.com/a'])
    expect(items[0]!.title).toBe('example.com')
    expect(items[1]!.title).toBe('站点 A')
  })

  it('非数组、空值与超长标题都不让整份设置失效', () => {
    expect(normalizeBrowseFavorites(undefined)).toEqual([])
    expect(normalizeBrowseFavorites('broken')).toEqual([])
    expect(normalizeBrowseFavorites([null, 42])).toEqual([])
    const [item] = normalizeBrowseFavorites([{ url: 'https://example.com/x', title: '字'.repeat(120) }])
    expect(item!.title).toHaveLength(60)
  })

  it('最多保留 40 条', () => {
    const items = Array.from({ length: 45 }, (_, index) => ({ url: `https://example.com/${index}`, title: `站点 ${index}` }))
    expect(normalizeBrowseFavorites(items)).toHaveLength(40)
  })

  it('走 settings.get / settings.set 落盘，重启后还在', async () => {
    const entry = { url: 'https://example.com/book/1', title: '示例站', addedAt: '2026-01-01T00:00:00.000Z' }
    const saved = await updateSettings({ browseFavorites: [entry] })
    expect(saved.browseFavorites).toEqual([entry])

    resetSettingsCacheForTests()
    expect((await getSettings()).browseFavorites).toEqual([entry])
  })

  it('旧 settings.json 没有该字段时返回空数组', async () => {
    const settings = await getSettings()
    expect(settings.browseFavorites).toEqual([])
  })
})
