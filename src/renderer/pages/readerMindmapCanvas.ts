/**
 * 思维导图画布相机（移植自 infinite-reader web/src/ui/useMindmapCanvas.ts）。
 *
 * 这里只保留与框架无关的相机数学：平移、以指针为锚点的缩放、适应视口。
 * 手势事件绑定在 ReaderMindmap.vue 里；相机状态不触碰页面/阅读器缩放。
 */

export interface Point { x: number; y: number }
export interface Camera extends Point { scale: number }

export const MIN_MAP_ZOOM = 0.5
export const MAX_MAP_ZOOM = 3

export const clampZoom = (scale: number): number => {
  if (!Number.isFinite(scale)) return 1
  return Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, scale))
}

export const pointDistance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
export const pointMiddle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** 以 point 为不动点缩放：缩放前后该点下的内容保持不动。 */
export function zoomCameraAt(camera: Camera, scale: number, point: Point): Camera {
  const next = clampZoom(scale)
  const ratio = next / camera.scale
  return {
    scale: next,
    x: point.x - (point.x - camera.x) * ratio,
    y: point.y - (point.y - camera.y) * ratio,
  }
}

/** 平移相机。 */
export function panCamera(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x + dx, y: camera.y + dy }
}

/** 让内容整体适应视口并居中；内容或视口为空时回到原点。 */
export function fitCamera(viewport: { width: number; height: number }, content: { width: number; height: number }, padding = 24): Camera {
  if (viewport.width <= 0 || viewport.height <= 0 || content.width <= 0 || content.height <= 0) {
    return { x: 0, y: 0, scale: 1 }
  }
  const scale = clampZoom(Math.min(
    (viewport.width - padding * 2) / content.width,
    (viewport.height - padding * 2) / content.height,
    1,
  ))
  return {
    scale,
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2,
  }
}

/** 相机 → CSS transform。 */
export function cameraTransform(camera: Camera): string {
  return `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`
}

/** 滚轮意图：Ctrl/⌘ + 滚轮 = 缩放；其余一律平移（与参考实现一致）。 */
export function wheelIntent(event: { ctrlKey: boolean; metaKey: boolean; deltaX: number; deltaY: number }):
  | { kind: 'zoom'; factor: number }
  | { kind: 'pan'; dx: number; dy: number } {
  if (event.ctrlKey || event.metaKey) {
    return { kind: 'zoom', factor: Math.exp(-event.deltaY * 0.01) }
  }
  return { kind: 'pan', dx: -event.deltaX, dy: -event.deltaY }
}
