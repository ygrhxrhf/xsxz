import { describe, expect, it } from 'vitest'
import { discoverChapterLinks, extractBrowseReadingPage } from './browseReading'

const url = 'https://novel.example/book/12.html'

describe('web reading extraction', () => {
  it('finds valid chapter anchors and respects manual selectors', () => {
    const html = `<h1>第十二章 夜行</h1><a href="/book/11.html">上一章</a><a href="/book/13.html">下一章</a><a class="chosen" href="/book/14.html">下一章 第十四章</a>`
    expect(discoverChapterLinks(html, url).next?.url).toBe('https://novel.example/book/13.html')
    expect(discoverChapterLinks(html, url, { host: 'novel.example', nextChapter: '.chosen' }).next?.url).toBe('https://novel.example/book/14.html')
    expect(discoverChapterLinks(html, url, { host: 'novel.example', nextChapter: '.missing' }).next).toBeUndefined()
  })

  it('rejects cross-origin and script links', () => {
    const html = `<a href="https://elsewhere.example/1">下一章</a><a href="javascript:go()">上一章</a>`
    expect(discoverChapterLinks(html, url)).toEqual({ previous: undefined, next: undefined })
  })

  it('returns pure text from the current chapter and rejects empty pages', () => {
    const body = '这是一个可读的章节段落。'.repeat(12)
    const html = `<h1>第十二章 夜行</h1><div id="chaptercontent"><p>${body}</p></div>`
    const result = extractBrowseReadingPage(html, url, { host: 'novel.example', body: '#chaptercontent' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.page.title).toBe('第十二章 夜行')
      expect(result.page.body).toContain('这是一个可读的章节段落。')
      expect(result.page.body).not.toContain('<p>')
    }
    expect(extractBrowseReadingPage('<title>目录</title><a href="/1">第一章</a>', url).ok).toBe(false)
  })

  it('keeps the chapter h1 when a hidden panel h2 comes first', () => {
    const body = '风从山口压下来，把整片草场按出一道长长的波纹。'.repeat(8)
    const html = `<html><head><title>某某书_第190章 先生早晨_笔趣阁</title></head><body>
      <div id="xiaoshi" class="jilu1" style="display:none"><h2>阅读记录</h2><div id="jilulist"></div></div>
      <div id="content"><h1>第190章 先生早晨(粤语)</h1><p>${body}</p></div>
    </body></html>`
    const result = extractBrowseReadingPage(html, url)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.page.title).toBe('第190章 先生早晨(粤语)')
  })

  it('falls back to a visible h2 when no h1 exists', () => {
    const body = '林昭把缰绳绕在手腕上，一步一步朝那片翻滚的云里走去。'.repeat(8)
    const html = `<div><h2>第三章 归途</h2><div id="content"><p>${body}</p></div></div>`
    const result = extractBrowseReadingPage(html, url)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.page.title).toBe('第三章 归途')
  })
})
