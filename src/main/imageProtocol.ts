import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { getLibraryPath } from './library'

/**
 * 章内图片协议：`spbf-image://i/<bookId>/<file>` 由主进程从书目录的 `images/` 读取。
 *
 * 与封面协议同一个理由：开发模式下页面来自 http://127.0.0.1，Chromium 不允许
 * 直接加载 file:// 图片。渲染层只给书 id 与安全文件名，拼路径与校验都在主进程。
 */
const IMAGE_SCHEME = 'spbf-image'

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/
const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
}

/** 必须在 app ready 之前调用。 */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    // corsEnabled + ACAO：图片要画进 canvas 再上传成 WebGL 纹理，不放开 CORS 会把画布污染成黑块。
    { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ])
}

export function installImageProtocol(): void {
  protocol.handle(IMAGE_SCHEME, async (request) => {
    const notFound = (): Response => new Response(null, { status: 404 })
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return notFound()
    }
    // standard scheme 里 `spbf-image://i/<bookId>/<file>` 的 i 是 host，不是路径段。
    if (url.hostname !== 'i') return notFound()
    const parts = url.pathname.split('/')
    if (parts.length !== 3) return notFound()
    let bookId: string
    let file: string
    try {
      bookId = decodeURIComponent(parts[1] ?? '')
      file = decodeURIComponent(parts[2] ?? '')
    } catch {
      return notFound()
    }
    if (!SAFE_TOKEN.test(bookId) || !SAFE_TOKEN.test(file) || file.startsWith('.')) return notFound()
    const type = MIME[extname(file).toLowerCase()]
    if (!type) return notFound()
    try {
      const body = await readFile(join(getLibraryPath(), bookId, 'images', file))
      return new Response(body as unknown as BodyInit, {
        headers: {
          'content-type': type,
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        },
      })
    } catch {
      return notFound()
    }
  })
}
