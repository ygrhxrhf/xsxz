import { decorateText } from '@shared/paragraphSearch'
import { splitIntoParagraphs } from './useTts'

/** 无搜索全量 decorate 的阻塞门：超过则允许按证据改渲染策略。 */
export const LARGE_CHAPTER_PLAIN_DECORATE_GATE_MS = 100

export function shouldOptimizeLargeChapter(plainDecorateMs: number): boolean {
  return Number.isFinite(plainDecorateMs) && plainDecorateMs > LARGE_CHAPTER_PLAIN_DECORATE_GATE_MS
}

export function buildSyntheticChapterBody(paragraphCount = 10_000): string {
  const parts: string[] = []
  for (let i = 0; i < paragraphCount; i++) {
    parts.push(`第${i + 1}段：山间松针落在石上，夜色如墨，行者独行。`)
  }
  return parts.join('\n\n')
}

export interface LargeChapterPerfSample {
  paragraphCount: number
  splitMs: number
  plainDecorateMs: number
  searchDecorateMs: number
  highlightDecorateMs: number
  shouldOptimize: boolean
}

function elapsedMs(start: number): number {
  return performance.now() - start
}

function paragraphStarts(paras: string[]): number[] {
  const starts: number[] = []
  let offset = 0
  for (const p of paras) {
    starts.push(offset)
    offset += p.length + 2
  }
  return starts
}

/** 与阅读器一致：少量章级划线映射到每段局部坐标。 */
function fewChapterHighlightRanges(starts: number[], lastLen: number): Array<{ start: number; end: number }> {
  const mid = starts[Math.floor(starts.length / 2)] ?? 0
  const last = starts[starts.length - 1] ?? 0
  return [
    { start: 0, end: 4 },
    { start: mid, end: mid + 3 },
    { start: last, end: last + Math.min(3, lastLen) },
  ]
}

/**
 * 用合成大章测量分段与三种 decorate 全量路径。
 * 测量本身会真正执行 10_000 段 map，不是估算。
 */
export function measureLargeChapterRender(paragraphCount = 10_000): LargeChapterPerfSample {
  const body = buildSyntheticChapterBody(paragraphCount)

  const splitStart = performance.now()
  const paras = splitIntoParagraphs(body)
  const splitMs = elapsedMs(splitStart)

  const plainStart = performance.now()
  for (const p of paras) decorateText(p, '', [])
  const plainDecorateMs = elapsedMs(plainStart)

  const searchStart = performance.now()
  for (const p of paras) decorateText(p, '针', [])
  const searchDecorateMs = elapsedMs(searchStart)

  const starts = paragraphStarts(paras)
  const lastLen = paras[paras.length - 1]?.length ?? 0
  const chapterHl = fewChapterHighlightRanges(starts, lastLen)
  const hlStart = performance.now()
  for (let i = 0; i < paras.length; i++) {
    const base = starts[i] ?? 0
    const localHl = chapterHl.map((a) => ({ start: a.start - base, end: a.end - base }))
    decorateText(paras[i], '', localHl)
  }
  const highlightDecorateMs = elapsedMs(hlStart)

  return {
    paragraphCount: paras.length,
    splitMs,
    plainDecorateMs,
    searchDecorateMs,
    highlightDecorateMs,
    shouldOptimize: shouldOptimizeLargeChapter(plainDecorateMs),
  }
}
