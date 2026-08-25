import { describe, expect, it } from 'vitest'
import { clampTtsRate, splitIntoParagraphs } from './useTts'

describe('splitIntoParagraphs', () => {
  it('splits on blank lines the same way the reader renders', () => {
    const body = '第一段。\n\n第二段。\n\n\n第三段。'
    expect(splitIntoParagraphs(body)).toEqual(['第一段。', '第二段。', '第三段。'])
  })

  it('drops empty segments and keeps single-line bodies as one paragraph', () => {
    expect(splitIntoParagraphs('只有一段')).toEqual(['只有一段'])
    expect(splitIntoParagraphs('\n\n\n')).toEqual([])
    expect(splitIntoParagraphs('')).toEqual([])
  })
})

describe('clampTtsRate', () => {
  it('keeps rate inside 0.5–2 and falls back to 1 for junk', () => {
    expect(clampTtsRate(1)).toBe(1)
    expect(clampTtsRate(0.2)).toBe(0.5)
    expect(clampTtsRate(5)).toBe(2)
    expect(clampTtsRate(Number.NaN)).toBe(1)
    expect(clampTtsRate(Number.POSITIVE_INFINITY)).toBe(1)
  })
})
