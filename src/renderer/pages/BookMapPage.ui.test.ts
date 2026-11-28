// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 书中地图页只负责状态展示：Key 缺失、加载中、加载失败、底图就绪。
 * 真正的腾讯脚本行为由 `tencentMapLoader.test.ts` 覆盖，这里用假的 Map 构造函数
 * 钉住「什么时候建图、失败时给什么提示、去设置怎么走」。
 */
vi.mock('./tencentMapLoader', () => ({
  loadTencentMap: vi.fn(),
}))

import type { AiPlace } from '@shared/types'
import BookMapPage from './BookMapPage.vue'
import { loadTencentMap } from './tencentMapLoader'

const loadMock = vi.mocked(loadTencentMap)

const mapCalls: Array<{ container: HTMLElement; options: unknown }> = []
const markerCalls: Array<{ options: Record<string, unknown> }> = []
const markerListeners: Array<() => void> = []
const infoCalls: Array<{ options: Record<string, unknown> }> = []
const centerCalls: Array<{ latitude: number; longitude: number }> = []
const zoomCalls: number[] = []
let fitCalls = 0
class FakeMap {
  constructor(container: HTMLElement, options: unknown) {
    mapCalls.push({ container, options })
  }
  fitBounds() { fitCalls += 1 }
  setCenter(point: unknown) {
    const at = point as { latitude?: number; longitude?: number }
    centerCalls.push({ latitude: Number(at.latitude), longitude: Number(at.longitude) })
  }
  setZoom(zoom: number) { zoomCalls.push(zoom) }
}
class FakeLatLng { constructor(public latitude: number, public longitude: number) {} }
class FakeMarker {
  constructor(options: Record<string, unknown>) { markerCalls.push({ options }) }
  setMap() {}
}
class FakeBounds { extend() {} }
class FakeInfoWindow {
  constructor(options: Record<string, unknown>) { infoCalls.push({ options }) }
  open() {}
  close() {}
}
const fakeApi = {
  maps: {
    Map: FakeMap,
    LatLng: FakeLatLng,
    Marker: FakeMarker,
    LatLngBounds: FakeBounds,
    InfoWindow: FakeInfoWindow,
    event: { addListener: (_target: unknown, _name: string, handler: () => void) => { markerListeners.push(handler) } },
  },
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

interface MapApiOverrides {
  extractPlaces?: ReturnType<typeof vi.fn>
  getPlaces?: ReturnType<typeof vi.fn>
  geocodePlaces?: ReturnType<typeof vi.fn>
  getImage?: ReturnType<typeof vi.fn>
  setImage?: ReturnType<typeof vi.fn>
  openFile?: ReturnType<typeof vi.fn>
  confirmPlace?: ReturnType<typeof vi.fn>
  searchPlaceCandidates?: ReturnType<typeof vi.fn>
  choosePlaceCandidate?: ReturnType<typeof vi.fn>
  addManualPlace?: ReturnType<typeof vi.fn>
  recognize?: ReturnType<typeof vi.fn>
  getRecognition?: ReturnType<typeof vi.fn>
}

function installMapApi(key: string, overrides: MapApiOverrides = {}) {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      map: {
        getKey: async () => key,
        getImage: overrides.getImage ?? vi.fn(async () => ({ ok: true, url: null })),
        setImage: overrides.setImage ?? vi.fn(async () => ({ ok: false, message: '测试桩：不保存图片' })),
        getPlaces: overrides.getPlaces ?? vi.fn(async () => ({ ok: true, places: [] })),
        geocodePlaces: overrides.geocodePlaces ?? vi.fn(async () => ({ ok: false, message: '测试桩：不定位' })),
        confirmPlace: overrides.confirmPlace ?? vi.fn(async () => ({ ok: false, message: '测试桩：不确认' })),
        searchPlaceCandidates: overrides.searchPlaceCandidates ?? vi.fn(async () => ({ ok: false, message: '测试桩：不搜候选' })),
        choosePlaceCandidate: overrides.choosePlaceCandidate ?? vi.fn(async () => ({ ok: false, message: '测试桩：不选候选' })),
        addManualPlace: overrides.addManualPlace ?? vi.fn(async () => ({ ok: false, message: '测试桩：不手工标注' })),
        recognize: overrides.recognize ?? vi.fn(async () => ({ ok: false, message: '测试桩：不识别' })),
        getRecognition: overrides.getRecognition ?? vi.fn(async () => ({ ok: true, recognition: null })),
      },
      dialog: { openFile: overrides.openFile ?? vi.fn(async () => ({ filePaths: [] })) },
      ai: { extractPlaces: overrides.extractPlaces ?? vi.fn(async () => ({ ok: false, message: '测试桩：不抽取' })) },
    },
  })
}

