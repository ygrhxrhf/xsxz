import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { monthlyBudgetStatus, reserveAutomaticTokens } from './aiMonthlyBudget'
import { setLibraryPath } from './library'

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spbf-budget-'))
  await setLibraryPath(directory)
})

afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function seedBookDir(bookId: string) {
  await mkdir(join(directory, bookId, 'ai'), { recursive: true })
}

describe('monthlyBudgetStatus', () => {
  it('returns full remaining when no usage exists', async () => {
    await seedBookDir('i_budget')
    const status = await monthlyBudgetStatus('i_budget', 100_000)
    expect(status.usedTokens).toBe(0)
    expect(status.reservedTokens).toBe(0)
    expect(status.remainingTokens).toBe(100_000)
    expect(status.limitTokens).toBe(100_000)
  })
})

describe('reserveAutomaticTokens', () => {
  it('reserves, settles with reported usage, and updates consumed', async () => {
    await seedBookDir('i_budget')
    const reservation = await reserveAutomaticTokens('i_budget', 1000, 100_000)
    const during = await monthlyBudgetStatus('i_budget', 100_000)
    expect(during.reservedTokens).toBe(1000)
    expect(during.remainingTokens).toBe(99_000)

    await reservation.settle({ inputTokens: 800, outputTokens: 200 })
    const after = await monthlyBudgetStatus('i_budget', 100_000)
    expect(after.usedTokens).toBe(1000)
    expect(after.reservedTokens).toBe(0)
    expect(after.remainingTokens).toBe(99_000)
  })

  it('consumes the estimate when the service reports no usage', async () => {
    await seedBookDir('i_budget')
    const reservation = await reserveAutomaticTokens('i_budget', 500, 100_000)
    await reservation.settle()
    const after = await monthlyBudgetStatus('i_budget', 100_000)
    expect(after.usedTokens).toBe(500)
  })

  it('releases the reservation without charging', async () => {
    await seedBookDir('i_budget')
    const reservation = await reserveAutomaticTokens('i_budget', 1000, 100_000)
    await reservation.release()
    const after = await monthlyBudgetStatus('i_budget', 100_000)
    expect(after.usedTokens).toBe(0)
    expect(after.reservedTokens).toBe(0)
    expect(after.remainingTokens).toBe(100_000)
  })

  it('throws when the reservation would exceed the limit', async () => {
    await seedBookDir('i_budget')
    const first = await reserveAutomaticTokens('i_budget', 80_000, 100_000)
    await expect(reserveAutomaticTokens('i_budget', 50_000, 100_000)).rejects.toThrow('额度已到上限')
    await first.release()
  })

  it('rejects invalid estimates', async () => {
    await seedBookDir('i_budget')
    await expect(reserveAutomaticTokens('i_budget', 0, 100_000)).rejects.toThrow('估算无效')
    await expect(reserveAutomaticTokens('i_budget', -1, 100_000)).rejects.toThrow('估算无效')
  })
})

describe('crash recovery', () => {
  it('treats orphan reservations as consumed on next read', async () => {
    const bookId = 'i_budget'
    await seedBookDir(bookId)
    const date = new Date()
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    await writeFile(join(directory, bookId, 'ai', 'monthly-usage.json'), JSON.stringify({
      version: 1, month, consumedTokens: 50, reservations: { 'orphan-1': 100 },
    }), 'utf-8')
    const status = await monthlyBudgetStatus(bookId, 100_000)
    expect(status.usedTokens).toBe(150)
    expect(status.reservedTokens).toBe(0)
    expect(status.remainingTokens).toBe(99_850)
  })

  it('recovers from a corrupt file by resetting to zero', async () => {
    const bookId = 'i_budget'
    await seedBookDir(bookId)
    await writeFile(join(directory, bookId, 'ai', 'monthly-usage.json'), '{broken', 'utf-8')
    const status = await monthlyBudgetStatus(bookId, 100_000)
    expect(status.usedTokens).toBe(0)
    expect(status.remainingTokens).toBe(100_000)
  })

  it('resets when the stored month does not match the current month', async () => {
    const bookId = 'i_budget'
    await seedBookDir(bookId)
    await writeFile(join(directory, bookId, 'ai', 'monthly-usage.json'), JSON.stringify({
      version: 1, month: '2020-01', consumedTokens: 9999, reservations: {},
    }), 'utf-8')
    const status = await monthlyBudgetStatus(bookId, 100_000)
    expect(status.usedTokens).toBe(0)
    expect(status.month).not.toBe('2020-01')
  })
})
