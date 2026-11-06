import { describe, expect, it, vi } from 'vitest'

// ruleMarketIpc 依赖 electron（safeStorage 与 userData 路径）；测试里注入假实现。
vi.mock('electron', () => ({
  app: {
    getPath(): string {
      throw new Error('ruleMarketIpc tests must inject deps instead of using app.getPath')
    },
  },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async () => {
      throw new Error('safeStorage not available in tests')
    },
    decryptStringAsync: async () => {
      throw new Error('safeStorage not available in tests')
    },
  },
}))

import {
  isCredentialShapedKey,
  localRuleToMarketEntry,
  marketEntryToSiteRule,
  mergeMarketEntries,
  normalizeMarketHost,
  parseMarketEntry,
  parseMarketListing,
  sanitizeSiteRule,
} from './ruleMarket'
import {
  assertMarketUrl,
  registerRuleMarketIpc,
  type RuleMarketIpcDeps,
} from './ruleMarketIpc'

describe('normalizeMarketHost', () => {
  it('小写、去掉一层 www，并接受 URL 形态', () => {
    expect(normalizeMarketHost('www.Example.com')).toBe('example.com')
    expect(normalizeMarketHost('https://WWW.Foo.com/path')).toBe('foo.com')
    expect(normalizeMarketHost('  example.com  ')).toBe('example.com')
  })

  it('空值与非法输入返回空串', () => {
    expect(normalizeMarketHost('')).toBe('')
    expect(normalizeMarketHost('   ')).toBe('')
    expect(normalizeMarketHost(undefined)).toBe('')
    expect(normalizeMarketHost('http://')).toBe('')
  })
})

describe('isCredentialShapedKey', () => {
  it('认出凭据形状的字段名', () => {
    expect(isCredentialShapedKey('apiKey')).toBe(true)
    expect(isCredentialShapedKey('api_key')).toBe(true)
    expect(isCredentialShapedKey('accessToken')).toBe(true)
    expect(isCredentialShapedKey('password')).toBe(true)
    expect(isCredentialShapedKey('apiKeyEnc')).toBe(true)
    expect(isCredentialShapedKey('cookie')).toBe(true)
  })

  it('普通字段名不算凭据', () => {
    expect(isCredentialShapedKey('body')).toBe(false)
    expect(isCredentialShapedKey('catalog')).toBe(false)
    expect(isCredentialShapedKey('fontSize')).toBe(false)
    expect(isCredentialShapedKey('')).toBe(false)
  })
})

describe('sanitizeSiteRule', () => {
  it('只保留 CSS 选择器与开关，剔除凭据形状的字段', () => {
    const rule = sanitizeSiteRule({
      host: 'www.Example.com',
      title: '.book-title',
      catalog: '#catalog',
      body: '.content',
      apiKey: 'sk-should-not-survive',
      token: 'should-not-survive',
      password: 'should-not-survive',
      apiKeyEnc: 'should-not-survive',
    })
    expect(rule).not.toBeNull()
    expect(rule!.host).toBe('example.com')
    expect(rule!.body).toBe('.content')
    expect(JSON.stringify(rule)).not.toContain('should-not-survive')
  })

  it('host 不可规范化时返回 null', () => {
    expect(sanitizeSiteRule({ host: '' })).toBeNull()
    expect(sanitizeSiteRule(null)).toBeNull()
    expect(sanitizeSiteRule('not a rule')).toBeNull()
  })
})

