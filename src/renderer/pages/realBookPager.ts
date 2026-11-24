/**
 * 真实书籍的分页引擎：纯逻辑，不碰 DOM。
 *
 * 为什么不能复用 `readerPager.ts`：那边的坐标语言全是滚动像素——给定 scrollTop
 * 给出下一个 scrollTop。真实书籍要回答的是相反的问题：「给定版面尺寸，哪一段文字
 * 属于哪一页」。正文在真实书籍里没有 scrollHeight，量测只能发生在离屏容器里。
 *
 * 坐标真源仍是段落锚点（段落下标 + 段内字符偏移），与 `ReadingProgress` 同构；
 * 页码只是排版缓存，签名一变（字号、窗口缩放、单双页）就整表重算，不落盘。
 *
 * 排版规则：
 * - 段不腰斩：一段能整段放进本页就放本页；本页放不下但空页放得下，就整体挪到下一页；
 * - 超长段（高度超过一整页）例外：按行切开续排，续页片段标 `continued`；
 * - 段间距只在两段之间计一次，续排片段不再重复计。
 */

export interface RealBookLine {
  /** 行首字符偏移（含） */
  start: number
  /** 行尾字符偏移（不含） */
  end: number
}

export interface RealBookLayout {
  /** 版心高度（px）：一页能放多少行 */
  pageHeight: number
  /** 行高（px） */
  lineHeight: number
  /** 段间距（px） */
  paragraphGap: number
}

/** 页内的一段文字（一个段落的连续片段）。 */
export interface RealBookTextItem {
  kind: 'text'
  /** 段落下标（对应分页器输入数组的下标，不是原始段落下标） */
  paragraph: number
  /** 段内起始偏移（含） */
  start: number
  /** 段内结束偏移（不含） */
  end: number
  /** 是否为上一页延续下来的片段 */
  continued: boolean
  /**
   * 这个片段实际包含的断行。
   *
   * 分页器本来就能拿到量测结果；把行区间一起带出去，WebGL 纹理层就能按
   * 与 DOM 分页完全相同的断行绘制，不必再用 Canvas 重新猜一遍换行。
   * 旧调用方可以忽略，因此保持可选。
   */
  lines?: readonly RealBookLine[]
}

/**
 * 页内的一张批注卡片。
 *
 * 卡片是原子块：要么整张落在同一页，要么整体移到下一页；高度由渲染层按真实
 * 版心与三行截断量出，分页器只负责占位。
 */
export interface RealBookNoteItem {
  kind: 'note'
  /** 批注 id（对应 Reader 的 Annotation.id） */
  noteId: string
  /** 锚定段落（分页器输入下标） */
  paragraph: number
  /** 锚定段落内的结束偏移，用于批注页页首的恢复锚点 */
  anchorOffset: number
  /** 卡片占高（px，含与上文之间的间距） */
  height: number
}

/** 参考站 layout 产出的图片块：沿用同样的页内顺序。 */
export interface RealBookImageItem {
  kind: 'image'
  /** 书目录 images/ 下的文件名 */
  file: string
  /** 原图像素尺寸 */
  width: number
  height: number
  caption: string
  /** 版心里的显示高度（px） */
  displayHeight: number
  /** 锚定段落（参考站 layout 的图片块落在哪个输入段落）。 */
  paragraph: number
  /** 锚定段落内的偏移。 */
  anchorOffset: number
}

export type RealBookPageItem = RealBookTextItem | RealBookNoteItem | RealBookImageItem

/** 渲染层量好高度后交给分页器的批注块。 */
export interface RealBookNoteBlock {
  id: string
  /** 放在这个输入段落的最后一个文本片段之后 */
  paragraph: number
  /** 锚定段落内的结束偏移 */
  anchorOffset: number
  /** 卡片占高（px，含与上文之间的间距） */
  height: number
}

export interface RealBookPage {
  items: RealBookPageItem[]
  /** 页首锚点：页内第一段的起始位置 */
  paragraph: number
  offset: number
  /** 参考站 layout 的标题页/空白页。 */
  special?: 'title' | 'blank'
  /** 参考站的页码标签（正文页从 1 开始，标题/空白页为空）。 */
  label?: string
}

