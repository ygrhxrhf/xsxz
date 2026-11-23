import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bookDir } from './library'

/**
 * 书中原图的协议：`spbf-map://m/<bookId>`。
 *
 * 渲染层要读原图字节做 SHA-256 精确识别，而生产构建是 file://，
 * `fetch(file://...)` 会被拦（与字体/地图数据同一个原因）。这里按书 id
 * 读取书目录 `map/original.<ext>`，只接受 jpg/jpeg/png/webp。
 */
const MAP_SCHEME = 'spbf-map'

const SAFE_BOOK = /^[A-Za-z0-9._-]+$/
const EXTS = ['jpg', 'jpeg', 'png', 'webp'] as const
const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** 必须在 app ready 之前调用。 */
export function registerMapScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MAP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ])
}

export function installMapProtocol(): void {
  protocol.handle(MAP_SCHEME, async (request) => {
    const notFound = (): Response => new Response(null, { status: 404 })
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return notFound()
    }
    if (url.hostname !== 'm') return notFound()
    let bookId: string
    try {
      bookId = decodeURIComponent(url.pathname.replace(/^\//, ''))
    } catch {
      return notFound()
    }
    if (!SAFE_BOOK.test(bookId) || bookId.startsWith('.')) return notFound()
    for (const ext of EXTS) {
      try {
        const body = await readFile(join(bookDir(bookId), 'map', `original.${ext}`))
        return new Response(body as unknown as BodyInit, {
          headers: {
            'content-type': MIME[ext],
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
          },
        })
      } catch {
        // 试下一个后缀。
      }
    }
    return notFound()
  })
}