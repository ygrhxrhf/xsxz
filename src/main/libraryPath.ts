import { homedir } from 'node:os'
import { join, posix } from 'node:path'

/**
 * 默认书库落在当前用户家目录下的 `spbf/library`。
 *
 * 原先 Windows 钉死 `D:\spbf\library`，但目标机器不一定有 D 盘（实测本机就没有）：
 * 启动即失败，用户还没有任何自救路径。家目录一定存在、当前用户一定可写，
 * 不会再出现「默认目录不可用」；非 Windows 也走同一套结构，避免相对路径在工作目录里
 * 造出一个字面量名为盘符路径的目录。
 */
export function defaultLibraryPath(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  // 非 win32 分支按目标平台拼：本机是 Windows 时宿主 join 会拼出反斜杠，
  // 与「其它系统落到家目录下同名结构」的语义不符（生产里该分支只在非 Windows 上走到）。
  return platform === 'win32' ? join(home, 'spbf', 'library') : posix.join(home, 'spbf', 'library')
}