async function mountPage() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const goSettings = vi.fn()
  const selectPlace = vi.fn()
  const app = createApp({
    render: () => h(BookMapPage, {
      bookId: 'book-1',
      bookTitle: '测试书',
      onGoSettings: goSettings,
      onSelectPlace: selectPlace,
    }),
  })
  app.mount(host)
  await nextTick(); await flush(); await nextTick()
  return { app, goSettings, selectPlace }
}

const PLACE: AiPlace = {
  id: 'place-c1-0-8',
  name: '长安',
  aliases: [],
  kind: 'city',
  chapterId: 'c1',
  chapterTitle: '第一章',
  paragraphIndex: 0,
  paragraphOffset: 8,
  excerpt: '东行至长安',
}

const PLACE_GEO = { ...PLACE, geocodeStatus: 'pending' as const }

/** 手工标注条目：id 带 `place-manual-anchor-` 前缀，段号与偏移指向正文。 */
const MANUAL_PLACE = {
  id: 'place-manual-anchor-2-6',
  name: '洛阳',
  aliases: [],
  kind: 'other' as const,
  chapterId: '',
  chapterTitle: '手工标注',
  paragraphIndex: 2,
  paragraphOffset: 6,
  excerpt: '',
  geocodeStatus: 'resolved' as const,
  location: { latitude: 34.6, longitude: 112.4 },
}

beforeEach(() => {
  loadMock.mockReset()
  mapCalls.length = 0
  markerCalls.length = 0
  markerListeners.length = 0
  infoCalls.length = 0
  centerCalls.length = 0
  zoomCalls.length = 0
  fitCalls = 0
  document.body.innerHTML = ''
})

