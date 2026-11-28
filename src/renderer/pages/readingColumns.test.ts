import { describe, expect, it } from 'vitest'
import {
  autoPageIntervalMs,
  columnPageCount,
  columnPageForOffset,
  columnPageIndex,
  columnScrollLeft,
} from './readingColumns'

describe('网页阅读的分栏分页几何', () => {
  it('按视口宽度数页数，最后一页不足一屏也算一页', () => {
    expect(columnPageCount(900, 900)).toBe(1)
    expect(columnPageCount(1800, 900)).toBe(2)
    expect(columnPageCount(1900, 900)).toBe(3)
    expect(columnPageCount(8044, 900)).toBe(9)
  })

  it('滚动位置换算成页码，并把页边界外的偏移吸回整页', () => {
    expect(columnPageIndex(0, 900)).toBe(0)
    expect(columnPageIndex(880, 900)).toBe(1)
    expect(columnPageIndex(-40, 900)).toBe(0)
    expect(columnScrollLeft(0, 900)).toBe(0)
    expect(columnScrollLeft(3, 900)).toBe(2700)
  })

  it('段落横向偏移落在第几页：左栏与右栏同页，下一屏才是下一页', () => {
    // 双栏 900px 视口：栏宽 338、栏距 112，第二栏起点约 450。
    expect(columnPageForOffset(0, 900)).toBe(0)
    expect(columnPageForOffset(450, 900)).toBe(0)
    expect(columnPageForOffset(899, 900)).toBe(0)
    expect(columnPageForOffset(900, 900)).toBe(1)
    expect(columnPageForOffset(2400, 900)).toBe(2)
  })

  it('非法输入退回第一页，速度档夹在 1–5', () => {
    expect(columnPageCount(Number.NaN, 900)).toBe(1)
    expect(columnPageCount(900, 0)).toBe(1)
    expect(columnPageIndex(Number.NaN, 900)).toBe(0)
    expect(columnScrollLeft(-2, 900)).toBe(0)
    expect(autoPageIntervalMs(1)).toBe(6800)
    expect(autoPageIntervalMs(5)).toBe(2000)
    expect(autoPageIntervalMs(99)).toBe(2000)
    expect(autoPageIntervalMs(Number.NaN)).toBe(4400)
  })
})
