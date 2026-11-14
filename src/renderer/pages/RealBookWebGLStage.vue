<script setup lang="ts">
/**
 * 真实书籍的 WebGL 渲染层。
 *
 * 它是 `RealBookStage` 的视觉子层：分页、锚点、进度、批注仍由父组件算，
 * 这里只接收“左右页 + 翻页正反面”的纹理数据，用 Three.js 画书。
 * 保留 CSS 3D 舞台作为回退，因此本组件不接管任何 Reader 级状态。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RealBookTexturePage, RealBookTextureStyle } from './realBookTexture'
import type { RealBookWebGLScene } from './realBookWebGLScene'
import { DEFAULT_ZOOM, type RealBookDesk, type RealBookEndpaper } from './realBookWebGLModel'
import { clampPitch, DEFAULT_TILT_DEG, MAX_TILT_DEG, TILT_SENSITIVITY } from './realBookPitch'

const props = withDefaults(defineProps<{
  leftPage: RealBookTexturePage | null
  rightPage: RealBookTexturePage | null
  flipFrontPage: RealBookTexturePage | null
  flipBackPage: RealBookTexturePage | null
  flipping?: boolean
  flipProgress?: number
  flipDirection?: 1 | -1
  fontSize?: number
  lineHeight?: number
  fontFamily?: string
  paragraphGap?: number
  searchQuery?: string
  paper?: string
  ink?: string
  muted?: string
  desk?: RealBookDesk
  endpaper?: RealBookEndpaper
  tilt?: number
  zoom?: number
  open?: boolean
  totalChars?: number
  pageCount?: number
  progress?: number
  bookTitle?: string
  bookAuthor?: string
}>(), {
  flipping: false,
  flipProgress: 0,
  flipDirection: 1,
  fontSize: 18,
  lineHeight: 1.8,
  fontFamily: 'serif',
  paragraphGap: 0.45,
  searchQuery: '',
  paper: '#f1dbbe',
  ink: '#241c15',
  muted: 'rgba(36,28,21,0.52)',
  desk: 'walnut',
  endpaper: 'ivory',
  tilt: DEFAULT_TILT_DEG,
  zoom: DEFAULT_ZOOM,
  open: true,
  totalChars: 0,
  pageCount: 0,
  progress: 0,
  bookTitle: '',
  bookAuthor: '',
})

const emit = defineEmits<{
  (event: 'update:pitch', value: number): void
  (event: 'update:open', value: boolean): void
  (event: 'unsupported'): void
}>()

const hostRef = ref<HTMLElement | null>(null)
const hitRef = ref<HTMLElement | null>(null)
const unsupported = ref(false)
let scene: RealBookWebGLScene | null = null
let resizeObserver: ResizeObserver | null = null
let hitRaf = 0
let mounted = true
let draggingTilt = false
let dragStartY = 0
let dragStartPitch = 0
let dragMoved = false

const textureStyle = computed<RealBookTextureStyle>(() => ({
  fontSize: props.fontSize,
  lineHeight: Math.max(1, props.fontSize * props.lineHeight),
  fontFamily: props.fontFamily,
  paragraphGap: Math.max(0, props.fontSize * props.paragraphGap),
  paper: props.paper,
  ink: props.ink,
  muted: props.muted,
  searchQuery: props.searchQuery,
}))

const pages = computed(() => ({
  left: props.leftPage,
  right: props.rightPage,
  flipFront: props.flipFrontPage,
  flipBack: props.flipBackPage,
}))

function syncScene(): void {
  if (!scene) return
  scene.setPages(pages.value, textureStyle.value)
  scene.setView(props.tilt, props.zoom)
  scene.setOpen(props.open, false)
  scene.setProgress(props.progress, props.totalChars, props.pageCount)
  scene.setAppearance(props.desk, props.endpaper)
  scene.setFlip(props.flipping, props.flipProgress, props.flipDirection)
}

function updateHitRect(): void {
  if (!scene || !hitRef.value) return
  const rect = scene.getBookScreenRect()
  hitRef.value.style.left = `${Math.max(0, rect.left)}px`
  hitRef.value.style.top = `${Math.max(0, rect.top)}px`
  hitRef.value.style.width = `${Math.max(1, rect.width)}px`
  hitRef.value.style.height = `${Math.max(1, rect.height)}px`
}

function hitLoop(): void {
  if (!mounted) return
  updateHitRect()
  hitRaf = requestAnimationFrame(hitLoop)
}

function onPointerDown(event: PointerEvent): void {
  // 目标站用右键 / Alt 拖动调整视角；左键留给 Reader 的分区翻页和选字。
  if (event.button !== 2 && !(event.button === 0 && event.altKey)) return
  event.preventDefault()
  draggingTilt = true
  dragMoved = false
  dragStartY = event.clientY
  dragStartPitch = props.tilt
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (!draggingTilt) return
  const delta = event.clientY - dragStartY
  if (Math.abs(delta) > 2) dragMoved = true
  emit('update:pitch', clampPitch(dragStartPitch + delta * TILT_SENSITIVITY, MAX_TILT_DEG))
}

function onPointerUp(event: PointerEvent): void {
  if (!draggingTilt) return
  draggingTilt = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
  if (dragMoved) event.stopPropagation()
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
}

function setOpen(open: boolean): void {
  scene?.setOpen(open, false)
  emit('update:open', open)
}

function toggleOpen(): void {
  setOpen(!props.open)
}

function setPitch(value: number): void {
  emit('update:pitch', clampPitch(value, MAX_TILT_DEG))
}

defineExpose({
  /** 让 Reader 的三分区翻页按书体实际屏幕投影计算，而不是整块舞台。 */
  paperEl: hitRef,
  setOpen,
  toggleOpen,
  setPitch,
})

