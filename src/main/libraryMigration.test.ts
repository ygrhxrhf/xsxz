import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./settings', () => ({
  updateSettings: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
}))

import { createBookFromBootstrap, getLibraryPath, listBooks, setLibraryPath, writeChapterFile } from './library'
import { cleanupInterruptedMigration, migrateLibrary } from './libraryMigration'
import { updateSettings } from './settings'

describe('书库搬迁', () => {
  let source: string
  let target: string
  beforeEach(async () => {
    source = await mkdtemp(join(tmpdir(), 'spbf-move-source-'))
    target = await mkdtemp(join(tmpdir(), 'spbf-move-target-'))
    await setLibraryPath(source)
    await createBookFromBootstrap({ bookId: 'd_move', title: '搬迁测试', author: '',
      importType: 'txt', chapterTitles: ['第一章'] })
    await writeChapterFile('d_move', 'c0001', { title: '第一章', body: '原始正文', status: 'ready' })
    vi.mocked(updateSettings).mockReset().mockResolvedValue({} as never)
  })
  afterEach(async () => {
    await rm(source, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  })

  it('copies and verifies an empty target while retaining the original', async () => {
    const result = await migrateLibrary(target)
    expect(result.ok).toBe(true)
    expect(getLibraryPath()).toBe(target)
    expect((await listBooks()).map((book) => book.id)).toEqual(['d_move'])
    expect(await readdir(source)).toContain('d_move')
    expect(await readdir(target)).toContain('d_move')
  })

  it('moves a valid empty library', async () => {
    await rm(join(source, 'd_move'), { recursive: true, force: true })
    const result = await migrateLibrary(target)
    expect(result).toMatchObject({ ok: true, files: 1 })
    expect(getLibraryPath()).toBe(target)
    expect(await listBooks()).toEqual([])
    expect(await readdir(source)).toContain('index.json')
  })

  it('rejects a nonempty target and rolls back a settings failure', async () => {
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(target, 'occupied'), 'x'))
    expect(await migrateLibrary(target)).toMatchObject({ ok: false, message: '目标目录必须为空' })
    await rm(join(target, 'occupied'))
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error('设置写入失败'))
    expect(await migrateLibrary(target)).toMatchObject({ ok: false, message: '设置写入失败' })
    expect(getLibraryPath()).toBe(source)
    expect((await listBooks()).map((book) => book.id)).toEqual(['d_move'])
    expect(await readdir(target)).toEqual([])
  })

  it('requires an existing empty target directory', async () => {
    await rm(target, { recursive: true, force: true })
    expect(await migrateLibrary(target)).toMatchObject({
      ok: false, message: '目标目录不存在，请先选择空目录',
    })
    expect(getLibraryPath()).toBe(source)
  })

  it('清理中断搬迁留下的 .spbf-migrate-* 暂存目录，且不动书库', async () => {
    // 模拟在 rmdir/rename 之间被杀：旧库里留下指向暂存目录的记录，暂存目录还在原地
    const stage = join(target, '.spbf-migrate-abc')
    await import('node:fs/promises').then(({ mkdir, writeFile }) =>
      mkdir(join(source, '__tmp__'), { recursive: true })
        .then(() => mkdir(stage, { recursive: true }))
        .then(() => writeFile(join(source, '__tmp__', 'migration-stage.json'), JSON.stringify({ stage }))))
    const cleaned = await cleanupInterruptedMigration(source)
    expect(cleaned).toBe(1)
    expect(await readdir(target)).not.toContain('.spbf-migrate-abc')
    expect(await readdir(source)).toContain('d_move')
    // 记录已清，第二次调用是幂等的
    expect(await cleanupInterruptedMigration(source)).toBe(0)
  })

  it('没有搬迁记录时不做任何事', async () => {
    expect(await cleanupInterruptedMigration(source)).toBe(0)
    expect(await readdir(source)).toContain('d_move')
  })
})
