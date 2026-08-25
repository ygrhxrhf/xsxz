import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBookFromBootstrap, setLibraryPath } from './library'
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
})

describe('character card storage（ai/characters.json）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-charcard-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: 'd_card',
      title: '人物卡用书',
      author: '',
      importType: 'txt',
      chapterTitles: ['第一章'],
    })
  })

  it('writeCharacterCard / readCharacterCard round-trip', async () => {
    const { readCharacterCard, writeCharacterCard } = await import('./library')
    expect(await readCharacterCard('d_card')).toBeNull()

    const card = {
      version: 1 as const,
      uptoChapterId: 'c0001',
      characters: [{ name: '张若尘', role: '主角' }],
      foreshadows: [{ desc: '轮回诀', open: true }],
      raw: '{"characters":[]}',
      updatedAt: new Date().toISOString(),
    }
    await writeCharacterCard('d_card', card)

    const back = await readCharacterCard('d_card')
    expect(back?.uptoChapterId).toBe('c0001')
    expect(back?.characters[0].name).toBe('张若尘')
    expect(back?.version).toBe(1)
    expect(back?.updatedAt).toBeTruthy()
  })
})
