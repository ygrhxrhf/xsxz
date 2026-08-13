import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractPage, extractCatalog, extractBody } from './extract'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../../fixtures', name), 'utf-8')

describe('extractPage — catalog page', () => {
  it('detects catalog and extracts 6 chapters', () => {
    const html = fixture('catalog.html')
    const result = extractPage(html, 'https://example.com/book/index.html')
    expect(result.ok).toBe(true)
    expect(result.pageKind).toBe('catalog')
    expect(result.bootstrap!.chapters.length).toBe(6)
    expect(result.bootstrap!.bookTitle).toContain('万古神帝')
    expect(result.bootstrap!.author).toBe('飞天鱼')
  })
})

describe('extractPage — chapter page', () => {
  it('detects chapter and extracts body', () => {
    const html = fixture('chapter.html')
    const result = extractPage(html, 'https://example.com/book/1.html')
    expect(result.ok).toBe(true)
    expect(result.pageKind).toBe('chapter')
    expect(result.body!).toContain('张若尘从梦中惊醒')
    expect(result.body!).not.toContain('上一章')
    expect(result.body!).not.toContain('返回目录')
    expect(result.bootstrap!.catalogUrl).toBeTruthy()
  })

  it('returns NeedLogin for login wall', () => {
    const html = fixture('login-wall.html')
    const result = extractPage(html, 'https://example.com/book/2.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('NeedLogin')
  })

  it('returns BodyEmpty when body is too short', () => {
    const html = fixture('chapter-empty.html')
    const result = extractPage(html, 'https://example.com/book/2.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('BodyEmpty')
  })
})

describe('extractCatalog', () => {
  it('extracts chapter list from catalog HTML', () => {
    const html = fixture('catalog.html')
    const chapters = extractCatalog(html, 'https://example.com/book/index.html')
    expect(chapters.length).toBe(6)
    expect(chapters[0].title).toContain('第一章')
    expect(chapters[0].url).toContain('1.html')
    expect(chapters[5].title).toContain('第六章')
  })
})

describe('extractBody', () => {
  it('extracts body from chapter HTML', () => {
    const html = fixture('chapter.html')
    const result = extractBody(html, 'https://example.com/book/1.html')
    expect(result.ok).toBe(true)
    expect(result.body).toContain('张若尘')
    expect(result.body).not.toContain('本站所有小说')
  })

  it('returns fail for empty body', () => {
    const html = fixture('chapter-empty.html')
    const result = extractBody(html, 'https://example.com/book/2.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('BodyEmpty')
  })
})
