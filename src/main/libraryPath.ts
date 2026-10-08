import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LIBRARY_PATH } from '../shared/types'

/**
 * Windows 按需求钉死 `D:\spbf\library`；其它系统落到家目录下的同名结构，
 * 否则相对路径会在工作目录里造出一个字面量名为 `D:\spbf\library` 的目录。
 */
export function defaultLibraryPath(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return platform === 'win32' ? DEFAULT_LIBRARY_PATH : join(home, 'spbf', 'library')
}
