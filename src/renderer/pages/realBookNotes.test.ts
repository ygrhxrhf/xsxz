import { describe, expect, it } from 'vitest'
import type { Annotation } from '@shared/types'
import { decorateTextWithNotes, deriveRealBookNotes, estimateInlineNoteHeight } from './realBookNotes'

function annotation(partial: Partial<Annotation> = {}): Annotation {
  return {
    id: 'a1',
    bookId: 'b1',
    chapterId: 'c1',
    kind: 'highlight',
    start: 0,
    end: 3,
    excerpt: '第一段',
    createdAt: '2026-11-09T00:00:00.000Z',
    ...partial,
  }
}

const starts = [0, 6, 12]

describe('realBookNotes（真实书籍页内批注）', () => {
  it('只取本章带话的划线，锚定到所选区间的最后一段', () => {
    const notes = deriveRealBookNotes([
      annotation({ id: 'n1', start: 1, end: 4, note: '第一段批注' }),
      annotation({ id: 'plain', start: 1, end: 3 }),
      annotation({ id: 'other', chapterId: 'c2', note: '别的章' }),
      annotation({ id: 'bookmark', kind: 'bookmark', note: '书签不算' }),
      annotation({ id: 'span', start: 1, end: 9, note: '跨段批注' }),
    ], 'c1', new Set(), starts)

    expect(notes.map((note) => note.id)).toEqual(['n1', 'span'])
    expect(notes.find((note) => note.id === 'span')).toMatchObject({ paragraph: 1, offset: 3 })
  })

  it('丢失标注与空批注不显示，同段按偏移和创建时间排序', () => {
    const notes = deriveRealBookNotes([
      annotation({ id: 'later', start: 2, end: 4, note: '后写', createdAt: '2026-11-09T00:00:02.000Z' }),
      annotation({ id: 'earlier', start: 1, end: 4, note: '先写', createdAt: '2026-11-09T00:00:01.000Z' }),
      annotation({ id: 'lost', start: 1, end: 4, note: '丢失' }),
      annotation({ id: 'blank', start: 1, end: 4, note: '   ' }),
    ], 'c1', new Set(['lost']), starts)

    expect(notes.map((note) => note.id)).toEqual(['earlier', 'later'])
  })

  it('AI 来源被保留，读者手写按 user 处理，并带上 #tag', () => {
    const notes = deriveRealBookNotes([
      annotation({ id: 'ai', note: 'AI 解释', noteSource: 'ai', tags: ['quote'] }),
      annotation({ id: 'me', note: '我的话' }),
    ], 'c1', new Set(), starts)
    expect(notes.map((note) => note.source)).toEqual(['ai', 'user'])
    expect(notes.find((note) => note.id === 'ai')?.tags).toEqual(['quote'])
    expect(notes.find((note) => note.id === 'me')?.tags).toEqual([])
  })

  it('「注」标记按段内偏移插入，且不把标记字写进正文片段', () => {
    const parts = decorateTextWithNotes('甲乙丙丁', '', [], [{ id: 'n1', offset: 2 }])
    expect(parts.map((part) => part.noteId ? 'marker' : part.text)).toEqual(['甲乙', 'marker', '丙丁'])
    expect(parts.filter((part) => !part.noteId).map((part) => part.text).join('')).toBe('甲乙丙丁')
    expect(parts.find((part) => part.noteId)?.text).toBe('')

    const atEnd = decorateTextWithNotes('甲乙', '', [], [{ id: 'n1', offset: 2 }])
    expect(atEnd.map((part) => part.noteId ? 'marker' : part.text)).toEqual(['甲乙', 'marker'])
  })

  it('高度估算随正文长度增长但不超过三行', () => {
    const short = estimateInlineNoteHeight('短', 400, 18)
    const long = estimateInlineNoteHeight('长'.repeat(400), 400, 18)
    expect(long).toBeGreaterThan(short)
    expect(estimateInlineNoteHeight('长'.repeat(1000), 400, 18)).toBe(long)
  })
})
