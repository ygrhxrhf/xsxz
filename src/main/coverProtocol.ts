import { nativeImage, net, protocol } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getLibraryPath } from './library'

/**
 * 书架封面协议：`spbf-cover://c/<bookId>/<cover file>` 由主进程按当前书库目录解析。
 *
 * 不用 `file://`：开发模式页面来自 `http://127.0.0.1`，Chromium 会拦住它加载 `file://` 图片，
 * 封面只剩破损图标。渲染层因此不再拼本机绝对路径，只给书 id 和文件名（见 libraryCard.ts）。
 */
const COVER_SCHEME = 'spbf-cover'

const COVER_FILE = /^cover\.(jpg|png|webp)$/

/** 书架封面最大显示 112 CSS px；发到 640 宽，2x/3x 屏和以后加大卡片都够用。 */
const COVER_MAX_WIDTH = 640
const COVER_CACHE_LIMIT = 200

/** key 带绝对路径 + mtime + 大小：换了封面文件自然失效，不用手动清缓存。 */
const resizedCovers = new Map<string, Buffer>()

function readCachedCover(key: string): Buffer | undefined {
  const hit = resizedCovers.get(key)
  if (!hit) return undefined
  // 命中后挪到队尾，翻完整个书架也不会把刚看过的图先挤掉。
  resizedCovers.delete(key)
  resizedCovers.set(key, hit)
  return hit
}

function cacheCover(key: string, body: Buffer): void {
  resizedCovers.set(key, body)
  while (resizedCovers.size > COVER_CACHE_LIMIT) {
    const oldest = resizedCovers.keys().next().value
    if (oldest === undefined) break
    resizedCovers.delete(oldest)
  }
}

const jpegResponse = (body: Buffer) =>
  new Response(body as unknown as BodyInit, {
    headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' },
  })

/**
 * 大图封面按显示尺寸缩一遍再发。
 *
 * 用户把手机照片/扫描图直接设成封面时（每张几 MB、3000px 宽），书架一屏十几张原图
 * 会让渲染进程解码卡顿：80 本书实测滚动 p95 从 12ms 涨到 56ms。缩到 640 宽后回落。
 * nativeImage 解不了的文件（例如个别 webp）退回原文件，不让封面变空。
 */
async function coverResponse(absPath: string): Promise<Response> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absPath)
  } catch {
    return new Response(null, { status: 404 })
  }
  const key = `${absPath}:${info.mtimeMs}:${info.size}`
  const cached = readCachedCover(key)
  if (cached) return jpegResponse(cached)

  const original = () => net.fetch(pathToFileURL(absPath).href)
  let image: Electron.NativeImage
  try {
    image = nativeImage.createFromPath(absPath)
  } catch {
    return original()
  }
  if (image.isEmpty()) return original()
  const size = image.getSize()
  if (!size.width || size.width <= COVER_MAX_WIDTH) return original()

  let body: Buffer
  try {
    body = image.resize({ width: COVER_MAX_WIDTH, quality: 'good' }).toJPEG(82)
  } catch {
    return original()
  }
  if (!body.length) return original()
  cacheCover(key, body)
  return jpegResponse(body)
}

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
      return await coverResponse(join(getLibraryPath(), bookId, file))
    } catch {
      return notFound()
    }
  })
}
