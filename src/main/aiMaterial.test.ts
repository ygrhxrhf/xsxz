import { describe, expect, it } from 'vitest'
import type { AiMemoryFile } from '../shared/types'
import { addBookUsage, correctCharacterAliases, correctMemorySummary, describeMaterialCoverage, preserveUserMemoryCorrections, seedMemoryBeforeChapter, selectRebuildBatches } from './aiMaterial'

function memory(): AiMemoryFile {
  return {
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    characters: [{
      id: 'character-1',
      name: '顾清',
      aliases: ['阿清'],
      role: '主角',
      status: '追查',
      summary: '回到旧宅。',
      accuracy: 'normal',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [
        { id: 's1', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 1, excerpt: '顾清' },
        { id: 's2', chapterId: 'c0004', chapterTitle: '第四章', paragraphIndex: 2, excerpt: '阿清' },
      ],
    }],
    relations: [],
    foreshadows: [],
    events: [],
  }
}

describe('reader corrections and material coverage', () => {
  it('replaces aliases, drops the canonical name, and reports affected chapters', () => {
    const result = correctCharacterAliases(memory(), 'character-1', [' 账房先生 ', '顾清', '账房先生', ''], '2026-02-01T00:00:00.000Z')
    expect(result.character.aliases).toEqual(['账房先生'])
    expect(result.affectedChapterIds).toEqual(['c0001', 'c0004'])
    expect(result.memory.updatedAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('rejects an unknown item and an overlong alias', () => {
    expect(() => correctCharacterAliases(memory(), 'missing', ['阿清'], 'now')).toThrow('记忆条目不存在')
    expect(() => correctCharacterAliases(memory(), 'character-1', ['超'.repeat(21)], 'now')).toThrow('20 字')
  })

  it('retains reader corrections when rebuilding from an affected source chapter', () => {
    const original = memory()
    correctCharacterAliases(original, 'character-1', ['账房先生'], 't1')
    correctMemorySummary(original, 'character', 'character-1', '用户核对后的说明。', 't1')
    const chapters = [
      { id: 'c0001', index: 1, title: '第一章', status: 'ready' },
      { id: 'c0002', index: 2, title: '第二章', status: 'ready' },
      { id: 'c0004', index: 4, title: '第四章', status: 'ready' },
    ]
    const seed = seedMemoryBeforeChapter(original, chapters, 'c0004')
    expect(seed?.characters[0]?.sources.map((source) => source.chapterId)).toEqual(['c0001'])
    const regenerated = memory()
    regenerated.characters[0]!.id = 'character-new-source'
    regenerated.characters[0]!.summary = '模型生成的新说法。'
    regenerated.characters[0]!.aliases = ['阿清']
    const result = preserveUserMemoryCorrections(regenerated, original)
    expect(result.characters[0]).toMatchObject({
      summary: '用户核对后的说明。', aliases: ['账房先生'], userEditedSummary: true, userEditedAliases: true,
    })
    const missing = preserveUserMemoryCorrections({ ...memory(), characters: [] }, original)
    expect(missing.characters[0]).toMatchObject({ summary: '用户核对后的说明。', accuracy: 'review' })
  })

  it('reprocesses only the affected chapter through the read cutoff', () => {
    const chapters = Array.from({ length: 9 }, (_, index) => ({ id: `c${String(index + 1).padStart(4, '0')}`, index: index + 1 }))
    expect(selectRebuildBatches(chapters.slice(0, 8), 'c0003', chapters).map((batch) => batch.map((chapter) => chapter.id)))
      .toEqual([['c0003', 'c0004', 'c0005', 'c0006', 'c0007'], ['c0008']])
    expect(() => selectRebuildBatches(chapters.slice(0, 8), 'c0009', chapters)).toThrow('已读范围')
  })

  it('stops coverage at stored progress and lists ready chapters without summaries', () => {
    const coverage = describeMaterialCoverage([
      { id: 'c0001', index: 1, title: '第一章', status: 'ready' },
      { id: 'c0002', index: 2, title: '第二章', status: 'failed' },
      { id: 'c0003', index: 3, title: '第三章', status: 'ready' },
      { id: 'c0004', index: 4, title: '第四章', status: 'ready' },
    ], 'c0003', new Set(['c0001']))
    expect(coverage).toMatchObject({
      uptoChapterId: 'c0003',
      uptoChapterTitle: '第三章',
      readyChapters: 2,
      summarizedChapters: 1,
    })
    expect(coverage?.missing).toEqual([{ chapterId: 'c0003', title: '第三章' }])
  })

  it('returns no coverage before the reader has progress', () => {
    expect(describeMaterialCoverage([], null, new Set())).toBeNull()
  })

  it('accumulates token counts without inventing a price', () => {
    const first = addBookUsage(null, { inputTokens: 10, outputTokens: 4 }, 't1')
    const second = addBookUsage(first, { inputTokens: 3, cacheHitTokens: 2 }, 't2')
    expect(second).toEqual({
      calls: 2, inputTokens: 13, outputTokens: 4, cacheHitTokens: 2, cacheMissTokens: 0, updatedAt: 't2',
    })
  })
})
