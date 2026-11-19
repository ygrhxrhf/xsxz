import { describe, expect, it } from 'vitest'
import { parseUnicodeRange, selectFontFaces, type FontFaceSpec } from './realBookFontFaces'

describe('parseUnicodeRange', () => {
  it('解析显式区间与单字', () => {
    expect(parseUnicodeRange('U+0030-0039, U+4e00')).toEqual([
      { start: 0x30, end: 0x39 },
      { start: 0x4e00, end: 0x4e00 },
    ])
  })

  it('展开 U+4? 这类前缀', () => {
    expect(parseUnicodeRange('U+4?')).toEqual([{ start: 0x40, end: 0x4f }])
  })

  it('忽略坏值', () => {
    expect(parseUnicodeRange('')).toEqual([])
    expect(parseUnicodeRange('nonsense, U+zz')).toEqual([])
  })
})

describe('selectFontFaces', () => {
  const faces: FontFaceSpec[] = [
    { family: 'A', style: 'normal', weight: '400', range: 'U+4e00-4e10', url: 'a.woff2' },
    { family: 'B', style: 'normal', weight: '400', range: 'U+0041-005a', url: 'b.woff2' },
    { family: 'C', style: 'normal', weight: '400', range: '', url: 'c.woff2' },
  ]

  it('只保留覆盖页面文字的子集，没有 unicode-range 的总带上', () => {
    expect(selectFontFaces(faces, '一')).toEqual([faces[0], faces[2]])
    expect(selectFontFaces(faces, 'A一')).toEqual([faces[0], faces[1], faces[2]])
    expect(selectFontFaces(faces, 'z')).toEqual([faces[2]])
  })

  it('空文本只带无范围的面', () => {
    expect(selectFontFaces(faces, '')).toEqual([faces[2]])
  })
})
