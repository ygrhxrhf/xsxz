import { describe, expect, it } from 'vitest'

import { buildCraftNoteMarkdown, craftNoteTitle } from './craftMarkdown'
import type { AiChapterNote, AiMemoryFile, Annotation } from '../shared/types'

const book = {
  id: 'd_1',
  title: '长夜行',
  author: '某人',
  status: 'ready' as const,
  chapters: [
    { id: 'c0001', index: 1, title: '第一章 归来', file: 'chapters/0001.json', status: 'ready' as const },
    { id: 'c0002', index: 2, title: '第二章 铜锁', file: 'chapters/0002.json', status: 'ready' as const },
  ],
  progress: { chapterId: 'c0002', scrollRatio: 0.42, updatedAt: '2026-11-01T00:00:00.000Z' },
}

function note(chapterId: string, text: string, userEdited = false): AiChapterNote {
  return { chapterId, bodyHash: 'h', text, updatedAt: '2026-11-02T00:00:00.000Z', userEdited }
}

function memory(overrides: Partial<AiMemoryFile> = {}): AiMemoryFile {
  return {
    version: 1,
    characters: [
      {
        id: 'ch-1',
        name: '顾清',
        aliases: ['阿清'],
        role: '主角',
        status: '正在找账册',
        summary: '顾家长女，回旧宅查父亲失踪的线索。',
        sources: [],
        accuracy: 'normal',
        updatedAt: '2026-11-02T00:00:00.000Z',
      },
    ],
    relations: [
      { id: 'r-1', from: '顾清', to: '沈砚', relation: '师徒', status: '稳定', sources: [], accuracy: 'normal', updatedAt: '2026-11-02T00:00:00.000Z' },
    ],
    foreshadows: [
      { id: 'f-1', desc: '铜锁上的划痕', status: 'open', sources: [], accuracy: 'normal', updatedAt: '2026-11-02T00:00:00.000Z' },
      { id: 'f-2', desc: '父亲的账册', status: 'resolved', sources: [], accuracy: 'normal', updatedAt: '2026-11-02T00:00:00.000Z' },
    ],
    events: [
      { id: 'e-1', title: '码头交接', participants: ['顾清', '沈砚'], result: '账册易手', sources: [], accuracy: 'normal', updatedAt: '2026-11-02T00:00:00.000Z' },
    ],
    updatedAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  } as AiMemoryFile
}

function annotation(overrides: Partial<Annotation>): Annotation {
  return {
    id: 'a-1',
    bookId: 'd_1',
    chapterId: 'c0001',
    kind: 'highlight',
    start: 0,
    end: 6,
    excerpt: '风从山口压下来',
    createdAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  } as Annotation
}

describe('craftNoteTitle', () => {
  it('加书名号并限长 80', () => {
    expect(craftNoteTitle('长夜行')).toBe('《长夜行》')
    expect(craftNoteTitle('  ')).toBe('《未命名书籍》')
    expect(craftNoteTitle('长'.repeat(200)).length).toBe(80)
  })
})

describe('buildCraftNoteMarkdown', () => {
  it('没有材料时只留标题与页首，不写空标题', () => {
    const markdown = buildCraftNoteMarkdown({ book })
    expect(markdown.startsWith('# 《长夜行》')).toBe(true)
    expect(markdown).toContain('作者：某人')
    expect(markdown).toContain('进度：第 2 章 · 42%')
    expect(markdown).not.toContain('## 全书概览')
    expect(markdown).not.toContain('## 人物')
    expect(markdown).not.toContain('## 划线批注')
  })

  it('进度、人物、关系、伏笔、事件都在', () => {
    const markdown = buildCraftNoteMarkdown({
      book,
      overview: '主角回乡查案。',
      memory: memory(),
    })
    expect(markdown).toContain('## 全书概览\n\n主角回乡查案。')
    expect(markdown).toContain('### 顾清（主角）')
    expect(markdown).toContain('- 别名：阿清')
    expect(markdown).toContain('- 顾清 — 沈砚：师徒 · 稳定')
    expect(markdown).toContain('- 铜锁上的划痕（已埋未解）')
    expect(markdown).toContain('- 父亲的账册（已回收）')
    expect(markdown).toContain('- 码头交接（顾清、沈砚） — 账册易手')
  })

  it('章节笔记按书序而不是文件序，AI 生成的带标注', () => {
    const markdown = buildCraftNoteMarkdown({
      book,
      notes: [note('c0002', '第二章记下的事'), note('c0001', '第一章记下的事')],
    })
    const first = markdown.indexOf('第一章记下的事')
    const second = markdown.indexOf('第二章记下的事')
    expect(first).toBeGreaterThan(-1)
    expect(first).toBeLessThan(second)
    expect(markdown).toContain('### 第一章 归来')
    expect(markdown).toContain('（AI 生成）\n第二章记下的事')
  })

  it('读者手写的笔记不挂 AI 标注', () => {
    const markdown = buildCraftNoteMarkdown({ book, notes: [note('c0001', '我自己写的', true)] })
    expect(markdown).toContain('我自己写的')
    expect(markdown).not.toContain('（AI 生成）')
  })

  it('划线按书序排，带批注与标签；书签另起一行', () => {
    const markdown = buildCraftNoteMarkdown({
      book,
      annotations: [
        annotation({ id: 'a-2', chapterId: 'c0002', excerpt: '铜锁发亮', note: '这里反复出现', noteSource: 'ai', tags: ['物件'] }),
        annotation({ id: 'a-1', chapterId: 'c0001', excerpt: '风从山口压下来', note: '写得好' }),
        annotation({ id: 'a-3', kind: 'bookmark', chapterId: 'c0002', excerpt: '', note: '读到这' }),
      ],
    })
    const first = markdown.indexOf('风从山口压下来')
    const second = markdown.indexOf('铜锁发亮')
    expect(first).toBeLessThan(second)
    expect(markdown).toContain('> 铜锁发亮')
    expect(markdown).toContain('这里反复出现（AI 解释）')
    expect(markdown).toContain('#物件')
    expect(markdown).toContain('**第二章 铜锁** 书签：读到这')
  })

  it('空笔记与空批注不进正文', () => {
    const markdown = buildCraftNoteMarkdown({
      book,
      notes: [note('c0001', '   ')],
      annotations: [],
      overview: '   ',
    })
    expect(markdown).not.toContain('## 章节笔记')
    expect(markdown).not.toContain('## 划线批注')
  })
})
