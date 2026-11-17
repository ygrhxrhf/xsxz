import { describe, expect, it } from 'vitest'
import { chapterImageHeight, chapterImageText, parseChapterImage } from './chapterImages'

describe('chapter image markers', () => {
  it('round-trips file, size and caption', () => {
    const text = chapterImageText({ file: 'c0001-1.png', width: 640, height: 480, caption: '图 1 示意' })
    expect(text).toBe('[图]c0001-1.png|640|480|图 1 示意')
    expect(parseChapterImage(text)).toEqual({ file: 'c0001-1.png', width: 640, height: 480, caption: '图 1 示意' })
  })

  it('accepts a marker without caption and keeps pipes inside the caption', () => {
    expect(parseChapterImage('[图]a.jpg|10|20')).toEqual({ file: 'a.jpg', width: 10, height: 20, caption: '' })
    expect(parseChapterImage('[图]a.jpg|10|20|甲|乙')?.caption).toBe('甲|乙')
  })

  it('rejects non-markers, unsafe names and bad sizes', () => {
    expect(parseChapterImage('普通段落')).toBeNull()
    expect(parseChapterImage('[图]../x.png|10|20')).toBeNull()
    expect(parseChapterImage('[图]a.png|0|20')).toBeNull()
    expect(parseChapterImage('[图]a.png')).toBeNull()
  })

  it('fits the image into the content width and caps the height', () => {
    expect(chapterImageHeight({ file: 'a.png', width: 800, height: 400, caption: '' }, 500, 1000)).toBe(250)
    expect(chapterImageHeight({ file: 'a.png', width: 100, height: 1000, caption: '' }, 500, 600)).toBe(600)
  })
})
