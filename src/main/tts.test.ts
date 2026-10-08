import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ dir: '', key: 'secret-tts-key' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.dir } }))
vi.mock('./settings', () => ({
  getSettings: async () => ({ tts: { onlineEndpoint: 'https://voice.example/v1/audio/speech', onlineModel: 'model', onlineVoice: 'voice' } }),
  getTtsApiKey: async () => mocks.key,
}))
vi.mock('./library', () => ({ bookDir: (bookId: string) => join(mocks.dir, 'library', bookId) }))

import { cancelTts, normalizeTtsPosition, readTtsPosition, synthesizeTts, trimTtsCache, validateTtsEndpoint, writeTtsPosition } from './tts'

beforeEach(async () => { mocks.dir = await mkdtemp(join(tmpdir(), 'spbf-tts-')) })
afterEach(async () => { vi.unstubAllGlobals(); await rm(mocks.dir, { recursive: true, force: true }) })

describe('online TTS', () => {
  it('sends the compatible request with the separate key and reuses cached audio', async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer secret-tts-key' })
      expect(JSON.parse(String(options.body))).toEqual({ model: 'model', voice: 'voice', input: '你好', response_format: 'mp3' })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect([...await synthesizeTts('first', '你好')]).toEqual([1, 2, 3])
    expect([...await synthesizeTts('second', '你好')]).toEqual([1, 2, 3])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces quota failures and cancels before sending a stopped request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota', { status: 429 })))
    await expect(synthesizeTts('quota', '额度测试')).rejects.toThrow('额度不足')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const pending = synthesizeTts('stopped', '取消测试')
    cancelTts('stopped')
    await expect(pending).rejects.toThrow('已取消')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects unsafe endpoints and preserves the listening position', async () => {
    expect(() => validateTtsEndpoint('http://voice.example/v1/audio/speech')).toThrow()
    expect(validateTtsEndpoint('http://localhost:8000/v1/audio/speech')).toContain('localhost')
    const dir = join(mocks.dir, 'library', 'book1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'book.json'), '{}')
    const position = { chapterId: 'c1', paragraphIndex: 2, bodyHash: '1234abcd', updatedAt: new Date().toISOString() }
    await writeTtsPosition('book1', position)
    expect(await readTtsPosition('book1')).toEqual(position)
    expect(normalizeTtsPosition({ ...position, paragraphIndex: -1 })).toBeNull()
    await expect(writeTtsPosition('../escape', position)).rejects.toThrow()
  })

  it('removes least recently used cached files above the limit', async () => {
    const dir = join(mocks.dir, 'cache')
    await mkdir(dir)
    const oldFile = join(dir, `${'a'.repeat(64)}.mp3`)
    const newFile = join(dir, `${'b'.repeat(64)}.mp3`)
    await writeFile(oldFile, Buffer.alloc(4))
    await writeFile(newFile, Buffer.alloc(4))
    await utimes(oldFile, new Date(1000), new Date(1000))
    await trimTtsCache(dir, 4)
    expect(await readdir(dir)).toEqual([`${'b'.repeat(64)}.mp3`])
    expect((await readFile(newFile)).length).toBe(4)
  })
})