/** 位置锚点：段落下标 + 段内字符偏移。 */
export interface RealBookAnchor {
  paragraph: number
  offset: number
  /**
   * 整本连排（continuous）时，这个段落属于窗口里的哪一章。
   * 非连续（单章）模式不设；进度/锚点据此落到正确的章。
   */
  chapterId?: string
}

export interface RealBookPaginator {
  /** 已排好的页（快照数组；每次调用返回新数组，便于响应式更新） */
  readonly pages: RealBookPage[]
  /** 是否已排完整章 */
  readonly complete: boolean
  /** 排到至少第 targetPage 页（0-based）；返回当前页数 */
  ensure(targetPage: number): number
  /** 排完第 targetParagraph 段为止的所有页；返回当前页数 */
  ensureThroughParagraph(targetParagraph: number): number
}

/**
 * 惰性分页器：段落按需量测，排到哪里算到哪里。
 *
 * 长章有上万段，一次性量测会把首屏拖住；这里只保证「当前页往后一页」已排好，
 * 读者翻过去时再续排（与经典模式的窗口化同构）。
 */
export function createRealBookPaginator(
  paragraphs: readonly string[],
  linesOf: (text: string, index: number) => RealBookLine[],
  layout: RealBookLayout,
  notes: readonly RealBookNoteBlock[] = [],
): RealBookPaginator {
  /** 已排完的页 */
  const pages: RealBookPage[] = []
  /** 正在排的页（还没满，可能就是最后一页） */
  let pageItems: RealBookPageItem[] = []
  let used = 0
  let nextParagraph = 0
  let done = false
  /** 段落下标 → 页内批注块；段内按传入顺序渲染。 */
  const notesAfter = new Map<number, RealBookNoteBlock[]>()
  for (const note of notes) {
    if (!Number.isInteger(note.paragraph) || note.paragraph < 0) continue
    if (!Number.isFinite(note.height) || note.height <= 0) continue
    const list = notesAfter.get(note.paragraph)
    if (list) list.push(note)
    else notesAfter.set(note.paragraph, [note])
  }

  const lineHeight = Number.isFinite(layout.lineHeight) && layout.lineHeight > 0 ? layout.lineHeight : 0
  const pageHeight = Number.isFinite(layout.pageHeight) && layout.pageHeight > 0 ? layout.pageHeight : 0
  const gap = Number.isFinite(layout.paragraphGap) && layout.paragraphGap > 0 ? layout.paragraphGap : 0

  function flush(): void {
    if (!pageItems.length) return
    const first = pageItems[0]!
    pages.push({
      items: pageItems,
      paragraph: first.paragraph,
      offset: first.kind === 'text' ? first.start : first.anchorOffset,
    })
    pageItems = []
    used = 0
  }

  /** 已排出的页数（含正在排的那页）。 */
  function pageCount(): number {
    return pages.length + (pageItems.length ? 1 : 0)
  }

  /** 当前页剩余能放几行（先扣掉段间距）。 */
  function remaining(extra: number): number {
    if (lineHeight <= 0 || pageHeight <= 0) return 0
    const free = pageHeight - used - extra
    if (free < 0) return 0
    return Math.floor(free / lineHeight)
  }

  /**
   * 放一个批注块。
   *
   * 卡片不拆：当前页剩余高度不够就先把当前页封掉，让卡片从下一页开头出现。
   * 极端情况下卡片比整页还高（字体异常放大），仍强行放一页，避免死循环；
   * 真实渲染层的三行截断会把卡片高度控制在版心以内。
   */
  function placeNote(note: RealBookNoteBlock): void {
    if (pageItems.length && used + note.height > pageHeight) flush()
    pageItems.push({
      kind: 'note',
      noteId: note.id,
      paragraph: note.paragraph,
      anchorOffset: note.anchorOffset,
      height: note.height,
    })
    used += note.height
    if (used >= pageHeight) flush()
  }

  function placeNotesAfter(paragraph: number): void {
    const list = notesAfter.get(paragraph)
    if (!list?.length) return
    for (const note of list) placeNote(note)
    notesAfter.delete(paragraph)
  }

  /**
   * 批注锚点落在哪一行：取「行尾 >= 段内结束偏移」的第一行。
   * 锚点正好落在行尾时挂在这一行（而不是下一行），卡片才会贴在被划线的那行下面。
   */
  function lineForAnchor(lines: readonly RealBookLine[], offset: number): number {
    for (let i = 0; i < lines.length; i += 1) {
      if (offset <= lines[i]!.end) return i
    }
    return Math.max(0, lines.length - 1)
  }

  /**
   * 带批注的段落：按「划线所在行」切开正文，把批注块插在这一行后面。
   *
   * 不能等整段排完再插：长段跨页时，卡片会被推到段落末尾甚至下一页，
   * 读者在当前页只能看到「注」标记、看不到批注内容。切开后的后半段标
   * `continued`，CSS 会取消首行缩进，读起来仍是同一段。
   */
  function placeAnnotatedParagraph(
    paragraph: number,
    lines: readonly RealBookLine[],
    notes: readonly RealBookNoteBlock[],
  ): void {
    const notesAfterLine = new Map<number, RealBookNoteBlock[]>()
    for (const note of notes) {
      const line = lineForAnchor(lines, note.anchorOffset)
      const list = notesAfterLine.get(line)
      if (list) list.push(note)
      else notesAfterLine.set(line, [note])
    }
    notesAfter.delete(paragraph)

    let line = 0
    let started = false
    while (line < lines.length) {
      const gapNow = pageItems.length && !started ? gap : 0
      let room = remaining(gapNow)
      if (room <= 0) {
        if (pageItems.length) {
          flush()
          continue
        }
        room = 1
      }
      let take = Math.min(room, lines.length - line)
      // 一段要在批注所在行的行尾断开，先放这一行，再放卡片。
      for (let i = line; i < line + take; i += 1) {
        if (notesAfterLine.has(i)) {
          take = i - line + 1
          break
        }
      }
      const first = lines[line]!
      const last = lines[line + take - 1]!
      pageItems.push({
        kind: 'text',
        paragraph,
        start: first.start,
        end: last.end,
        continued: started,
        lines: lines.slice(line, line + take),
      })
      used += gapNow + take * lineHeight
      const after = notesAfterLine.get(line + take - 1)
      if (after?.length) {
        for (const note of after) placeNote(note)
      }
      line += take
      started = true
    }
  }

  /**
   * 排下一段；返回是否还有段落没排。
   *
   * 「段不腰斩」是这里的核心规则：一段要么整段落在某页，要么（它本身就比一整页还高）
   * 才允许按行切开续排。带批注的段落例外：必须在批注所在行的行尾断开。
   */
  function step(): void {
    if (nextParagraph >= paragraphs.length) {
      flush()
      done = true
      return
    }
    const text = paragraphs[nextParagraph] ?? ''
    const paragraphIndex = nextParagraph
    nextParagraph += 1
    const lines = linesOf(text, paragraphIndex)
    if (!lines.length) {
      placeNotesAfter(paragraphIndex)
      return
    }
    const paragraphNotes = notesAfter.get(paragraphIndex)
    if (paragraphNotes?.length) {
      placeAnnotatedParagraph(paragraphIndex, lines, paragraphNotes)
      return
    }

    const paragraphHeight = lines.length * lineHeight
    // 这一段要付的段间距：只有它不是本页第一块内容时才付。
    const extra = pageItems.length ? gap : 0

    if (paragraphHeight + extra <= pageHeight) {
      // 整段放得下（考虑段间距）：本页放得下就放本页，放不下就整体挪到下一页。
      if (remaining(extra) < lines.length) flush()
      const gapNow = pageItems.length ? gap : 0
      const first = lines[0]!
      const last = lines[lines.length - 1]!
      pageItems.push({ kind: 'text', paragraph: paragraphIndex, start: first.start, end: last.end, continued: false, lines })
      used += gapNow + paragraphHeight
      if (used >= pageHeight) flush()
      placeNotesAfter(paragraphIndex)
      return
    }

    // 超长段：一页放不下，只能按行切开续排。先把当前页收干净，让超长段从新页开头起排。
    if (pageItems.length) flush()
    let line = 0
    while (line < lines.length) {
      const continued = line > 0
      const gapNow = pageItems.length && !continued ? gap : 0
      let room = remaining(gapNow)
      if (room <= 0) {
        if (pageItems.length) {
          flush()
          continue
        }
        // 版面比一行还矮：强行放一行，避免死循环。
        room = 1
      }
      const take = Math.min(room, lines.length - line)
      const first = lines[line]!
      const last = lines[line + take - 1]!
      pageItems.push({
        kind: 'text',
        paragraph: paragraphIndex,
        start: first.start,
        end: last.end,
        continued,
        lines: lines.slice(line, line + take),
      })
      used += gapNow + take * lineHeight
      line += take
      if (line < lines.length) flush()
    }
    if (used >= pageHeight) flush()
    placeNotesAfter(paragraphIndex)
  }

  function ensureEmptyFallback(): void {
    if (pageCount() || !paragraphs.length) return
    // 版面异常（页高或行高为 0）时也给一页，别让读者看到空白书台。
    pageItems.push({ kind: 'text', paragraph: 0, start: 0, end: (paragraphs[0] ?? '').length, continued: false })
    flush()
  }

  return {
    get pages() {
      // 快照：调用方把它塞进 ref 就能触发响应式更新。正在排的那页也算一页（可能不满）。
      const out = pages.map((page) => ({ items: page.items.slice(), paragraph: page.paragraph, offset: page.offset }))
      if (pageItems.length) {
        const first = pageItems[0]!
        out.push({
          items: pageItems.slice(),
          paragraph: first.paragraph,
          offset: first.kind === 'text' ? first.start : first.anchorOffset,
        })
      }
      return out
    },
    get complete() {
      return done
    },
    ensure(targetPage: number) {
      let guard = 0
      // 排到第 targetPage 页已经封页为止：未封的尾页不算「排好」，
      // 否则读者可能拿到半页内容又被下一段顶开。
      while (!done && pages.length <= targetPage) {
        step()
        guard += 1
        if (guard > 100000) break
      }
      ensureEmptyFallback()
      return pageCount()
    },
    ensureThroughParagraph(targetParagraph: number) {
      let guard = 0
      while (nextParagraph <= targetParagraph && !done) {
        step()
        guard += 1
        if (guard > 100000) break
      }
      ensureEmptyFallback()
      return pageCount()
    },
  }
}

