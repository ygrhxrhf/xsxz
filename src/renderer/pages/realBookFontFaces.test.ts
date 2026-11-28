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

describe('Worker 字体分片预加载契约', () => {
  it('RealBookTextureRasterizer 首帧一次性向 Worker 发送全部已收集分片，后续帧不再重复发送同 URL 分片', async () => {
    const posted: Array<{ id: number; fonts: FontFaceSpec[] }> = []
    const OriginalWorker = globalThis.Worker
    const OriginalOffscreen = globalThis.OffscreenCanvas
    const sheetRule = {
      type: 5, // CSSRule.FONT_FACE_RULE
      style: {
        fontFamily: '"LXGW WenKai Screen"',
        fontStyle: 'normal',
        fontWeight: '400',
        getPropertyValue: (name: string) =>
          name === 'src'
            ? 'url("https://example.com/sub1.woff2")'
            : name === 'unicode-range'
              ? 'U+4e00-4e10'
              : '',
      },
    }
    const sheetRule2 = {
      type: 5,
      style: {
        fontFamily: '"LXGW WenKai Screen"',
        fontStyle: 'normal',
        fontWeight: '400',
        getPropertyValue: (name: string) =>
          name === 'src'
            ? 'url("https://example.com/sub2.woff2")'
            : name === 'unicode-range'
              ? 'U+6bb7'
              : '',
      },
    }
    const OriginalDocument = (globalThis as unknown as Record<string, unknown>).document
    const OriginalCSSRule = (globalThis as unknown as Record<string, unknown>).CSSRule
    ;(globalThis as unknown as Record<string, unknown>).document = {
      baseURI: 'https://example.com/',
      styleSheets: [{ cssRules: [sheetRule, sheetRule2] }],
    }
    ;(globalThis as unknown as Record<string, unknown>).CSSRule = { FONT_FACE_RULE: 5 }
    ;(globalThis as unknown as Record<string, unknown>).OffscreenCanvas = class {}
    ;(globalThis as unknown as Record<string, unknown>).Worker = class {
      onmessage: ((e: unknown) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      postMessage(msg: { id: number; fonts: FontFaceSpec[] }): void {
        posted.push({ id: msg.id, fonts: msg.fonts })
      }
      terminate(): void {}
    }
    try {
      const { RealBookTextureRasterizer } = await import('./realBookTextureRasterizer')
      const { buildPageTexturePlan } = await import('./realBookTexture')
      const THREE = await import('three')
      const rasterizer = new RealBookTextureRasterizer()
      const style = {
        fontSize: 22,
        lineHeight: 33,
        fontFamily: '"LXGW WenKai Screen", serif',
        paragraphGap: 0,
        paper: '#f1dbbe',
        ink: '#241c15',
        muted: '#666',
      }
      const plan1 = buildPageTexturePlan(
        { pageNumber: 1, chapterTitle: '章一', items: [] },
        style,
      )
      const plan2 = buildPageTexturePlan(
        { pageNumber: 2, chapterTitle: '章一', items: [] },
        style,
      )
      const placeholder = new THREE.Texture()
      rasterizer.get('k1', plan1, style, 2, placeholder)
      rasterizer.get('k2', plan2, style, 2, placeholder)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(posted).toHaveLength(2)
      expect(posted[0]!.fonts.map((f) => f.range)).toEqual(['U+4e00-4e10', 'U+6bb7'])
      expect(posted[1]!.fonts).toEqual([])
      rasterizer.dispose()
    } finally {
      ;(globalThis as unknown as Record<string, unknown>).document = OriginalDocument
      ;(globalThis as unknown as Record<string, unknown>).CSSRule = OriginalCSSRule
      ;(globalThis as unknown as Record<string, unknown>).Worker = OriginalWorker
      ;(globalThis as unknown as Record<string, unknown>).OffscreenCanvas = OriginalOffscreen
    }
  })
})
