/**
 * 书页纹理 Worker 的字体清单。
 *
 * Worker 里没有 document，不能直接用 CSS 的 @font-face。这里在主线程把
 * `@font-face` 规则抽出来，按页面用到的字筛选子集，再把 URL 交给 Worker
 * 自己 `new FontFace(...).load()`。构建后页面是 file://，Worker 取不到
 * file:// 字体，所以把 `file://.../<name>.woff2` 改写成主进程的
 * `spbf-font://f/<name>`（见 src/main/fontProtocol.ts）。
 */

export interface FontFaceSpec {
  family: string
  style: string
  weight: string
  /** CSS unicode-range 原文；空串表示不限。 */
  range: string
  /** 已解析并（在生产构建里）改写成可 fetch 的 URL。 */
  url: string
}

interface CodeRange {
  start: number
  end: number
}

/** `U+0030-0039, U+4?` → 码点区间。 */
export function parseUnicodeRange(value: string): CodeRange[] {
  const out: CodeRange[] = []
  for (const part of value.split(',')) {
    const token = part.trim().replace(/^U\+/, '').replace(/^u\+/, '')
    if (!token) continue
    const dash = token.indexOf('-')
    if (dash >= 0) {
      const start = Number.parseInt(token.slice(0, dash), 16)
      const end = Number.parseInt(token.slice(dash + 1), 16)
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end) out.push({ start, end })
      continue
    }
    const question = token.indexOf('?')
    if (question >= 0) {
      const base = Number.parseInt(token.slice(0, question), 16)
      // `U+4?` 表示 4 后面 1 个十六进制位，`U+4??` 是 2 个。
      const digits = token.length - question
      if (Number.isFinite(base) && digits > 0 && digits <= 6) {
        const size = 16 ** digits
        // `U+4?` 是 0x4?：前缀 4 要左移一位十六进制。
        const start = base * size
        out.push({ start, end: start + size - 1 })
      }
      continue
    }
    const single = Number.parseInt(token, 16)
    if (Number.isFinite(single)) out.push({ start: single, end: single })
  }
  return out
}

function extractUrl(src: string): string {
  const open = src.indexOf('url(')
  if (open < 0) return ''
  const close = src.indexOf(')', open + 4)
  if (close < 0) return ''
  return src.slice(open + 4, close).trim().replace(/^['"]|['"]$/g, '')
}

/** 生产构建（file://）下把字体映射到主进程协议；开发态保持 http(s)。 */
function resolveFontUrl(url: string): string {
  let absolute = url
  try {
    absolute = new URL(url, typeof document !== 'undefined' ? document.baseURI : undefined).href
  } catch {
    return url
  }
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    const base = absolute.split('/').pop() ?? ''
    if (/^[A-Za-z0-9._-]+\.woff2$/.test(base)) return `spbf-font://f/${base}`
  }
  return absolute
}

/** 读取文档里所有 @font-face。跨域样式表读不到 cssRules 时跳过。 */
export function collectFontFaces(): FontFaceSpec[] {
  if (typeof document === 'undefined') return []
  const out: FontFaceSpec[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      if (rule.type !== CSSRule.FONT_FACE_RULE) continue
      const face = rule as CSSFontFaceRule
      const family = (face.style.fontFamily ?? '').replace(/^['"]|['"]$/g, '').trim()
      const url = extractUrl(face.style.getPropertyValue('src') || '')
      if (!family || !url) continue
      out.push({
        family,
        style: face.style.fontStyle || 'normal',
        weight: face.style.fontWeight || '400',
        range: face.style.getPropertyValue('unicode-range') || '',
        url: resolveFontUrl(url),
      })
    }
  }
  return out
}

/** 只保留覆盖页面文字的子集；没有 unicode-range 的面（如可变字体）总是带上。 */
export function selectFontFaces(faces: readonly FontFaceSpec[], text: string): FontFaceSpec[] {
  const parsed = faces.map((face) => ({
    face,
    ranges: face.range ? parseUnicodeRange(face.range) : null,
  }))
  if (!parsed.length) return []
  const points = new Set<number>()
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code !== undefined) points.add(code)
  }
  const selected: FontFaceSpec[] = []
  for (const { face, ranges } of parsed) {
    if (!ranges || ranges.length === 0) {
      selected.push(face)
      continue
    }
    let hit = false
    for (const point of points) {
      if (ranges.some((range) => point >= range.start && point <= range.end)) {
        hit = true
        break
      }
    }
    if (hit) selected.push(face)
  }
  return selected
}
