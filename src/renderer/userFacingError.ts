/**
 * 把 IPC / JS 运行时错误翻译成用户能读懂的文案。
 * `window.api.x is not a function` 这类内部错误不该原样渲染到界面上：
 * 普通用户看不懂，也暴露内部通道命名。这里统一兜底，
 * 友好文案进提示正文，技术细节放到 title 供排查。
 */
export function userFacingError(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  if (!raw) return fallback
  // IPC 通道没注册 / preload 没暴露：对功能缺失给一句人话，通道名不外露。
  if (/is not a function|Cannot read propert|undefined is not|ipcRenderer|invoke .*channel|No handler/i.test(raw)) {
    return fallback
  }
  return raw
}

/** 给排查用的原始错误文本：放 title / 控制台，不进提示正文。 */
export function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
