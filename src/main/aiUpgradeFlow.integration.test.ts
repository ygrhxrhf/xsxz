import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBookFromBootstrap, readChat, setLibraryPath, writeChat } from './library'
import { executeEvidenceQaPipeline } from './aiEvidenceQa'
import { locateMemorySourceParagraph } from '../renderer/pages/memorySourceLocator'

const citation = {
  id: 'qa-c0001-p1', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 1,
  excerpt: '顾清在码头找到了旧账册。',
}

describe('trusted AI assistant mock flow', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('persists a whitelisted grounded answer and relocates its source after paragraph drift', async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-ai-flow-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: 'd_flow', title: '测试小说', author: '', importType: 'download', chapterTitles: ['第一章'],
    })
    const stages: string[] = []
    const result = await executeEvidenceQaPipeline({
      question: '账册在哪里？',
      taskInstruction: '只根据证据回答。',
      stopped: () => false,
      onStage: (stage) => stages.push(stage),
      rewrite: async () => ({
        text: '{"corePhrase":"账册","keywords":["码头"]}',
        json: { corePhrase: '账册', keywords: ['码头'] }, usage: { inputTokens: 4, outputTokens: 3 }, truncated: false,
      }),
      search: async () => ({ citations: [citation], uptoChapterId: 'c0001' }),
      answer: async () => ({
        text: '{"answer":"在码头。","citations":["qa-c0001-p1"]}',
        json: { answer: '在码头。', citations: [citation.id] }, usage: { inputTokens: 8, outputTokens: 5 }, truncated: false,
      }),
    })
    expect(result).toMatchObject({
      kind: 'answer', text: '在码头。', citations: [citation], uptoChapterId: 'c0001',
      usage: { inputTokens: 12, outputTokens: 8 },
    })
    expect(stages).toEqual(['rewriting', 'searching', 'requesting'])
    if (result.kind !== 'answer') throw new Error('unexpected mock result')
    await writeChat('d_flow', [
      { role: 'user', content: '账册在哪里？' },
      {
        role: 'assistant', content: result.text, citations: result.citations,
        uptoChapterId: result.uptoChapterId,
      },
    ])
    await expect(readChat('d_flow')).resolves.toMatchObject({
      version: 2,
      messages: [
        { role: 'user', content: '账册在哪里？' },
        { role: 'assistant', content: '在码头。', citations: [citation], uptoChapterId: 'c0001' },
      ],
    })
    expect(locateMemorySourceParagraph([
      '后来新增的段落。', '另一段。', '顾清在码头找到了旧账册。随后她离开。',
    ], citation.paragraphIndex, citation.excerpt)).toEqual({ paragraphIndex: 2, mode: 'relocated' })
  })
})
