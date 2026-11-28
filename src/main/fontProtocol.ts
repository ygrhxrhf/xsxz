import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 书页字体的 Worker 协议：`spbf-font://f/<file>`。
 *
 * 构建后页面是 file://，Worker 既不能 fetch 也不能用 FontFace 加载 file:// 字体，
 * 而书页纹理现在要在 Worker 里光栅化，必须让 Worker 能取到字体。
 * 这里只放行构建产物 `out/renderer/`（含 `assets/`）下的 `.woff2`，
 * 主进程按文件名白名单读取，不暴露任意路径。
 */
const FONT_SCHEME = 'spbf-font'

const SAFE_FILE = /^[A-Za-z0-9._-]+\.woff2$/

/** 必须在 app ready 之前调用。 */
export function registerFontScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: FONT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ])
}

export function installFontProtocol(): void {
  protocol.handle(FONT_SCHEME, async (request) => {
    const notFound = (): Response => new Response(null, { status: 404 })
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return notFound()
    }
    if (url.hostname !== 'f') return notFound()
    const file = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (!SAFE_FILE.test(file)) return notFound()
    const roots = [join(__dirname, '../renderer'), join(__dirname, '../renderer/assets')]
    for (const root of roots) {
      try {
        const body = await readFile(join(root, file))
        return new Response(body as unknown as BodyInit, {
          headers: {
            'content-type': 'font/woff2',
            // 本地协议，允许 Worker 的 FontFace 与 fetch 读取；字体内容不变，可缓存。
            'cache-control': 'public, max-age=31536000, immutable',
            'access-control-allow-origin': '*',
          },
        })
      } catch {
        // 换下一个根目录。
      }
    }
    return notFound()
  })
}
