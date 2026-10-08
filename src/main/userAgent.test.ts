import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { browseUserAgent } from './userAgent'

describe('browseUserAgent', () => {
  it('sends a plain Chrome UA matching the platform', () => {
    expect(browseUserAgent('win32', '140.0.7339.133')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.133 Safari/537.36',
    )
    expect(browseUserAgent('linux', '140.0.7339.133')).toContain('(X11; Linux x86_64)')
    expect(browseUserAgent('darwin', '140.0.7339.133')).toContain('(Macintosh; Intel Mac OS X 10_15_7)')
    expect(browseUserAgent('freebsd', '140.0.7339.133')).toContain('(X11; Linux x86_64)')
  })

  it('hides the app name and Electron version that sites block on', () => {
    const ua = browseUserAgent('win32', '140.0.0.0')
    expect(ua).not.toContain('Electron')
    expect(ua).not.toContain('spbf')
    expect(ua).toContain('Mozilla/5.0')
    expect(ua).toContain('Safari/537.36')
  })

  it('never prints Chrome/undefined outside the Electron runtime', () => {
    expect(browseUserAgent('win32', undefined)).toContain('Chrome/140.0.0.0')
    expect(browseUserAgent()).not.toContain('undefined')
  })

  it('is applied to the shared persist:novel session in main', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const start = source.indexOf('function novelSession()')
    const block = source.slice(start, source.indexOf('}', source.indexOf('return ses', start)))
    expect(block).toContain("session.fromPartition(PARTITION)")
    expect(block).toContain('ses.setUserAgent(browseUserAgent())')
  })
})