onMounted(async () => {
  if (typeof WebGL2RenderingContext === 'undefined' && typeof WebGLRenderingContext === 'undefined') {
    unsupported.value = true
    emit('unsupported')
    return
  }
  const canvas = document.createElement('canvas')
  let gl: RenderingContext | null = null
  try {
    gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  } catch {
    gl = null
  }
  if (!gl) {
    unsupported.value = true
    emit('unsupported')
    return
  }
  if (!hostRef.value) return
  try {
    const module = await import('./realBookWebGLScene')
    if (!mounted || !hostRef.value) return
    scene = new module.RealBookWebGLScene(hostRef.value, {
      style: textureStyle.value,
      pages: pages.value,
      desk: props.desk,
      endpaper: props.endpaper,
      tiltDeg: props.tilt,
      zoom: props.zoom,
      open: props.open,
      totalChars: props.totalChars,
      pageCount: Math.max(1, props.pageCount),
      progress: props.progress,
      bookTitle: props.bookTitle,
      bookAuthor: props.bookAuthor,
    })
    resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      scene?.resize()
      updateHitRect()
    })
    if (hostRef.value) resizeObserver?.observe(hostRef.value)
    hitLoop()
  } catch (error) {
    unsupported.value = true
    emit('unsupported')
    // 让控制台保留真实原因；UI 只负责回退，不吞掉诊断信息。
    console.error('[realbook-webgl] init failed', error)
  }
})

watch(pages, syncScene, { deep: true })
watch(textureStyle, syncScene, { deep: true })
watch(() => [props.tilt, props.zoom], () => scene?.setView(props.tilt, props.zoom))
watch(() => [props.open], () => scene?.setOpen(props.open, false))
watch(() => [props.desk, props.endpaper], () => scene?.setAppearance(props.desk, props.endpaper))
watch(() => [props.totalChars, props.pageCount, props.progress], () => scene?.setProgress(props.progress, props.totalChars, props.pageCount))
watch(() => [props.flipping, props.flipProgress, props.flipDirection], () => scene?.setFlip(props.flipping, props.flipProgress, props.flipDirection))

onBeforeUnmount(() => {
  mounted = false
  cancelAnimationFrame(hitRaf)
  resizeObserver?.disconnect()
  resizeObserver = null
  scene?.dispose()
  scene = null
})
</script>

<template>
  <div
    ref="hostRef"
    class="real-book-webgl-stage"
    data-renderer="webgl"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @contextmenu="onContextMenu"
  >
    <div ref="hitRef" class="real-book-webgl-hit" aria-hidden="true"></div>
    <div v-if="unsupported" class="real-book-webgl-fallback" role="status">
      WebGL 不可用，已保留 CSS 3D 回退
    </div>
  </div>
</template>

<style scoped>
.real-book-webgl-stage {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
  cursor: grab;
}

.real-book-webgl-stage:active {
  cursor: grabbing;
}

.real-book-webgl-hit {
  position: absolute;
  pointer-events: none;
  z-index: 2;
}

.real-book-webgl-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--rb-ui-ink, #2e2c26);
  font-size: 13px;
  letter-spacing: 0.04em;
  pointer-events: none;
}
</style>
