import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setAtomicWriteBeforeCommitForTests } from './atomicFile'
import { bookDir, createBookFromBootstrap, setLibraryPath } from './library'
import {
  addAnnotation,
  listAnnotations,
  removeAnnotation,
  updateAnnotation,
} from './annotations'

describe('annotations（书签/划线存储）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-anno-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: 'd_anno',
      title: '标记用书',
      author: '',
      importType: 'txt',
      chapterTitles: ['第一章', '第二章'],
    })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('adds highlights and bookmarks, lists them sorted by creation', async () => {
    const hl = await addAnnotation({
      bookId: 'd_anno',
      chapterId: 'c0001',
      kind: 'highlight',
      start: 3,
      end: 9,
      excerpt: '窗外月光',
    })
    expect(hl.id).toBeTruthy()
    expect(hl.createdAt).toBeTruthy()

    const bm = await addAnnotation({
      bookId: 'd_anno',
      chapterId: 'c0002',
      kind: 'bookmark',
      start: 0,
      end: 0,
      excerpt: '',
    })

    const items = await listAnnotations('d_anno')
    expect(items.map((a) => a.id)).toEqual([hl.id, bm.id])
    expect(items[0].excerpt).toBe('窗外月光')
  })

  it('updates notes and relocated offsets', async () => {
    const hl = await addAnnotation({
      bookId: 'd_anno',
      chapterId: 'c0001',
      kind: 'highlight',
      start: 3,
      end: 9,
      excerpt: '窗外月光',
    })

    const withNote = await updateAnnotation('d_anno', hl.id, { note: '伏笔：月夜' })
    expect(withNote?.note).toBe('伏笔：月夜')

    const moved = await updateAnnotation('d_anno', hl.id, { start: 20, end: 26 })
    expect(moved?.start).toBe(20)
    expect(moved?.end).toBe(26)

    // 非法坐标对被忽略
    const bad = await updateAnnotation('d_anno', hl.id, { start: 5, end: 2 })
    expect(bad?.start).toBe(20)

    // 空备注清除
    const cleared = await updateAnnotation('d_anno', hl.id, { note: '' })
    expect(cleared?.note).toBeUndefined()

    expect(await updateAnnotation('d_anno', '不存在', { note: 'x' })).toBeNull()
  })

  it('noteSource 跟着备注走，只改坐标不影响来源', async () => {
    const aiNote = await addAnnotation({
      bookId: 'd_anno',
      chapterId: 'c0001',
      kind: 'highlight',
      start: 3,
      end: 9,
      excerpt: '窗外月光',
      note: '这段是伏笔',
      noteSource: 'ai',
    })
    expect(aiNote.noteSource).toBe('ai')

    // 漂移校正只传坐标：备注与来源原样保留
    const moved = await updateAnnotation('d_anno', aiNote.id, { start: 20, end: 26 })
    expect(moved?.note).toBe('这段是伏笔')
    expect(moved?.noteSource).toBe('ai')

    // 读者改写文本 → 归属回到读者
    const edited = await updateAnnotation('d_anno', aiNote.id, { note: '这段是伏笔，我加的' })
    expect(edited?.noteSource).toBe('user')

    // 清空备注 → 来源一并删除，不留孤儿标记
    const cleared = await updateAnnotation('d_anno', aiNote.id, { note: '' })
    expect(cleared?.note).toBeUndefined()
    expect('noteSource' in (cleared ?? {})).toBe(false)

    // 没有备注就不记来源
    const bare = await addAnnotation({
      bookId: 'd_anno',
      chapterId: 'c0001',
      kind: 'highlight',
      start: 0,
      end: 4,
      excerpt: '张若尘',
      noteSource: 'ai',
    })
    expect('noteSource' in bare).toBe(false)
    expect((await listAnnotations('d_anno')).find((a) => a.id === bare.id)?.noteSource).toBeUndefined()
  })

  it('removes annotations', async () => {
    const a = await addAnnotation({
      bookId: 'd_anno',
      chapterId: 'c0001',
      kind: 'highlight',
      start: 0,
      end: 4,
      excerpt: '张若尘',
    })
    await removeAnnotation('d_anno', a.id)
    expect(await listAnnotations('d_anno')).toEqual([])
    // 幂等
    await removeAnnotation('d_anno', a.id)
  })

  it('rejects bad drafts', async () => {
    await expect(
      addAnnotation({
        bookId: 'd_anno',
        chapterId: '不存在',
        kind: 'bookmark',
        start: 0,
        end: 0,
        excerpt: '',
      }),
    ).rejects.toThrow('章节不存在')

    await expect(
      addAnnotation({
        bookId: 'd_anno',
        chapterId: 'c0001',
        kind: 'highlight',
        start: 9,
        end: 3,
        excerpt: 'x',
      }),
    ).rejects.toThrow('不合法')

    await expect(
      addAnnotation({
        bookId: 'd_anno',
        chapterId: 'c0001',
        kind: 'highlight',
        start: 0,
        end: 4,
        excerpt: '',
      }),
    ).rejects.toThrow('摘录')
  })

  it('落盘走原子写：提交失败时旧标记一字不丢，也不留临时文件', async () => {
    await addAnnotation({
      bookId: 'd_anno',
      chapterId: 'c0001',
      kind: 'bookmark',
      start: 0,
      end: 0,
      excerpt: '',
    })
    const file = join(bookDir('d_anno'), 'annotations.json')
    const before = await readFile(file, 'utf-8')

    setAtomicWriteBeforeCommitForTests((path) => {
      if (path.endsWith('annotations.json')) throw new Error('disk full')
    })
    try {
      await expect(
        addAnnotation({
          bookId: 'd_anno',
          chapterId: 'c0002',
          kind: 'bookmark',
          start: 0,
          end: 0,
          excerpt: '',
        }),
      ).rejects.toThrow('disk full')
    } finally {
      setAtomicWriteBeforeCommitForTests(null)
    }

    expect(await readFile(file, 'utf-8')).toBe(before)
    const leftovers = (await readdir(bookDir('d_anno'))).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
    expect(await listAnnotations('d_anno')).toHaveLength(1)
  })
})
