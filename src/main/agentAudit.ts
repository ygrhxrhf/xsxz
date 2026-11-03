/**
 * Agent 调用审计：每次经桥接的工具调用都追加一行 JSONL。
 *
 * 红线：条目里只有工具名、频道、分级、结果码与耗时、参数的**哈希前缀**——
 * 绝不记录参数值、正文、Key、密文字段或令牌明文。
 * 容量超 5 MB 时轮转一代（`agent-audit.jsonl.1`）；轮转代保留 30 天后删除。
 */

import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

export interface AgentAuditEntry {
  ts: string
  client: string
  tool: string
  channel: string
  tier: string
  dryRun: boolean
  /** 本次调用是否凭 dryRun 签发的确认令牌执行。 */
  confirmed: boolean
  ok: boolean
  code?: string
  ms: number
  /** 参数的 SHA-256 前 16 位十六进制；不含参数值。 */
  argsHash: string
}

const MAX_BYTES = 5 * 1024 * 1024
const ROTATED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

let fileOverride: string | undefined

/** 测试注入审计文件路径；传 undefined 恢复默认。 */
export function setAgentAuditFileForTests(path: string | undefined): void {
  fileOverride = path
}

function auditFile(): string {
  return fileOverride ?? join(app.getPath('userData'), 'agent-audit.jsonl')
}

function normalizeEntry(entry: AgentAuditEntry): AgentAuditEntry {
  const safe: AgentAuditEntry = {
    ts: String(entry.ts),
    client: String(entry.client).slice(0, 80),
    tool: String(entry.tool),
    channel: String(entry.channel),
    tier: String(entry.tier),
    dryRun: entry.dryRun === true,
    confirmed: entry.confirmed === true,
    ok: entry.ok === true,
    ms: Number.isFinite(entry.ms) ? Math.max(0, entry.ms) : 0,
    argsHash: /^[0-9a-f]{16}$/i.test(entry.argsHash) ? entry.argsHash.toLowerCase() : '',
  }
  if (entry.code) safe.code = String(entry.code).slice(0, 120)
  return safe
}

export async function recordAgentAudit(entry: AgentAuditEntry): Promise<void> {
  const path = auditFile()
  try {
    await mkdir(dirname(path), { recursive: true })
    await rotateIfNeeded(path)
    await appendFile(path, `${JSON.stringify(normalizeEntry(entry))}\n`, 'utf-8')
  } catch (error) {
    // 审计写失败不能挡住工具调用本身，也不能把错误带进 MCP 结果。
    console.warn('agent 审计写入失败：', error instanceof Error ? error.message : String(error))
  }
}

/**
 * 保留策略（设计 §5.6）：当前文件超 5 MB 就轮转一代，旧代超过 30 天直接删除。
 * 先清旧代再轮转，才不会出现"刚轮转的旧代又因为超龄被删掉"的空窗。
 */
async function rotateIfNeeded(path: string): Promise<void> {
  const rotated = `${path}.1`
  try {
    const info = await stat(rotated)
    if (Date.now() - info.mtimeMs > ROTATED_RETENTION_MS) await rm(rotated, { force: true })
  } catch {
    // 还没有旧代。
  }
  try {
    const info = await stat(path)
    if (info.size > MAX_BYTES) await rename(path, rotated)
  } catch {
    // 当前文件还没写过。
  }
}

/** 读取最近 limit 条审计（界面「agent 调用记录」用），按时间倒序。 */
export async function readAgentAudit(limit = 100): Promise<AgentAuditEntry[]> {
  try {
    const text = await readFile(auditFile(), 'utf-8')
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .map((line) => normalizeEntry(JSON.parse(line) as AgentAuditEntry))
  } catch {
    return []
  }
}

/** 审计条目的安全不变量：不得出现 Key/密码/令牌命名字段或嵌套对象。 */
export function isAuditEntrySafe(entry: AgentAuditEntry): boolean {
  for (const [key, value] of Object.entries(entry)) {
    if (/Enc$/.test(key) || /passwor|apikey|secret/i.test(key)) return false
    if (value !== null && typeof value === 'object') return false
  }
  return true
}
