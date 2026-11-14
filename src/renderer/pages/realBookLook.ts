/** WebGL 真实书籍的桌面/衬纸本机偏好。CSS 3D 回退不使用这组值。 */

import {
  DESK_PALETTES,
  ENDPAPER_PALETTES,
  type RealBookDesk,
  type RealBookEndpaper,
} from './realBookWebGLModel'

const STORAGE_KEY = 'spore:reader-realbook-look:v1'

export interface RealBookLook {
  desk: RealBookDesk
  endpaper: RealBookEndpaper
}

export const DEFAULT_REALBOOK_LOOK: RealBookLook = { desk: 'walnut', endpaper: 'ivory' }

export function readRealBookLook(): RealBookLook {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_REALBOOK_LOOK }
    const parsed = JSON.parse(raw) as Partial<RealBookLook>
    return {
      desk: parsed.desk && Object.prototype.hasOwnProperty.call(DESK_PALETTES, parsed.desk)
        ? parsed.desk
        : DEFAULT_REALBOOK_LOOK.desk,
      endpaper: parsed.endpaper && Object.prototype.hasOwnProperty.call(ENDPAPER_PALETTES, parsed.endpaper)
        ? parsed.endpaper
        : DEFAULT_REALBOOK_LOOK.endpaper,
    }
  } catch {
    return { ...DEFAULT_REALBOOK_LOOK }
  }
}

export function writeRealBookLook(look: RealBookLook): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(look))
  } catch {
    // 无存储环境只保留本次会话状态。
  }
}
