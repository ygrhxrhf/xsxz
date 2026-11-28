import { describe, expect, it } from 'vitest'
import {
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  cameraTransform,
  clampZoom,
  fitCamera,
  panCamera,
  wheelIntent,
  zoomCameraAt,
} from './readerMindmapCanvas'
import {
  DEFAULT_MINDMAP_THEME,
  MINDMAP_THEMES,
  loadMindmapThemeId,
  mindmapThemeStyle,
  normalizeMindmapThemeId,
  saveMindmapThemeId,
} from './readerMindmapThemes'

describe('readerMindmapCanvas', () => {
  it('缩放被限制在上下界内', () => {
    expect(clampZoom(100)).toBe(MAX_MAP_ZOOM)
    expect(clampZoom(0)).toBe(MIN_MAP_ZOOM)
    expect(clampZoom(Number.NaN)).toBe(1)
  })

  it('以指针为锚点缩放时该点下的内容不动', () => {
    const before = { x: 10, y: 20, scale: 1 }
    const point = { x: 200, y: 100 }
    const after = zoomCameraAt(before, 2, point)
    // 内容坐标 = (屏幕 - 平移) / 缩放，缩放前后必须相同
    expect((point.x - before.x) / before.scale).toBeCloseTo((point.x - after.x) / after.scale)
    expect((point.y - before.y) / before.scale).toBeCloseTo((point.y - after.y) / after.scale)
  })

  it('平移只改位置不改缩放', () => {
    expect(panCamera({ x: 1, y: 2, scale: 1.5 }, 3, 4)).toEqual({ x: 4, y: 6, scale: 1.5 })
  })

  it('适应视口：内容更大时缩小并居中，更小时不放大', () => {
    const big = fitCamera({ width: 400, height: 300 }, { width: 800, height: 600 })
    expect(big.scale).toBeLessThan(1)
    const small = fitCamera({ width: 400, height: 300 }, { width: 100, height: 50 })
    expect(small.scale).toBe(1)
    expect(small.x).toBe(150)
    expect(fitCamera({ width: 0, height: 0 }, { width: 1, height: 1 })).toEqual({ x: 0, y: 0, scale: 1 })
  })

  it('适应视口：上万像素高的长章节也能整棵树进框', () => {
    const viewport = { width: 1200, height: 670 }
    const content = { width: 1032, height: 10502 }
    const camera = fitCamera(viewport, content)
    expect(camera.scale).toBeGreaterThan(MIN_MAP_ZOOM)
    expect(camera.scale).toBeLessThan(0.1)
    // 四边都落在视口里（含 24px 内边距）
    expect(camera.x).toBeGreaterThanOrEqual(24 - 1e-6)
    expect(camera.y).toBeGreaterThanOrEqual(24 - 1e-6)
    expect(camera.x + content.width * camera.scale).toBeLessThanOrEqual(viewport.width - 24 + 1e-6)
    expect(camera.y + content.height * camera.scale).toBeLessThanOrEqual(viewport.height - 24 + 1e-6)
  })

  it('滚轮：Ctrl/⌘ 缩放，其余平移', () => {
    expect(wheelIntent({ ctrlKey: true, metaKey: false, deltaX: 0, deltaY: -100 }).kind).toBe('zoom')
    expect(wheelIntent({ ctrlKey: false, metaKey: true, deltaX: 0, deltaY: 100 }).kind).toBe('zoom')
    expect(wheelIntent({ ctrlKey: false, metaKey: false, deltaX: 5, deltaY: 7 })).toEqual({ kind: 'pan', dx: -5, dy: -7 })
  })

  it('相机 → transform 字符串', () => {
    expect(cameraTransform({ x: 1, y: 2, scale: 3 })).toBe('translate(1px, 2px) scale(3)')
  })
})

describe('readerMindmapThemes', () => {
  it('提供 5 套主题，每套 6 个分支色', () => {
    expect(MINDMAP_THEMES).toHaveLength(5)
    for (const theme of MINDMAP_THEMES) expect(theme.branches).toHaveLength(6)
  })

  it('非法 id 退回默认主题', () => {
    expect(normalizeMindmapThemeId('nope')).toBe(DEFAULT_MINDMAP_THEME)
    expect(normalizeMindmapThemeId('midnight')).toBe('midnight')
  })

  it('读写存储，存储抛错时不崩溃', () => {
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value) },
    }
    saveMindmapThemeId('grove', storage)
    expect(loadMindmapThemeId(storage)).toBe('grove')
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(loadMindmapThemeId(broken)).toBe(DEFAULT_MINDMAP_THEME)
    expect(() => saveMindmapThemeId('ink', broken)).not.toThrow()
  })

  it('主题输出 CSS 变量', () => {
    const style = mindmapThemeStyle(MINDMAP_THEMES[0]!)
    expect(style['--map-canvas']).toBe('#f5f7fa')
    expect(style['--map-branch-5']).toBeTruthy()
  })
})
