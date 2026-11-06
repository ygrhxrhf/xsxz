import { describe, expect, it } from 'vitest'
import {
  buildSyncBundle,
  dedupeRulesByHost,
  mergeSyncBundles,
  parseSyncBundle,
  pickSyncSettings,
  stripCredentialFields,
  summarizeSyncResult,
  SYNC_SETTINGS_WHITELIST,
} from './syncCloud'

const SETTINGS_WITH_SECRETS = {
  libraryPath: 'D:\\books',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  apiKeyConfigured: true,
  apiKey: 'sk-plain-leak',
  apiKeyEnc: 'enc-leak',
  reader: { fontSize: 18, lineHeight: 1.8 },
  tts: { rate: 1, onlineKeyConfigured: true, onlineKey: 'tts-leak' },
  appearance: { skin: 'light' },
  webReading: { autoPage: true },
  downloadPace: 'standard',
  browseFavorites: [{ title: 'A', url: 'https://a.com' }],
  proxy: { mode: 'off', password: 'proxy-leak', passwordConfigured: true },
  ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'x', customPrompts: { clean: 'p' } },
}

describe('stripCredentialFields', () => {
  it('递归剔除凭据形状的字段', () => {
    const stripped = stripCredentialFields({
      apiKey: 'a',
      nested: { password: 'b', keep: 'c' },
      list: [{ token: 'd', keep: 'e' }],
    })
    expect(stripped).toEqual({ nested: { keep: 'c' }, list: [{ keep: 'e' }] })
  })

  it('非对象原样返回', () => {
    expect(stripCredentialFields('x')).toBe('x')
    expect(stripCredentialFields(3)).toBe(3)
    expect(stripCredentialFields(null)).toBeNull()
  })
})

describe('pickSyncSettings', () => {
  it('只取白名单字段并剔凭据', () => {
    const picked = pickSyncSettings(SETTINGS_WITH_SECRETS)
    expect(Object.keys(picked).sort()).toEqual([...SYNC_SETTINGS_WHITELIST].sort())
    expect(picked.libraryPath).toBeUndefined()
    expect(picked.apiKeyConfigured).toBeUndefined()
    const text = JSON.stringify(picked)
    expect(text).not.toContain('leak')
    expect(text).not.toContain('sk-plain')
  })

  it('缺字段不补空值', () => {
    expect(pickSyncSettings({ reader: { fontSize: 18 } })).toEqual({ reader: { fontSize: 18 } })
  })

  it('非设置对象给出空白名单', () => {
    expect(pickSyncSettings(null)).toEqual({})
    expect(pickSyncSettings('x')).toEqual({})
  })
})

describe('dedupeRulesByHost', () => {
  it('同 host 只留一条，非法规则丢弃', () => {
    const rules = dedupeRulesByHost([
      { host: 'www.a.com', body: '.first' },
      { host: 'a.com', body: '.second' },
      { host: '' },
      'nope',
    ])
    expect(rules).toHaveLength(1)
    expect(rules[0]!.host).toBe('a.com')
    expect(rules[0]!.body).toBe('.second')
  })

  it('非数组返回空数组', () => {
    expect(dedupeRulesByHost(undefined)).toEqual([])
  })
})

describe('buildSyncBundle', () => {
  it('只含白名单设置与站点规则，不含令牌形状', () => {
    const bundle = buildSyncBundle(SETTINGS_WITH_SECRETS, [{ host: 'a.com', body: '.c' }], '2026-01-01T00:00:00.000Z')
    expect(bundle.version).toBe(1)
    expect(bundle.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(bundle.rules).toHaveLength(1)
    expect(bundle.rules[0]!.body).toBe('.c')
    const text = JSON.stringify(bundle)
    expect(text).not.toContain('leak')
    expect(text).not.toContain('sk-plain')
    expect(text).not.toContain('libraryPath')
  })

  it('规则里的凭据形状字段同样被剔除', () => {
    const bundle = buildSyncBundle({}, [{ host: 'a.com', body: '.c', apiKey: 'leak' }])
    expect(JSON.stringify(bundle)).not.toContain('leak')
  })
})

describe('parseSyncBundle', () => {
  it('接受版本 1 的包并剔凭据', () => {
    const parsed = parseSyncBundle({
      version: 1,
      updatedAt: '2026-02-02T00:00:00.000Z',
      settings: { reader: { fontSize: 18 }, apiKey: 'leak' },
      rules: [{ host: 'a.com', body: '.c' }],
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.rules[0]!.host).toBe('a.com')
    expect(JSON.stringify(parsed)).not.toContain('leak')
  })

  it('版本不对或形状不对时返回 null', () => {
    expect(parseSyncBundle({ version: 2 })).toBeNull()
    expect(parseSyncBundle(null)).toBeNull()
    expect(parseSyncBundle([])).toBeNull()
  })
})

describe('mergeSyncBundles', () => {
  it('云端更新时以云端设置为准，规则按 host 合并', () => {
    const local = buildSyncBundle({ reader: { fontSize: 18 } }, [{ host: 'a.com', body: '.local' }], '2026-01-01T00:00:00.000Z')
    const remote = buildSyncBundle({ reader: { fontSize: 22 } }, [{ host: 'b.com', body: '.remote' }], '2026-06-01T00:00:00.000Z')
    const merged = mergeSyncBundles(local, remote)
    expect((merged.settings.reader as { fontSize: number }).fontSize).toBe(22)
    expect(merged.rules.map((rule) => rule.host).sort()).toEqual(['a.com', 'b.com'])
  })

  it('本机更新时保留本机设置', () => {
    const local = buildSyncBundle({ reader: { fontSize: 18 } }, [], '2026-06-01T00:00:00.000Z')
    const remote = buildSyncBundle({ reader: { fontSize: 22 } }, [], '2026-01-01T00:00:00.000Z')
    const merged = mergeSyncBundles(local, remote)
    expect((merged.settings.reader as { fontSize: number }).fontSize).toBe(18)
  })

  it('云端没有版本时保持本机', () => {
    const local = buildSyncBundle({ reader: { fontSize: 18 } }, [])
    expect(mergeSyncBundles(local, null)).toBe(local)
  })
})

describe('summarizeSyncResult', () => {
  it('成功时清空失败原因', () => {
    const result = summarizeSyncResult({ ok: true, pushed: 3, pulled: 2, message: '忽略我' })
    expect(result.ok).toBe(true)
    expect(result.pushed).toBe(3)
    expect(result.pulled).toBe(2)
    expect(result.message).toBe('')
    expect(result.updatedAt).toBeTruthy()
  })

  it('失败时给出原因，计数不为负', () => {
    const result = summarizeSyncResult({ ok: false, pushed: -5, pulled: 1.7, message: '端点不可达' })
    expect(result.ok).toBe(false)
    expect(result.pushed).toBe(0)
    expect(result.pulled).toBe(1)
    expect(result.message).toBe('端点不可达')
  })

  it('失败但没给原因时用默认文案', () => {
    expect(summarizeSyncResult({ ok: false, pushed: 0, pulled: 0 }).message).toBe('同步失败')
  })
})
