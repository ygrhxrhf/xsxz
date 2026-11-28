// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useInlineAsk } from './readerInlineAsk'

/**
 * 划词行内问答的行为：问一句→看流式回答→「在侧边栏继续」把整段对话搬进侧栏。
 * 这里只驱动纯状态，不挂 DOM；界面接线由 Reader 的模板测试负责。
 */
function makeInline(excerpt = '那句话是什么意思') {
  const handOff = vi.fn()
  const ask = vi.fn(async (_prompt: string) => ({ ok: true as const, jobId: 'job-inline' }))
  const explainWord = vi.fn(async (_word: string) => ({ ok: true as const, jobId: 'job-word' }))
  const inline = useInlineAsk({
    canAsk: () => true,
    excerpt: () => excerpt,
    context: () => '书籍：《验收书》\n本章：《第一章》',
    ask,
    explainWord,
    handOff,
    message: { warning: () => {} },
  })
  return { inline, handOff, ask, explainWord }
}

beforeEach(() => { vi.clearAllMocks() })

describe('划词行内问答', () => {
  it('询问 AI：打开时锁住选中原文与书籍上下文，提交把选中原文与书籍上下文一并送给书籍 agent', async () => {
    const { inline, ask, explainWord } = makeInline('玉印')
    inline.show()
    expect(inline.open.value).toBe(true)
    expect(inline.mode.value).toBe('ask')
    expect(inline.subject.value).toBe('玉印')

    inline.question.value = '这是什么'
    await inline.submit()

    expect(ask).toHaveBeenCalledTimes(1)
    expect(explainWord).not.toHaveBeenCalled()
    // vi.fn 的默认签名没有参数元组；把入参当 unknown 读，再断言成字符串。
    const sent = ask.mock.calls[0]?.[0] as unknown as string
    expect(sent).toContain('玉印')
    expect(sent).toContain('这是什么')
    expect(sent).toContain('书籍：《验收书》')
    expect(sent).toContain('本章：《第一章》')
    expect(inline.status.value).toBe('loading')
    expect(inline.jobId.value).toBe('job-inline')
  })

  it('解释字词：单纯解释所选字或词本身，不附带文章与书籍上下文，也不调用书籍 agent', async () => {
    const { inline, ask, explainWord } = makeInline('踟蹰')
    await inline.explainWord()

    expect(inline.open.value).toBe(true)
    expect(inline.mode.value).toBe('word')
    expect(inline.subject.value).toBe('踟蹰')
    expect(explainWord).toHaveBeenCalledTimes(1)
    expect(ask).not.toHaveBeenCalled()

    const sent = explainWord.mock.calls[0]?.[0] as unknown as string
    expect(sent).toBe('踟蹰')
    expect(sent).not.toContain('本章')
    expect(sent).not.toContain('验收书')
    expect(inline.status.value).toBe('loading')
    expect(inline.jobId.value).toBe('job-word')
  })

  it('流式增量只落在这张卡片上，终态记为可交棒的一问一答', async () => {
    const { inline } = makeInline()
    inline.show()
    inline.question.value = '这是什么'
    await inline.submit()

    inline.appendDelta('job-inline', '这是')
    inline.appendDelta('job-inline', '一枚玉印。')
    expect(inline.answer.value).toBe('这是一枚玉印。')

    inline.finish({ jobId: 'job-inline', ok: true, text: '这是一枚玉印。' })
    expect(inline.status.value).toBe('ready')
    expect(inline.turns.value).toEqual([{ question: '这是什么', answer: '这是一枚玉印。' }])
  })

  it('别的 jobId 的终态不会污染这张卡片', async () => {
    const { inline } = makeInline()
    inline.show()
    inline.question.value = '这是什么'
    await inline.submit()

    inline.finish({ jobId: 'job-other', ok: true, text: '别的回答' })
    expect(inline.status.value).toBe('loading')
    expect(inline.answer.value).toBe('')

    inline.appendDelta('job-other', '不该出现')
    expect(inline.answer.value).toBe('')
  })

  it('「在侧边栏中继续」把整段对话交出去并关掉卡片', async () => {
    const { inline, handOff } = makeInline()
    inline.show()
    inline.question.value = '这是什么'
    await inline.submit()
    inline.finish({ jobId: 'job-inline', ok: true, text: '这是一枚玉印。' })

    inline.continueInSidebar()
    expect(handOff).toHaveBeenCalledWith([{ question: '这是什么', answer: '这是一枚玉印。' }])
    expect(inline.open.value).toBe(false)
  })

  it('没有回答时不交棒，免得把空气搬进侧栏', () => {
    const { inline, handOff } = makeInline()
    inline.show()
    inline.continueInSidebar()
    expect(handOff).not.toHaveBeenCalled()
  })

  it('失败会显示错误并留在卡片里，不假装成功', async () => {
    const handOff = vi.fn()
    const inline = useInlineAsk({
      canAsk: () => true,
      excerpt: () => '玉印',
      context: () => '',
      ask: async () => ({ ok: false as const, message: '没有配置模型服务' }),
      handOff,
      message: { warning: () => {} },
    })
    inline.show()
    inline.question.value = '这是什么'
    await inline.submit()
    expect(inline.status.value).toBe('error')
    expect(inline.errorText.value).toBe('没有配置模型服务')
    expect(inline.turns.value).toEqual([])
  })

  it('没有选中文字时拒绝打开', () => {
    const inline = useInlineAsk({
      canAsk: () => true,
      excerpt: () => '   ',
      context: () => '',
      ask: async () => ({ ok: true as const, jobId: 'x' }),
      handOff: () => {},
      message: { warning: () => {} },
    })
    inline.show()
    expect(inline.open.value).toBe(false)
  })
})
