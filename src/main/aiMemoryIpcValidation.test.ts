import { describe, expect, it } from 'vitest'
import {
  parseMemoryBookPayload,
  parseMemoryMarkPayload,
  parseMemoryRunPayload,
} from './aiMemoryIpcValidation'

const bookId = 'd_0123456789abcdef'

describe('memory IPC payload boundary', () => {
  it('accepts only production book and chapter id formats', () => {
    expect(parseMemoryBookPayload({ bookId })).toEqual({ bookId })
    expect(parseMemoryBookPayload({ bookId: 'i_fedcba9876543210' })).toEqual({ bookId: 'i_fedcba9876543210' })
    expect(parseMemoryRunPayload({ bookId, uptoChapterId: 'c0001' })).toEqual({ bookId, uptoChapterId: 'c0001' })
  })

  it.each([
    '../outside', '/tmp/outside', 'C:\\outside', 'd_0123/../../x', 'd_0123456789abcdeg',
    '', null, undefined, 12, {},
  ])('rejects an unsafe book id before any library call: %j', (unsafe) => {
    expect(() => parseMemoryBookPayload({ bookId: unsafe })).toThrow('书籍不存在')
    expect(() => parseMemoryRunPayload({ bookId: unsafe, uptoChapterId: 'c0001' })).toThrow('书籍不存在')
  })

  it.each(['../c0001', '/c0001', 'c1', 'c0001/other', '', null, 1])
  ('rejects an unsafe chapter cutoff: %j', (unsafe) => {
    expect(() => parseMemoryRunPayload({ bookId, uptoChapterId: unsafe })).toThrow('章节不存在')
  })

  it('accepts exactly four own kind literals and stable item ids', () => {
    for (const kind of ['character', 'relation', 'foreshadow', 'event'] as const) {
      expect(parseMemoryMarkPayload({ bookId, kind, itemId: `${kind}-0123456789abcdef` })).toEqual({
        bookId, kind, itemId: `${kind}-0123456789abcdef`,
      })
    }
  })

  it.each(['constructor', '__proto__', 'toString', 'characters', '', null, 1])
  ('strictly rejects inherited or unknown kind values: %j', (kind) => {
    expect(() => parseMemoryMarkPayload({ bookId, kind, itemId: 'character-0123456789abcdef' }))
      .toThrow('记忆类型无效')
  })

  it.each(['../item', 'character-x', 'relation-0123456789abcdef', '', null, 1])
  ('rejects an unsafe or kind-mismatched memory item id: %j', (itemId) => {
    expect(() => parseMemoryMarkPayload({ bookId, kind: 'character', itemId }))
      .toThrow('记忆条目不存在')
  })
})
