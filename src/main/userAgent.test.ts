import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { browseUserAgent, sessionUserAgent } from './userAgent'

describe('sessionUserAgent：默认不覆盖 UA', () => {
  it('返回空串，表示保留 Chromium 原生 UA', () => {
    expect(sessionUserAgent()).toBe('')
  })

  it('空串才是对的：手工拼串会丢掉 Electron 标记与完整补丁版本号', () => {
    // 实测（Electron 45 / Chromium 156 + 代理，2026-11-03）：
    // 覆盖成 Chrome/156.0.0.0 → uaa001 的 Cloudflare 挑战过不去；
    // 保留原生（Chrome/156.0.8078.75 Electron/45.2.1）→ 挑战能过。
    const spoofed = browseUserAgent('win32', '156.0.0.0')
    expect(spoofed).not.toContain('Electron')
    expect(spoofed).toContain('Chrome/156.0.0.0')
    expect(sessionUserAgent()).toBe('')
  })
})

describe('browseUserAgent：仅作可选伪装，不是默认', () => {
  it('按平台拼出不带 Electron 标记的 Chrome UA', () => {
    expect(browseUserAgent('win32', '140.0.7339.133')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.133 Safari/537.36',
    )
    expect(browseUserAgent('linux', '140.0.7339.133')).toContain('(X11; Linux x86_64)')
    expect(browseUserAgent('darwin', '140.0.7339.133')).toContain('(Macintosh; Intel Mac OS X 10_15_7)')
    expect(browseUserAgent('freebsd', '140.0.7339.133')).toContain('(X11; Linux x86_64)')
  })

  it('确实抹掉了 Electron 与应用名（这是它的用途，也是它踩坑的原因）', () => {
    const ua = browseUserAgent('win32', '140.0.0.0')
    expect(ua).not.toContain('Electron')
    expect(ua).not.toContain('spbf')
    expect(ua).toContain('Mozilla/5.0')
    expect(ua).toContain('Safari/537.36')
  })

  it('不会打印 Chrome/undefined', () => {
    expect(browseUserAgent('win32', undefined)).toContain('Chrome/140.0.0.0')
    expect(browseUserAgent()).not.toContain('undefined')
  })
})

describe('会话接线', () => {
  it('novelSession 默认不覆盖 UA，只在显式给出时才设', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const start = source.indexOf('function novelSession()')
    const block = source.slice(start, source.indexOf('return ses', start))
    expect(block).toContain('session.fromPartition(PARTITION)')
    expect(block).toContain('sessionUserAgent()')
    // 必须是条件设置：空串时不调用 setUserAgent，否则会制造指纹不一致
    expect(block).toContain('if (ua) ses.setUserAgent(ua)')
    expect(block).not.toContain('ses.setUserAgent(browseUserAgent())')
  })
})
