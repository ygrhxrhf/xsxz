import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ prefs: { destDir: '', lastSuccessAt: '', lastError: '' } }))
vi.mock('./settings', () => ({
  getSettings: async () => ({ autoBackup: state.prefs }),
  updateSettings: async (patch: { autoBackup: Partial<typeof state.prefs> }) => {
    Object.assign(state.prefs, patch.autoBackup)
    return { autoBackup: state.prefs }
  },
}))

import { createBookFromBootstrap, setLibraryPath, writeChapterFile } from './library'
import { runAutoBackupIfDue } from './backup'

describe('每周自动备份', () => {
  let library: string
  let dest: string
  beforeEach(async () => {
    library = await mkdtemp(join(tmpdir(), 'spbf-auto-lib-'))
    dest = await mkdtemp(join(tmpdir(), 'spbf-auto-dest-'))
    await setLibraryPath(library)
    await createBookFromBootstrap({ bookId: 'd_auto', title: '自动备份', author: '',
      importType: 'txt', chapterTitles: ['第一章'] })
    await writeChapterFile('d_auto', 'c0001', { title: '第一章', body: '正文', status: 'ready' })
    Object.assign(state.prefs, { destDir: dest, lastSuccessAt: '', lastError: '' })
  })
  afterEach(async () => {
    await rm(library, { recursive: true, force: true })
    await rm(dest, { recursive: true, force: true })
  })

  it('runs when due and rotates only automatic archives', async () => {
    for (let day = 1; day <= 6; day++) {
      await writeFile(join(dest, `spbf-auto-2026090${day}-120000.zip`), 'old')
    }
    await writeFile(join(dest, 'spbf-backup-20260901-120000.zip'), 'manual')
    const now = new Date('2026-09-30T12:00:00.000Z')
    expect((await runAutoBackupIfDue(now)).status).toBe('created')
    const names = await readdir(dest)
    expect(names.filter((name) => name.startsWith('spbf-auto-'))).toHaveLength(5)
    expect(names).toContain('spbf-backup-20260901-120000.zip')
    expect((await runAutoBackupIfDue(now)).status).toBe('notDue')
  })

  it('records a failure and leaves the last successful time unset', async () => {
    state.prefs.destDir = join(library, 'backups')
    const result = await runAutoBackupIfDue(new Date('2026-09-30T12:00:00.000Z'))
    expect(result.status).toBe('failed')
    expect(state.prefs.lastError).toContain('书库内')
    expect(state.prefs.lastSuccessAt).toBe('')
  })
})
