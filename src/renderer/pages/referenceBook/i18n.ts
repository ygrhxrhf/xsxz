/**
 * 参考站 i18n 的最小替身（spbf 界面固定中文）。
 *
 * 上游的 `web/src/i18n/runtime.ts` 依赖 Cookie/URL/云端文案表；书页排版只用到
 * `t()` 的少量界面词，这里直接给出中文串，排版逻辑本身不做任何改动。
 *
 * 许可文本见 third_party/infinite-reader/LICENSE。
 */

type Locale = 'zh-CN' | 'en'

let locale: Locale = 'zh-CN'

export const getLocale = (): Locale => locale

const ZH: Record<string, string> = {
  'Read on the desk': '在书桌上阅读',
  '注': '注',
  '笔记': '笔记',
  '笔记 · 续': '笔记 · 续',
  '图片': '图片',
  '［图片缺失］': '［图片缺失］',
  '阅读脚注': '阅读脚注',
  '第 {0} 页': '第 {0} 页',
}

export function t(key: string, ...args: unknown[]): string {
  const template = (locale === 'zh-CN' ? ZH[key] : undefined) ?? key
  return template.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)] ?? ''))
}

export const subscribe = (): (() => void) => () => {}
