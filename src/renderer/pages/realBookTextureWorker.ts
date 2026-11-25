/**
 * 书页纹理的 Worker：用 OffscreenCanvas 画计划，产出一张 ImageBitmap 传回主线程。
 *
 * 这里不能依赖 document，也不能用主线程的 canvas。字体由主线程挑好子集后
 * 通过消息带过来（URL 已改成 file:// 下可 fetch 的 spbf-font://）。
 */
import { drawPageTexture, type PageTexturePlan, type RealBookTextureStyle } from './realBookTexture'
import type { FontFaceSpec } from './realBookFontFaces'

interface RenderMessage {
  t: 'render'
  id: number
  plan: PageTexturePlan
  style: RealBookTextureStyle
  scale: number
  fonts: FontFaceSpec[]
  images: Record<string, ImageBitmap>
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<RenderMessage>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
  fonts: FontFaceSet
}

const scope = self as unknown as WorkerScope
const loadedFonts = new Set<string>()
const failedFonts = new Set<string>()
const loadingFonts = new Map<string, Promise<void>>()

async function ensureFonts(fonts: readonly FontFaceSpec[]): Promise<void> {
  for (const font of fonts) {
    if (loadedFonts.has(font.url) || failedFonts.has(font.url) || loadingFonts.has(font.url)) continue
    const pending = (async () => {
      try {
        const face = new FontFace(font.family, `url(${font.url})`, {
          style: font.style,
          weight: font.weight,
          ...(font.range ? { unicodeRange: font.range } : {}),
        })
        scope.fonts.add(await face.load())
        loadedFonts.add(font.url)
      } catch {
        // 单个子集失败不拖垮整页：缺的字会落到系统回退字体。
        failedFonts.add(font.url)
      } finally {
        loadingFonts.delete(font.url)
      }
    })()
    loadingFonts.set(font.url, pending)
  }
  if (loadingFonts.size > 0) {
    await Promise.all([...loadingFonts.values()])
  }
}

scope.onmessage = async (event) => {
  const message = event.data
  if (message.t !== 'render') return
  try {
    await ensureFonts(message.fonts)
    const style: RealBookTextureStyle = { ...message.style, images: new Map(Object.entries(message.images)) }
    const canvas = drawPageTexture(message.plan, style, message.scale)
    if (!canvas) throw new Error('OffscreenCanvas 不可用')
    const bitmap = await createImageBitmap(canvas, { imageOrientation: 'flipY', premultiplyAlpha: 'none' })
    scope.postMessage({ t: 'done', id: message.id, bitmap }, [bitmap])
  } catch (error) {
    scope.postMessage({ t: 'fail', id: message.id, error: error instanceof Error ? error.message : String(error) })
  }
}
