/**
 * 书页纹理的光栅化器：主线程只建计划、管缓存，真正画 canvas 的活交给 Worker。
 *
 * 为什么用 Worker：一页 1280×1840 的正文要画上百行 fillText/strokeText，
 * 快速连翻时会在主线程堆一串，掉帧。Worker 用 OffscreenCanvas 画，主线程只等
 * ImageBitmap 回来后上传 WebGL。Worker 不可用（或字体/图片准备失败）时回退到
 * 主线程 `drawPageTexture`。
 *
 * 缓存按「页 + 侧 + 样式签名」做 key，LRU 上限 64 张（约 600MB 上界的 1/4，
 * 实际常见只有几页在飞）。纹理就绪后通过 `onReady(key)` 让场景重新贴一次。
 */
import * as THREE from 'three'
import { drawPageTexture, type PageTexturePlan, type RealBookTextureStyle } from './realBookTexture'
import { collectFontFaces, selectFontFaces, type FontFaceSpec } from './realBookFontFaces'

interface RenderJob {
  key: string
  plan: PageTexturePlan
  style: RealBookTextureStyle
  scale: number
  texture: THREE.Texture
  /** 等待期间给场景的占位贴图（通常是纯色纸），不要 dispose。 */
  placeholder: THREE.Texture
  bitmap: ImageBitmap | null
  pending: boolean
  lastUsed: number
}

interface RasterizerOptions {
  onReady?: (key: string) => void
  limit?: number
  maxAnisotropy?: number
}

type WorkerResponse =
  | { t: 'done'; id: number; bitmap: ImageBitmap }
  | { t: 'fail'; id: number; error: string }

function collectPageText(plan: PageTexturePlan): string {
  let text = `${plan.header}${plan.footer}${plan.chapterTitle}`
  for (const line of plan.lines) text += line.text
  for (const box of plan.notes) {
    text += box.note.text
    if (box.note.tags?.length) text += box.note.tags.join('')
  }
  for (const image of plan.images) text += image.caption
  return text
}

export class RealBookTextureRasterizer {
  private readonly onReady: (key: string) => void
  private readonly limit: number
  private readonly maxAnisotropy: number
  private readonly faces: FontFaceSpec[]
  private readonly cache = new Map<string, RenderJob>()
  private readonly jobsById = new Map<number, RenderJob>()
  private worker: Worker | null = null
  private nextId = 1
  private disposed = false

  constructor(options: RasterizerOptions = {}) {
    this.onReady = options.onReady ?? (() => {})
    this.limit = Math.max(4, options.limit ?? 64)
    this.maxAnisotropy = Math.max(1, options.maxAnisotropy ?? 8)
    this.faces = collectFontFaces()
    if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        const worker = new Worker(new URL('./realBookTextureWorker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data)
        worker.onerror = () => {
          this.worker = null
          // Worker 崩了：把在途的几次光栅化全部落到主线程，页面不会停在占位纸。
          for (const job of this.jobsById.values()) this.fallback(job)
          this.jobsById.clear()
        }
        this.worker = worker
      } catch {
        this.worker = null
      }
    }
  }

  /** 取一张纹理：命中或已排队就返回现有贴图（可能是占位），否则排队光栅化。 */
  get(
    key: string,
    plan: PageTexturePlan,
    style: RealBookTextureStyle,
    scale: number,
    placeholder: THREE.Texture,
  ): THREE.Texture {
    const existing = this.cache.get(key)
    if (existing) {
      existing.lastUsed = performance.now()
      return existing.texture
    }
    const job: RenderJob = {
      key,
      plan,
      style,
      scale,
      texture: placeholder,
      placeholder,
      bitmap: null,
      pending: true,
      lastUsed: performance.now(),
    }
    this.cache.set(key, job)
    this.evict()
    void this.enqueue(job)
    return placeholder
  }

