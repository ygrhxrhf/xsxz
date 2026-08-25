import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  createBookFromBootstrap,
  deleteBook,
  ensureLibrary,
  listBooks,
  loadBook,
  setLibraryPath,
  writeChapterFile,
} from './library'
import { backupFileName, createBackup, restoreBackup } from './backup'

describe('backup（书库备份/恢复）', () => {
  let libDir: string

  beforeEach(async () => {
    libDir = await mkdtemp(join(tmpdir(), 'spbf-backup-lib-'))
    await setLibraryPath(libDir)
  })

  afterEach(async () => {
    await rm(libDir, { recursive: true, force: true })
    await rm(join(tmpdir(), 'spbf-backup-out'), { recursive: true, force: true })
  })

  async function seedBook(id: string, title: string): Promise<void> {
    await createBookFromBootstrap({
      bookId: id,
      title,
      author: '作者',
      importType: 'txt',
      chapterTitles: ['第一章', '第二章'],
    })
    await writeChapterFile(id, 'c0001', { title: '第一章', body: '正文一', status: 'ready' })
  }

  it('round-trips the whole library through a zip, excluding __trash__', async () => {
    await seedBook('d_keep_a', '书甲')
    await seedBook('d_keep_b', '书乙')
    // 造一本进回收站的书：不应进入备份
    await seedBook('d_gone', '回收站的书')
    await deleteBook('d_gone')

    const outDir = join(tmpdir(), 'spbf-backup-out')
    const created = await createBackup(outDir)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.path.endsWith('.zip')).toBe(true)

    const zip = await JSZip.loadAsync(await readFile(created.path))
    expect(zip.file('index.json')).toBeTruthy()
    expect(Object.keys(zip.files).some((n) => n.startsWith('__trash__'))).toBe(false)
    expect(zip.file('d_keep_a/book.json')).toBeTruthy()
    expect(zip.file('d_keep_a/chapters/0001.json')).toBeTruthy()

    // 清空书库后恢复
    for (const ent of await readdir(libDir)) {
      await rm(join(libDir, ent), { recursive: true, force: true })
    }
    expect(await listBooks()).toHaveLength(0)

    const restored = await restoreBackup(created.path)
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    expect(restored.books).toBe(2)

    const books = await listBooks()
    expect(books.map((b) => b.title).sort()).toEqual(['书乙', '书甲'])
    const back = await loadBook('d_keep_a')
    expect(back.chapters[0].status).toBe('ready')
    const ch = await import('./library').then((m) => m.readChapter('d_keep_a', 'c0001'))
    expect(ch.body).toBe('正文一')
  })

  it('rejects zips without index.json and non-zip files with Chinese messages', async () => {
    const outDir = join(tmpdir(), 'spbf-backup-out')
    await mkdir(outDir, { recursive: true })

    const badZip = new JSZip()
    badZip.file('random.txt', '不是书库')
    const badPath = join(outDir, 'bad.zip')
    await writeFile(badPath, await badZip.generateAsync({ type: 'nodebuffer' }))
    const bad = await restoreBackup(badPath)
    expect(bad).toMatchObject({ ok: false })
    if (!bad.ok) expect(bad.message).toContain('不是有效的书库备份')

    const notZip = join(outDir, 'nope.zip')
    await writeFile(notZip, 'plain text')
    const worse = await restoreBackup(notZip)
    expect(worse).toMatchObject({ ok: false })
    if (!worse.ok) expect(worse.message.length).toBeGreaterThan(0)

    expect(await restoreBackup('')).toMatchObject({ ok: false })
    expect(await createBackup('')).toMatchObject({ ok: false })
  })

  it('names backups spbf-backup-<date>-<time>.zip', () => {
    expect(backupFileName(new Date('2026-08-25T09:07:05'))).toBe('spbf-backup-20260825-090705.zip')
  })

  it('refuses an empty library instead of writing an empty zip', async () => {
    await ensureLibrary()
    const outDir = join(tmpdir(), 'spbf-backup-out')
    const res = await createBackup(outDir)
    expect(res).toMatchObject({ ok: false })
  })
})
