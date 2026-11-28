import { describe, expect, it } from 'vitest'
import { createTierSenseAdvisor, type TierSenseClient } from './tierSense'

function client(overrides: Partial<TierSenseClient> = {}): TierSenseClient {
  return {
    difficulty: async () => null,
    compress: async () => ({ compressed: '压缩后的正文' }),
    memoryDecide: async () => null,
    ping: async () => 'ok',
    ...overrides,
  }
}

describe('TierSense 压缩', () => {
  it('只替换带正文的那条消息，system 规则原样保留', async () => {
    const advisor = createTierSenseAdvisor(client(), 'chapterNote', () => {})
    const messages = [
      { role: 'system' as const, content: '固定规则：只返回 JSON。' },
      { role: 'user' as const, content: `用户任务要求：整理笔记。\n\n正文：${'长'.repeat(200)}` },
    ]
    const advice = await advisor!.consult!({
      prompt: messages.map((message) => message.content).join('\n'),
      task: 'chapterNote',
      messages,
    })
    expect(advice?.messages?.[0]).toEqual({ role: 'system', content: '固定规则：只返回 JSON。' })
    expect(advice?.messages?.[1]?.content).toContain('压缩后的正文')
    expect(advice?.messages?.[1]?.content).toContain('用户任务要求：整理笔记。')
    expect(advice?.messages).toHaveLength(2)
  })

  it('没有原始消息时才退回单条 user 消息', async () => {
    const advisor = createTierSenseAdvisor(client(), 'chapterNote', () => {})
    const advice = await advisor!.consult!({
      prompt: `用户任务要求：整理笔记。\n\n正文：${'长'.repeat(200)}`,
      task: 'chapterNote',
    })
    expect(advice?.messages).toEqual([{ role: 'user', content: expect.stringContaining('压缩后的正文') }])
  })
})
