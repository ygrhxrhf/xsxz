import { describe, expect, it } from 'vitest'
import { clampTtsRate, splitIntoParagraphs, useTts } from './useTts'

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

describe('useTts start index', () => {
  it('starts from the requested paragraph without reading earlier paragraphs', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const originalUtterance = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance')
    const spoken: Array<{ text: string; rate: number; lang: string }> = []
    class MockUtterance {
      rate = 1
      lang = ''
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(readonly text: string) {}
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { speechSynthesis: { cancel: () => {}, speak: (utterance: MockUtterance) => spoken.push(utterance) } },
    })
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: MockUtterance })
    try {
      const tts = useTts({
        paragraphs: () => ['第一段', '第二段', '第三段'],
        rate: () => 1.25,
        autoNext: () => false,
        onChapterEnd: () => {},
      })
      tts.start(1)
      expect(tts.spokenPara.value).toBe(1)
      expect(spoken.map(({ text, rate, lang }) => ({ text, rate, lang }))).toEqual([{ text: '第二段', rate: 1.25, lang: 'zh-CN' }])
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as { window?: unknown }).window
      if (originalUtterance) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', originalUtterance)
      else delete (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
    }
  })
})
