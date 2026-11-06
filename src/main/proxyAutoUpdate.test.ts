import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_INTERVAL_MINUTES,
  computeNextRefreshAt,
  createProxyAutoUpdate,
  isAutoUpdateDue,
  normalizeAutoUpdatePrefs,
  normalizeIntervalMinutes,
} from './proxyAutoUpdate'

/**
 * 订阅自动更新的纯逻辑与运行时。
 *
 * 运行时全部依赖注入：目录给临时目录、时钟给假时钟、fetch 给假 fetch，
 * 所以这些用例不联网也不碰用户的真实数据目录。
 */

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-auto-update-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

describe('normalizeIntervalMinutes', () => {
  it('接受 1–1440 的整数', () => {
    expect(normalizeIntervalMinutes(1)).toBe(1)
    expect(normalizeIntervalMinutes(60)).toBe(60)
    expect(normalizeIntervalMinutes(1440)).toBe(1440)
  })

  it('非法值回退到 60', () => {
    expect(normalizeIntervalMinutes(0)).toBe(DEFAULT_INTERVAL_MINUTES)
    expect(normalizeIntervalMinutes(-5)).toBe(DEFAULT_INTERVAL_MINUTES)
    expect(normalizeIntervalMinutes(1441)).toBe(DEFAULT_INTERVAL_MINUTES)
    expect(normalizeIntervalMinutes(12.5)).toBe(DEFAULT_INTERVAL_MINUTES)
    expect(normalizeIntervalMinutes('60')).toBe(DEFAULT_INTERVAL_MINUTES)
    expect(normalizeIntervalMinutes(undefined)).toBe(DEFAULT_INTERVAL_MINUTES)
  })
})

describe('normalizeAutoUpdatePrefs', () => {
  it('缺省时给出一份默认偏好', () => {
    expect(normalizeAutoUpdatePrefs(null)).toEqual({
      enabled: false,
      intervalMinutes: 60,
      lastUpdatedAt: '',
      lastError: '',
    })
  })

  it('脏数据被夹回合法形状', () => {
    expect(normalizeAutoUpdatePrefs({ enabled: 'yes', intervalMinutes: 9999 })).toMatchObject({
      enabled: false,
      intervalMinutes: 60,
    })
  })
})

describe('computeNextRefreshAt / isAutoUpdateDue', () => {
  const now = new Date('2026-11-07T10:00:00.000Z')

  it('以上次成功时间为基准算下次', () => {
    const next = computeNextRefreshAt(
      { enabled: true, intervalMinutes: 30, lastUpdatedAt: '2026-11-07T09:00:00.000Z', lastError: '' },
      now,
    )
    expect(next).toBe('2026-11-07T09:30:00.000Z')
  })

  it('从没成功过就以现在为基准', () => {
    const next = computeNextRefreshAt(
      { enabled: true, intervalMinutes: 60, lastUpdatedAt: '', lastError: '' },
      now,
    )
    expect(next).toBe('2026-11-07T11:00:00.000Z')
  })

  it('关着开关时没有下次', () => {
    expect(
      computeNextRefreshAt({ enabled: false, intervalMinutes: 60, lastUpdatedAt: '', lastError: '' }, now),
    ).toBe('')
  })

  it('到期判定跟着开关走', () => {
    const overdue = { enabled: true, intervalMinutes: 30, lastUpdatedAt: '2026-11-07T09:00:00.000Z', lastError: '' }
    expect(isAutoUpdateDue(overdue, now)).toBe(true)
    expect(isAutoUpdateDue({ ...overdue, enabled: false }, now)).toBe(false)
    expect(
      isAutoUpdateDue({ ...overdue, lastUpdatedAt: '2026-11-07T09:59:00.000Z' }, now),
    ).toBe(false)
  })
})

