import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath(): string {
      throw new Error('siteRules tests must inject a temp dir via setSiteRulesDir')
    },
  },
}))

import {
  findSiteRuleForUrl,
  listSiteRules,
  normalizeHost,
  removeSiteRule,
  setSiteRulesDir,
  upsertSiteRule,
} from './siteRules'

describe('normalizeHost', () => {
  it('lowercases, strips one leading www, and accepts URL-shaped input', () => {
    expect(normalizeHost('www.example.com')).toBe('example.com')
    expect(normalizeHost('Example.com')).toBe('example.com')
    expect(normalizeHost('https://www.Foo.com/path')).toBe('foo.com')
    expect(normalizeHost('  WWW.EXAMPLE.COM  ')).toBe('example.com')
  })

  it('rejects empty host', () => {
    expect(() => normalizeHost('')).toThrow(/域名/)
    expect(() => normalizeHost('   ')).toThrow(/域名/)
  })
})

describe('findSiteRuleForUrl / persist', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-rules-'))
    setSiteRulesDir(dir)
  })

  afterEach(async () => {
    setSiteRulesDir(null)
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the stored example.com rule for www / case / utm variants (VAL-RULE-005)', async () => {
    const stored = await upsertSiteRule({
      host: 'example.com',
      title: 'h1',
      author: '.author',
      catalog: '#list',
      body: '#content',
    })
    expect(stored.host).toBe('example.com')

    const urls = [
      'https://www.example.com/book/',
      'https://Example.com/book/',
      'https://www.example.com/book/?utm_source=x',
    ]
    for (const url of urls) {
      const found = await findSiteRuleForUrl(url)
      expect(found).toBeDefined()
      expect(found!.host).toBe('example.com')
      expect(found!.title).toBe('h1')
      expect(found!.body).toBe('#content')
    }

    await upsertSiteRule({ host: 'WWW.EXAMPLE.COM', title: 'h2' })
    const all = await listSiteRules()
    expect(all).toHaveLength(1)
    expect(all[0].host).toBe('example.com')
    expect(all[0].title).toBe('h2')
  })

  it('writes site-rules.json under the injected dir, not settings.json', async () => {
    await upsertSiteRule({ host: '127.0.0.1', catalog: '#spbf-toc' })
    const raw = JSON.parse(await readFile(join(dir, 'site-rules.json'), 'utf-8')) as {
      version: number
      rules: Array<{ host: string }>
    }
    expect(raw.version).toBe(1)
    expect(raw.rules).toHaveLength(1)
    expect(raw.rules[0].host).toBe('127.0.0.1')
  })

  it('persists ad display preferences alongside extraction selectors', async () => {
    await upsertSiteRule({ host: 'example.com', body: '#chapter', previousChapter: '.prev a', nextChapter: '.next a', adFilterEnabled: false, adHideSelectors: '.floating-ad\n#banner' })
    const found = await findSiteRuleForUrl('https://www.example.com/chapter/1')
    expect(found).toMatchObject({
      host: 'example.com',
      body: '#chapter',
      previousChapter: '.prev a',
      nextChapter: '.next a',
      adFilterEnabled: false,
      adHideSelectors: '.floating-ad\n#banner',
    })
    const disk = JSON.parse(await readFile(join(dir, 'site-rules.json'), 'utf-8'))
    expect(disk.rules[0].adFilterEnabled).toBe(false)
  })

  it('removeSiteRule drops the normalized host', async () => {
    await upsertSiteRule({ host: 'www.example.com', title: 'h1' })
    await removeSiteRule('https://WWW.example.com/x')
    expect(await listSiteRules()).toEqual([])
    expect(await findSiteRuleForUrl('https://example.com/book/')).toBeUndefined()
  })
})

describe('bodyCleanPatterns 落盘', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-rules-clean-'))
    setSiteRulesDir(dir)
  })

  afterEach(async () => {
    setSiteRulesDir(null)
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps the hand-written clean patterns across a save', async () => {
    const rule = await upsertSiteRule({
      host: 'clean.example.com',
      body: '#content',
      bodyCleanPatterns: '^本章未完\n请记住本站\n[a-z]{2,}-\\d+',
    })
    expect(rule.bodyCleanPatterns).toBe('^本章未完\n请记住本站\n[a-z]{2,}-\\d+')
    // 从磁盘读回来还在：以前 toStoredRule 会把这个字段丢掉
    const stored = (await listSiteRules()).find((item) => item.host === 'clean.example.com')
    expect(stored?.bodyCleanPatterns).toBe('^本章未完\n请记住本站\n[a-z]{2,}-\\d+')
  })

  it('drops blank lines and illegal regexes instead of refusing the save', async () => {
    const rule = await upsertSiteRule({
      host: 'clean2.example.com',
      body: '#content',
      bodyCleanPatterns: '\n   \n这行合法\n[unclosed(\n',
    })
    expect(rule.bodyCleanPatterns).toBe('这行合法')
  })
})
