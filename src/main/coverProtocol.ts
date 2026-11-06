import { net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getLibraryPath } from './library'

/**
 * 书架封面协议：`spbf-cover://c/<bookId>/<cover file>` 由主进程按当前书库目录解析。
 *
 * 不用 `file://`：开发模式页面来自 `http://127.0.0.1`，Chromium 会拦住它加载 `file://` 图片，
 * 封面只剩破损图标。渲染层因此不再拼本机绝对路径，只给书 id 和文件名（见 libraryCard.ts）。
 */
export const COVER_SCHEME = 'spbf-cover'

const COVER_FILE = /^cover\.(jpg|png|webp)$/

/** 必须在 app ready 之前调用。 */
export function registerCoverScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: COVER_SCHEME, privileges: { standard: true, secure: true } },
  ])
}

export function installCoverProtocol(): void {
  protocol.handle(COVER_SCHEME, async (request) => {
    const notFound = () => new Response(null, { status: 404 })
    const parts = new URL(request.url).pathname.split('/')
    if (parts.length !== 3) return notFound()
    let bookId: string
    try {
      bookId = decodeURIComponent(parts[1])
    } catch {
      return notFound()
    }
    const file = parts[2]
    if (!bookId || bookId.includes('..') || /[\\/]/.test(bookId) || !COVER_FILE.test(file)) return notFound()
    try {
      return await net.fetch(pathToFileURL(join(getLibraryPath(), bookId, file)).href)
    } catch {
      return notFound()
    }
  })
}
