/**
 * 全文搜索共用的纯文本工具。分段规则与阅读器渲染一致：
 * 以空行（\n{2,}）切段、丢弃空段。
 */

export interface ParaRange {
  /** 渲染时的段落下标（空段不计入） */
  index: number
  start: number
  end: number
}

/** 计算每段在原文中的字符偏移区间。 */
export function paragraphRanges(body: string): ParaRange[] {
  const ranges: ParaRange[] = []
  const re = /\n{2,}/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) {
      ranges.push({ index: ranges.length, start: last, end: m.index })
    }
    last = m.index + m[0].length
  }
  if (last < body.length) {
    ranges.push({ index: ranges.length, start: last, end: body.length })
  }
  return ranges
}

export function paraIndexOfOffset(ranges: ParaRange[], offset: number): number {
  for (const r of ranges) {
    if (offset >= r.start && offset < r.end) return r.index
  }
  return -1
}

/** 把命中偏移裁成摘录，前后各留约 radius 字。 */
export function buildExcerpt(body: string, offset: number, needleLen: number, radius = 20): string {
  const start = Math.max(0, offset - radius)
  const end = Math.min(body.length, offset + Math.max(1, needleLen) + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < body.length ? '…' : ''
  return prefix + body.slice(start, end).replace(/\s*\n+\s*/g, ' ') + suffix
}

export interface TextSegment {
  text: string
  hit: boolean
}

/**
 * 把一段文本按查询词（大小写不敏感）切成片段；无命中时返回单片段。
 */
export function segmentParagraphText(text: string, rawQuery: string): TextSegment[] {
  const q = rawQuery.trim().toLowerCase()
  if (!q || !text.toLowerCase().includes(q)) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const segs: TextSegment[] = []
  let pos = 0
  for (;;) {
    const at = lower.indexOf(q, pos)
    if (at < 0) {
      segs.push({ text: text.slice(pos), hit: false })
      break
    }
    if (at > pos) segs.push({ text: text.slice(pos, at), hit: false })
    segs.push({ text: text.slice(at, at + q.length), hit: true })
    pos = at + q.length
  }
  return segs.filter((s) => s.text.length > 0)
}

export interface DecoSegment {
  text: string
  /** 搜索命中 */
  hit: boolean
  /** 划线笔记 */
  hl: boolean
}

interface Interval {
  start: number
  end: number
}

/**
 * 同时叠加搜索命中与划线的段落渲染切片。hlRanges 为本段内坐标（可为空），
 * 越界部分自动裁剪。返回的片段按原文字符顺序排列，拼接后等于原文。
 */
export function decorateText(
  text: string,
  rawQuery: string,
  hlRanges: Interval[],
): DecoSegment[] {
  if (!text) return []
  const q = rawQuery.trim().toLowerCase()
  const hits: Interval[] = []
  if (q && text.toLowerCase().includes(q)) {
    const lower = text.toLowerCase()
    for (let pos = lower.indexOf(q); pos >= 0; pos = lower.indexOf(q, pos + Math.max(1, q.length))) {
      hits.push({ start: pos, end: pos + q.length })
    }
  }
  const hls = hlRanges
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(text.length, r.end) }))
    .filter((r) => r.end > r.start)

  const pts = new Set<number>([0, text.length])
  for (const r of [...hits, ...hls]) {
    pts.add(r.start)
    pts.add(r.end)
  }
  const sorted = [...pts].sort((a, b) => a - b)
  const out: DecoSegment[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i]
    const e = sorted[i + 1]
    if (e <= s) continue
    out.push({
      text: text.slice(s, e),
      hit: hits.some((r) => r.start <= s && s < r.end),
      hl: hls.some((r) => r.start <= s && s < r.end),
    })
  }
  return out.filter((s) => s.text.length > 0)
}

/**
 * 笔记漂移校正：偏移处内容与摘录一致则原样返回；否则按摘录重新定位一次；
 * 找不到（正文被清理/改写）返回 null，条目保留但不高亮。
 */
export function relocateRange(
  body: string,
  start: number,
  end: number,
  excerpt: string,
): { start: number; end: number } | null {
  if (start >= 0 && end >= start && body.slice(start, end) === excerpt) {
    return { start, end }
  }
  if (excerpt) {
    const at = body.indexOf(excerpt)
    if (at >= 0) return { start: at, end: at + excerpt.length }
  }
  return null
}
