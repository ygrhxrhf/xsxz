// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { measureLines } from './realBookMeasure'

/**
 * 量断行的回归测试：jsdom 没有排版，这里用 Range 的几何桩模拟
 * 「按宽度断行、首行缩进 N 个字」。
 *
 * 要防的是这个 bug：量测容器漏掉正文的 2em 首行缩进，首行多盛两个字，
 * 行数比实际渲染少一行，分页器把多出来的那行排到栏底之外，被 overflow 裁掉。
 */
const FONT = 18
const LINE = FONT * 1.8
const WIDTH = 640

const firstLineChars = (indentPx: number): number => Math.max(1, Math.floor((WIDTH - indentPx) / FONT))
const lineChars = (): number => Math.max(1, Math.floor(WIDTH / FONT))

/** 模拟：同一段文字在给定首行缩进下要占几行。 */
function modeledLines(text: string, indentPx: number): number {
  const first = firstLineChars(indentPx)
  if (text.length <= first) return 1
  return 1 + Math.ceil((text.length - first) / lineChars())
}

const originals = {
  rects: Range.prototype.getClientRects,
  box: Range.prototype.getBoundingClientRect,
}

function indentPxOf(range: Range): number {
  const el = range.startContainer.parentElement
  const raw = el?.style.textIndent ?? ''
  if (!raw) return 0
  const size = Number.parseFloat(el?.style.fontSize ?? '') || FONT
  return raw.trim().endsWith('em') ? (Number.parseFloat(raw) || 0) * size : Number.parseFloat(raw) || 0
}

function installLayoutStub(): void {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value(this: Range) {
      const text = this.startContainer.textContent ?? ''
      const count = modeledLines(text, indentPxOf(this))
      const rects = Array.from({ length: count }, (_, i) => ({ top: i * LINE, height: LINE, width: WIDTH }))
      return rects as unknown as DOMRectList
    },
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Range) {
      const text = this.startContainer.textContent ?? ''
      const indent = indentPxOf(this)
      const first = firstLineChars(indent)
      const offset = this.startOffset
      const index = offset < first ? 0 : 1 + Math.floor((offset - first) / lineChars())
      return { top: index * LINE, height: LINE, width: WIDTH } as unknown as DOMRect
    },
  })
}

function measureEl(textIndent?: string): HTMLElement {
  const el = document.createElement('div')
  el.style.width = `${WIDTH}px`
  el.style.fontSize = `${FONT}px`
  el.style.lineHeight = `${LINE}px`
  if (textIndent) el.style.textIndent = textIndent
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: originals.rects })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: originals.box })
  document.body.innerHTML = ''
})

describe('measureLines（量断行）', () => {
  it('段落正好卡在行边界时：按 2em 首行缩进计算，行数不少于渲染行数', () => {
    installLayoutStub()
    // 无缩进正好两行整——这正是「卡在行边界」的段落
    const text = '字'.repeat(lineChars() * 2)
    const renderedLines = modeledLines(text, FONT * 2)
    expect(renderedLines).toBe(3)
    expect(modeledLines(text, 0)).toBe(2)

    const lines = measureLines(text, measureEl('2em'))
    expect(lines.length).toBeGreaterThanOrEqual(renderedLines)
    // 行区间必须首尾相接、覆盖全文：少一行就会在这里露馅
    expect(lines[0]!.start).toBe(0)
    expect(lines[lines.length - 1]!.end).toBe(text.length)
  })

  it('量测容器漏掉首行缩进时少算一行：测试能抓住这个回归', () => {
    installLayoutStub()
    const text = '字'.repeat(lineChars() * 2)
    const withoutIndent = measureLines(text, measureEl())

    expect(withoutIndent.length).toBe(modeledLines(text, 0))
    expect(withoutIndent.length).toBeLessThan(modeledLines(text, FONT * 2))
  })
})
