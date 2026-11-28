import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setMapImage } from './mapImage'
import { recognizeOriginalMap } from './atlasRecognition'
import { setAtlasCitiesForTests } from './atlasCities'
import { bookDir, createBookFromBootstrap, setLibraryPath } from './library'

/**
 * 视觉服务选择：设置里的地址优先；没配置时探本机网关；两者都不可用才回退聊天 AI。
 * 这里把「探测」与「识别」分开钉，免得一次失败被误判成另一个原因。
 */
describe('识别服务的选择', () => {
  let lib = ''
  let source = ''

  beforeEach(async () => {
    lib = await mkdtemp(join(tmpdir(), 'spbf-vision-lib-'))
    source = await mkdtemp(join(tmpdir(), 'spbf-vision-src-'))
    await setLibraryPath(lib)
    await createBookFromBootstrap({ bookId: 'd_vision', title: '视觉书', author: '', importType: 'txt', chapterTitles: ['第一章'] })
    const png = join(source, 'map.png')
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]))
    expect((await setMapImage('d_vision', png)).ok).toBe(true)
  })

  afterEach(async () => {
    setAtlasCitiesForTests(null)
    await rm(lib, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  })

  it('免 Key 的网关不发 Authorization 头', async () => {
    setAtlasCitiesForTests([['1', 'London', 'GB', -0.11, 51.5, ['London']]])
    const seen: Array<Record<string, string> | undefined> = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({ isMap: true, confidence: 0.9, bounds: [[-12, 35], [16, 64]], places: [] }) },
        }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    await recognizeOriginalMap('d_vision', {
      config: { baseUrl: 'http://127.0.0.1:3425/v1', model: 'auto/glm-5.3-flash', apiKey: '', provider: 'custom' },
      bookTitle: '视觉书',
      fetchImpl,
      refresh: true,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.Authorization).toBeUndefined()
  })

  it('有 Key 时带上 Bearer 头', async () => {
    setAtlasCitiesForTests([])
    let headers: Record<string, string> | undefined
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ isMap: false, confidence: 0.99, places: [] }) } }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    await recognizeOriginalMap('d_vision', {
      config: { baseUrl: 'https://llm.test/v1', model: 'm', apiKey: 'k', provider: 'custom' },
      bookTitle: '视觉书',
      fetchImpl,
      refresh: true,
    })
    expect(headers?.Authorization).toBe('Bearer k')
    expect(headers?.['Content-Type']).toBe('application/json')
  })

  it('换了模型就不再复用上一个模型写的缓存', async () => {
    setAtlasCitiesForTests([['1', 'London', 'GB', -0.11, 51.5, ['London']]])
    let calls = 0
    const ok = (async () => {
      calls += 1
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({ isMap: true, confidence: 0.9, bounds: [[-12, 35], [16, 64]], places: [] }) },
        }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const first = await recognizeOriginalMap('d_vision', {
      config: { baseUrl: 'http://127.0.0.1:3425/v1', model: 'model-a', apiKey: '', provider: 'custom' },
      bookTitle: '视觉书', fetchImpl: ok, refresh: true,
    })
    expect(first.ok && first.recognition.cached).toBe(false)

    // 同模型：命中缓存，不再请求。
    const cached = await recognizeOriginalMap('d_vision', {
      config: { baseUrl: 'http://127.0.0.1:3425/v1', model: 'model-a', apiKey: '', provider: 'custom' },
      bookTitle: '视觉书', fetchImpl: ok,
    })
    expect(cached.ok && cached.recognition.cached).toBe(true)
    expect(calls).toBe(1)

    // 换模型：缓存作废，重新请求。
    const switched = await recognizeOriginalMap('d_vision', {
      config: { baseUrl: 'http://127.0.0.1:3425/v1', model: 'model-b', apiKey: '', provider: 'custom' },
      bookTitle: '视觉书', fetchImpl: ok,
    })
    expect(switched.ok && switched.recognition.cached).toBe(false)
    expect(switched.ok && switched.recognition.model).toBe('model-b')
    expect(calls).toBe(2)
    expect(bookDir('d_vision')).toContain('d_vision')
  })
})