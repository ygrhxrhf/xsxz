/**
 * WebGL 真实书籍的纯数值模型。
 *
 * 这里只放相机、开本、桌面/衬纸色板和厚度换算，不 import Three.js，
 * 因而能在 vitest/jsdom 里稳定验证。场景类只负责把这里的数值塞进网格与材质。
 */

export const BOOK_WIDTH = 6.4
export const BOOK_HEIGHT = 9.2
export const COVER_OVERHANG = 0.15
export const BOARD_THICKNESS = 0.11
export const PAGE_TEXTURE_WIDTH = 640
export const PAGE_TEXTURE_HEIGHT = 920
export const PAGE_ASPECT = PAGE_TEXTURE_HEIGHT / PAGE_TEXTURE_WIDTH

export const CAMERA_FOV = 24
export const DEFAULT_TILT_RAD = 0.44
export const MIN_TILT_RAD = 0.02
export const MAX_TILT_RAD = 1.08
export const DEFAULT_ZOOM = 0.9
export const MIN_ZOOM = 0.12
export const MAX_ZOOM = 7

export type RealBookDesk = 'walnut' | 'linen' | 'graphite' | 'sage' | 'limestone'
export type RealBookEndpaper = 'ivory' | 'sand' | 'slate' | 'sage' | 'burgundy'

export interface DeskPalette {
  label: string
  swatch: string
  dark: string
  light: string
  roughness: number
}

export const DESK_PALETTES: Record<RealBookDesk, DeskPalette> = {
  walnut: { label: '胡桃木', swatch: '#514944', dark: '#454148', light: '#625c63', roughness: 0.88 },
  linen: { label: '亚麻', swatch: '#b7b0a2', dark: '#aba79c', light: '#c0bcb1', roughness: 1 },
  graphite: { label: '石墨', swatch: '#363a3b', dark: '#3b4852', light: '#48555f', roughness: 0.96 },
  sage: { label: '鼠尾草', swatch: '#93a592', dark: '#91aaa5', light: '#a0bbb3', roughness: 1 },
  limestone: { label: '石灰岩', swatch: '#cccec8', dark: '#c8cdd0', light: '#dcdfdf', roughness: 0.93 },
}

export interface EndpaperPalette {
  label: string
  swatch: string
}

export const ENDPAPER_PALETTES: Record<RealBookEndpaper, EndpaperPalette> = {
  ivory: { label: '象牙白', swatch: '#dedfdc' },
  sand: { label: '沙色', swatch: '#bdbbb5' },
  slate: { label: '板岩', swatch: '#718692' },
  sage: { label: '鼠尾草', swatch: '#96a99f' },
  burgundy: { label: '勃艮第红', swatch: '#765863' },
}

export interface CameraPose {
  position: [number, number, number]
  lookAt: [number, number, number]
}

export interface BookThickness {
  total: number
  left: number
  right: number
  leaf: number
  hingeZ: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** 与参考站点同一套适配：双页摊开留出桌边，FOV 24°；窄屏单页时只适配一张纸。 */
export function fitDistance(aspect: number, singlePage = false, pageHeight = BOOK_HEIGHT): number {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const halfFov = Math.tan((CAMERA_FOV * Math.PI) / 360)
  const targetWidth = (singlePage ? BOOK_WIDTH + 1.0 : BOOK_WIDTH * 2 + 2.6) * 1.12
  const targetHeight = (pageHeight + 2.2) * 1.12
  return Math.max(targetHeight / 2 / halfFov, targetWidth / 2 / halfFov / safeAspect)
}

/** 相机始终看向书本中心；tilt 越大越接近平视，不是自由轨道。 */
export function cameraPose(
  tiltRad: number,
  zoom = DEFAULT_ZOOM,
  x = 0,
  y = 0,
  aspect = 1,
  singlePage = false,
  pageHeight = BOOK_HEIGHT,
): CameraPose {
  const safeTilt = clamp(Number.isFinite(tiltRad) ? tiltRad : DEFAULT_TILT_RAD, 0, MAX_TILT_RAD)
  const safeZoom = clamp(Number.isFinite(zoom) ? zoom : DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM)
  // 参考站的 zoom 以 0.9 为默认构图，dist = fitDist / zoom；100% 仍表示整书适配。
  const distance = fitDistance(aspect, singlePage, pageHeight) / safeZoom
  return {
    position: [x, y - distance * Math.sin(safeTilt), distance * Math.cos(safeTilt)],
    lookAt: [x, y, 0],
  }
}

export function degreesToTilt(degrees: number): number {
  return clamp((Number.isFinite(degrees) ? degrees : 0) * Math.PI / 180, MIN_TILT_RAD, MAX_TILT_RAD)
}

export function tiltToDegrees(radians: number): number {
  return clamp(Number.isFinite(radians) ? radians : 0, MIN_TILT_RAD, MAX_TILT_RAD) * 180 / Math.PI
}

/** 书本总厚度：页数和字符数共同决定，夹在参考站的 0.14–1.15 场景单位。 */
export function bookThickness(pageCount: number, totalChars = 0, progress = 0): BookThickness {
  const fromPages = Math.max(0, pageCount) * 0.0105
  const fromChars = Math.max(0, totalChars) / 820000
  const total = clamp(Math.max(fromPages, fromChars), 0.14, 1.15)
  const safeProgress = clamp(Number.isFinite(progress) ? progress : 0, 0, 1)
  const left = total * safeProgress
  return {
    total,
    left,
    right: total - left,
    leaf: total / Math.max(1, pageCount),
    hingeZ: BOARD_THICKNESS + total / 2,
  }
}

/** 摊开时整本书向书脊中心平移；合上时回到单本书的居中位置。窄屏单页始终居中。 */
export function bookOffsetX(open01: number, hingeZ: number, singlePage = false): number {
  if (singlePage) return 0
  return -(BOOK_WIDTH / 2 + hingeZ * 0.1) * (1 - clamp(open01, 0, 1))
}

/** 双页窗口：当前页是左页，下一页是右页。 */
export function spreadPages(currentPage: number): { left: number; right: number } {
  const left = Math.max(0, Math.floor(currentPage))
  return { left, right: left + 1 }
}
