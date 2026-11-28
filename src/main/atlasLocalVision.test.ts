import { describe, expect, it, vi } from 'vitest'
import { ATLAS_LOCAL_VISION, localVisionAvailable } from './atlasRecognition'

/**
 * 书中地图识别的视觉服务选择：默认走本机 magpie 网关（免 Key），
 * 网关不可用时调用方回退聊天 AI。这里只钉「探测」这一步的判据与代价。
 */
describe('本机 magpie 视觉服务', () => {
  it('默认地址与模型指向本机网关', () => {
    expect(ATLAS_LOCAL_VISION.baseUrl).toBe('http://127.0.0.1:3425/v1')
    expect(ATLAS_LOCAL_VISION.model).toBe('auto/glm-5.3-flash')
  })

  it('探测只打 /models，不发正文也不带凭据', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"data":[]}', { status: 200 })) as unknown as typeof fetch
    expect(await localVisionAvailable(fetchImpl)).toBe(true)
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3425/v1/models')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.headers).toBeUndefined()
    expect(init.body).toBeUndefined()
  })

  it('网关未启动、返回非 2xx 或报错时都判定为不可用', async () => {
    const refused = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await localVisionAvailable(refused)).toBe(false)
    const notFound = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect(await localVisionAvailable(notFound)).toBe(false)
  })
})