/** 页首锚点。 */
export function anchorForPage(pages: readonly RealBookPage[], pageIndex: number): RealBookAnchor | null {
  const page = pages[pageIndex]
  if (!page) return null
  return { paragraph: page.paragraph, offset: page.offset }
}

/** 锚点落在哪一页；锚点在正文范围外时钳到最近的页。 */
export function pageForAnchor(pages: readonly RealBookPage[], anchor: RealBookAnchor): number {
  if (!pages.length) return 0
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i]!
    const textItems = page.items.filter((item): item is RealBookTextItem => item.kind === 'text')
    const first = textItems[0]
    const last = textItems[textItems.length - 1]
    if (!first || !last) continue
    if (anchor.paragraph < first.paragraph) return Math.max(0, i - 1)
    if (anchor.paragraph > last.paragraph) continue
    for (const item of textItems) {
      if (item.paragraph === anchor.paragraph && anchor.offset >= item.start && anchor.offset < item.end) return i
    }
    return i
  }
  return pages.length - 1
}

/**
 * 按「排版输入下标 + 段内偏移」查页。
 *
 * 与 pageForAnchor 的区别：这里用的是分页器输入数组的下标（过滤后的段序列），
 * 而 pageForAnchor 用的是原始段落下标——两者不能混用，否则查到的页会整体偏移。
 */
export function findPageForInput(
  pages: readonly RealBookPage[],
  inputIndex: number,
  offset: number,
): number {
  for (let i = 0; i < pages.length; i += 1) {
    for (const item of pages[i]!.items) {
      if (item.kind !== 'text') continue
      if (item.paragraph !== inputIndex) continue
      if (offset >= item.start && offset < item.end) return i
      // 段落在这一页但偏移落在段外：取这一页，位置由调用方再微调。
      return i
    }
  }
  return pages.length ? pages.length - 1 : 0
}

/** 页码 → 进度比例（0..1），用于与经典模式的 scrollRatio 互换。 */
export function pageRatio(pageIndex: number, pageCount: number): number {
  if (!Number.isFinite(pageCount) || pageCount <= 1) return 0
  const index = Math.max(0, Math.min(pageCount - 1, Math.trunc(pageIndex)))
  return index / (pageCount - 1)
}

/** 进度比例 → 页码。 */
export function pageIndexFromRatio(ratio: number, pageCount: number): number {
  if (!Number.isFinite(pageCount) || pageCount <= 1) return 0
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  return Math.round(clamped * (pageCount - 1))
}
