/**
 * 腾讯地图 JS API v2 的按需加载器（书中地图页唯一消费者）。
 *
 * 底图瓦片与 POI 都在腾讯服务端，Key 只在内存里拼进脚本地址：不写日志、不落盘，
 * 也不进入 `Settings`（`settings.get` 只给配置标志）。加载失败统一收敛成可读错误，
 * 界面只负责展示与重试。
 *
 * 脚本一旦加载过就复用同一份 API；换 Key 时先移除旧脚本再重新加载，避免同一页面
 * 里挂着两份腾讯地图脚本。
 */

export interface TencentMapInstance {
  fitBounds?: (bounds: unknown) => void
  setCenter?: (point: unknown) => void
  setZoom?: (zoom: number) => void
}

export interface TencentMarker {
  setMap?: (map: unknown) => void
}

export interface TencentLatLngBounds {
  extend: (point: unknown) => void
}

export interface TencentInfoWindow {
  setContent?: (content: string | HTMLElement) => void
  open?: (map: unknown, position?: unknown) => void
  close?: () => void
}

export interface TencentMapApi {
  maps: {
    Map: new (container: HTMLElement, options: Record<string, unknown>) => TencentMapInstance
    LatLng: new (latitude: number, longitude: number) => unknown
    Marker?: new (options: Record<string, unknown>) => TencentMarker
    LatLngBounds?: new () => TencentLatLngBounds
    InfoWindow?: new (options: Record<string, unknown>) => TencentInfoWindow
    event?: {
      addListener: (target: unknown, name: string, handler: (...args: unknown[]) => void) => unknown
    }
  }
}

type MapWindow = Window & { qq?: TencentMapApi; [callback: string]: unknown }

const SCRIPT_ID = 'spbf-tencent-map'
const CALLBACK_NAME = '__spbfTencentMapReady'
const DEFAULT_TIMEOUT_MS = 15_000

let pending: { key: string; promise: Promise<TencentMapApi> } | null = null
let loadedKey = ''

/** 腾讯地图 JS API v2 的脚本地址；`callback` 是脚本加载完成后会调用的全局函数名。 */
export function tencentMapScriptUrl(key: string, callback = CALLBACK_NAME): string {
  return `https://map.qq.com/api/js?v=2.exp&key=${encodeURIComponent(key)}&callback=${encodeURIComponent(callback)}`
}

export function loadTencentMap(key: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TencentMapApi> {
  const trimmed = key.trim()
  if (!trimmed) return Promise.reject(new Error('未配置腾讯地图 Key'))

  const win = window as unknown as MapWindow
  if (win.qq?.maps?.Map && loadedKey === trimmed) return Promise.resolve(win.qq)
  if (pending?.key === trimmed) return pending.promise

  // 换 Key：旧脚本里的全局 API 与旧 Key 绑定，必须清掉再拉新脚本。
  if (win.qq) {
    delete win.qq
    document.getElementById(SCRIPT_ID)?.remove()
  }

  const promise = new Promise<TencentMapApi>((resolve, reject) => {
    document.getElementById(SCRIPT_ID)?.remove()

    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      delete win[CALLBACK_NAME]
      if (error) { reject(error); return }
      if (win.qq?.maps?.Map) { loadedKey = trimmed; resolve(win.qq); return }
      reject(new Error('腾讯地图脚本已加载，但地图接口不可用'))
    }
    const timer = setTimeout(
      () => finish(new Error('腾讯地图加载超时，请检查网络后重试')),
      Math.max(1, timeoutMs),
    )

    win[CALLBACK_NAME] = () => finish()
    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.async = true
    script.src = tencentMapScriptUrl(trimmed)
    script.onerror = () => finish(new Error('腾讯地图脚本加载失败，请检查网络或 Key 是否有效'))
    document.head.appendChild(script)
  }).finally(() => {
    if (pending?.key === trimmed) pending = null
  })

  pending = { key: trimmed, promise }
  return promise
}

/** 仅测试用：清掉模块级缓存与已插入的脚本，避免用例之间串状态。 */
export function resetTencentMapLoaderForTests(): void {
  pending = null
  loadedKey = ''
  delete (window as unknown as MapWindow).qq
  document.getElementById(SCRIPT_ID)?.remove()
}