describe('parseMarketEntry', () => {
  it('接受规则嵌在 rule 里的形状', () => {
    const entry = parseMarketEntry({
      id: 'example.com',
      host: 'www.example.com',
      title: '示例站',
      note: '作者自述',
      updatedAt: '2026-01-02T03:04:05.000Z',
      uses: 12,
      rule: { host: 'example.com', body: '.content', catalog: '#list', apiKey: 'leak' },
    })
    expect(entry).not.toBeNull()
    expect(entry!.id).toBe('example.com')
    expect(entry!.host).toBe('example.com')
    expect(entry!.rule.body).toBe('.content')
    expect(entry!.note).toBe('作者自述')
    expect(entry!.updatedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(entry!.uses).toBe(12)
    expect(JSON.stringify(entry)).not.toContain('leak')
  })

  it('接受选择器直接摊在条目上的形状', () => {
    const entry = parseMarketEntry({ host: 'example.com', body: '.content' })
    expect(entry).not.toBeNull()
    expect(entry!.rule.body).toBe('.content')
    expect(entry!.title).toBe('example.com')
  })

  it('没有正文与目录选择器的条目不可用，丢弃', () => {
    expect(parseMarketEntry({ host: 'example.com', title: '只有标题' })).toBeNull()
  })

  it('host 缺失时丢弃', () => {
    expect(parseMarketEntry({ body: '.content' })).toBeNull()
  })
})

describe('parseMarketListing', () => {
  it('接受顶层数组、entries 与 rules 三种形状', () => {
    const one = parseMarketListing([{ host: 'a.com', body: '.c' }])
    expect(one).toHaveLength(1)
    const two = parseMarketListing({ entries: [{ host: 'a.com', body: '.c' }] })
    expect(two).toHaveLength(1)
    const three = parseMarketListing({ rules: [{ host: 'a.com', body: '.c' }] })
    expect(three).toHaveLength(1)
  })

  it('丢掉非法条目，保留合法条目', () => {
    const entries = parseMarketListing({
      entries: [
        { host: 'a.com', body: '.c' },
        { body: '.no-host' },
        'not an object',
        null,
        { host: 'b.com' },
      ],
    })
    expect(entries.map((entry) => entry.host)).toEqual(['a.com'])
  })

  it('形状不认识时返回空数组', () => {
    expect(parseMarketListing(null)).toEqual([])
    expect(parseMarketListing({ hello: 'world' })).toEqual([])
  })
})

describe('mergeMarketEntries', () => {
  it('同 host 去重，同优先级取更新时间新者', () => {
    const older = parseMarketEntry({ host: 'a.com', body: '.old', updatedAt: '2026-01-01T00:00:00.000Z' })!
    const newer = parseMarketEntry({ host: 'www.a.com', body: '.new', updatedAt: '2026-05-01T00:00:00.000Z' })!
    const listing = mergeMarketEntries([{ source: 'remote', entries: [older, newer] }])
    expect(listing.entries).toHaveLength(1)
    expect(listing.entries[0]!.rule.body).toBe('.new')
    expect(listing.sources[listing.entries[0]!.id]).toBe('remote')
  })

  it('本机自建优先于远端订阅', () => {
    const remote = parseMarketEntry({ host: 'a.com', body: '.remote', updatedAt: '2026-05-01T00:00:00.000Z' })!
    const local = parseMarketEntry({ host: 'a.com', body: '.local' })!
    const listing = mergeMarketEntries([
      { source: 'remote', entries: [remote] },
      { source: 'local', entries: [local] },
    ])
    expect(listing.entries).toHaveLength(1)
    expect(listing.entries[0]!.rule.body).toBe('.local')
    expect(listing.sources[listing.entries[0]!.id]).toBe('local')
  })

  it('不同 host 的条目都保留', () => {
    const a = parseMarketEntry({ host: 'a.com', body: '.c' })!
    const b = parseMarketEntry({ host: 'b.com', body: '.c' })!
    const listing = mergeMarketEntries([{ source: 'remote', entries: [a, b] }])
    expect(listing.entries).toHaveLength(2)
  })
})

describe('marketEntryToSiteRule / localRuleToMarketEntry', () => {
  it('市场条目转本机规则时只留选择器', () => {
    const entry = parseMarketEntry({
      host: 'a.com',
      title: 'A 站',
      rule: { host: 'a.com', body: '.c', apiKey: 'leak' },
    })!
    const rule = marketEntryToSiteRule(entry)
    expect(rule.host).toBe('a.com')
    expect(rule.body).toBe('.c')
    expect(JSON.stringify(rule)).not.toContain('leak')
  })

  it('本机规则转市场条目，来源字段留空由合并层决定', () => {
    const entry = localRuleToMarketEntry({ host: 'www.a.com', body: '.c' })
    expect(entry).not.toBeNull()
    expect(entry!.id).toBe('a.com')
    expect(entry!.host).toBe('a.com')
    expect(entry!.title).toBe('a.com')
  })

  it('host 不合法的本机规则不产条目', () => {
    expect(localRuleToMarketEntry({ host: '  ' })).toBeNull()
  })
})

describe('assertMarketUrl', () => {
  it('只收 http(s) 绝对地址', () => {
    expect(assertMarketUrl('https://a.com/list.json')).toBe('https://a.com/list.json')
    expect(assertMarketUrl('http://a.com')).toBe('http://a.com/')
    expect(() => assertMarketUrl('ftp://a.com')).toThrow(/http/)
    expect(() => assertMarketUrl('/local.json')).toThrow(/http/)
    expect(() => assertMarketUrl('')).toThrow(/不能为空/)
  })
})

/** 内存态依赖：磁盘、网络、凭据都不碰真环境。 */
function makeDeps(overrides: Partial<RuleMarketIpcDeps> = {}) {
  const state = {
    rules: [] as Array<Record<string, unknown>>,
    subscriptions: [] as Array<{ url: string; entries: unknown[]; updatedAt: string }>,
    token: '',
    account: { account: '', endpoint: '' },
    pushed: [] as unknown[],
  }
  const deps: RuleMarketIpcDeps = {
    listLocalRules: async () => state.rules as never,
    applyLocalRule: async (rule) => {
      state.rules = state.rules.filter((item) => item.host !== rule.host)
      state.rules.push({ ...rule })
      return rule
    },
    listSubscriptions: async () => state.subscriptions as never,
    saveSubscription: async (subscription) => {
      state.subscriptions = state.subscriptions.filter((item) => item.url !== subscription.url)
      state.subscriptions.push({ url: subscription.url, entries: subscription.entries, updatedAt: subscription.updatedAt })
    },
    removeSubscription: async (url) => {
      state.subscriptions = state.subscriptions.filter((item) => item.url !== url)
    },
    fetchText: async () => '[]',
    readSettings: async () => ({ reader: { fontSize: 18 }, apiKey: 'leak' }),
    credentials: {
      get: async () => state.token,
      set: async (token) => { state.token = token },
      clear: async () => { state.token = '' },
    },
    account: {
      read: async () => state.account,
      write: async (value) => { state.account = value },
      clear: async () => { state.account = { account: '', endpoint: '' } },
    },
    transport: async (input) => {
      state.pushed.push(input)
      return { bundle: null, message: '云端没有回包' }
    },
    ...overrides,
  }
  return { deps, state }
}

/** 注册并返回可调用的 handler 表。 */
function registerHandlers(deps: RuleMarketIpcDeps) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerRuleMarketIpc((channel, listener) => {
    handlers.set(channel, listener as (...args: unknown[]) => unknown)
  }, deps)
  return handlers
}

