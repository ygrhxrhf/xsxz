/**
 * AI / 向量 / TTS / 封面图统一出口。
 *
 * 主进程的 Node `fetch` 不认 Chromium 的代理栈：应用里配了订阅或手填代理，浏览与下载能走，
 * AI 却直连失败。这里在真实 Electron 进程改用 `net.fetch`（走 defaultSession 的代理），
 * 单测环境没有 Electron，退回全局 fetch。
 */
export async function aiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (process.versions.electron) {
    const { net } = await import('electron')
    return net.fetch(input, init)
  }
  return fetch(input, init)
}
