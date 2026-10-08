import { describe, expect, it } from 'vitest'
import { beginLibraryRestore, isLibraryRestoring, runAsLibraryRestore, withLibraryWrite } from './libraryMaintenance'

describe('library restore gate', () => {
  it('waits for an in-flight write and blocks new writes until restore ends', async () => {
    let finish!: () => void
    const writing = withLibraryWrite(() => new Promise<void>((resolve) => { finish = resolve }))
    expect(beginLibraryRestore).toThrow('书库正在写入')
    finish()
    await writing

    const release = beginLibraryRestore()
    try {
      expect(isLibraryRestoring()).toBe(true)
      await expect(withLibraryWrite(async () => {})).rejects.toThrow('书库正在恢复')
      await expect(runAsLibraryRestore(() => withLibraryWrite(async () => 'index rebuilt'))).resolves.toBe('index rebuilt')
    } finally {
      release()
    }
    expect(isLibraryRestoring()).toBe(false)
  })
})
