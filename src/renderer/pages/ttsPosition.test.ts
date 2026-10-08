import { describe, expect, it } from 'vitest'
import { ttsBodyHash, validTtsPosition } from './ttsPosition'

describe('listening position', () => {
  it('accepts the same chapter and body and rejects edited or missing paragraphs', () => {
    const body = '第一段\n\n第二段'
    const position = { chapterId: 'c1', paragraphIndex: 1, bodyHash: ttsBodyHash(body), updatedAt: new Date().toISOString() }
    expect(validTtsPosition(position, 'c1', body)).toBe(true)
    expect(validTtsPosition(position, 'c2', body)).toBe(false)
    expect(validTtsPosition(position, 'c1', '第一段\n\n新第二段')).toBe(false)
    expect(validTtsPosition({ ...position, paragraphIndex: 2 }, 'c1', body)).toBe(false)
  })
})
