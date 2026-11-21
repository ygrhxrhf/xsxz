/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/book/noteFontCatalog.ts，Apache-2.0。已修改：去掉 .ts 扩展名引用、内联 i18n/笔记
 * Markdown 的最小替身，以接入 spbf 的真实书籍页面纹理。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
/** Stable IDs persisted per note, independent of the book's reading typeface. */
export const NOTE_FONTS = [
  { id: 'inherit', label: '跟随正文', detail: '沿用当前阅读字体', family: '' },
  { id: 'wenkai', label: '霞鹜文楷', detail: '温润清晰 · 中英文手写', family: 'LXGW WenKai' },
  { id: 'ma-shan-zheng', label: '马善政楷体', detail: '毛笔楷书 · 中文', family: 'Ma Shan Zheng' },
  { id: 'long-cang', label: '龙藏手写', detail: '舒展行楷 · 中文', family: 'Long Cang' },
  { id: 'zhi-mang-xing', label: '志莽行书', detail: '随性行书 · 中文', family: 'Zhi Mang Xing' },
  { id: 'caveat', label: 'Caveat', detail: '英文手写 · 中文搭配文楷', family: 'Caveat Variable' },
  { id: 'noto-serif', label: '思源宋体', detail: '端正书刊 · 中英文', family: 'Noto Serif SC Variable' },
  { id: 'noto-sans', label: '思源黑体', detail: '简洁清晰 · 中英文', family: 'Noto Sans SC Variable' },
] as const
export type NoteFontId = (typeof NOTE_FONTS)[number]['id']
export const DEFAULT_NOTE_FONT: NoteFontId = 'wenkai'
export function noteFontIdOf(value: unknown): NoteFontId {
  return NOTE_FONTS.find(font => font.id === value)?.id ?? 'inherit'
}
export function noteFontFamily(value: unknown, readerFamily: string): string {
  const id = noteFontIdOf(value)
  if (id === 'inherit') return readerFamily
  const selected = NOTE_FONTS.find(font => font.id === id)!
  return `"${selected.family}", ${id === 'caveat' ? '"LXGW WenKai", ' : ''}${readerFamily}`
}
