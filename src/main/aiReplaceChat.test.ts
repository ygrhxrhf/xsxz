import { describe, expect, it } from 'vitest'
import {
  parseReplaceChatPayload,
  REPLACE_CHAT_MAX_CLAIM_TEXT,
  REPLACE_CHAT_MAX_CLAIMS,
  REPLACE_CHAT_MAX_CONTENT,
  REPLACE_CHAT_MAX_CITATIONS,
  REPLACE_CHAT_MAX_MESSAGES,
  REPLACE_CHAT_MAX_QUOTE,
  REPLACE_CHAT_VERIFICATIONS,
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

  it('claim 的 quote 可选：合法引文原样保留，全空白的按没给处理', () => {
    const parsed = parseReplaceChatPayload({
      bookId,
      messages: [{
        role: 'assistant', content: '答案',
        claims: [{ text: '结论', citationIds: [citation.id], quote: '她把玉印交了出去' }],
      }],
    })
    expect(parsed.messages[0]!.claims).toEqual([
      { text: '结论', citationIds: [citation.id], quote: '她把玉印交了出去' },
    ])
    // 边界值仍然收下：上限是「不超过」，与证据流水线的解析上限一致
    const edge = '顾'.repeat(REPLACE_CHAT_MAX_QUOTE)
    expect(parseReplaceChatPayload({
      bookId,
      messages: [{
        role: 'assistant', content: '答案',
        claims: [{ text: '结论', citationIds: [], quote: edge }],
      }],
    }).messages[0]!.claims![0]!.quote).toBe(edge)
    // 全空白等于没给：写进记录只会让界面以为这条真带过逐字引文
    expect(parseReplaceChatPayload({
      bookId,
      messages: [{
        role: 'assistant', content: '答案',
        claims: [{ text: '结论', citationIds: [], quote: '   ' }],
      }],
    }).messages[0]!.claims![0]).not.toHaveProperty('quote')
  })

  it.each([12, null, true, { text: '顾清' }, ['顾清']])('quote 不是字符串就拒绕：%j', (quote) => {
    expect(() => parseReplaceChatPayload({
      bookId,
      messages: [{ role: 'assistant', content: '答案', claims: [{ text: '结论', citationIds: [], quote }] }],
    })).toThrow('引文必须是文本')
  })

  it('quote 超过 500 字就拒绕：那不是逐字引文，是一段重写的正文', () => {
    expect(() => parseReplaceChatPayload({
      bookId,
      messages: [{
        role: 'assistant', content: '答案',
        claims: [{ text: '结论', citationIds: [], quote: '顾'.repeat(REPLACE_CHAT_MAX_QUOTE + 1) }],
      }],
    })).toThrow(`引文超过 ${REPLACE_CHAT_MAX_QUOTE} 字`)
  })

  it.each(REPLACE_CHAT_VERIFICATIONS)('可信度标记 %s 可以写回记录', (verification) => {
    expect(parseReplaceChatPayload({
      bookId, messages: [{ role: 'assistant', content: '答案', verification }],
    }).messages[0]!.verification).toBe(verification)
  })

  /**
   * disabled 必须能写回去：读者关掉核验后产生的回答跟 verified/not_run 一样是合法记录，
   * 拒绕它会让一次删除或重问直接报错；而它跟 not_run 是两个意思，也不能被归并成同一个值。
   */
  it('已关闭核验的 disabled 能写回，且不会被归并成 not_run', () => {
    expect(parseReplaceChatPayload({
      bookId, messages: [{ role: 'assistant', content: '答案', verification: 'disabled' }],
    }).messages[0]!.verification).toBe('disabled')
    expect(REPLACE_CHAT_VERIFICATIONS).toContain('disabled')
    expect(REPLACE_CHAT_VERIFICATIONS).toContain('not_run')
  })

  it.each(['verified ', ' ok', 'VERIFIED', '', 1, null, true])('非枚举的可信度标记一律拒绝：%j', (verification) => {
    expect(() => parseReplaceChatPayload({
      bookId, messages: [{ role: 'assistant', content: '答案', verification }],
    })).toThrow('可信度标记无效')
  })

  it('droppedClaims 只接受非负整数', () => {
    expect(parseReplaceChatPayload({
      bookId, messages: [{ role: 'assistant', content: '答案', droppedClaims: 0 }],
    }).messages[0]!.droppedClaims).toBe(0)
    // 0 也必须写回：它表示「judge 跑了、一条没删」，与缺省是不同的意思
    expect(parseReplaceChatPayload({
      bookId, messages: [{ role: 'assistant', content: '答案', droppedClaims: 3 }],
    }).messages[0]!.droppedClaims).toBe(3)
  })

  it.each([-1, -0.5, 1.5, '2', null, true, NaN])('droppedClaims 非法直接拒绝：%j', (droppedClaims) => {
    expect(() => parseReplaceChatPayload({
      bookId, messages: [{ role: 'assistant', content: '答案', droppedClaims }],
    })).toThrow('已删除结论数无效')
  })
})
