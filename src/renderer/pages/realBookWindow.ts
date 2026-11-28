/**
 * 真实书籍「整本连排」窗口：把包含当前章的一段连续已下载（ready）章节合成一本物理书，
 * 翻页时跨章节边界无缝，不再每章重建、不再每章插 title/blank 空页。
 *
 * 纯函数层，方便单测。窗口装配（哪些章进来、怎么按页数封顶裁剪）在这里；
 * 正文获取（readChapter）与合并段落数组的拼装放在 Reader，避免把 IO 掺进来。
 */
import type { ChapterMeta } from '@shared/types'

/** 窗口里的一章：正文段落 + 这些段落相对「原始正文」的下标 + 在合并数组里的起点。 */
export interface RealBookWindowChapter {
  meta: ChapterMeta
  /** 该章的可见段落文本（已过滤尾巴，与 Reader 喂给书页模式的段落同源） */
  paragraphs: string[]
  /** 与 paragraphs 等长：每段在原始正文里的下标 */
  paragraphIndexes: number[]
  /** 在合并段落数组（所有窗口章首尾相接）里，本章段落的起始下标 */
  start: number
  /** 本章段落数 */
  total: number
}

export interface RealBookWindow {
  chapters: RealBookWindowChapter[]
  /** 当前章在窗口里的下标（找不到就是 null） */
  currentIndex: number | null
  /** 合并段落数组总长 */
  length: number
}

export interface RealBookWindowOptions {
  /** 窗口最多塞多少章（含当前章）。缺省不限，只受 maxParagraphs 管。 */
  maxChapters?: number
  /** 窗口合并段落总数上限（页数代理）：超长时优先保留当前章及之后的前向空间。缺省 2400。 */
  maxParagraphs?: number
  /** 某章正文是否可用（已下载/已缓存）。缺省视为全部可用。 */
  bodyAvailable?: (meta: ChapterMeta) => boolean
}

interface ResolvedOptions {
  maxChapters: number | null
  maxParagraphs: number
  bodyAvailable: (meta: ChapterMeta) => boolean
}

function resolveOptions(options?: RealBookWindowOptions): ResolvedOptions {
  return {
    maxChapters: options?.maxChapters ?? null,
    maxParagraphs: options?.maxParagraphs ?? 2400,
    bodyAvailable: options?.bodyAvailable ?? (() => true),
  }
}

/**
 * 取包含 `current` 的「最大连续 ready 章段」，再按上限裁剪。
 *
 * 裁剪策略：前向优先。先把当前章之后的 ready 章尽量塞满，再回头补当前章之前的；
 * 这样读者站在某章时，翻向未来的空间始终比翻向过去的大，几乎不会「翻两下就撞墙」。
 *
 * 只有连续 `status==='ready'` 且正文可用的章才进窗口；中间一旦断（未下载/正文取不到），
 * 窗口就在那章之前收住——保持「连续」这个不变式。
 */
