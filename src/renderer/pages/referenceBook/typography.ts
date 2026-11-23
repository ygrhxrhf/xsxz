/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/book/typography.ts，Apache-2.0。已修改：去掉 .ts 扩展名引用、内联 i18n/笔记
 * Markdown 的最小替身，以接入 spbf 的真实书籍页面纹理。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import type { Block } from './types'

export function isSourceQuote(b: Block): boolean {
  return b.literary?.role === 'quote' || (b.kind === 'quote' && (!b.literary || b.literary.role === 'attribution'))
}
