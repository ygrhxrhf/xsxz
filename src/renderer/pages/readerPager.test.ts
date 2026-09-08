import { describe, expect, it } from 'vitest'
import {
  adjacentVisualPage,
  scrollTopForVisualPage,
  visualPageCount,
  visualPageIndex,
  visualPageIndexFromRatio,
  visualPageLabel,
} from './readerPager'

describe('visualPageCount', () => {
  it('is 1 when content fits or the viewport is unusable', () => {
    expect(visualPageCount(800, 800)).toBe(1)
    expect(visualPageCount(600, 800)).toBe(1)
    expect(visualPageCount(1800, 0)).toBe(1)
    expect(visualPageCount(1800, -100)).toBe(1)
  })

  it('ceils partial last screens', () => {
    expect(visualPageCount(2400, 800)).toBe(3)
    expect(visualPageCount(2500, 1000)).toBe(3)
    expect(visualPageCount(1001, 1000)).toBe(2)
  })

  it('treats NaN / Infinity / negative heights as a single page', () => {
    expect(visualPageCount(Number.NaN, 800)).toBe(1)
    expect(visualPageCount(1800, Number.NaN)).toBe(1)
    expect(visualPageCount(Number.POSITIVE_INFINITY, 800)).toBe(1)
    expect(visualPageCount(1800, Number.POSITIVE_INFINITY)).toBe(1)
    expect(visualPageCount(Number.NEGATIVE_INFINITY, 800)).toBe(1)
    expect(visualPageCount(-500, 800)).toBe(1)
  })
})

describe('scrollTopForVisualPage', () => {
  it('uses min(i * clientHeight, max scroll) and clamps the index', () => {
    expect(scrollTopForVisualPage(0, 2500, 1000)).toBe(0)
    expect(scrollTopForVisualPage(1, 2500, 1000)).toBe(1000)
    expect(scrollTopForVisualPage(2, 2500, 1000)).toBe(1500)
    expect(scrollTopForVisualPage(9, 2500, 1000)).toBe(1500)
    expect(scrollTopForVisualPage(-3, 2500, 1000)).toBe(0)
  })

  it('caps the short last page below a full screen', () => {
    expect(scrollTopForVisualPage(2, 2500, 1000)).toBe(1500)
    expect(1500).toBeLessThan(2 * 1000)
  })

  it('returns 0 for non-finite input', () => {
    expect(scrollTopForVisualPage(Number.NaN, 2500, 1000)).toBe(0)
    expect(scrollTopForVisualPage(1, Number.POSITIVE_INFINITY, 1000)).toBe(0)
    expect(scrollTopForVisualPage(1, 2500, Number.NaN)).toBe(0)
  })
})

describe('visualPageIndex', () => {
  it('snaps mid-viewport scrollTop to the nearest page', () => {
    expect(visualPageIndex(0, 2400, 800)).toBe(0)
    expect(visualPageIndex(400, 2400, 800)).toBe(1)
    expect(visualPageIndex(399, 2400, 800)).toBe(0)
    expect(visualPageIndex(1200, 2400, 800)).toBe(2)
  })

  it('adsorbs onto a short last page rather than a full-height slot', () => {
    expect(visualPageIndex(1400, 2500, 1000)).toBe(2)
    expect(visualPageIndex(1249, 2500, 1000)).toBe(1)
    expect(visualPageIndex(1250, 2500, 1000)).toBe(2)
    expect(visualPageIndex(1500, 2500, 1000)).toBe(2)
  })

  it('returns 0 for illegal input', () => {
    expect(visualPageIndex(Number.NaN, 2400, 800)).toBe(0)
    expect(visualPageIndex(400, Number.NaN, 800)).toBe(0)
    expect(visualPageIndex(400, 2400, 0)).toBe(0)
    expect(visualPageIndex(-100, 2400, 800)).toBe(0)
  })
})

describe('visualPageIndexFromRatio', () => {
  it('maps clamped 0 / 1 / 1.5 onto first and last pages', () => {
    expect(visualPageIndexFromRatio(0, 2500, 1000)).toBe(0)
    expect(visualPageIndexFromRatio(1, 2500, 1000)).toBe(2)
    expect(visualPageIndexFromRatio(1.5, 2500, 1000)).toBe(2)
    expect(visualPageIndexFromRatio(0.5, 2500, 1000)).toBe(1)
  })

  it('is 0 when there is only one visual page', () => {
    expect(visualPageIndexFromRatio(1, 600, 800)).toBe(0)
    expect(visualPageIndexFromRatio(0.7, 800, 800)).toBe(0)
  })
})

describe('adjacentVisualPage', () => {
  it('steps by one page and stays inside [0, pageCount-1]', () => {
    expect(adjacentVisualPage(1, 1, 3)).toBe(2)
    expect(adjacentVisualPage(1, -1, 3)).toBe(0)
    expect(adjacentVisualPage(0, -1, 3)).toBe(0)
    expect(adjacentVisualPage(2, 1, 3)).toBe(2)
  })

  it('returns 0 when pageCount is not more than one page', () => {
    expect(adjacentVisualPage(4, 1, 1)).toBe(0)
    expect(adjacentVisualPage(4, -1, 0)).toBe(0)
    expect(adjacentVisualPage(1, 1, -2)).toBe(0)
  })
})

describe('visualPageLabel', () => {
  it('formats a 1-based Chinese page label and clamps x/y', () => {
    expect(visualPageLabel(0, 3)).toBe('第 1 / 3 页')
    expect(visualPageLabel(2, 3)).toBe('第 3 / 3 页')
    expect(visualPageLabel(9, 3)).toBe('第 3 / 3 页')
    expect(visualPageLabel(-1, 3)).toBe('第 1 / 3 页')
  })

  it('falls back to 第 1 / 1 页 when input is illegal', () => {
    expect(visualPageLabel(0, 0)).toBe('第 1 / 1 页')
    expect(visualPageLabel(2, -4)).toBe('第 1 / 1 页')
    expect(visualPageLabel(Number.NaN, 3)).toBe('第 1 / 1 页')
    expect(visualPageLabel(1, Number.POSITIVE_INFINITY)).toBe('第 1 / 1 页')
  })
})