describe('createProxyAutoUpdate', () => {
  it('重拉成功记时间并清空上次错误', async () => {
    const dir = await tempDir()
    const runtime = createProxyAutoUpdate({
      dir,
      readSubscriptionUrl: () => 'https://example.com/sub',
      fetch: async () => 'vless://uuid@jp.example.com:443?security=reality#%E6%97%A5%E6%9C%AC',
      now: () => new Date('2026-11-07T10:00:00.000Z'),
    })
    await runtime.setPrefs({ enabled: true, intervalMinutes: 30 })
    const result = await runtime.refresh()
    expect(result.ok).toBe(true)
    const prefs = await runtime.readPrefs()
    expect(prefs.lastUpdatedAt).toBe('2026-11-07T10:00:00.000Z')
    expect(prefs.lastError).toBe('')
  })

  it('重拉失败记中文原因且不抹掉上次成功时间', async () => {
    const dir = await tempDir()
    const runtime = createProxyAutoUpdate({
      dir,
      readSubscriptionUrl: () => 'https://example.com/sub',
      fetch: async () => {
        throw new Error('HTTP 502')
      },
      now: () => new Date('2026-11-07T10:00:00.000Z'),
    })
    await runtime.setPrefs({ enabled: true, intervalMinutes: 30 })
    const failed = await runtime.refresh()
    expect(failed.ok).toBe(false)
    expect(failed.message).toContain('订阅拉取失败')
    const prefs = await runtime.readPrefs()
    expect(prefs.lastError).toContain('HTTP 502')
    expect(prefs.lastUpdatedAt).toBe('')

    // 再成功一次：错误被清空
    const runtime2 = createProxyAutoUpdate({
      dir,
      readSubscriptionUrl: () => 'https://example.com/sub',
      fetch: async () => 'vless://uuid@jp.example.com:443#%E6%97%A5%E6%9C%AC',
      now: () => new Date('2026-11-07T11:00:00.000Z'),
    })
    expect((await runtime2.refresh()).ok).toBe(true)
    expect((await runtime2.readPrefs()).lastError).toBe('')
  })

  it('没有订阅地址时报中文原因', async () => {
    const dir = await tempDir()
    const runtime = createProxyAutoUpdate({
      dir,
      readSubscriptionUrl: () => '  ',
      fetch: async () => 'x',
    })
    const result = await runtime.refresh()
    expect(result.ok).toBe(false)
    expect(result.message).toBe('还没有填写订阅地址')
  })

  it('间隔非法时存的是回退值', async () => {
    const dir = await tempDir()
    const runtime = createProxyAutoUpdate({ dir, readSubscriptionUrl: () => '', fetch: async () => 'x' })
    const prefs = await runtime.setPrefs({ enabled: true, intervalMinutes: 5000 })
    expect(prefs.intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES)
  })

  it('偏好落盘，重开进程读得到', async () => {
    const dir = await tempDir()
    const first = createProxyAutoUpdate({ dir, readSubscriptionUrl: () => '', fetch: async () => 'x' })
    await first.setPrefs({ enabled: true, intervalMinutes: 45 })
    const second = createProxyAutoUpdate({ dir, readSubscriptionUrl: () => '', fetch: async () => 'x' })
    expect((await second.readPrefs()).intervalMinutes).toBe(45)
    const raw = JSON.parse(await readFile(join(dir, 'proxy-auto-update.json'), 'utf-8'))
    expect(raw.enabled).toBe(true)
  })

  it('没到期不重拉，到期才重拉', async () => {
    const dir = await tempDir()
    let current = new Date('2026-11-07T10:00:00.000Z')
    let calls = 0
    const runtime = createProxyAutoUpdate({
      dir,
      readSubscriptionUrl: () => 'https://example.com/sub',
      fetch: async () => {
        calls += 1
        return 'vless://uuid@jp.example.com:443#%E6%97%A5%E6%9C%AC'
      },
      now: () => current,
    })
    await runtime.setPrefs({ enabled: true, intervalMinutes: 60 })
    // 刚成功重拉过一次：下次重拉在 11:00
    expect((await runtime.refresh()).ok).toBe(true)
    expect(calls).toBe(1)

    // 10:30 还没到期
    current = new Date('2026-11-07T10:30:00.000Z')
    expect(await runtime.runDue()).toBe(false)
    expect(calls).toBe(1)

    // 11:05 到期
    current = new Date('2026-11-07T11:05:00.000Z')
    expect(await runtime.runDue()).toBe(true)
    expect(calls).toBe(2)
  })

  it('关掉开关后不再重拉', async () => {
    const dir = await tempDir()
    let current = new Date('2026-11-07T10:00:00.000Z')
    let calls = 0
    const runtime = createProxyAutoUpdate({
      dir,
      readSubscriptionUrl: () => 'https://example.com/sub',
      fetch: async () => {
        calls += 1
        return 'vless://uuid@jp.example.com:443#%E6%97%A5%E6%9C%AC'
      },
      now: () => current,
    })
    await runtime.setPrefs({ enabled: true, intervalMinutes: 60 })
    await runtime.setPrefs({ enabled: false })
    current = new Date('2026-11-07T12:00:00.000Z')
    expect(await runtime.runDue()).toBe(false)
    expect(calls).toBe(0)
  })

  it('重拉只更新正文缓存，不碰节点切换', async () => {
    const dir = await tempDir()
    const applied: string[] = []
    const runtime = createProxyAutoUpdate({
      dir,
      readSubscriptionUrl: () => 'https://example.com/sub',
      fetch: async () => 'vless://uuid@jp.example.com:443#%E6%97%A5%E6%9C%AC',
      applyBody: (body) => {
        applied.push(body)
      },
    })
    await runtime.refresh()
    expect(applied).toHaveLength(1)
    expect(applied[0]).toContain('vless://')
  })
})
