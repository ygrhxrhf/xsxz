import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 阅读地图的本地资源协议：`spbf-atlas://a/atlas/<path>`。
 *
 * 生产构建页面是 file://，MapLibre 的 Worker 不能 fetch file:// 瓦片/水系 JSON
 * （与字体协议同一个原因）。这里只放行构建产物（或开发态 public 目录）里的
 * `atlas/` 子目录：relief 瓦片、rivers.json、water.json。
 */
export const ATLAS_SCHEME = 'spbf-atlas'

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/
const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
}

/** 必须在 app ready 之前调用。 */
export function registerAtlasScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ATLAS_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ])
}

export function installAtlasProtocol(): void {
  protocol.handle(ATLAS_SCHEME, async (request) => {
    const notFound = (): Response => new Response(null, { status: 404 })
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return notFound()
    }
    if (url.hostname !== 'a') return notFound()
    let path: string
    try {
      path = decodeURIComponent(url.pathname.replace(/^\//, ''))
    } catch {
      return notFound()
    }
    if (!path.startsWith('atlas/') || !SAFE_PATH.test(path) || path.includes('..')) return notFound()
    const relative = path.slice('atlas/'.length)
    const type = MIME[relative.slice(relative.lastIndexOf('.')).toLowerCase()]
    if (!type) return notFound()
    const roots = [
      join(__dirname, '../renderer/atlas'),
      // 开发态：主进程拿不到 Vite 的内存文件，退回源码 public 目录。
      join(__dirname, '../../src/renderer/public/atlas'),
    ]
    for (const root of roots) {
      try {
        const body = await readFile(join(root, relative))
        return new Response(body as unknown as BodyInit, {
          headers: {
            'content-type': type,
            'cache-control': 'public, max-age=86400',
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
