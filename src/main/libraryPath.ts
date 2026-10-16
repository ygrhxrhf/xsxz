import { homedir } from 'node:os'
import { posix } from 'node:path'
import { DEFAULT_LIBRARY_PATH } from '../shared/types'

/**
 * Windows 按需求钉死 `D:\spbf\library`；其它系统落到家目录下的同名结构，
 * 否则相对路径会在工作目录里造出一个字面量名为 `D:\spbf\library` 的目录。
 */
export function defaultLibraryPath(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  // 非 win32 分支按目标平台拼路径：本机是 Windows 时宿主 join 会拼出反斜杠，
  // 与「其它系统落到家目录下同名结构」的语义不符（生产里该分支只在非 Windows 上走到）。
  return platform === 'win32' ? DEFAULT_LIBRARY_PATH : posix.join(home, 'spbf', 'library')
}
