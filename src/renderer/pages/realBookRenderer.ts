/**
 * 真实书籍渲染层的本机偏好。
 *
 * 不塞进共享 ReaderPrefs：WebGL 是渲染能力，不是同步到其他设备的阅读偏好。
 * 这里只读写 localStorage，并在没有 WebGL2 的测试/旧机器上自动回退 CSS 3D。
 */

export type RealBookRenderer = 'css' | 'webgl'

const STORAGE_KEY = 'spore:reader-realbook-renderer:v1'

export function readRealBookRenderer(): RealBookRenderer | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'webgl' || value === 'css' ? value : null
  } catch {
    return null
  }
}

export function writeRealBookRenderer(value: RealBookRenderer): void {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // 隐私模式/无存储：本次会话仍按 ref 生效，不阻塞阅读。
  }
}

/** jsdom 不实现 WebGL，探测失败时自动留在 CSS 3D。 */
export function detectWebGL(): boolean {
  if (typeof document === 'undefined') return false
  // jsdom 既没有 WebGL 构造器，也会把 getContext 打印成“未实现”警告；先做能力判断。
  if (typeof WebGL2RenderingContext === 'undefined' && typeof WebGLRenderingContext === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export function defaultRealBookRenderer(): RealBookRenderer {
  return detectWebGL() ? 'webgl' : 'css'
}
