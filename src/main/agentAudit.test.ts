import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userDataPath: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userDataPath } }))

import { isAuditEntrySafe, readAgentAudit, recordAgentAudit, setAgentAuditFileForTests } from './agentAudit'

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spbf-agent-audit-'))
  mocks.userDataPath = dir
})

afterAll(async () => {
  setAgentAuditFileForTests(undefined)
  await rm(dir, { recursive: true, force: true })
})

function entry(overrides: Partial<Parameters<typeof recordAgentAudit>[0]> = {}) {
  return {
    ts: '2026-11-03T09:00:00.000Z',
    client: 'claude-code/2.x',
    tool: 'library_list',
    channel: 'library.list',
    tier: 'read',
    dryRun: false,
    confirmed: false,
    ok: true,
    ms: 12,
    argsHash: 'a'.repeat(16),
    ...overrides,
  }
}

describe('agent 审计', () => {
  it('每次调用追加一行 JSONL，可按时间倒序读回', async () => {
    await recordAgentAudit(entry())
    await recordAgentAudit(entry({ tool: 'library_get', channel: 'library.get', ok: false, code: 'UPSTREAM_FAILED' }))

    const entries = await readAgentAudit(10)
    expect(entries).toHaveLength(2)
    expect(entries[0].tool).toBe('library_get')
    expect(entries[1].tool).toBe('library_list')
    expect(entries[0].ok).toBe(false)
    expect(entries[1].ok).toBe(true)
  })

  it('条目只含元数据：没有 Key、密文、参数值或令牌明文', async () => {
    await recordAgentAudit(entry({ confirmed: true }))
    const [first] = await readAgentAudit(1)
    expect(isAuditEntrySafe(first)).toBe(true)

    const raw = await readFile(join(dir, 'agent-audit.jsonl'), 'utf-8')
    expect(raw).not.toMatch(/sk-|apiKeyEnc|"apiKey"|proxyPassword|confirmToken/)
    for (const line of raw.trim().split('\n')) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(String(parsed.argsHash)).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('超过 5 MB 轮转一代，旧文件保留', async () => {
    const rotated = join(dir, 'audit-rotated.jsonl')
    setAgentAuditFileForTests(rotated)
    try {
      // 直接写一个大文件，绕开逐条 append 的耗时。
      const { writeFile } = await import('node:fs/promises')
      await writeFile(rotated, 'x'.repeat(5 * 1024 * 1024 + 1), 'utf-8')
      await recordAgentAudit(entry({ tool: 'library_list' }))
      expect((await stat(`${rotated}.1`)).size).toBeGreaterThan(5 * 1024 * 1024)
      const entries = await readAgentAudit(10)
      expect(entries).toHaveLength(1)
    } finally {
      setAgentAuditFileForTests(undefined)
    }
  })

  it('轮转代超过 30 天就删掉，不会无限堆积', async () => {
    const rot = join(dir, 'audit-retention.jsonl')
    setAgentAuditFileForTests(rot)
    try {
      await writeFile(`${rot}.1`, 'old\n', 'utf-8')
      const minuteAgo = new Date(Date.now() - 60_000)
      await utimes(`${rot}.1`, minuteAgo, minuteAgo)
      await recordAgentAudit(entry())
      expect((await stat(`${rot}.1`)).size).toBeGreaterThan(0)

      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
      await utimes(`${rot}.1`, fortyDaysAgo, fortyDaysAgo)
      await recordAgentAudit(entry())
      await expect(stat(`${rot}.1`)).rejects.toThrow()
    } finally {
      setAgentAuditFileForTests(undefined)
    }
  })

  it('写入时按白名单剥除 Key、密文、令牌和嵌套字段', async () => {
    await recordAgentAudit({
      ...entry(),
      apiKey: 'sk-secret',
      proxyPasswordEnc: 'ciphertext',
      token: 'bridge-token',
      nested: { body: 'sensitive' },
    } as never)
    const [saved] = await readAgentAudit(1)
    expect(isAuditEntrySafe(saved)).toBe(true)
    expect(Object.keys(saved).sort()).toEqual([
      'argsHash', 'channel', 'client', 'confirmed', 'dryRun', 'ms', 'ok', 'tier', 'tool', 'ts',
    ])
    expect(JSON.stringify(saved)).not.toMatch(/sk-secret|ciphertext|bridge-token|sensitive/)
  })

  it('isAuditEntrySafe 拦住携带凭据形状的条目', () => {
    expect(isAuditEntrySafe(entry())).toBe(true)
    expect(isAuditEntrySafe({ ...entry(), apiKey: 'sk-x' } as never)).toBe(false)
    expect(isAuditEntrySafe({ ...entry(), proxyPasswordEnc: 'x' } as never)).toBe(false)
    expect(isAuditEntrySafe({ ...entry(), nested: { a: 1 } } as never)).toBe(false)
  })
})
