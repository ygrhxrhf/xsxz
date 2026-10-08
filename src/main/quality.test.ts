import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBookFromBootstrap, readChapter, repairChapterBody, setLibraryPath, writeChapterFile } from './library'
import { auditBook } from './quality'

describe('章节质量报告与人工修复', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-quality-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: 'd_quality', title: '测试书', author: '', importType: 'download',
      chapterTitles: ['一', '二', '三'],
      chapterUrls: ['https://example.com/1', 'https://example.com/2', 'https://example.com/2'],
    })
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reports suspicious chapters without changing their status', async () => {
    const text = '这是正常正文。'.repeat(30)
    await writeChapterFile('d_quality', 'c0001', { title: '一', body: text, status: 'ready' })
    await writeChapterFile('d_quality', 'c0002', { title: '二', body: text, status: 'ready' })
    await writeChapterFile('d_quality', 'c0003', { title: '三', body: '请先登录后阅读', status: 'ready' })
    const report = await auditBook('d_quality')
    expect(report.checked).toBe(3)
    expect(report.issues.map((issue) => issue.kind)).toEqual(expect.arrayContaining([
      'duplicateBody', 'duplicateUrl', 'short', 'suspectedWall',
    ]))
    expect((await readChapter('d_quality', 'c0003')).status).toBe('ready')
  })

  it('flags a stored paid teaser as suspectedWall without changing its status', async () => {
    const teaser = `${'夜风吹过城墙，林舟把信收进袖中，沿着石阶继续前行。'.repeat(4)}本章剩余内容需要付费阅读，购买本章后可解锁后续章节。`
    await writeChapterFile('d_quality', 'c0001', { title: '一', body: teaser, status: 'ready' })
    const report = await auditBook('d_quality')
    const wall = report.issues.filter((issue) => issue.kind === 'suspectedWall')
    expect(wall.map((issue) => issue.chapterId)).toEqual(['c0001'])
    expect(wall[0]!.reason).toMatch(/付费/)
    expect((await readChapter('d_quality', 'c0001')).status).toBe('ready')
  })

  it('saves manual text and preserves the first original for undo', async () => {
    await writeChapterFile('d_quality', 'c0001', { title: '一', body: '旧正文', status: 'ready' })
    await repairChapterBody('d_quality', 'c0001', '修好后的正文')
    await repairChapterBody('d_quality', 'c0001', '第二次修改')
    const chapter = await readChapter('d_quality', 'c0001')
    expect(chapter.body).toBe('第二次修改')
    expect(chapter.bodyRaw).toBe('旧正文')
    await expect(repairChapterBody('d_quality', 'c0001', ' ')).rejects.toThrow('正文不能为空')
  })
})
