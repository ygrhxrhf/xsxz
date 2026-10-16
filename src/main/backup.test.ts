import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { setAtomicWriteBeforeCommitForTests } from './atomicFile'

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

  it('keeps the old book when a backup has an index but no ready chapter body', async () => {
    await seedBook('d_old', '原书')
    const outDir = join(tmpdir(), 'spbf-backup-out')
    const created = await createBackup(outDir)
    if (!created.ok) throw new Error('backup failed')
    const zip = await JSZip.loadAsync(await readFile(created.path))
    zip.remove('d_old/chapters/0001.json')
    await writeFile(created.path, await zip.generateAsync({ type: 'nodebuffer' }))

    const result = await restoreBackup(created.path)
    expect(result.ok).toBe(false)
    expect((await loadBook('d_old')).title).toBe('原书')
    expect((await readFile(join(libDir, 'd_old', 'chapters', '0001.json'), 'utf-8'))).toContain('正文一')
  })

  it('rejects unsafe zip paths before touching the current library', async () => {
    await seedBook('d_old', '原书')
    const zip = new JSZip()
    zip.file('index.json', JSON.stringify({ version: 1, books: [] }))
    zip.file('../outside.json', '{}')
    const outDir = join(tmpdir(), 'spbf-backup-out')
    await mkdir(outDir, { recursive: true })
    const path = join(outDir, 'unsafe.zip')
    await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
    const result = await restoreBackup(path)
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('不安全') })
    expect((await loadBook('d_old')).title).toBe('原书')
  })

  it('keeps the old library when staging extraction or directory switch fails', async () => {
    await seedBook('d_old', '原书')
    const outDir = join(tmpdir(), 'spbf-backup-out')
    const created = await createBackup(outDir)
    if (!created.ok) throw new Error('backup failed')
    const before = await readFile(join(libDir, 'd_old', 'book.json'), 'utf-8')

    const extraction = await restoreBackup(created.path, {
      beforeExtractWrite: () => { throw new Error('disk full') },
    })
    expect(extraction.ok).toBe(false)
    expect(await readFile(join(libDir, 'd_old', 'book.json'), 'utf-8')).toBe(before)

    let moves = 0
    const switching = await restoreBackup(created.path, {
      rename: async (from, to) => {
        moves++
        if (moves === 2) throw new Error('switch failed')
        await rename(from, to)
      },
    })
    expect(switching.ok).toBe(false)
    expect(moves, JSON.stringify(switching)).toBe(3)
    expect(await readFile(join(libDir, 'd_old', 'book.json'), 'utf-8')).toBe(before)
  })

  it('removes the temporary old-library copy after a successful restore', async () => {
    await seedBook('d_backup', '备份书')
    const outDir = join(tmpdir(), 'spbf-backup-out')
    const created = await createBackup(outDir)
    if (!created.ok) throw new Error('backup failed')
    await seedBook('d_current', '当前书')
    const result = await restoreBackup(created.path)
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, books: 1 })
    expect((await listBooks()).map((book) => book.id)).toEqual(['d_backup'])
    const leftovers = (await readdir(dirname(libDir))).filter((name) =>
      name.startsWith('.spbf-previous-') || name.startsWith('.spbf-restore-'))
    expect(leftovers).toEqual([])
  })

  it('rolls back when rebuilding the restored index fails', async () => {
    await seedBook('d_backup', '备份书')
    const outDir = join(tmpdir(), 'spbf-backup-out')
    const created = await createBackup(outDir)
    if (!created.ok) throw new Error('backup failed')
    await seedBook('d_current', '当前书')
    const before = await readFile(join(libDir, 'd_current', 'book.json'), 'utf-8')
    setAtomicWriteBeforeCommitForTests((path) => {
      if (path === join(libDir, 'index.json')) throw new Error('index write failed')
    })
    try {
      const result = await restoreBackup(created.path)
      expect(result.ok).toBe(false)
      expect(await readFile(join(libDir, 'd_current', 'book.json'), 'utf-8')).toBe(before)
    } finally {
      setAtomicWriteBeforeCommitForTests(null)
    }
  })

  it('备份目录不可用时给出可执行的下一步，而不是甩系统错误码', async () => {
    await seedBook('d_hint', '提示书')
    // 用文件占住路径中间一段：Windows 下 mkdir 抛 ENOTDIR
    const blocker = join(tmpdir(), 'spbf-backup-blocker')
    await writeFile(blocker, 'x')
    try {
      const res = await createBackup(join(blocker, 'sub'))
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.message).toContain('无法写入备份目录')
      expect(res.message).toContain('文件夹')
      // 不能把原始错误码甩给用户
      expect(res.message).not.toContain('ENOTDIR')
    } finally {
      await rm(blocker, { force: true })
    }
  })

  it('目标盘不存在时提示先去创建目录', async () => {
    await seedBook('d_hint2', '提示书二')
    const res = await createBackup('Q:/spbf-no-such-drive/out')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toContain('无法写入备份目录')
    expect(res.message).toContain('创建该目录')
    expect(res.message).not.toContain('ENOENT')
  })
})