export function buildRealBookWindow(
  chapters: readonly ChapterMeta[],
  current: Pick<ChapterMeta, 'id'> | null,
  inputOf: (meta: ChapterMeta) => { paragraphs: string[]; paragraphIndexes: number[] },
  options?: RealBookWindowOptions,
): RealBookWindow | null {
  if (!current) return null
  const currentId = current.id
  const currentPos = chapters.findIndex((chapter) => chapter.id === currentId)
  if (currentPos < 0) return null

  const opts = resolveOptions(options)
  // 当前章自己必须 ready 且正文可用，否则没有「包含当前章的窗口」可言。
  const currentMeta = chapters[currentPos]
  if (currentMeta.status !== 'ready' || !opts.bodyAvailable(currentMeta)) return null

  // 从当前章向外扩到最大连续 ready+正文可用段。
  const forward: ChapterMeta[] = []
  for (let i = currentPos + 1; i < chapters.length; i += 1) {
    const meta = chapters[i]
    if (meta.status !== 'ready' || !opts.bodyAvailable(meta)) break
    forward.push(meta)
// forward 是「当前章之后」：最多留 maxChapters-1 章（给当前章留 1 个名额）；不设则不限。
    if (opts.maxChapters != null && forward.length >= opts.maxChapters - 1) break
  }
  let backward: ChapterMeta[] = []
  const room = opts.maxChapters == null ? chapters.length : Math.max(0, opts.maxChapters - forward.length - 1)
  for (let i = currentPos - 1; i >= 0 && backward.length < room; i -= 1) {
    const meta = chapters[i]
    if (meta.status !== 'ready' || !opts.bodyAvailable(meta)) break
    backward.unshift(meta)
  }

  // 合并段落总数封顶：前向优先。先保留当前章 + 尽量多的后向章，再补前向。
  // 累计：先放当前章，再按「前向优先」顺序塞：当前章后 → 当前章前。
  const order = [currentMeta, ...forward, ...backward]
  const counts = new Map<string, number>()
  for (const meta of order) counts.set(meta.id, inputOf(meta).paragraphs.length)

  const chosen: ChapterMeta[] = []
  let used = 0
  // 第一遍：当前章（必须进）+ 前向，直到撞上 maxParagraphs。
  for (const meta of [currentMeta, ...forward]) {
    const count = counts.get(meta.id) ?? 0
    if (chosen.length > 0 && used + count > opts.maxParagraphs) break
    chosen.push(meta)
    used += count
  }
  // 第二遍：回头补当前章之前的，塞得下就塞。
  for (const meta of backward) {
    if (chosen.includes(meta)) continue
    const count = counts.get(meta.id) ?? 0
    if (used + count > opts.maxParagraphs) continue
    chosen.push(meta)
    used += count
  }

  // 把「乱序选出来」的章重排回目录顺序，只保留仍在 chosen 里的章。
  const chosenIds = new Set(chosen.map((meta) => meta.id))
  const ordered = chapters.filter((meta) => chosenIds.has(meta.id))

  let cursor = 0
  const chaptersOut: RealBookWindowChapter[] = ordered.map((meta) => {
    const input = inputOf(meta)
    const chapter: RealBookWindowChapter = {
      meta,
      paragraphs: input.paragraphs,
      paragraphIndexes: input.paragraphIndexes,
      start: cursor,
      total: input.paragraphs.length,
    }
    cursor += input.paragraphs.length
    return chapter
  })

  return {
    chapters: chaptersOut,
    currentIndex: chaptersOut.findIndex((chapter) => chapter.meta.id === currentId),
    length: cursor,
  }
}

/** 合并段落下标 → 窗口里的哪一章（按 start 边界二分）。 */
export function windowIndexOf(window: RealBookWindow, mergedIndex: number): number {
  const { chapters } = window
  if (chapters.length === 0) return -1
  if (mergedIndex < 0) return 0
  for (let i = chapters.length - 1; i >= 0; i -= 1) {
    if (mergedIndex >= chapters[i].start) return i
  }
  return 0
}

/** 合并段落下标 → 该页在其所属章里的局部段落下标。 */
export function localOfMerged(window: RealBookWindow, mergedIndex: number): { win: number; local: number } {
  const win = windowIndexOf(window, mergedIndex)
  const chapter = window.chapters[win]
// 负下标等越界输入夹到 0；正常输入落在 [start, start+total) 内。
  const local = win < 0 || !chapter ? 0 : Math.max(0, mergedIndex - chapter.start)
  return { win, local }
}

/** 把窗口各章的段落首尾相接成一条扁平数组（段落文本 / 原始下标 / 章内批注）。 */
export function mergedWindowParagraphs(window: RealBookWindow): {
  paragraphs: string[]
  paragraphIndexes: number[]
} {
  const paragraphs: string[] = []
  const paragraphIndexes: number[] = []
  for (const chapter of window.chapters) {
    for (let i = 0; i < chapter.paragraphs.length; i += 1) {
      paragraphs.push(chapter.paragraphs[i] ?? '')
      paragraphIndexes.push(chapter.paragraphIndexes[i] ?? -1)
    }
  }
  return { paragraphs, paragraphIndexes }
}
