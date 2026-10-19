import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addWebAnnotation,
  listWebAnnotations,
  removeWebAnnotation,
  setWebAnnotationsDirForTests,
  updateWebAnnotation,
  WEB_ANNOTATION_LIMIT,
  webAnnotationKey,
} from './webAnnotations'

const URL_A = 'https://novel.example/book/1/chapter-2.html'
/** 同一章、不同噪音参数：归一后应与 URL_A 同键。 */
const URL_A_NOISY = 'https://novel.example/book/1/chapter-2.html?utm_source=x&page=3#top'
const URL_B = 'https://novel.example/book/1/chapter-3.html'

describe('webAnnotations（网页阅读模式标注）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-webanno-'))
    setWebAnnotationsDirForTests(dir)
  })

  afterEach(async () => {
    setWebAnnotationsDirForTests(null)
    await rm(dir, { recursive: true, force: true })
  })

  it('adds highlights and bookmarks, lists only the requested chapter', async () => {
    const hl = await addWebAnnotation({
      url: URL_A, kind: 'highlight', start: 3, end: 9, excerpt: '窗外月光',
    })
    expect(hl.id).toBeTruthy()
    expect(hl.createdAt).toBeTruthy()
    await addWebAnnotation({ url: URL_B, kind: 'bookmark', start: 0, end: 0, excerpt: '' })

    expect((await listWebAnnotations(URL_A)).map((a) => a.id)).toEqual([hl.id])
    expect((await listWebAnnotations(URL_B))).toHaveLength(1)
  })

  it('treats noisy query parameters as the same chapter', async () => {
    const hl = await addWebAnnotation({
      url: URL_A, kind: 'highlight', start: 1, end: 5, excerpt: '风从山口',
    })
    expect(webAnnotationKey(URL_A_NOISY)).toBe(webAnnotationKey(URL_A))
    const items = await listWebAnnotations(URL_A_NOISY)
    expect(items.map((a) => a.id)).toEqual([hl.id])
  })

  it('rejects illegal urls and bad coordinates', async () => {
    await expect(addWebAnnotation({ url: 'javascript:void(0)', kind: 'highlight', start: 0, end: 1, excerpt: 'x' }))
      .rejects.toThrow('地址不合法')
    await expect(addWebAnnotation({ url: URL_A, kind: 'highlight', start: 9, end: 3, excerpt: 'x' }))
      .rejects.toThrow('划线位置不合法')
    await expect(addWebAnnotation({ url: URL_A, kind: 'highlight', start: 1, end: 5, excerpt: '' }))
      .rejects.toThrow('划线缺少原文摘录')
    expect(await listWebAnnotations('not-a-url')).toEqual([])
  })

  it('updates notes, resets noteSource to user, and relocates offsets', async () => {
    const hl = await addWebAnnotation({
      url: URL_A, kind: 'highlight', start: 1, end: 5, excerpt: '风从山口',
    })
    const noted = await updateWebAnnotation(URL_A, hl.id, { note: 'AI 的解释', noteSource: 'ai' })
    expect(noted?.note).toBe('AI 的解释')
    expect(noted?.noteSource).toBe('ai')

    // 改写正文却不声明来源：文本换了就是新的作者，来源落回 user
    const edited = await updateWebAnnotation(URL_A, hl.id, { note: '我自己的话' })
    expect(edited?.noteSource).toBe('user')

    const moved = await updateWebAnnotation(URL_A, hl.id, { start: 40, end: 44 })
    expect(moved?.start).toBe(40)
    expect(moved?.end).toBe(44)

    // 清空备注：note 与 noteSource 一起删
    const cleared = await updateWebAnnotation(URL_A, hl.id, { note: '' })
    expect(cleared?.note).toBeUndefined()
    expect(cleared?.noteSource).toBeUndefined()
  })

  it('removes only within the owning chapter', async () => {
    const hl = await addWebAnnotation({ url: URL_A, kind: 'highlight', start: 1, end: 5, excerpt: '风从山口' })
    expect(await removeWebAnnotation(URL_B, hl.id)).toBe(false)
    expect(await listWebAnnotations(URL_A)).toHaveLength(1)
    expect(await removeWebAnnotation(URL_A, hl.id)).toBe(true)
    expect(await listWebAnnotations(URL_A)).toHaveLength(0)
  })

  it('drops illegal items on read and caps the file', async () => {
    const { writeFile } = await import('node:fs/promises')
    // 基准时间必须显式用 UTC：本用例先写 5005 条超限数据，再断言 id=ok 的那条被保留，
    // 而保留策略是按 createdAt 升序取最后 5000 条。若这里用本地时间构造，在 UTC+8 上
    // 这些时间戳会早于 ok，在 UTC 的 CI 上却晚于 ok，测试结果随 runner 时区翻转。
    const seeded = Array.from({ length: WEB_ANNOTATION_LIMIT + 5 }, (_, i) => ({
      id: `a${i}`, url: URL_B, kind: 'bookmark', start: 0, end: 0, excerpt: '',
      createdAt: new Date(Date.UTC(2025, 11, 31, 23, 59, 0, i % 1000)).toISOString(),
    }))
    await writeFile(join(dir, 'web-annotations.json'), JSON.stringify({
      version: 1,
      items: [
        { id: 'ok', url: URL_A, kind: 'highlight', start: 1, end: 5, excerpt: 'x', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'bad-url', url: 'javascript:1', kind: 'highlight', start: 1, end: 5, excerpt: 'x', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'bad-kind', url: URL_A, kind: 'scribble', start: 1, end: 5, excerpt: 'x', createdAt: '2026-01-01T00:00:00.000Z' },
        null,
        ...seeded,
      ],
    }), 'utf-8')

    expect((await listWebAnnotations(URL_A)).map((a) => a.id)).toEqual(['ok'])
    const raw = JSON.parse(await readFile(join(dir, 'web-annotations.json'), 'utf-8')) as { items: unknown[] }
    // 读盘时已按上限裁剪，写回后不超限
    await addWebAnnotation({ url: URL_B, kind: 'bookmark', start: 0, end: 0, excerpt: '' })
    const after = JSON.parse(await readFile(join(dir, 'web-annotations.json'), 'utf-8')) as { items: unknown[] }
    expect(after.items.length).toBeLessThanOrEqual(WEB_ANNOTATION_LIMIT)
    expect(raw.items.length).toBeGreaterThan(0)
  })
})
