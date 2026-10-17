import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { defaultLibraryPath } from './libraryPath'

describe('defaultLibraryPath', () => {
  it('on Windows it lands in the home directory, not a pinned D: drive', () => {
    expect(defaultLibraryPath('win32', 'C:\\Users\\goot')).toBe('C:\\Users\\goot\\spbf\\library')
  })

  it('uses the home directory on other systems too', () => {
    expect(defaultLibraryPath('linux', '/home/goot')).toBe('/home/goot/spbf/library')
    expect(defaultLibraryPath('darwin', '/Users/goot')).toBe('/Users/goot/spbf/library')
  })

  it('always lands under the given home, never on a hard-coded drive', () => {
    const cases = [['win32', 'C:\\Users\\goot'], ['linux', '/home/goot'], ['darwin', '/Users/goot']] as const
    for (const [platform, home] of cases) {
      const resolved = defaultLibraryPath(platform, home)
      expect(resolved.startsWith(home)).toBe(true)
      // 回归线：默认值曾经钉死 D:\spbf\library，没有 D 盘的机器启动即失败。
      expect(resolved).not.toContain('D:\\spbf')
    }
  })

  it('defaults to the current platform and real home directory', () => {
    expect(defaultLibraryPath()).toBe(defaultLibraryPath(process.platform, homedir()))
  })
})
