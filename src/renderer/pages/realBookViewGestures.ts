/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/viewGestures.ts，Apache-2.0。已修改：文件改名，接入 spbf 的真实书籍场景。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */

/** Keep mouse-wheel and modified-wheel zoom gentle in all desktop platforms. */
export function readerWheelZoom(
  event: Pick<WheelEvent, 'deltaMode' | 'deltaY'>,
  viewport: { clientHeight: number },
) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
  // About 10% per 100px, with a bounded step for coarse wheels and fast scroll bursts.
  const delta = Math.max(-120, Math.min(120, event.deltaY * unit))
  return Math.exp(-delta * .001)
}

export function wheelIntent(
  event: Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY' | 'ctrlKey' | 'metaKey'>,
  viewport: { clientWidth: number; clientHeight: number },
) {
  // Pixel deltas cannot identify the device: fast trackpad sweeps can look exactly
  // like mouse wheels. Only an explicit pinch/modifier requests zoom.
  if (event.ctrlKey || event.metaKey) {
    return { kind: 'zoom' as const, factor: Math.exp(-event.deltaY * .0105) }
  }
  const unitX = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1
  const unitY = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
  return { kind: 'pan' as const, x: event.deltaX * unitX, y: event.deltaY * unitY }
}

/** Safari delivers trackpad pinches as gesture events rather than only Ctrl+wheel. */
export interface WebKitGesture extends Event {
  scale: number
  clientX?: number
  clientY?: number
}

export function readerWheelIntent(
  event: Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY' | 'ctrlKey' | 'metaKey'>,
  viewport: { clientWidth: number; clientHeight: number },
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
) {
  // macOS scrolls always pan; modifiers/pinches zoom without guessing the device.
  if (!/Mac/i.test(platform) || event.ctrlKey || event.metaKey) {
    return { kind: 'zoom' as const, factor: readerWheelZoom(event, viewport) }
  }
  return wheelIntent(event, viewport)
}