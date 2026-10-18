import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Annotation } from '@shared/types'
import { useReaderMarks } from './readerMarks'
import type { ReaderMarksDeps } from './readerMarks'

const BODY = '第一段文字。\n\n第二段文字。'

function annotation(partial: Partial<Annotation> = {}): Annotation {
  return {
    id: 'a1', bookId: 'b1', chapterId: 'c0001', kind: 'highlight',
    start: 0, end: 3, excerpt: '第一段', createdAt: '2026-10-16T00:00:00.000Z',
    ...partial,
  }
}

const api = {
  annotations: {
    list: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}

let notices: string[]

function makeMarks(overrides: Partial<ReaderMarksDeps> = {}) {
  return useReaderMarks({
    bookId: () => 'b1',
    currentChapterId: () => 'c0001',
    normalizedBody: () => BODY,
    chapterOrder: () => new Map([['c0001', 0], ['c0002', 1]]),
    memoryCharacters: () => [],
    notify: (kind, text) => notices.push(`${kind}:${text}`),
    ...overrides,
  })
}

beforeEach(() => {
  notices = []
  vi.clearAllMocks()
  vi.stubGlobal('window', { api } as unknown as Window & typeof globalThis)
  api.annotations.list.mockResolvedValue({ ok: true, items: [] })
  api.annotations.add.mockImplementation(async (draft: Partial<Annotation>) => ({ ok: true, item: annotation(draft) }))
  api.annotations.update.mockResolvedValue({ ok: true, item: annotation({ note: '改了', noteSource: 'user' }) })
  api.annotations.remove.mockResolvedValue({ ok: true })
  api.annotations.add.mockClear()
})

describe('useReaderMarks（阅读器标记域）', () => {
  it('划线成功推进列表，失败只提示不动列表', async () => {
    const marks = makeMarks()
    expect(await marks.addHighlight({ start: 0, end: 3, text: '第一段' })).toBe(true)
    expect(marks.annotations.value).toHaveLength(1)
    expect(notices).toEqual(['success:已划线'])

    api.annotations.add.mockResolvedValueOnce({ ok: false, message: '章节不存在' })
    expect(await marks.addHighlight({ start: 0, end: 3, text: '第一段' })).toBe(false)
    expect(marks.annotations.value).toHaveLength(1)
    expect(notices.at(-1)).toBe('error:章节不存在')
  })

  it('AI 存回的备注带 noteSource=ai，读者自己写的默认不带', async () => {
    const marks = makeMarks()
    await marks.addNote({ start: 0, end: 3, text: '第一段' }, '这是 AI 的解释', { source: 'ai' })
    expect(api.annotations.add.mock.calls[0]![0]).toMatchObject({ note: '这是 AI 的解释', noteSource: 'ai' })

    await marks.addNote({ start: 0, end: 3, text: '第一段' }, '我自己写的')
    expect(api.annotations.add.mock.calls[1]![0]).not.toHaveProperty('noteSource')
  })

  it('每章最多一条书签：第二次点击是移除', async () => {
    const marks = makeMarks()
    await marks.toggleBookmark()
    expect(marks.annotations.value.map((item) => item.kind)).toEqual(['bookmark'])

    const existing = marks.annotations.value[0]!
    await marks.toggleBookmark()
    expect(api.annotations.remove).toHaveBeenCalledWith('b1', existing.id)
    expect(marks.annotations.value).toHaveLength(0)
    expect(notices).toEqual(['success:已加书签', 'info:已移除书签'])
  })

  it('打开章节时按摘录校正漂移，找不到的划线标为丢失且不再渲染', async () => {
    const drifted = annotation({ id: 'a-drift', start: 99, end: 102, excerpt: '第二段' })
    const gone = annotation({ id: 'a-gone', start: 0, end: 3, excerpt: '这段正文里没有的句子' })
    const marks = makeMarks()
    marks.annotations.value = [drifted, gone]

    marks.resolveCurrentChapter()

    const at = BODY.indexOf('第二段')
    expect(api.annotations.update).toHaveBeenCalledWith('b1', 'a-drift', { start: at, end: at + '第二段'.length })
    // 本地坐标只在落盘成功后更新，所以这里等一次微任务。
    await vi.waitFor(() => expect(drifted.start).toBe(at))
    expect(marks.lostHighlightIds.value.has('a-gone')).toBe(true)
    expect(marks.currentHighlightRanges.value.map((item) => item.id)).toEqual(['a-drift'])
  })

  it('当前章划线只看本章：别的章与丢失的都不算', () => {
    const marks = makeMarks()
    marks.annotations.value = [
      annotation({ id: 'here' }),
      annotation({ id: 'other', chapterId: 'c0002' }),
      annotation({ id: 'bookmark', kind: 'bookmark' }),
    ]
    marks.lostHighlightIds.value = new Set(['here'])
    expect(marks.currentHighlightRanges.value).toEqual([])
    marks.lostHighlightIds.value = new Set()
    expect(marks.currentHighlightRanges.value.map((item) => item.id)).toEqual(['here'])
  })

  it('标记列表按目录顺序排，生词本截断到前 60 条', () => {
    const marks = makeMarks()
    marks.annotations.value = [annotation({ id: 'later', chapterId: 'c0002' }), annotation({ id: 'earlier', chapterId: 'c0001' })]
    expect(marks.sortedMarks.value.map((item) => item.id)).toEqual(['earlier', 'later'])

    marks.annotations.value = Array.from({ length: 61 }, (_, index) => annotation({ id: `w${index}`, excerpt: `词${index}` }))
    expect(marks.wordbookTerms.value).toHaveLength(60)
    expect(marks.wordbookTrimmed.value).toBe(true)

    marks.annotations.value = [annotation({ id: 'no-excerpt', excerpt: '   ' })]
    expect(marks.wordbookHighlights.value).toEqual([])
    expect(marks.wordbookTrimmed.value).toBe(false)
  })

  it('删除确认文案按类型区分', () => {
    const marks = makeMarks()
    expect(marks.deleteConfirmText(annotation({ kind: 'bookmark' }))).toContain('书签')
    expect(marks.deleteConfirmText(annotation({ note: '有备注' }))).toContain('划线与备注')
    expect(marks.deleteConfirmText(annotation())).toContain('划线？')
  })
})
