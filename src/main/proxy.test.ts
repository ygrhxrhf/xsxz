import { describe, expect, it } from 'vitest'
import {
  applyProxyToSession,
  buildProxyBypassList,
  buildProxyRules,
  describeProxy,
  isProxyConfigured,
  judgeProxyProbe,
  normalizeProxyHost,
  normalizeProxyPort,
  normalizeProxyPrefs,
} from './proxy'
import { DEFAULT_PROXY_PREFS } from '../shared/types'

describe('normalizeProxyHost', () => {
  it('保留合法的域名与 IPv4', () => {
    expect(normalizeProxyHost('127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeProxyHost('proxy.example.com')).toBe('proxy.example.com')
  })

  it('从粘贴的整条 URL 里剥出主机名', () => {
    expect(normalizeProxyHost('http://127.0.0.1:7890')).toBe('127.0.0.1')
    expect(normalizeProxyHost('socks5://proxy.example.com:1080/')).toBe('proxy.example.com')
  })

  it('去掉误粘的 user:pass@ 与端口', () => {
    expect(normalizeProxyHost('user:pass@127.0.0.1:7890')).toBe('127.0.0.1')
  })

  it('保留 IPv6 方括号形式', () => {
    expect(normalizeProxyHost('[::1]')).toBe('[::1]')
  })

  it('空值与非法值返回空串', () => {
    expect(normalizeProxyHost('')).toBe('')
    expect(normalizeProxyHost('   ')).toBe('')
    expect(normalizeProxyHost('http://')).toBe('')
    expect(normalizeProxyHost('has space')).toBe('')
  })
})

describe('normalizeProxyPort', () => {
  it('接受合理端口', () => {
    expect(normalizeProxyPort(7890)).toBe(7890)
    expect(normalizeProxyPort('1080')).toBe(1080)
    expect(normalizeProxyPort(1)).toBe(1)
    expect(normalizeProxyPort(65535)).toBe(65535)
  })

  it('越界与非法值回退默认端口', () => {
    expect(normalizeProxyPort(0)).toBe(DEFAULT_PROXY_PREFS.port)
    expect(normalizeProxyPort(70000)).toBe(DEFAULT_PROXY_PREFS.port)
    expect(normalizeProxyPort('abc')).toBe(DEFAULT_PROXY_PREFS.port)
    expect(normalizeProxyPort(null)).toBe(DEFAULT_PROXY_PREFS.port)
  })
})

describe('normalizeProxyPrefs', () => {
  it('缺省即直连：不改变任何现存用户的网络行为', () => {
    const prefs = normalizeProxyPrefs(undefined)
    expect(prefs.mode).toBe('off')
    expect(prefs.protocol).toBe('http')
  })

  it('只改坏一个字段时不清空其它字段', () => {
    const prefs = normalizeProxyPrefs({
      mode: 'manual',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 'oops',
      bypass: 'localhost',
    })
    expect(prefs.mode).toBe('manual')
    expect(prefs.host).toBe('127.0.0.1')
    // 端口非法回退默认，但地址与 bypass 保留
    expect(prefs.port).toBe(DEFAULT_PROXY_PREFS.port)
    expect(prefs.bypass).toBe('localhost')
  })

  it('非法模式回退 off', () => {
    expect(normalizeProxyPrefs({ mode: 'turbo' }).mode).toBe('off')
  })
})

describe('isProxyConfigured', () => {
  it('off / system 永远算配好', () => {
    expect(isProxyConfigured({ ...DEFAULT_PROXY_PREFS, mode: 'off' })).toBe(true)
    expect(isProxyConfigured({ ...DEFAULT_PROXY_PREFS, mode: 'system' })).toBe(true)
  })

  it('manual 模式缺地址不算配好（否则会把整机指向不存在的代理）', () => {
    expect(isProxyConfigured({ ...DEFAULT_PROXY_PREFS, mode: 'manual', host: '' })).toBe(false)
    expect(isProxyConfigured({ ...DEFAULT_PROXY_PREFS, mode: 'manual', host: '127.0.0.1' })).toBe(true)
  })
})

describe('buildProxyRules', () => {
  it('off 用 direct:// —— 连系统代理也不走', () => {
    expect(buildProxyRules({ ...DEFAULT_PROXY_PREFS, mode: 'off' })).toBe('direct://')
  })

  it('system 返回空串，交给 Chromium 跟随系统', () => {
    expect(buildProxyRules({ ...DEFAULT_PROXY_PREFS, mode: 'system' })).toBe('')
  })

  it('manual 拼出协议://主机:端口', () => {
    expect(
      buildProxyRules({ ...DEFAULT_PROXY_PREFS, mode: 'manual', protocol: 'socks5', host: '127.0.0.1', port: 1080 }),
    ).toBe('socks5://127.0.0.1:1080')
  })
})

describe('buildProxyBypassList', () => {
  it('总是带上 <local>，让内网短名不走代理', () => {
    expect(buildProxyBypassList('')).toBe('<local>')
  })

  it('换行与逗号两种写法都认', () => {
    expect(buildProxyBypassList('localhost\n127.0.0.1,*.lan')).toBe('<local>,localhost,127.0.0.1,*.lan')
  })

  it('忽略空项与多余分隔符', () => {
    expect(buildProxyBypassList(' , \n\n a ,, ')).toBe('<local>,a')
  })
})

describe('describeProxy', () => {
  it('三种模式各给一句人话', () => {
    expect(describeProxy({ ...DEFAULT_PROXY_PREFS, mode: 'off' })).toContain('直连')
    expect(describeProxy({ ...DEFAULT_PROXY_PREFS, mode: 'system' })).toContain('系统代理')
    expect(describeProxy({ ...DEFAULT_PROXY_PREFS, mode: 'manual', host: 'h', port: 1 })).toContain('http://h:1')
  })

  it('manual 没填地址时说清楚', () => {
    expect(describeProxy({ ...DEFAULT_PROXY_PREFS, mode: 'manual', host: '' })).toContain('未填完整')
  })
})

describe('applyProxyToSession', () => {
  function fakeSession() {
    const calls: unknown[] = []
    let closed = 0
    return {
      calls,
      get closed() { return closed },
      async setProxy(config: unknown) { calls.push(config) },
      async closeAllConnections() { closed++ },
    }
  }

  it('off 传 direct 模式', async () => {
    const ses = fakeSession()
    const res = await applyProxyToSession(ses, { ...DEFAULT_PROXY_PREFS, mode: 'off' })
    expect(res.ok).toBe(true)
    expect(ses.calls[0]).toEqual({ mode: 'direct' })
  })

  it('system 传 system 模式', async () => {
    const ses = fakeSession()
    await applyProxyToSession(ses, { ...DEFAULT_PROXY_PREFS, mode: 'system' })
    expect(ses.calls[0]).toEqual({ mode: 'system' })
  })

  it('manual 传 fixed_servers 并附 bypass', async () => {
    const ses = fakeSession()
    await applyProxyToSession(ses, {
      ...DEFAULT_PROXY_PREFS,
      mode: 'manual',
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      bypass: 'localhost',
    })
    expect(ses.calls[0]).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: '<local>,localhost',
    })
  })

  it('每次应用都断开旧连接（否则改完还要靠系统代理）', async () => {
    const ses = fakeSession()
    await applyProxyToSession(ses, { ...DEFAULT_PROXY_PREFS, mode: 'manual', host: '127.0.0.1', port: 1 })
    expect(ses.closed).toBe(1)
  })

  it('manual 没填地址时不动会话，避免把整机指向不存在的代理', async () => {
    const ses = fakeSession()
    const res = await applyProxyToSession(ses, { ...DEFAULT_PROXY_PREFS, mode: 'manual', host: '' })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('没填完整')
    expect(ses.calls).toHaveLength(0)
  })

  it('closeAllConnections 抛错不影响「已应用」的结论', async () => {
    const calls: unknown[] = []
    const ses = {
      async setProxy(config: unknown) { calls.push(config) },
      async closeAllConnections() { throw new Error('busy') },
    }
    const res = await applyProxyToSession(ses, { ...DEFAULT_PROXY_PREFS, mode: 'off' })
    expect(res.ok).toBe(true)
  })
})

describe('judgeProxyProbe', () => {
  it('拿到任何 HTTP 状态码都算通（403/挑战页也证明链路通了）', () => {
    expect(judgeProxyProbe({ ok: true, status: 200 }).ok).toBe(true)
    expect(judgeProxyProbe({ ok: true, status: 403 }).ok).toBe(true)
  })

  it('连不上时给失败与原因', () => {
    const res = judgeProxyProbe({ ok: false, error: 'ERR_PROXY_CONNECTION_FAILED' })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('ERR_PROXY_CONNECTION_FAILED')
  })

  it('没有状态码也算失败', () => {
    expect(judgeProxyProbe({ ok: true }).ok).toBe(false)
  })
})
