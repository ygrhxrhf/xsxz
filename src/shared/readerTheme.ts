import type { ReaderTheme } from './types'

/**
 * 阅读主题的纸色真源：本地阅读器（Reader.vue）与网页阅读模式（Browse.vue）共用。
 *
 * 之前两个界面各写一份色表，导致同一个「纸白」在两处渲染出不同颜色。
 * 取值以网页阅读模式为准（暖纸），本地阅读器随之统一。
 */
export interface ReaderThemeColors {
  /** 正文纸面底色 */
  paper: string
  /** 正文文字色 */
  text: string
  /** 纸面外的画布色；本地阅读器用全局 --app-bg，网页阅读模式用这个值 */
  outer: string
}

export const READER_THEME_COLORS: Record<ReaderTheme, ReaderThemeColors> = {
  paper: { paper: '#F7F3E8', text: '#2F2A24', outer: '#E9E3D7' },
  sepia: { paper: '#F3E2B8', text: '#3A2F22', outer: '#E6D2A4' },
  gray: { paper: '#E5E7E6', text: '#252A2D', outer: '#D6D9D8' },
  night: { paper: '#1B1D20', text: '#D8D2C7', outer: '#111316' },
}
