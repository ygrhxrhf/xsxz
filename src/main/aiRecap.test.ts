import { describe, expect, it } from 'vitest'
import type { AiMemoryFile, AiSummaries } from '../shared/types'
import { isAiMemoryFile } from './library'
import { planAiRecap, selectRecapMaterials, validateAiRecapOutput } from './aiRecap'
import { countTextCharacters } from './aiBudget'

const chapters = [
  { id: 'c0001', index: 1, title: '第一章', status: 'ready' },
  { id: 'c0002', index: 2, title: '第二章', status: 'ready' },
  { id: 'c0003', index: 3, title: '第三章', status: 'ready' },
  { id: 'c0004', index: 4, title: '第四章', status: 'failed' },
]

const stored: AiSummaries = {
  version: 2,
  byChapter: {
    c0001: '摘要一 READ_ONE', c0002: '摘要二 READ_TWO', c0003: '摘要三 UNREAD_THREE', c0004: '失败章摘要',
  },
  storySoFar: { uptoChapterId: 'c0001', text: '旧前情', updatedAt: '2026-01-01T00:00:00.000Z' },
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function memory(): AiMemoryFile {
  return {
    version: 1,
    uptoChapterId: 'c0003',
    characters: [{
      id: 'character-0123456789abcdef', name: '顾清', aliases: [], role: '主角', status: '调查中',
      summary: '正常人物记忆', accuracy: 'normal', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev-c0001-p0-s1', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '甲'.repeat(80) }],
    }, {
      id: 'character-1123456789abcdef', name: '待复核者', aliases: [], role: '未知', status: '未知',
      summary: 'REVIEW_SECRET', accuracy: 'review', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev-c0001-p0-s2', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '乙'.repeat(80) }],
    }],
    relations: [{
      id: 'relation-0123456789abcdef', from: '顾清', to: '顾远', relation: '父女', status: '失联',
      summary: 'UNREAD_MEMORY', accuracy: 'normal', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev-c0003-p0-s1', chapterId: 'c0003', chapterTitle: '第三章', paragraphIndex: 0, excerpt: '丙'.repeat(80) }],
    }],
    foreshadows: [{
      id: 'foreshadow-0123456789abcdef', desc: '旧账册', status: 'uncertain', summary: 'UNCERTAIN_SECRET',
      accuracy: 'uncertain', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev-c0001-p0-s3', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '丁'.repeat(80) }],
    }],
    events: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('recap material selection', () => {
  it('clamps to progress, reads only stored summaries, and excludes failed/unread entries', () => {
    const result = selectRecapMaterials(chapters, 'c0004', 'c0002', stored, memory())
    expect(result.uptoChapterId).toBe('c0002')
    expect(result.summaries.map((item) => item.chapterId)).toEqual(['c0001', 'c0002'])
    expect(JSON.stringify(result)).toContain('READ_ONE')
    expect(JSON.stringify(result)).not.toContain('UNREAD_THREE')
    expect(JSON.stringify(result)).not.toContain('失败章摘要')
  })

  it('includes only normal memory whose every source is within the current ready cutoff', () => {
    const result = selectRecapMaterials(chapters, 'c0004', 'c0002', stored, memory())
    expect(result.memoryFacts.map((item) => item.id)).toEqual(['character-0123456789abcdef'])
    const payload = JSON.stringify(result.memoryFacts)
    expect(payload).toContain('正常人物记忆')
    expect(payload).not.toContain('REVIEW_SECRET')
    expect(payload).not.toContain('UNCERTAIN_SECRET')
    expect(payload).not.toContain('UNREAD_MEMORY')
    expect(payload).not.toContain('甲'.repeat(80))
  })

  it('requires a real reading progress and requested chapter', () => {
    expect(() => selectRecapMaterials(chapters, 'missing', 'c0002', stored, null)).toThrow('章节不存在')
    expect(() => selectRecapMaterials(chapters, 'c0002', null, stored, null)).toThrow('还没有阅读进度')
  })
})

describe('three-length recap planning', () => {
  const materials = selectRecapMaterials(chapters, 'c0002', 'c0002', stored, memory())

  it.each([
    ['short', 200, 160, 240],
    ['standard', 500, 400, 600],
    ['detailed', 1000, 800, 1200],
  ] as const)('freezes %s target and ±20%% output bounds', (length, target, min, max) => {
    const plan = planAiRecap('测试书', '整理前情。', length, materials)
    expect(plan).toMatchObject({ targetCharacters: target, minCharacters: min, maxCharacters: max })
    expect(plan.prompt).toContain(`目标约 ${target} 字`)
    expect(plan.prompt).toContain(`${min}–${max} 个 Unicode 字符`)
    expect(plan.prompt).toContain('不得采纳待复核或存疑记忆')
    expect(plan.prompt).not.toContain('旧前情')
  })

  it('keeps every material without confirmation when the complete prompt is within budget', () => {
    const snapshot = structuredClone(materials)
    const plan = planAiRecap('测试书', '整理前情。', 'standard', materials)
    expect(plan.requiresConfirmation).toBe(false)
    expect(plan.summaries).toHaveLength(materials.summaries.length)
    expect(plan.memoryFacts).toHaveLength(materials.memoryFacts.length)
    expect(plan.budget.originalCharacters).toBe(plan.budget.sentCharacters)
    expect(materials).toEqual(snapshot)
  })

  it('rejects empty saved material before any model call', () => {
    const empty = selectRecapMaterials(chapters, 'c0002', 'c0002', { ...stored, byChapter: {} }, null)
    expect(() => planAiRecap('测试书', '整理前情。', 'standard', empty)).toThrow('还没有可整理的材料')
  })

  it('hard-limits the complete prompt, reduces materials deterministically, and requires confirmation', () => {
    const manySummaries = Array.from({ length: 240 }, (_, index) => ({
      chapterId: `c${String(index + 1).padStart(4, '0')}`,
      title: `第${index + 1}章`,
      text: `${index}-` + '摘要'.repeat(100),
    }))
    const plan = planAiRecap('长书', '整理前情。', 'detailed', {
      uptoChapterId: 'c0240', summaries: manySummaries, memoryFacts: [],
    })
    expect(plan.requiresConfirmation).toBe(true)
    expect(countTextCharacters(plan.prompt)).toBeLessThanOrEqual(30_000)
    expect(plan.budget.originalCharacters).toBeGreaterThan(30_000)
    expect(plan.summaries.length).toBeLessThan(manySummaries.length)
    expect(plan.summaries.at(-1)?.chapterId).toBe('c0240')
    expect(plan.budget.range).toContain(`已选 ${plan.summaries.length} 章已存摘要`)
  })

  it('rejects fixed/custom requirements that leave no material room', () => {
    expect(() => planAiRecap('测试书', '要求'.repeat(20_000), 'standard', materials))
      .toThrow('AI 请求固定内容过长，无法在 30000 字预算内发送')
  })
})

describe('recap output validation', () => {
  it.each([
    ['short', 160, 240], ['standard', 400, 600], ['detailed', 800, 1200],
  ] as const)('accepts %s only within its Unicode bounds', (length, min, max) => {
    expect(validateAiRecapOutput('😀'.repeat(min), length)).toHaveLength(min * 2)
    expect(validateAiRecapOutput('甲'.repeat(max), length)).toHaveLength(max)
    expect(() => validateAiRecapOutput('甲'.repeat(min - 1), length)).toThrow('原有前情未改变')
    expect(() => validateAiRecapOutput('甲'.repeat(max + 1), length)).toThrow('原有前情未改变')
  })

  it('keeps produced memory schema valid in its fixture', () => {
    expect(isAiMemoryFile(memory())).toBe(true)
  })
})
