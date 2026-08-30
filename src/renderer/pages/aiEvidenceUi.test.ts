import { describe, expect, it } from 'vitest'
import { normalizeEvidenceChatHistory } from './aiEvidenceUi'

const citation = {
  id: 'qa-c1-p0', chapterId: 'c1', chapterTitle: '一', paragraphIndex: 0, excerpt: '证据',
}

describe('evidence chat history boundary', () => {
  it('accepts v1 user and assistant messages while rejecting system and malformed values', () => {
    expect(normalizeEvidenceChatHistory([
      { role: 'system', content: 'hidden' }, null,
      { role: 'user', content: '问题' }, { role: 'assistant', content: '旧回答' },
      { role: 'assistant' },
    ])).toEqual([
      { role: 'user', content: '问题' }, { role: 'assistant', content: '旧回答' },
    ])
  })

  it('preserves v2 citation, cutoff, and stopped metadata', () => {
    const message = {
      role: 'assistant', content: '部分回答', citations: [citation], uptoChapterId: 'c1', stopped: true,
    }
    const normalized = normalizeEvidenceChatHistory([message])
    expect(normalized).toEqual([message])
    expect(normalized[0]).toBe(message)
  })
})
