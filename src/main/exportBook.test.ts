import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBookFromBootstrap, setLibraryPath, writeChapterFile } from './library'
import { exportBook, sanitizeExportName } from './exportBook'

describe('exportBook', () => {
  let lib: string
  let dest: string

  beforeEach(async () => {
    lib = await mkdtemp(join(tmpdir(), 'spbf-export-lib-'))
    dest = await mkdtemp(join(tmpdir(), 'spbf-export-out-'))
    await setLibraryPath(lib)
  })

  afterEach(async () => {
    await rm(lib, { recursive: true, force: true })
    await rm(dest, { recursive: true, force: true })
  })

  it('sanitizes reserved filename characters', () => {
    expect(sanitizeExportName('书名:卷一/上?')).toBe('书名 卷一 上')
    expect(sanitizeExportName('   ')).toBe('未命名')
  })

  it('exports ready chapters to a local txt and skips failed ones', async () => {
    const book = await createBookFromBootstrap({
      bookId: 'i_exporttxt000001',
      title: '导出书',
      author: '甲',
      importType: 'txt',
      chapterTitles: ['第一章', '失败章', '第二章'],
    })
    await writeChapterFile(book.id, book.chapters[0].id, {
      title: '第一章',
      body: '正文甲',
      status: 'ready',
    })
    await writeChapterFile(book.id, book.chapters[1].id, {
      title: '失败章',
      body: '',
      status: 'failed',
      failCode: 'BodyEmpty',
    })
    await writeChapterFile(book.id, book.chapters[2].id, {
      title: '第二章',
      body: '正文乙',
      status: 'ready',
    })

    const res = await exportBook(book.id, 'txt', dest)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.path.endsWith('导出书.txt')).toBe(true)
    const text = await readFile(res.path, 'utf-8')
    expect(text).toContain('《导出书》')
    expect(text).toContain('## 第一章')
    expect(text).toContain('正文甲')
    expect(text).toContain('## 第二章')
    expect(text).toContain('正文乙')
    expect(text).not.toContain('失败章')
  })

  it('exports a local epub that can be unzipped', async () => {
    const book = await createBookFromBootstrap({
      bookId: 'i_exportepub00001',
      title: 'Epub书',
      author: '乙',
      importType: 'txt',
      chapterTitles: ['开篇'],
    })
    await writeChapterFile(book.id, book.chapters[0].id, {
      title: '开篇',
      body: '一段可导出的正文',
      status: 'ready',
    })
    const res = await exportBook(book.id, 'epub', dest)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const zip = await JSZip.loadAsync(await readFile(res.path))
    expect(await zip.file('mimetype')?.async('string')).toBe('application/epub+zip')
    const xhtml = await zip.file('OEBPS/ch0001.xhtml')?.async('string')
    expect(xhtml).toContain('一段可导出的正文')
    expect(xhtml).not.toMatch(/<script/i)
  })

  it('fails when nothing is ready', async () => {
    const book = await createBookFromBootstrap({
      bookId: 'i_exportempty0001',
      title: '空书',
      author: '',
      importType: 'txt',
      chapterTitles: ['未下'],
    })
    const res = await exportBook(book.id, 'txt', dest)
    expect(res).toEqual({ ok: false, message: '没有可导出的章节' })
  })

  it('导出目录不可用时给出可执行的下一步，而不是甩系统错误码', async () => {
    const book = await createBookFromBootstrap({
      bookId: 'i_exporthint0001',
      title: '提示书',
      author: '',
      importType: 'txt',
      chapterTitles: ['第一章'],
    })
    await writeChapterFile(book.id, book.chapters[0].id, {
      title: '第一章',
      body: '正文内容',
      status: 'ready',
    })
    // 用文件占住路径中间一段：Windows 下 mkdir 抛 ENOTDIR
    const blocker = join(tmpdir(), 'spbf-export-blocker')
    await writeFile(blocker, 'x')
    try {
      const res = await exportBook(book.id, 'txt', join(blocker, 'sub'))
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.message).toContain('无法写入导出目录')
      expect(res.message).toContain('文件夹')
      expect(res.message).not.toContain('ENOTDIR')
    } finally {
      await rm(blocker, { force: true })
    }
  })
})
