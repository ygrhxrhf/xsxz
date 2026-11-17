import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachChapterImages } from './chapterImages'
import { collectChapterImageCandidates, imageToken } from '../shared/chapterImageSource'
import { setLibraryPath } from './library'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABFSURBVFhH7c4hAQAgEAAxIn4cItIKQswgTsxvnT33ZwVVQVVQFVQFVUFVUBVUBVVBVVAVVAVVQVVQFVQFVUFVUH0enPsADzr+opQvf9EAAAAASUVORK5CYII=',
  'base64',
)

describe('collectChapterImageCandidates', () => {
  it('resolves relative src and keeps document order', () => {
    const html = `
      <img src="/img/a.jpg" alt="甲">
      <img data-src="pics/b.png" alt="">
      <img src="https://cdn.example.com/c.webp">`
    expect(collectChapterImageCandidates(html, 'https://novel.example.com/book/1.html')).toEqual([
      { url: 'https://novel.example.com/img/a.jpg', alt: '甲' },
      { url: 'https://novel.example.com/book/pics/b.png', alt: '' },
      { url: 'https://cdn.example.com/c.webp', alt: '' },
    ])
  })

  it('drops UI/ad images, data: urls, duplicates and tiny images', () => {
    const html = `
      <img src="/static/logo.png">
      <img src="/ads/banner.jpg">
      <img src="/avatar/u1.png">
      <img src="/chapter/1.jpg" width="80" height="60">
      <img src="/chapter/2.jpg" width="600" height="400">
      <img src="/chapter/2.jpg">
      <img src="data:image/png;base64,AAAA">
      <img src="/img/small-icon.png" alt="icon">`
    expect(collectChapterImageCandidates(html, 'https://x.example.com/a/b.html')).toEqual([
      { url: 'https://x.example.com/chapter/2.jpg', alt: '' },
    ])
  })
})

describe('attachChapterImages', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-chapter-images-'))
    await setLibraryPath(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('replaces inline image tokens with [图] paragraphs in place', async () => {
    const token = imageToken('https://x.example.com/img/a.png', '原位图')
    const body = `第一段正文。

${token}

第二段正文。`
    const out = await attachChapterImages({
      bookId: 'd_inline',
      chapterKey: 'c0001',
      pageUrl: 'https://x.example.com/ch/1.html',
      html: '',
      body,
      fetchImage: async () => PNG,
    })
    expect(out.indexOf('第一段正文。')).toBeLessThan(out.indexOf('[图]c0001-1.png|40|40|原位图'))
    expect(out.indexOf('[图]c0001-1.png|40|40|原位图')).toBeLessThan(out.indexOf('第二段正文。'))
    // 标记两侧要空行，分页器才会把图当成独立段落。
    expect(out).toContain(`第一段正文。

[图]c0001-1.png|40|40|原位图

第二段正文。`)
  })

  it('saves fetched images and appends [图] markers; failed images are skipped', async () => {
    const html = `
      <img src="/img/a.png" alt="示意图">
      <img src="/img/b.png">`
    const body = '第一段正文。\n\n第二段正文。'
    const out = await attachChapterImages({
      bookId: 'd_img',
      chapterKey: 'c0001',
      pageUrl: 'https://x.example.com/ch/1.html',
      html,
      body,
      fetchImage: async (url) => (url.endsWith('a.png') ? PNG : null),
    })
    expect(out.startsWith(body)).toBe(true)
    expect(out).toContain('[图]c0001-1.png|40|40|示意图')
    expect(out).not.toContain('c0001-2')
    expect(await readFile(join(dir, 'd_img', 'images', 'c0001-1.png'))).toEqual(PNG)
  })
})
