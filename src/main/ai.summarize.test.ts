import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildChapterSummaryPrompt,
  buildSummarizePrompt,
  clampSummarizeChapters,
  planChapterSummaryRequest,
  summarizeUpTo,
} from './ai'
import type { ChapterStatus } from '../shared/types'

interface TestChapter {
  id: string
  index: number
  title: string
  status: ChapterStatus
  body: string
}

function ch(
  id: string,
  index: number,
  body: string,
  status: ChapterStatus = 'ready',
): TestChapter {
  return { id, index, title: `第${index}章`, status, body }
}

const CH1 = ch('c0001', 1, '开篇 READABLE_CH1 已读正文')
const CH2 = ch('c0002', 2, '后续 UNREAD_CH2 未读正文')
const CH3 = ch('c0003', 3, '再后 UNREAD_CH3 未读正文')
const THREE = [CH1, CH2, CH3]

describe('clampSummarizeChapters', () => {
  it('clamps to progress chapter 1 so later unread ids are dropped even if upto is chapter 3', () => {
    const clamped = clampSummarizeChapters(THREE, 'c0003', 'c0001')
    expect(clamped.map((c) => c.id)).toEqual(['c0001'])
    const payload = clamped.map((c) => c.body).join('\n')
    expect(payload).toContain('READABLE_CH1')
    expect(payload).not.toContain('UNREAD_CH2')
    expect(payload).not.toContain('UNREAD_CH3')
  })

  it('uses provided uptoChapterId as cutoff when there is no progress', () => {
    const clamped = clampSummarizeChapters(THREE, 'c0002', null)
    expect(clamped.map((c) => c.id)).toEqual(['c0001', 'c0002'])
    const payload = clamped.map((c) => c.body).join('\n')
    expect(payload).toContain('READABLE_CH1')
    expect(payload).toContain('UNREAD_CH2')
    expect(payload).not.toContain('UNREAD_CH3')
  })

  it('keeps at most the last 10 ready chapters inside the cutoff', () => {
    const many: TestChapter[] = []
    for (let i = 1; i <= 14; i++) {
      const status: ChapterStatus = i === 5 ? 'pending' : 'ready'
      many.push(ch(`c${String(i).padStart(4, '0')}`, i, `BODY_${i}`, status))
    }
    const clamped = clampSummarizeChapters(many, 'c0014', null)
    expect(clamped).toHaveLength(10)
    expect(clamped.every((c) => c.status === 'ready')).toBe(true)
    expect(clamped.map((c) => c.id)).toEqual([
      'c0004',
      'c0006',
      'c0007',
      'c0008',
      'c0009',
      'c0010',
      'c0011',
      'c0012',
      'c0013',
      'c0014',
    ])
    expect(clamped.some((c) => c.id === 'c0005')).toBe(false)
    expect(clamped.some((c) => c.id === 'c0001')).toBe(false)
  })

  it('does not extend past progress when the last-10 window is applied', () => {
    const many: TestChapter[] = []
    for (let i = 1; i <= 12; i++) {
      many.push(ch(`c${String(i).padStart(4, '0')}`, i, `BODY_${i}`))
    }
    const clamped = clampSummarizeChapters(many, 'c0012', 'c0003')
    expect(clamped.map((c) => c.id)).toEqual(['c0001', 'c0002', 'c0003'])
  })
})

describe('buildChapterSummaryPrompt', () => {
  it('limits a chapter to 8000 characters and asks for an 80–150 character spoiler-free summary', () => {
    const prompt = buildChapterSummaryPrompt('测试书', '第一章', `${'甲'.repeat(8000)}未送入模型`)
    expect(prompt).toContain('80–150 字')
    expect(prompt).toContain('不要剧透后续章节')
    expect(prompt).toContain('正文过长，以下内容已截断')
    expect(prompt).toContain('甲'.repeat(8000))
    expect(prompt).not.toContain('未送入模型')
  })

  it('requires confirmation from the complete request before sending the reduced 8000-character range', () => {
    const plan = planChapterSummaryRequest('测试书', '超长章', '甲'.repeat(40_000))
    expect(plan.requiresConfirmation).toBe(true)
    expect(plan.budget.originalCharacters).toBeGreaterThan(30_000)
    expect(plan.budget.sentCharacters).toBeLessThan(10_000)
    expect(plan.budget.range).toContain('前 8000 字')
    expect(plan.prompt).toContain('正文过长，以下内容已截断')
  })
})

describe('buildSummarizePrompt / summarizeUpTo payload', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('prompt payload lists only clamped ids and omits UNREAD_CH2 / UNREAD_CH3', () => {
    const clamped = clampSummarizeChapters(THREE, 'c0003', 'c0001')
    const prompt = buildSummarizePrompt('测书', clamped)
    expect(clamped.map((c) => c.id)).toEqual(['c0001'])
    expect(prompt).toContain('READABLE_CH1')
    expect(prompt).not.toContain('UNREAD_CH2')
    expect(prompt).not.toContain('UNREAD_CH3')
  })

  it('summarizeUpTo drops later bodies even if the handler passes a too-large list', async () => {
    let captured = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '摘要' } }] }),
        }
      }),
    )
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) => {
      captured = String(init?.body ?? '')
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '摘要' } }] }),
      }
    })

    const text = await summarizeUpTo(
      { baseUrl: 'https://example.invalid/v1', model: 'test-model', apiKey: 'k' },
      '测书',
      THREE,
      { uptoChapterId: 'c0003', progressChapterId: 'c0001' },
    )
    expect(text).toBe('摘要')
    expect(captured).toContain('READABLE_CH1')
    expect(captured).not.toContain('UNREAD_CH2')
    expect(captured).not.toContain('UNREAD_CH3')
  })
})