describe('registerRuleMarketIpc', () => {
  it('注册 8 个频道，名字与 preload 逐字一致', () => {
    const { deps } = makeDeps()
    const handlers = registerHandlers(deps)
    expect([...handlers.keys()].sort()).toEqual([
      'ruleMarket.apply',
      'ruleMarket.list',
      'ruleMarket.subscribe',
      'ruleMarket.unsubscribe',
      'sync.run',
      'sync.signIn',
      'sync.signOut',
      'sync.status',
    ])
  })

  it('ruleMarket.list 汇总远端订阅与本机自建，并标出来源', async () => {
    const { deps } = makeDeps({
      listSubscriptions: async () => [{
        url: 'https://a.com/list.json',
        entries: [parseMarketEntry({ host: 'r.com', body: '.c' })!],
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      listLocalRules: async () => [{ host: 'l.com', body: '.c' }],
    })
    const handlers = registerHandlers(deps)
    const listing = (await handlers.get('ruleMarket.list')!()) as {
      entries: Array<{ host: string }>
      sources: Record<string, string>
    }
    expect(listing.entries.map((entry) => entry.host).sort()).toEqual(['l.com', 'r.com'])
    expect(Object.values(listing.sources).sort()).toEqual(['local', 'remote'])
  })

  it('ruleMarket.apply 把条目写进本机规则', async () => {
    const { deps, state } = makeDeps({
      listSubscriptions: async () => [{
        url: 'https://a.com/list.json',
        entries: [parseMarketEntry({ host: 'r.com', body: '.remote' })!],
        updatedAt: '',
      }],
    })
    const handlers = registerHandlers(deps)
    const res = (await handlers.get('ruleMarket.apply')!(null, { id: 'r.com' })) as {
      ok: boolean
      rule?: { host: string; body?: string }
      message?: string
    }
    expect(res.ok).toBe(true)
    expect(res.rule!.host).toBe('r.com')
    expect(state.rules[0]!.body).toBe('.remote')
  })

  it('ruleMarket.apply 对不存在的条目给出失败', async () => {
    const { deps } = makeDeps()
    const handlers = registerHandlers(deps)
    const res = (await handlers.get('ruleMarket.apply')!(null, { id: 'nope.com' })) as { ok: boolean; message: string }
    expect(res.ok).toBe(false)
    expect(res.message).toContain('nope.com')
  })

  it('ruleMarket.subscribe 只收 http(s) 清单地址，并存下条目快照', async () => {
    const { deps, state } = makeDeps({
      fetchText: async () => JSON.stringify([{ host: 'r.com', body: '.c' }]),
    })
    const handlers = registerHandlers(deps)
    const res = (await handlers.get('ruleMarket.subscribe')!(null, { url: 'https://a.com/list.json' })) as {
      ok: boolean
      entries: Array<{ host: string }>
    }
    expect(res.ok).toBe(true)
    expect(res.entries).toHaveLength(1)
    expect(state.subscriptions[0]!.url).toBe('https://a.com/list.json')

    const bad = (await handlers.get('ruleMarket.subscribe')!(null, { url: 'ftp://a.com' })) as { ok: boolean }
    expect(bad.ok).toBe(false)
  })

  it('ruleMarket.unsubscribe 只删订阅关系', async () => {
    const { deps, state } = makeDeps()
    const handlers = registerHandlers(deps)
    const res = (await handlers.get('ruleMarket.unsubscribe')!(null, { url: 'https://a.com/list.json' })) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(state.subscriptions).toHaveLength(0)
  })

  it('sync.status 未登录时 signedIn 为 false', async () => {
    const { deps } = makeDeps()
    const handlers = registerHandlers(deps)
    const res = (await handlers.get('sync.status')!()) as { ok: boolean; state: { signedIn: boolean } }
    expect(res.ok).toBe(true)
    expect(res.state.signedIn).toBe(false)
  })

  it('sync.signIn 存令牌与账号，状态变成已登录', async () => {
    const { deps, state } = makeDeps()
    const handlers = registerHandlers(deps)
    const res = (await handlers.get('sync.signIn')!(null, {
      token: 'my-token',
      endpoint: 'https://sync.example.com',
      account: 'me@example.com',
    })) as { ok: boolean; state: { signedIn: boolean; account: string; endpoint: string } }
    expect(res.ok).toBe(true)
    expect(res.state.signedIn).toBe(true)
    expect(res.state.account).toBe('me@example.com')
    expect(res.state.endpoint).toBe('https://sync.example.com')
    expect(state.token).toBe('my-token')
  })

  it('sync.signIn 空令牌被拒', async () => {
    const { deps } = makeDeps()
    const handlers = registerHandlers(deps)
    const res = (await handlers.get('sync.signIn')!(null, { token: '  ' })) as { ok: boolean; message: string }
    expect(res.ok).toBe(false)
    expect(res.message).toContain('令牌')
  })

  it('sync.signOut 清本机令牌，不动云端', async () => {
    const { deps, state } = makeDeps()
    const handlers = registerHandlers(deps)
    await handlers.get('sync.signIn')!(null, { token: 'my-token', account: 'me' })
    const res = (await handlers.get('sync.signOut')!()) as { ok: boolean; state: { signedIn: boolean } }
    expect(res.ok).toBe(true)
    expect(res.state.signedIn).toBe(false)
    expect(state.token).toBe('')
  })

  it('sync.run 未登录时给中文提示，不上传', async () => {
    const { deps, state } = makeDeps()
    const handlers = registerHandlers(deps)
    const res = (await handlers.get('sync.run')!()) as { ok: boolean; message: string }
    expect(res.ok).toBe(false)
    expect(res.message).toContain('未登录')
    expect(state.pushed).toHaveLength(0)
  })

  it('sync.run 上传的包不含令牌与 Key', async () => {
    const { deps, state } = makeDeps()
    const handlers = registerHandlers(deps)
    await handlers.get('sync.signIn')!(null, { token: 'token-should-not-leak', account: 'me' })
    const res = (await handlers.get('sync.run')!()) as { ok: boolean; message: string }
    expect(res.ok).toBe(false)
    expect(state.pushed).toHaveLength(1)
    // 令牌只作为传输层的鉴权参数出现，绝不进同步数据包。
    const bundle = JSON.stringify((state.pushed[0] as { bundle: unknown }).bundle)
    expect(bundle).not.toContain('token-should-not-leak')
    expect(bundle).not.toContain('leak')
  })
})
