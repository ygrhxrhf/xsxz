// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadTencentMap, resetTencentMapLoaderForTests, tencentMapScriptUrl } from './tencentMapLoader'

const KEY = 'test-map-key'
const CALLBACK = '__spbfTencentMapReady'

function scripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>('#spbf-tencent-map')]
}

function callbackOf(script: HTMLScriptElement): string {
  return new URL(script.src).searchParams.get('callback') ?? ''
}

function fakeApi() {
  class FakeMap { constructor(public container: HTMLElement, public options: unknown) {} }
  class FakeLatLng { constructor(public latitude: number, public longitude: number) {} }
  return { maps: { Map: FakeMap, LatLng: FakeLatLng } }
}

beforeEach(() => { resetTencentMapLoaderForTests() })

describe('tencentMapLoader（腾讯地图按需加载）', () => {
  it('脚本地址带 Key 与全局回调名', () => {
    expect(tencentMapScriptUrl(KEY)).toBe(
      `https://map.qq.com/api/js?v=2.exp&key=${KEY}&callback=${CALLBACK}`,
    )
  })

  it('空 Key 直接拒绝，不插入脚本', async () => {
    await expect(loadTencentMap('   ')).rejects.toThrow('未配置腾讯地图 Key')
    expect(scripts()).toHaveLength(0)
  })

  it('回调就绪后返回地图 API，并清掉全局回调', async () => {
    const loading = loadTencentMap(KEY, 50)
    const script = scripts()[0]!
    expect(script.src).toContain(`key=${KEY}`)
    const callback = callbackOf(script)
    const api = fakeApi()
    ;(window as unknown as Record<string, unknown>).qq = api
    ;(window as unknown as Record<string, () => void>)[callback]()

    await expect(loading).resolves.toBe(api)
    expect((window as unknown as Record<string, unknown>)[callback]).toBeUndefined()
  })

  it('同一 Key 只拉一次脚本', async () => {
    const loading = loadTencentMap(KEY, 50)
    const callback = callbackOf(scripts()[0]!)
    const api = fakeApi()
    ;(window as unknown as Record<string, unknown>).qq = api
    ;(window as unknown as Record<string, () => void>)[callback]()
    await expect(loading).resolves.toBe(api)

    await expect(loadTencentMap(KEY)).resolves.toBe(api)
    expect(scripts()).toHaveLength(1)
  })

  it('脚本加载失败给出可读错误', async () => {
    const loading = loadTencentMap(KEY, 50)
    scripts()[0]!.dispatchEvent(new Event('error'))
    await expect(loading).rejects.toThrow('腾讯地图脚本加载失败')
  })

  it('超时提示检查网络并允许重试', async () => {
    await expect(loadTencentMap(KEY, 5)).rejects.toThrow('腾讯地图加载超时')
  })
})