  private async enqueue(job: RenderJob): Promise<void> {
    if (this.disposed) return
    if (!this.worker) {
      this.fallback(job)
      return
    }
    const id = this.nextId++
    try {
      const images = await this.collectImages(job)
      const fonts = selectFontFaces(this.faces, collectPageText(job.plan))
      this.jobsById.set(id, job)
      // style 里的 images（Map）不传：图片单独走 ImageBitmap 记录。
      const style = { ...job.style, images: undefined } as RealBookTextureStyle
      this.worker.postMessage({ t: 'render', id, plan: job.plan, style, scale: job.scale, fonts, images })
    } catch {
      this.jobsById.delete(id)
      this.fallback(job)
    }
  }

  private async collectImages(job: RenderJob): Promise<Record<string, ImageBitmap>> {
    const out: Record<string, ImageBitmap> = {}
    const source = job.style.images
    if (!source) return out
    for (const box of job.plan.images) {
      if (out[box.file]) continue
      const image = source.get(box.file)
      if (!image) continue
      try {
        // 统一重新生成一份再传输：ImageBitmap 转移后原对象会失效，场景的 map 还要继续用。
        out[box.file] = await createImageBitmap(image as CanvasImageSource)
      } catch {
        // 图还没解码好：这一页先按占位框画，等图片轮次变化再重画。
      }
    }
    return out
  }

  private handleMessage(message: WorkerResponse): void {
    const job = this.jobsById.get(message.id)
    this.jobsById.delete(message.id)
    if (!job) {
      if (message.t === 'done') message.bitmap.close()
      return
    }
    if (this.disposed) {
      if (message.t === 'done') message.bitmap.close()
      return
    }
    if (message.t === 'done') {
      const texture = this.textureFromBitmap(message.bitmap)
      this.replaceTexture(job, texture, message.bitmap)
      this.notify(job.key)
      return
    }
    this.fallback(job)
  }

  private textureFromBitmap(bitmap: ImageBitmap): THREE.Texture {
    const texture = new THREE.Texture(bitmap)
    // Worker 用 createImageBitmap(..., { imageOrientation: 'flipY' }) 翻过一次，
    // 这里不再翻（flipY = false），与主线程 CanvasTexture 的朝向一致。
    texture.flipY = false
    texture.colorSpace = THREE.SRGBColorSpace
    texture.generateMipmaps = true
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.anisotropy = Math.min(8, this.maxAnisotropy)
    texture.needsUpdate = true
    return texture
  }

  private fallback(job: RenderJob): void {
    const canvas = drawPageTexture(job.plan, job.style, job.scale)
    if (canvas) {
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.generateMipmaps = true
      texture.minFilter = THREE.LinearMipmapLinearFilter
      texture.magFilter = THREE.LinearFilter
      texture.anisotropy = Math.min(8, this.maxAnisotropy)
      this.replaceTexture(job, texture, null)
      this.notify(job.key)
      return
    }
    job.pending = false
  }

  private replaceTexture(job: RenderJob, texture: THREE.Texture, bitmap: ImageBitmap | null): void {
    const old = job.texture
    if (old !== job.placeholder && old !== texture) old.dispose()
    job.bitmap?.close()
    job.texture = texture
    job.bitmap = bitmap
    job.pending = false
    job.lastUsed = performance.now()
  }

  private notify(key: string): void {
    queueMicrotask(() => {
      if (!this.disposed) this.onReady(key)
    })
  }

  private evict(): void {
    if (this.cache.size <= this.limit) return
    let victim: RenderJob | null = null
    for (const job of this.cache.values()) {
      if (job.pending) continue
      if (!victim || job.lastUsed < victim.lastUsed) victim = job
    }
    if (!victim) return
    this.cache.delete(victim.key)
    if (victim.texture !== victim.placeholder) victim.texture.dispose()
    victim.bitmap?.close()
  }

  dispose(): void {
    this.disposed = true
    this.worker?.terminate()
    this.worker = null
    for (const job of this.cache.values()) {
      if (job.texture !== job.placeholder) job.texture.dispose()
      job.bitmap?.close()
    }
    this.cache.clear()
    this.jobsById.clear()
  }
}
