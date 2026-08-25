import { describe, expect, it } from 'vitest'
import {
  buildCharacterCardPrompt,
  generateCharacterCard,
  parseCharacterCard,
  type CharacterMaterial,
} from './ai'

const material: CharacterMaterial = {
  bookTitle: '万古神帝',
  uptoChapterTitle: '第三章 入门',
  catalogTitles: ['第一章 前世记忆', '第二章 苏醒', '第三章 入门'],
  chapterSummaries: [{ title: '第一章 前世记忆', text: '张若尘重生回少年时代。' }],
  recentBodies: [{ title: '第三章 入门', body: '池瑶公主的身影挥之不去。' }],
}

describe('buildCharacterCardPrompt（材料红线）', () => {
  it('includes only read-up-to materials and the JSON contract', () => {
    const prompt = buildCharacterCardPrompt(material)
    expect(prompt).toContain('《万古神帝》')
    expect(prompt).toContain('第三章 入门')
    expect(prompt).toContain('第一章 前世记忆')
    expect(prompt).toContain('池瑶公主')
    expect(prompt).toContain('"foreshadows"')
    expect(prompt).toContain('不要猜测或引用未读章节')
  })

  it('never receives unread chapters from the caller', () => {
    // 调用方只应传截断后的材料；这里验证提示词不会出现未读章内容
    const prompt = buildCharacterCardPrompt({
      ...material,
      catalogTitles: material.catalogTitles.slice(0, 3),
      recentBodies: [],
      chapterSummaries: [],
    })
    expect(prompt).not.toContain('第四章')
    expect(prompt).not.toContain('未读正文片段')
  })

  it('generateCharacterCard sends the prompt through chat completion', async () => {
    let captured = ''
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      captured = String(init?.body ?? '')
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 })
    }) as typeof fetch
    try {
      await generateCharacterCard({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, material)
      const parsedBody = JSON.parse(captured) as { messages: Array<{ role: string; content: string }> }
      expect(parsedBody.messages[0].role).toBe('user')
      expect(parsedBody.messages[0].content).toContain('人物卡')
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('parseCharacterCard', () => {
  it('parses a clean JSON object', () => {
    const card = parseCharacterCard(
      '{"characters":[{"name":"张若尘","role":"主角","relations":"池瑶的未婚夫"}],"foreshadows":[{"desc":"九转轮回诀","where":"第一章","open":true}]}',
    )
    expect(card?.characters[0]).toMatchObject({ name: '张若尘', role: '主角' })
    expect(card?.foreshadows[0]).toMatchObject({ desc: '九转轮回诀', open: true })
  })

  it('tolerates markdown fences and prose around the JSON', () => {
    const fenced = '```json\n{"characters":[{"name":"池瑶"}],"foreshadows":[]}\n```'
    expect(parseCharacterCard(fenced)?.characters[0].name).toBe('池瑶')

    const prose = '好的，以下是人物卡：\n{"characters":[{"name":"王叔"}],"foreshadows":[{"desc":"口粮里的银票"}]}\n祝阅读愉快'
    expect(parseCharacterCard(prose)?.characters[0].name).toBe('王叔')
  })

  it('drops entries without name/desc and returns null on garbage', () => {
    const card = parseCharacterCard('{"characters":[{"role":"无名氏"},{"name":"有效"}],"foreshadows":[{"where":"无描述"}]}')
    expect(card?.characters.map((c) => c.name)).toEqual(['有效'])
    expect(card?.foreshadows).toEqual([])

    expect(parseCharacterCard('这不是 JSON')).toBeNull()
    expect(parseCharacterCard('')).toBeNull()
  })
})
