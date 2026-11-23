/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/book/fontCatalog.ts，Apache-2.0。已修改：去掉 .ts 扩展名引用、内联 i18n/笔记
 * Markdown 的最小替身，以接入 spbf 的真实书籍页面纹理。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
export const READER_FONTS = [
  { id: 'classic', label: '经典书刊', detail: 'EB Garamond · 中文跟随系统宋体', family: 'EB Garamond Variable' },
  { id: 'noto-serif', label: '思源宋体', detail: 'Noto Serif SC · 端正、适合长文', family: 'Noto Serif SC Variable' },
  { id: 'noto-sans', label: '思源黑体', detail: 'Noto Sans SC · 清晰、简洁', family: 'Noto Sans SC Variable' },
  { id: 'wenkai', label: '霞鹜文楷', detail: 'LXGW WenKai · 温润、手写韵味', family: 'LXGW WenKai' },
  { id: 'xiaowei', label: '站酷小薇体', detail: 'ZCOOL XiaoWei · 轻盈、书卷气', family: 'ZCOOL XiaoWei' },
] as const
export type ReaderFontId = (typeof READER_FONTS)[number]['id']
export const DEFAULT_READER_FONT: ReaderFontId = 'wenkai'
export type QuoteFontId = 'wenkai' | 'inherit'
export const DEFAULT_QUOTE_FONT: QuoteFontId = 'wenkai'

export interface FontAsset {
  url: string
  family?: string
  weight?: string
  style: 'normal' | 'italic'
  range: string
}

export function fontRangeIntersects(range: string, codepoints: readonly number[]) {
  return range.split(',').some((part) => {
    const [first, last] = part.trim().replace(/^U\+/i, '').split('-')
    const start = parseInt(first.replace(/\?/g, '0'), 16)
    const end = parseInt((last ?? first).replace(/\?/g, 'F'), 16)
    return codepoints.some((cp) => cp >= start && cp <= end)
  })
}
