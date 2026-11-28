/**
 * 思维导图主题（移植自 infinite-reader web/src/ui/mindmapThemes.ts）。
 *
 * 纯数据 + 纯函数，不依赖 Vue/DOM 以外的东西；主题只改变外观，不影响树模型与跳转锚点。
 * 选择结果写入 localStorage，存储被禁用时退回为会话内偏好。
 */

export interface MindmapTheme {
  id: string
  name: string
  description: string
  canvas: string
  panel: string
  ink: string
  muted: string
  border: string
  node: string
  root: string
  rootInk: string
  branches: readonly string[]
}

export const MINDMAP_THEMES: readonly MindmapTheme[] = [
  { id: 'porcelain', name: '清瓷', description: '冷白画布 · 清透彩枝', canvas: '#f5f7fa', panel: '#ffffff', ink: '#243247', muted: '#5c6979', border: '#dbe2eb', node: '#ffffff', root: '#284b70', rootInk: '#ffffff', branches: ['#4969a6', '#2c7c7a', '#99603d', '#8560a0', '#537b44', '#a4506c'] },
  { id: 'ink', name: '纸墨', description: '温润纸色 · 宋体细线', canvas: '#f5f1e8', panel: '#faf7f0', ink: '#33352f', muted: '#68665c', border: '#d8d2c5', node: '#faf7f0', root: '#343b35', rootInk: '#fffaf0', branches: ['#596b61', '#816247', '#666079', '#7e625d', '#526a78', '#747040'] },
  { id: 'grove', name: '森境', description: '深林底色 · 苔绿与黄铜', canvas: '#172823', panel: '#1d3029', ink: '#edf2e7', muted: '#afc3b5', border: '#3c5548', node: '#243c32', root: '#c5d6ad', rootInk: '#223427', branches: ['#a7c89c', '#d6ba83', '#90c4b3', '#bdb1cd', '#d3a799', '#8bbdd1'] },
  { id: 'midnight', name: '午夜', description: '深蓝夜幕 · 柔光分支', canvas: '#141c2c', panel: '#1b2538', ink: '#edf1fa', muted: '#aab8d1', border: '#394660', node: '#222f46', root: '#b7cafa', rootInk: '#1d2b47', branches: ['#a5bafa', '#7bc8c6', '#c3aaea', '#e2b58a', '#94c6a8', '#e1a9c5'] },
  { id: 'sand', name: '暖砂', description: '奶油暖底 · 陶土与鼠尾草', canvas: '#fbf2eb', panel: '#fff8f2', ink: '#4a3a34', muted: '#7d6a62', border: '#ecd9cc', node: '#fffaf5', root: '#9a5a48', rootInk: '#fff8f2', branches: ['#b4695a', '#7d9170', '#c39a52', '#8f7aa6', '#5f8f98', '#b76f8d'] },
]

export type MindmapThemeId = string

export const MINDMAP_THEME_KEY = 'xsxz.mindmap.theme'
export const DEFAULT_MINDMAP_THEME: MindmapThemeId = 'porcelain'

export function normalizeMindmapThemeId(value: unknown): MindmapThemeId {
  return typeof value === 'string' && MINDMAP_THEMES.some((theme) => theme.id === value)
    ? value
    : DEFAULT_MINDMAP_THEME
}

export function findMindmapTheme(id: unknown): MindmapTheme {
  const normalized = normalizeMindmapThemeId(id)
  return MINDMAP_THEMES.find((theme) => theme.id === normalized) ?? MINDMAP_THEMES[0]!
}

export function loadMindmapThemeId(storage: Pick<Storage, 'getItem'> | null | undefined = safeStorage()): MindmapThemeId {
  try {
    return normalizeMindmapThemeId(storage?.getItem(MINDMAP_THEME_KEY))
  } catch {
    return DEFAULT_MINDMAP_THEME
  }
}

export function saveMindmapThemeId(id: MindmapThemeId, storage: Pick<Storage, 'setItem'> | null | undefined = safeStorage()): void {
  try {
    storage?.setItem(MINDMAP_THEME_KEY, normalizeMindmapThemeId(id))
  } catch {
    /* 存储被禁用时保持会话内偏好 */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 主题 → CSS 自定义属性，作用在导图根元素上。 */
export function mindmapThemeStyle(theme: MindmapTheme): Record<string, string> {
  const style: Record<string, string> = {}
  for (const key of ['canvas', 'panel', 'ink', 'muted', 'border', 'node', 'root', 'rootInk'] as const) {
    style[`--map-${key}`] = theme[key]
  }
  theme.branches.forEach((color, index) => { style[`--map-branch-${index}`] = color })
  return style
}
