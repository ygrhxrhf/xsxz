import { afterEach, describe, expect, it, vi } from 'vitest'
import { splitSpeechChunks, useTts } from './useTts'

type MockUtterance = { text: string; onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null }

function setup(paragraphs = ['第一段。', '第二段。']) {
  const utterances: MockUtterance[] = []
  const synthesis = { cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    getVoices: () => [], speak: (u: MockUtterance) => utterances.push(u) }
  class Utterance {
    onend: (() => void) | null = null
    onerror: ((event: { error: string }) => void) | null = null
    rate = 1
    lang = ''
    constructor(readonly text: string) {}
  }
  vi.stubGlobal('window', { speechSynthesis: synthesis })
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
  const onChapterEnd = vi.fn()
  const tts = useTts({ paragraphs: () => paragraphs, rate: () => 1, autoNext: () => true, onChapterEnd })
  return { tts, utterances, synthesis, onChapterEnd }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('TTS playback state', () => {
  it('cuts long text at sentences without dropping characters', () => {
    const text = '甲'.repeat(300) + '。' + '乙'.repeat(300)
    const chunks = splitSpeechChunks(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every((chunk) => chunk.length <= 480)).toBe(true)
    expect(chunks[0]?.endsWith('。')).toBe(true)
  })

  it('ignores late callbacks after restart and does not silently skip real errors', () => {
    const { tts, utterances } = setup()
    tts.start(0)
    const old = utterances[0]!
    tts.start(1)
    old.onend?.()
    expect(utterances.map((item) => item.text)).toEqual(['第一段。', '第二段。'])
    utterances[1]!.onerror?.({ error: 'network' })
    expect(tts.paused.value).toBe(true)
    expect(tts.error.value).toContain('network')
    expect(utterances).toHaveLength(2)
    tts.retry()
    expect(utterances[2]!.text).toBe('第二段。')
  })

  it('pauses the sleep countdown and stops after the current paragraph', () => {
    vi.useFakeTimers()
    const { tts, utterances } = setup()
    tts.setSleepMinutes(10)
    tts.start()
    vi.advanceTimersByTime(5 * 60_000)
    tts.pause()
    vi.advanceTimersByTime(20 * 60_000)
    expect(tts.sleepAfterParagraph.value).toBe(false)
    tts.resume()
    vi.advanceTimersByTime(5 * 60_000)
    expect(tts.sleepAfterParagraph.value).toBe(true)
    utterances[0]!.onend?.()
    expect(tts.speaking.value).toBe(false)
    expect(utterances).toHaveLength(1)
  })

  it('continues to the next chapter only after the last paragraph', () => {
    const { tts, utterances, onChapterEnd } = setup()
    tts.start()
    utterances[0]!.onend?.()
    expect(utterances[1]!.text).toBe('第二段。')
    expect(onChapterEnd).not.toHaveBeenCalled()
    utterances[1]!.onend?.()
    expect(onChapterEnd).toHaveBeenCalledTimes(1)
  })
})
