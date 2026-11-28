/**
 * Agent 路径参数预检（设计 §5.5）。
 *
 * 统一规则：`filePath` / `sourcePath` / `zipPath` / `destDir` / `targetPath` 必须是
 * 被调用方给出的绝对路径。相对路径会被解析到应用的工作目录上，设备路径（`\\?\`、`\\.\`）
 * 与 UNC 网络路径则把读写带出用户的目录边界——这三类在交给 handler 之前就拒绝。
 *
 * `destDir` 的语义按代码实际行为校准：`exportBook` 与 `createBackup` 都会递归创建它，
 * 所以不要求叶子已存在；真正决定"能不能写进去"的是最近的已存在祖先，那里必须是可写目录。
 * 其余路径的存在性与业务语义（`library.migrate` 要求目标为空目录等）仍由 handler 判定。
 */

import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { win32 } from 'node:path'

const PATH_PARAM_NAMES = ['filePath', 'sourcePath', 'zipPath', 'destDir', 'targetPath'] as const

/** 会被 handler 递归创建的目标目录；只检查最近已存在祖先的可写性。 */
const CREATABLE_DIR_PARAMS: ReadonlySet<string> = new Set(['destDir'])

/** `\\?\C:\x` 与 `\\.\pipe\x` 这类设备路径，以及 `\\host\share\x` 这种 UNC。 */
const DEVICE_PREFIXES = ['\\\\?\\', '\\\\.\\']

interface AgentPathIssue {
  field: string
  message: string
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''
}

function checkPathShape(field: string, value: string): string | null {
  if (!value.trim()) return `${field} 不能是空字符串`
  if (DEVICE_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return `${field} 不接受设备路径（\\\\?\\ 或 \\\\.\\）`
  }
  if (value.startsWith('\\\\')) return `${field} 不接受 UNC 网络路径`
  if (!win32.isAbsolute(value)) return `${field} 必须是绝对路径`
  return null
}

/**
 * 目标目录可能还不存在（handler 会递归创建），所以从叶子往上找第一个真实存在的祖先，
 * 用它判断"这个路径能不能写"——父目录不存在而盘不存在，报错才有意义。
 */
async function checkCreatableDirectory(field: string, value: string): Promise<string | null> {
  let candidate = value
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const info = await stat(candidate)
      if (!info.isDirectory()) return `${field} 的路径中间有一段是文件而不是目录`
      try {
        await access(candidate, fsConstants.W_OK)
      } catch {
        return `${field} 没有写入权限：${candidate}`
      }
      return null
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return `${field} 不可用：${describeError(error)}`
      const parent = win32.dirname(candidate)
      if (!parent || parent === candidate) return `${field} 不存在或无法解析`
      candidate = parent
    }
  }
  return `${field} 层级过深，无法判定可用性`
}

/** 返回空数组表示所有路径参数都可用；每条问题都带字段名，供 MCP 结果直接转述。 */
export async function validateAgentPaths(args: Record<string, unknown>): Promise<AgentPathIssue[]> {
  const issues: AgentPathIssue[] = []
  for (const field of PATH_PARAM_NAMES) {
    const value = args[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') {
      issues.push({ field, message: `${field} 必须是字符串路径` })
      continue
    }
    const shapeIssue = checkPathShape(field, value)
    if (shapeIssue) {
      issues.push({ field, message: shapeIssue })
      continue
    }
    if (CREATABLE_DIR_PARAMS.has(field)) {
      const dirIssue = await checkCreatableDirectory(field, value)
      if (dirIssue) issues.push({ field, message: dirIssue })
    }
  }
  return issues
}
