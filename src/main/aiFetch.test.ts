import { afterEach, expect, it, vi } from 'vitest'
import { aiFetch } from './aiFetch'

afterEach(() => { vi.unstubAllGlobals() })

it('单测环境没有 Electron 时退回全局 fetch', async () => {
  const response = new Response('ok', { status: 200 })
  const fetchMock = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetchMock)
  await expect(aiFetch('https://example.com/v1/chat/completions', { method: 'POST' }))
    .resolves.toBe(response)
  expect(fetchMock).toHaveBeenCalledWith('https://example.com/v1/chat/completions', { method: 'POST' })
})
