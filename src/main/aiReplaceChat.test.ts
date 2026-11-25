import { describe, expect, it } from 'vitest'
import {
  parseReplaceChatPayload,
  REPLACE_CHAT_MAX_CLAIM_TEXT,
  REPLACE_CHAT_MAX_CLAIMS,
  REPLACE_CHAT_MAX_CONTENT,
  REPLACE_CHAT_MAX_CITATIONS,
  REPLACE_CHAT_MAX_MESSAGES,
} from './aiReplaceChat'

const bookId = 'd_0123456789abcdef'

const citation = {
  id: 'qa-c1-p1',
  chapterId: 'c1',
  chapterTitle: '第一章',
  paragraphIndex: 0,
  excerpt: '她把玉印交了出去。',
}

describe('ai.replaceChat 入参校验', () => {
  it('接受一段正常的问答历史并原样保留引用、结论与停止标记', () => {
    const parsed = parseReplaceChatPayload({
      bookId,
      messages: [
        { role: 'user', content: '玉印后来去了哪里？' },
        {
          role: 'assistant',
          content: '她把玉印交给了码头的账房先生。',
          citations: [citation],
          claims: [{ text: '她把玉印交给了码头的账房先生。', citationIds: [citation.id] }],
          uptoChapterId: 'c1',
          stopped: true,
        },
      ],
    })
    expect(parsed.bookId).toBe(bookId)
    expect(parsed.messages).toEqual([
      { role: 'user', content: '玉印后来去了哪里？' },
      {
        role: 'assistant',
        content: '她把玉印交给了码头的账房先生。',
        citations: [citation],
        claims: [{ text: '她把玉印交给了码头的账房先生。', citationIds: [citation.id] }],
        uptoChapterId: 'c1',
        stopped: true,
      },
    ])
  })

  it('允许清空（空数组），因为删除最后一轮就是一次整段覆盖', () => {
    expect(parseReplaceChatPayload({ bookId, messages: [] })).toEqual({ bookId, messages: [] })
  })

  it('丢掉本地思考链等非持久化字段，避免界面状态写进书库', () => {
    const parsed = parseReplaceChatPayload({
      bookId,
      messages: [{ role: 'assistant', content: '有答案。', steps: [{ label: '查目录', state: 'done' }] }],
    })
    expect(parsed.messages[0]).toEqual({ role: 'assistant', content: '有答案。' })
    expect(parsed.messages[0]).not.toHaveProperty('steps')
  })

  it.each([null, undefined, 12, 'book', [], {}])('非对象或缺少 bookId 直接拒绝：%j', (payload) => {
    expect(() => parseReplaceChatPayload(payload)).toThrow('无法覆盖问答历史')
  })

  it.each(['', '   ', 12, null])('bookId 必须是非空字符串：%j', (unsafe) => {
    expect(() => parseReplaceChatPayload({ bookId: unsafe, messages: [] })).toThrow('缺少书籍 ID')
  })

  it.each([undefined, null, 'messages', {}, 1])('messages 必须是数组：%j', (messages) => {
    expect(() => parseReplaceChatPayload({ bookId, messages })).toThrow('消息列表格式无效')
  })

  it('超过 200 条直接拒绝，并说清楚这次有多少条', () => {
    const messages = Array.from({ length: REPLACE_CHAT_MAX_MESSAGES + 1 }, () => ({ role: 'user', content: '问' }))
    expect(() => parseReplaceChatPayload({ bookId, messages })).toThrow(`一次最多只能覆盖 ${REPLACE_CHAT_MAX_MESSAGES} 条消息`)
    expect(parseReplaceChatPayload({ bookId, messages: messages.slice(0, REPLACE_CHAT_MAX_MESSAGES) }).messages)
      .toHaveLength(REPLACE_CHAT_MAX_MESSAGES)
  })

  it.each(['system', 'tool', '', null, 1])('角色只能是 user 或 assistant：%j', (role) => {
    expect(() => parseReplaceChatPayload({ bookId, messages: [{ role, content: '内容' }] }))
      .toThrow('角色只能是 user 或 assistant')
  })

  it.each([undefined, null, 12, {}, []])('正文必须是字符串：%j', (content) => {
    expect(() => parseReplaceChatPayload({ bookId, messages: [{ role: 'user', content }] })).toThrow('正文必须是文本')
  })

  it('正文超过 20000 字拒绝，边界值放行', () => {
    const long = 'a'.repeat(REPLACE_CHAT_MAX_CONTENT + 1)
    expect(() => parseReplaceChatPayload({ bookId, messages: [{ role: 'assistant', content: long }] }))
      .toThrow(`超过 ${REPLACE_CHAT_MAX_CONTENT} 字`)
    const edge = 'a'.repeat(REPLACE_CHAT_MAX_CONTENT)
    expect(parseReplaceChatPayload({ bookId, messages: [{ role: 'assistant', content: edge }] }).messages[0]!.content)
      .toHaveLength(REPLACE_CHAT_MAX_CONTENT)
  })

  it.each(['citations', 'claims'])('%s 存在时必须是数组', (field) => {
    expect(() => parseReplaceChatPayload({ bookId, messages: [{ role: 'assistant', content: '答案', [field]: {} }] }))
      .toThrow('格式无效')
  })

  it('引用超过 50 条拒绝，边界值放行', () => {
    const citations = Array.from({ length: REPLACE_CHAT_MAX_CITATIONS }, (_unused, index) => ({
      ...citation, id: `qa-c1-p${index}`,
    }))
    expect(parseReplaceChatPayload({ bookId, messages: [{ role: 'assistant', content: '答案', citations }] })
      .messages[0]!.citations).toHaveLength(REPLACE_CHAT_MAX_CITATIONS)
    expect(() => parseReplaceChatPayload({
      bookId,
      messages: [{ role: 'assistant', content: '答案', citations: [...citations, { ...citation, id: 'extra' }] }],
    })).toThrow(`引用超过 ${REPLACE_CHAT_MAX_CITATIONS} 条`)
  })

  it('结论超过 50 条、单条超过 1000 字、citationIds 不是字符串数组都拒绝', () => {
    const claims = Array.from({ length: REPLACE_CHAT_MAX_CLAIMS + 1 }, (_unused, index) => ({
      text: `结论${index}`, citationIds: [],
    }))
    expect(() => parseReplaceChatPayload({ bookId, messages: [{ role: 'assistant', content: '答案', claims }] }))
      .toThrow(`结论超过 ${REPLACE_CHAT_MAX_CLAIMS} 条`)
    const longText = 'b'.repeat(REPLACE_CHAT_MAX_CLAIM_TEXT + 1)
    expect(() => parseReplaceChatPayload({
      bookId, messages: [{ role: 'assistant', content: '答案', claims: [{ text: longText, citationIds: [] }] }],
    })).toThrow(`超过 ${REPLACE_CHAT_MAX_CLAIM_TEXT} 字`)
    expect(() => parseReplaceChatPayload({
      bookId, messages: [{ role: 'assistant', content: '答案', claims: [{ text: '结论', citationIds: [1] }] }],
    })).toThrow('引用 id 列表格式无效')
  })

  it('引用缺字段就拒绝：坏引用会让 readChat 整份历史作废', () => {
    for (const broken of [
      null, 'citation', {}, { ...citation, id: 1 }, { ...citation, paragraphIndex: -1 },
      { ...citation, chapterId: undefined },
    ]) {
      expect(() => parseReplaceChatPayload({
        bookId, messages: [{ role: 'assistant', content: '答案', citations: [broken] }],
      })).toThrow('引用格式无效')
    }
  })

  it('拒绝非法停止标记与已读截止类型', () => {
    expect(() => parseReplaceChatPayload({ bookId, messages: [{ role: 'assistant', content: '答案', stopped: 'yes' }] }))
      .toThrow('停止标记格式无效')
    expect(() => parseReplaceChatPayload({ bookId, messages: [{ role: 'assistant', content: '答案', uptoChapterId: 3 }] }))
      .toThrow('已读截止格式无效')
  })
})