describe('BookMapPage（书中地图页）', () => {
  it('未配置 Key：说明原因并可从空态去设置', async () => {
    installMapApi('')
    const { app, goSettings } = await mountPage()

    const overlay = document.querySelector('.book-map-overlay')
    expect(overlay?.textContent).toContain('未配置腾讯地图 Key')
    expect(document.querySelector('.book-map-canvas')).not.toBeNull()

    document.querySelector<HTMLButtonElement>('.book-map-overlay button')?.click()
    expect(goSettings).toHaveBeenCalledTimes(1)
    expect(loadMock).not.toHaveBeenCalled()
    app.unmount()
  })

  it('配置了 Key：底图加载完成后建图，左栏明确说明书中原图待提供', async () => {
    installMapApi('key-1')
    loadMock.mockResolvedValue(fakeApi)
    const { app } = await mountPage()

    expect(loadMock).toHaveBeenCalledWith('key-1')
    // 底图实例建在页面自己的容器里，且只建一次。
    expect(mapCalls).toHaveLength(1)
    expect(mapCalls[0]!.container).toBe(document.querySelector('.book-map-canvas'))
    expect((mapCalls[0]!.options as Record<string, unknown>).zoomControl).toBe(true)
    expect(document.querySelector('.book-map-overlay')).toBeNull()
    expect(document.querySelector('.book-map-original')?.textContent).toContain('尚未选择书中地图图片')
    app.unmount()
  })

  it('脚本加载失败：给出错误与离线提示，可重试', async () => {
    installMapApi('key-1')
    loadMock.mockRejectedValue(new Error('腾讯地图脚本加载失败，请检查网络或 Key 是否有效'))
    const { app } = await mountPage()

    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('腾讯地图脚本加载失败')
    expect(alert?.textContent).toContain('离线')
    expect(document.querySelector('.book-map-toolbar .book-map-button')).not.toBeNull()
    app.unmount()
  })

  it('抽取已读地名：显示名称/章节/段落，点击回传锚点', async () => {
    const extract = vi.fn(async () => ({
      ok: true,
      view: { places: [PLACE], chapterCount: 1, paragraphCount: 1, truncated: false, message: '' },
      budget: {},
    }))
    installMapApi('', {
      extractPlaces: extract,
      getPlaces: vi.fn(async () => ({ ok: true, places: [PLACE_GEO] })),
    })
    const { app, selectPlace } = await mountPage()

    document.querySelector<HTMLButtonElement>('.book-map-actions button')?.click()
    await flush(); await nextTick()

    expect(extract).toHaveBeenCalledWith('book-1', false)
    expect(document.querySelector('.book-map-place-name')?.textContent).toBe('长安')
    expect(document.querySelector('.book-map-place-meta')?.textContent).toContain('第一章 · 第 1 段')
    expect(document.querySelector('.book-map-place-excerpt')?.textContent).toBe('东行至长安')

    // 点地名只负责居中/高亮；跳原文是独立的「原文」按钮。
    document.querySelector<HTMLButtonElement>('.book-map-place')?.click()
    await nextTick()
    expect(selectPlace).not.toHaveBeenCalled()
    expect(document.querySelector('.book-map-budget')?.textContent).toContain('还没有坐标')
    ;[...document.querySelectorAll<HTMLButtonElement>('.book-map-place-actions button')]
      .find((button) => button.textContent === '原文')?.click()
    expect(selectPlace).toHaveBeenCalledWith({ paragraphIndex: 0, paragraphOffset: 8 })
    app.unmount()
  })

  it('预算超阈值时先提示，第二次点击带确认继续', async () => {
    const extract = vi.fn()
      .mockResolvedValueOnce({ ok: false, confirmationRequired: true, message: '预计输入约 50000 tokens。' })
      .mockResolvedValueOnce({
        ok: true,
        view: { places: [PLACE], chapterCount: 1, paragraphCount: 1, truncated: false, message: '' },
        budget: {},
      })
    installMapApi('', {
      extractPlaces: extract,
      getPlaces: vi.fn(async () => ({ ok: true, places: [PLACE_GEO] })),
    })
    const { app } = await mountPage()

    const button = () => document.querySelector<HTMLButtonElement>('.book-map-actions button')
    button()?.click()
    await flush(); await nextTick()
    expect(document.querySelector('.book-map-budget')?.textContent).toContain('预计输入约 50000 tokens')
    expect(button()?.textContent).toContain('确认继续抽取')

    button()?.click()
    await flush(); await nextTick()
    expect(extract).toHaveBeenLastCalledWith('book-1', true)
    expect(document.querySelector('.book-map-place-name')?.textContent).toBe('长安')
    app.unmount()
  })

  it('书中原图：读取已保存图片，选图后立即替换', async () => {
    const setImage = vi.fn(async () => ({ ok: true, url: 'file:///tmp/book/map/original.png' }))
    installMapApi('', {
      getImage: vi.fn(async () => ({ ok: true, url: 'file:///tmp/book/map/original.jpg' })),
      openFile: vi.fn(async () => ({ filePaths: ['C:\\tmp\\new-map.png'] })),
      setImage,
    })
    const { app } = await mountPage()
    await nextTick(); await flush()

    const image = () => document.querySelector<HTMLImageElement>('.book-map-original-image')
    expect(image()?.getAttribute('src')).toBe('file:///tmp/book/map/original.jpg')
    expect(document.querySelector('.book-map-original-head button')?.textContent).toContain('更换图片')

    document.querySelector<HTMLButtonElement>('.book-map-original-head button')?.click()
    await flush(); await nextTick()
    expect(setImage).toHaveBeenCalledWith({ bookId: 'book-1', sourcePath: 'C:\\tmp\\new-map.png' })
    expect(image()?.getAttribute('src')).toBe('file:///tmp/book/map/original.png')
    app.unmount()
  })

  it('低可信度地名标为待确认，确认后转为已定位、忽略后撤点', async () => {
    const ambiguous = {
      ...PLACE,
      geocodeStatus: 'ambiguous' as const,
      location: { latitude: 34.2, longitude: 108.9, reliability: 5 },
    }
    const confirmPlace = vi.fn(async (_bookId: string, placeId: string, accepted: boolean) => ({
      ok: true,
      places: [{
        ...ambiguous,
        geocodeStatus: accepted ? 'resolved' : 'ignored',
        ...(accepted ? {} : { location: undefined }),
      }],
    }))
    installMapApi('key-1', {
      getPlaces: vi.fn(async () => ({ ok: true, places: [ambiguous] })),
      confirmPlace,
    })
    loadMock.mockResolvedValue(fakeApi)
    const { app } = await mountPage()
    await nextTick(); await flush()

    expect(document.querySelector('.book-map-place-meta')?.textContent).toContain('待确认')
    const actions = () => [...document.querySelectorAll<HTMLButtonElement>('.book-map-place-actions button')]
    const confirmation = actions().find((button) => button.textContent === '确认')
    confirmation?.click()
    await flush(); await nextTick()
    expect(confirmPlace).toHaveBeenCalledWith('book-1', PLACE.id, true)
    expect(document.querySelector('.book-map-place-meta')?.textContent).toContain('已定位')
    expect(document.querySelector('.book-map-budget')?.textContent).toContain('已确认')
    app.unmount()
  })

  it('候选选择：搜索候选并写入选中坐标', async () => {
    const candidate = { id: 'poi-1', title: '常州站', address: '江苏省常州市', latitude: 31.79, longitude: 119.97 }
    const search = vi.fn(async () => ({
      ok: true,
      view: { candidates: [candidate], boundary: 'region(江苏省,0)', message: '' },
    }))
    const choose = vi.fn(async () => ({
      ok: true,
      places: [{ ...PLACE, geocodeStatus: 'resolved', location: { latitude: 31.79, longitude: 119.97, reliability: 9, source: 'search' } }],
    }))
    installMapApi('key-1', {
      getPlaces: vi.fn(async () => ({ ok: true, places: [PLACE_GEO] })),
      searchPlaceCandidates: search,
      choosePlaceCandidate: choose,
    })
    loadMock.mockResolvedValue(fakeApi)
    const { app } = await mountPage()
    await nextTick(); await flush()

    const candidateButton = () => [...document.querySelectorAll<HTMLButtonElement>('.book-map-place-actions button')]
      .find((button) => button.textContent === '候选')
    candidateButton()?.click()
    await flush(); await nextTick()
    expect(search).toHaveBeenCalledWith('book-1', PLACE.id)
    expect(document.querySelector('.book-map-candidate-title')?.textContent).toBe('常州站')
    expect(document.querySelector('.book-map-budget')?.textContent).toContain('region(江苏省,0)')

    document.querySelector<HTMLButtonElement>('.book-map-candidate')?.click()
    await flush(); await nextTick()
    expect(choose).toHaveBeenCalledWith('book-1', PLACE.id, { latitude: 31.79, longitude: 119.97 })
    expect(document.querySelector('.book-map-candidate')).toBeNull()
    expect(document.querySelector('.book-map-place-meta')?.textContent).toContain('已定位')
    app.unmount()
  })

  it('视野控制：全局收拢标记、区域放大选中地点；未找到可重试', async () => {
    const missing = { ...PLACE, id: 'place-c1-1-0', paragraphIndex: 1, geocodeStatus: 'not-found' as const }
    const located = {
      ...PLACE,
      id: 'place-c1-2-0',
      name: '上海',
      paragraphIndex: 2,
      geocodeStatus: 'resolved' as const,
      location: { latitude: 31.2, longitude: 121.5 },
    }
    const geocodePlaces = vi.fn(async () => ({
      ok: true,
      view: { places: [located], resolved: 1, ambiguous: 0, notFound: 0, cached: 0, message: '已定位 1 个地点' },
    }))
    installMapApi('key-1', {
      getPlaces: vi.fn(async () => ({ ok: true, places: [missing, located] })),
      geocodePlaces,
    })
    loadMock.mockResolvedValue(fakeApi)
    const { app } = await mountPage()
    await nextTick(); await flush()

    const retry = [...document.querySelectorAll<HTMLButtonElement>('.book-map-actions button')]
      .find((button) => button.textContent?.includes('重试未找到'))
    expect(retry).not.toBeUndefined()
    retry?.click()
    await flush(); await nextTick()
    expect(geocodePlaces).toHaveBeenCalledWith('book-1', true)

    const beforeFit = fitCalls
    document.querySelector<HTMLButtonElement>('[data-map-view="all"]')?.click()
    expect(fitCalls).toBe(beforeFit + 1)
    document.querySelector<HTMLButtonElement>('[data-map-view="region"]')?.click()
    expect(centerCalls.at(-1)).toEqual({ latitude: 31.2, longitude: 121.5 })
    expect(zoomCalls.at(-1)).toBe(10)
    app.unmount()
  })

  it('定位地名：按坐标建标记，列表显示已定位，点标记回传锚点', async () => {
    const located = {
      ...PLACE,
      geocodeStatus: 'resolved' as const,
      location: { latitude: 34.2, longitude: 108.9 },
    }
    const geocodePlaces = vi.fn(async () => ({
      ok: true,
      view: { places: [located], resolved: 1, notFound: 0, cached: 0, message: '已定位 1 个地点' },
    }))
    installMapApi('key-1', {
      getPlaces: vi.fn(async () => ({ ok: true, places: [PLACE_GEO] })),
      geocodePlaces,
    })
    loadMock.mockResolvedValue(fakeApi)
    const { app, selectPlace } = await mountPage()
    await nextTick(); await flush()

    const geocodeButton = () => document.querySelectorAll<HTMLButtonElement>('.book-map-actions button')[1]
    expect(geocodeButton()?.textContent).toContain('定位到地图')
    geocodeButton()?.click()
    await flush(); await nextTick()

    expect(geocodePlaces).toHaveBeenCalledWith('book-1', false)
    expect(markerCalls).toHaveLength(1)
    expect(markerCalls[0]!.options.title).toBe('长安')
    expect(document.querySelector('.book-map-place-meta')?.textContent).toContain('已定位')
    expect(document.querySelector('.book-map-budget')?.textContent).toContain('已定位 1 个地点')

    // 点地名 → 地图居中并高亮，不离开地图
    document.querySelector<HTMLButtonElement>('.book-map-place')?.click()
    await nextTick()
    expect(centerCalls).toEqual([{ latitude: 34.2, longitude: 108.9 }])
    expect(zoomCalls).toEqual([12])
    expect(document.querySelector('.book-map-place-row')?.classList.contains('active')).toBe(true)
    expect(selectPlace).not.toHaveBeenCalled()

    // 点标记 → 先弹原文信息窗，再点「跳到原文」回跳
    markerListeners[0]?.()
    expect(infoCalls).toHaveLength(1)
    const content = infoCalls[0]!.options.content as HTMLElement
    expect(content.textContent).toContain('长安')
    expect(content.textContent).toContain('第一章 · 第 1 段')
    const jump = [...content.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '跳到原文')
    expect(jump).not.toBeUndefined()
    jump?.click()
    expect(selectPlace).toHaveBeenCalledWith({ paragraphIndex: 0, paragraphOffset: 8 })
    app.unmount()
  })

  it('手工标注：入口展开表单，提交带上坐标与正文锚点，成功后刷新列表', async () => {
    const addManualPlace = vi.fn(async () => ({ ok: true, places: [MANUAL_PLACE] }))
    installMapApi('', { addManualPlace })
    const { app } = await mountPage()

    // 入口按钮在左栏，点了才展开表单（地图页左栏窄，常驻表单会挤掉地名列表）。
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '手工标注')
    expect(open).not.toBeUndefined()
    open?.click()
    await nextTick()
    expect(document.querySelector('.book-map-manual')).not.toBeNull()

    const inputs = document.querySelectorAll<HTMLInputElement>('.book-map-manual input')
    // 地名 / 纬度 / 经度 / 段号 / 段内偏移。
    expect(inputs).toHaveLength(5)
    const values = ['洛阳', '34.6', '112.4', '2', '6']
    inputs.forEach((input, index) => {
      input.value = values[index]!
      input.dispatchEvent(new Event('input'))
    })
    await nextTick()

    document.querySelector<HTMLButtonElement>('.book-map-manual button[type="submit"]')?.click()
    await flush(); await nextTick()

    expect(addManualPlace).toHaveBeenCalledWith({
      bookId: 'book-1',
      name: '洛阳',
      latitude: 34.6,
      longitude: 112.4,
      kind: 'other',
      paragraphIndex: 2,
      paragraphOffset: 6,
    })
    // 列表刷新出这条手工标注。
    expect(document.querySelector('.book-map-place-name')?.textContent).toBe('洛阳')
    expect(document.querySelector('.book-map-place-meta')?.textContent).toContain('手工标注')
    // 挂了正文锚点 → 给「原文」入口。
    const jump = [...document.querySelectorAll<HTMLButtonElement>('.book-map-place-actions button')]
      .find((button) => button.textContent === '原文')
    expect(jump).not.toBeUndefined()
    app.unmount()
  })

  it('手工标注：坐标非法时中文错误原样显示，不写盘', async () => {
    const addManualPlace = vi.fn(async () => ({ ok: false, message: '纬度须在 -90 到 90 之间' }))
    installMapApi('', { addManualPlace })
    const { app } = await mountPage()
    ;[...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '手工标注')?.click()
    await nextTick()

    const inputs = document.querySelectorAll<HTMLInputElement>('.book-map-manual input')
    const values = ['长安', '99', '108']
    inputs.forEach((input, index) => {
      if (index >= values.length) return
      input.value = values[index]!
      input.dispatchEvent(new Event('input'))
    })
    await nextTick()
    document.querySelector<HTMLButtonElement>('.book-map-manual button[type="submit"]')?.click()
    await flush(); await nextTick()

    expect(document.querySelector('.book-map-manual .book-map-budget')?.textContent).toContain('纬度须在 -90 到 90 之间')
    app.unmount()
  })

  it('未收录的原图：先读上次结论，只有点「识别地图」才调用模型', async () => {
    const recognize = vi.fn(async () => ({
      ok: true,
      recognition: {
        status: 'recognized' as const,
        message: '地图已自动识别。地名坐标来自 Natural Earth。',
        model: 'deepseek-flash',
        recognizedAt: Date.now(),
        cached: false,
        map: {
          id: 'auto-bytes',
          title: '东线战场',
          period: '1941',
          number: '3',
          bounds: [[-12, 35], [16, 64]] as [[number, number], [number, number]],
          center: [2, 49] as [number, number],
          image: { sha256: 'f'.repeat(64), bytes: 321 },
          places: [{
            id: 'london',
            name: '伦敦',
            modernName: 'London',
            coordinates: [-0.118668, 51.501941] as [number, number],
            imagePoint: [0.5, 0.4] as [number, number],
          }],
          recognition: { model: 'deepseek-flash', unresolved: ['不明小镇'] },
        },
      },
    }))
    const getImage = vi.fn(async () => ({ ok: true, url: 'file:///tmp/book/map/original.png' }))
    const getRecognition = vi.fn(async () => ({ ok: true, recognition: null }))
    installMapApi('', { recognize, getImage, getRecognition })
    const { app } = await mountPage()
    await nextTick(); await flush()

    // 打开地图页只做字节比对与读旧结论，绝不自动花钱。
    expect(getRecognition).toHaveBeenCalledWith('book-1')
    expect(recognize).not.toHaveBeenCalled()
    // jsdom 里没有 spbf-map 协议，读到的是「读不到字节」或「未收录」——两种状态都不得自动识别。
    const prompt = document.querySelector('.book-map-original')?.textContent ?? ''
    expect(prompt).toMatch(/这张地图未收录|暂时读不到原图字节/)
    const button = [...document.querySelectorAll<HTMLButtonElement>('.book-map-original button')]
      .find((item) => item.textContent === '识别地图')
    expect(button).not.toBeUndefined()

    button?.click()
    await flush(); await nextTick()
    expect(recognize).toHaveBeenCalledWith('book-1', false)
    expect(document.querySelector('.book-map-recognized')?.textContent).toContain('东线战场')
    expect(document.querySelector('.book-map-original')?.textContent).toContain('暂未匹配：不明小镇')
    // 识别结果已作为当前地图：地点列表与「在 3D 地图查看」入口都在。
    expect(document.querySelector('.book-map-atlas-places')?.textContent).toContain('伦敦')
    const open = [...document.querySelectorAll<HTMLButtonElement>('.book-map-original button')]
      .find((item) => item.textContent === '在 3D 地图查看')
    expect(open).not.toBeUndefined()
    app.unmount()
  })

  it('已保存的识别结论：打开地图页直接复用，不再调用模型', async () => {
    const recognize = vi.fn()
    const saved = {
      status: 'recognized' as const,
      message: '地图已自动识别。',
      model: 'deepseek-flash',
      recognizedAt: Date.now() - 1000,
      cached: true,
      map: {
        id: 'auto-saved',
        title: '西欧',
        period: '1940',
        number: '1',
        bounds: [[-12, 35], [16, 64]] as [[number, number], [number, number]],
        center: [2, 49] as [number, number],
        image: { sha256: 'e'.repeat(64), bytes: 200 },
        places: [{
          id: 'paris',
          name: '巴黎',
          modernName: 'Paris',
          coordinates: [2.352992, 48.858092] as [number, number],
          imagePoint: [0.6, 0.6] as [number, number],
        }],
        recognition: { model: 'deepseek-flash', unresolved: [] },
      },
    }
    installMapApi('', {
      getImage: vi.fn(async () => ({ ok: true, url: 'file:///tmp/book/map/original.png' })),
      getRecognition: vi.fn(async () => ({ ok: true, recognition: saved })),
      recognize,
    })
    const { app } = await mountPage()
    await nextTick(); await flush()

    expect(recognize).not.toHaveBeenCalled()
    expect(document.querySelector('.book-map-recognized')?.textContent).toContain('西欧')
    expect(document.querySelector('.book-map-original')?.textContent).toContain('巴黎')
    app.unmount()
  })

  it('识别失败：保留原图与中文原因，可重新识别', async () => {
    const recognize = vi.fn(async () => ({ ok: false, message: '地图识别等待超时，请稍后重试。' }))
    installMapApi('', {
      getImage: vi.fn(async () => ({ ok: true, url: 'file:///tmp/book/map/original.png' })),
      recognize,
    })
    const { app } = await mountPage()
    await nextTick(); await flush()

    const trigger = [...document.querySelectorAll<HTMLButtonElement>('.book-map-original button')]
      .find((item) => item.textContent === '识别地图')
    trigger?.click()
    await flush(); await nextTick()

    expect(recognize).toHaveBeenCalledWith('book-1', false)
    expect(document.querySelector('.book-map-original')?.textContent).toContain('地图识别等待超时')
    expect(document.querySelector('.book-map-original-image')).not.toBeNull()
    // 识别失败后给的是「重新识别」，用同一颗按钮继续。
    const retry = [...document.querySelectorAll<HTMLButtonElement>('.book-map-original button')]
      .find((item) => item.textContent === '重新识别')
    expect(retry).not.toBeUndefined()
    retry?.click()
    await flush(); await nextTick()
    expect(recognize).toHaveBeenLastCalledWith('book-1', true)
    app.unmount()
  })
})
