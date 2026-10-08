import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { defaultLibraryPath } from './libraryPath'

describe('defaultLibraryPath', () => {
  it('keeps the pinned Windows directory on win32', () => {
    expect(defaultLibraryPath('win32', 'C:\\Users\\goot')).toBe('D:\\spbf\\library')
  })

  it('uses the home directory instead of a Windows path on other systems', () => {
    expect(defaultLibraryPath('linux', '/home/goot')).toBe('/home/goot/spbf/library')
    expect(defaultLibraryPath('darwin', '/Users/goot')).toBe('/Users/goot/spbf/library')
  })

  it('never resolves to a path that would create a literal D:\\ dir in cwd', () => {
    if (process.platform === 'win32') return
    const resolved = defaultLibraryPath(process.platform, '/tmp/home')
    expect(isAbsolute(resolved)).toBe(true)
    expect(resolved).not.toContain('D:\\')
  })

  it('defaults to the current platform and real home directory', () => {
    expect(defaultLibraryPath()).toBe(defaultLibraryPath(process.platform, homedir()))
  })
})
