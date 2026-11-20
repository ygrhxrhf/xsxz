import { describe, expect, it, vi } from 'vitest'
import type { AutoUpdateCheckPrefs, CheckAllResult } from '../shared/types'

vi.mock('./settings', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}))
vi.mock('./download', () => ({
  checkAllUpdates: vi.fn(),
  isDownloadBusy: vi.fn(() => false),
}))
vi.mock('./libraryMaintenance', () => ({
  isLibraryRestoring: vi.fn(() => false),
}))

import { formatAutoUpdateSummary, isAutoUpdateCheckDue, runAutoUpdateCheckIfDue } from './autoUpdateCheck'

const HOUR = 60 * 60_000
const PREFS: AutoUpdateCheckPrefs = {
  enabled: true,
  intervalHours: 24,
  lastCheckedAt: '',
  lastSummary: '',
}

function result(partial: Partial<CheckAllResult> = {}): CheckAllResult {
  return {
    ok: true,
    total: 0,
    checked: 0,
    booksWithUpdates: 0,
    results: [],
    ...partial,
  }
}

describe('isAutoUpdateCheckDue', () => {
  it('从未检查过视为到期', () => {
    expect(isAutoUpdateCheckDue(PREFS, Date.now())).toBe(true)
  })

  it('时间戳损坏也视为到期，不会永久不再检查', () => {
    expect(isAutoUpdateCheckDue({ ...PREFS, lastCheckedAt: 'not-a-date' }, Date.now())).toBe(true)
  })

  it('未满间隔不跑，满了就跑', () => {
    const now = Date.parse('2026-11-21T12:00:00.000Z')
    expect(isAutoUpdateCheckDue({ ...PREFS, lastCheckedAt: new Date(now - 23 * HOUR).toISOString() }, now)).toBe(false)
    expect(isAutoUpdateCheckDue({ ...PREFS, lastCheckedAt: new Date(now - 25 * HOUR).toISOString() }, now)).toBe(true)
  })

  it('按配置的间隔判定', () => {
    const now = Date.parse('2026-11-21T12:00:00.000Z')
    const prefs = { ...PREFS, intervalHours: 72, lastCheckedAt: new Date(now - 25 * HOUR).toISOString() }
    expect(isAutoUpdateCheckDue(prefs, now)).toBe(false)
  })
})

describe('formatAutoUpdateSummary', () => {
  it('书库里没有可追更的书', () => {
    expect(formatAutoUpdateSummary(result())).toBe('书库里还没有可追更的下载书')
  })

  it('检查了但没有新章', () => {
    const summary = formatAutoUpdateSummary(
      result({ total: 2, checked: 2, results: [
        { ok: true, bookId: 'a', title: '甲', added: 0, changed: 0 },
        { ok: false, bookId: 'b', title: '乙', message: '需要登录' },
      ] }),
    )
    expect(summary).toBe('已检查 2 本，暂无新章，1 本检查失败')
  })

  it('有新章时给出书名和补章总数', () => {
    const summary = formatAutoUpdateSummary(
      result({ total: 2, checked: 2, booksWithUpdates: 1, results: [
        { ok: true, bookId: 'a', title: '甲', added: 5, changed: 1 },
        { ok: true, bookId: 'b', title: '乙', added: 0, changed: 0 },
      ] }),
    )
    expect(summary).toBe('已检查 2 本，《甲》有新章，共补 5 章')
  })

  it('超过三本时只列前三本', () => {
    const summary = formatAutoUpdateSummary(
      result({ total: 4, checked: 4, booksWithUpdates: 4, results: ['甲', '乙', '丙', '丁'].map((title, i) => ({
        ok: true, bookId: String(i), title, added: 2, changed: 0,
      })) }),
    )
    expect(summary).toBe('已检查 4 本，《甲》《乙》《丙》等 4 本有新章，共补 8 章')
  })
})

describe('runAutoUpdateCheckIfDue', () => {
  const now = new Date('2026-11-21T12:00:00.000Z')

  it('关闭时不检查', async () => {
    const checkAll = vi.fn()
    const outcome = await runAutoUpdateCheckIfDue({
      now,
      getPrefs: async () => ({ ...PREFS, enabled: false }),
      checkAll,
    })
    expect(outcome.status).toBe('disabled')
    expect(checkAll).not.toHaveBeenCalled()
  })

  it('未到期时不检查', async () => {
    const checkAll = vi.fn()
    const outcome = await runAutoUpdateCheckIfDue({
      now,
      getPrefs: async () => ({ ...PREFS, lastCheckedAt: new Date(now.getTime() - HOUR).toISOString() }),
      checkAll,
    })
    expect(outcome.status).toBe('notDue')
    expect(checkAll).not.toHaveBeenCalled()
  })

  it('忙时不检查也不写时间戳', async () => {
    const checkAll = vi.fn()
    const savePrefs = vi.fn()
    const outcome = await runAutoUpdateCheckIfDue({
      now,
      getPrefs: async () => PREFS,
      busy: () => true,
      checkAll,
      savePrefs,
    })
    expect(outcome.status).toBe('busy')
    expect(checkAll).not.toHaveBeenCalled()
    expect(savePrefs).not.toHaveBeenCalled()
  })

  it('批量检查被拒绝时不写时间戳，下次启动重试', async () => {
    const savePrefs = vi.fn()
    const outcome = await runAutoUpdateCheckIfDue({
      now,
      getPrefs: async () => PREFS,
      busy: () => false,
      checkAll: async () => ({ ...result(), ok: false, message: '已有下载任务' }),
      savePrefs,
    })
    expect(outcome).toEqual({ status: 'failed', message: '已有下载任务' })
    expect(savePrefs).not.toHaveBeenCalled()
  })

  it('空书库只写时间，不写摘要，避免每次启动都弹提示', async () => {
    const savePrefs = vi.fn(async () => ({}))
    const outcome = await runAutoUpdateCheckIfDue({
      now,
      getPrefs: async () => PREFS,
      busy: () => false,
      checkAll: async () => result(),
      savePrefs,
    })
    expect(outcome).toEqual({ status: 'ran', summary: '', result: result() })
    expect(savePrefs).toHaveBeenCalledWith({ lastCheckedAt: now.toISOString(), lastSummary: '' })
  })

  it('跑完把时间和摘要写回设置', async () => {
    const savePrefs = vi.fn(async () => ({}))
    const checkResult = result({
      total: 1, checked: 1, booksWithUpdates: 1,
      results: [{ ok: true, bookId: 'a', title: '甲', added: 3, changed: 0 }],
    })
    const outcome = await runAutoUpdateCheckIfDue({
      now,
      getPrefs: async () => PREFS,
      busy: () => false,
      checkAll: async () => checkResult,
      savePrefs,
    })
    expect(outcome).toEqual({
      status: 'ran',
      summary: '已检查 1 本，《甲》有新章，共补 3 章',
      result: checkResult,
    })
    expect(savePrefs).toHaveBeenCalledWith({
      lastCheckedAt: now.toISOString(),
      lastSummary: '已检查 1 本，《甲》有新章，共补 3 章',
    })
  })
})
