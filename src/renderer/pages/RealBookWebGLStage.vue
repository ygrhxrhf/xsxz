<script setup lang="ts">
/**
 * 真实书籍的 WebGL 渲染层。
 *
 * 它是 `RealBookStage` 的视觉子层：分页、锚点、进度、批注仍由父组件算，
 * 这里接收“任意页纹理 + 当前叶序号”，用参考站的 BookModel 画整本书；翻页、
 * 拖页与开合都由 BookModel 自己推进，落定后再把新叶序号回报给父层。
 * 保留 CSS 3D 舞台作为回退，因此本组件不接管任何 Reader 级状态。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { PAGE_TEXTURE_HEIGHT, PAGE_TEXTURE_WIDTH, buildPageTexturePlan, wrapTextureText, type PageTextureLine, type PageTexturePlan, type RealBookTexturePage, type RealBookTextureStyle } from './realBookTexture'
import { imageBlockLayout, noteBlockLayout, type PageImageLayout, type PageNoteLayout, type PageTextRun } from './realBookBlocks'
import type { RealBookSceneFlip, RealBookWebGLScene } from './realBookWebGLScene'
import { quadToMatrix3d, highlightRects, noteDots, type PageScreenQuad, type PageMarkRect, type PageNoteDot } from './realBookTextLayer'
import { flyerFacePages, flyerPieceMatrix, splitFlyerLine, type FlyerTextPiece } from './realBookFlyerText'
import {
  crossSelectionBoxes,
  orderSelection,
  type CrossLineBox,
  type CrossSelectionRange,
  type SelectionPoint,
} from './realBookCrossSelection'
import { BOOK_WIDTH, DEFAULT_ZOOM, type RealBookDesk, type RealBookEndpaper } from './realBookWebGLModel'
import { curlReach } from './realBookLeafSim'
import { clampPitch, DEFAULT_TILT_DEG, MAX_TILT_DEG, TILT_SENSITIVITY } from './realBookPitch'

const props = withDefaults(defineProps<{
  leftPage: RealBookTexturePage | null
  rightPage: RealBookTexturePage | null
  /** 此刻在飞的纸（CSS 回退用；WebGL 的飞页由 BookModel 自己管理）。 */
  flips?: RealBookSceneFlip[]
  /** 任意页的纹理页对象（0-based；双页模式偶数页是右页）。 */
  pageAt?: (index: number) => RealBookTexturePage | null
  /** 当前摊开的叶序号（左页数）。 */
  turned?: number
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
  /** 窄屏单页模式。 */
  singlePage?: boolean
  /** 逻辑页尺寸与版心，供窄屏重排。 */
  pageWidth?: number
  pageHeight?: number
  marginInner?: number
  marginOuter?: number
  marginTop?: number
  marginBottom?: number
  tilt?: number
  zoom?: number
  open?: boolean
  totalChars?: number
  pageCount?: number
  progress?: number
  bookTitle?: string
  bookAuthor?: string
  /** 书 id：章内图片走 spbf-image:// 协议按它取图。 */
  bookId?: string
}>(), {
  flips: () => [],
  turned: 0,
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
  singlePage: false,
  pageWidth: PAGE_TEXTURE_WIDTH,
  pageHeight: PAGE_TEXTURE_HEIGHT,
  marginInner: 80,
  marginOuter: 58,
  marginTop: 78,
  marginBottom: 100,
  tilt: DEFAULT_TILT_DEG,
  zoom: DEFAULT_ZOOM,
  open: true,
  totalChars: 0,
  pageCount: 0,
  progress: 0,
  bookTitle: '',
  bookAuthor: '',
  bookId: '',
})

const emit = defineEmits<{
  (event: 'update:pitch', value: number): void
  (event: 'update:open', value: boolean): void
  (event: 'page-turn', direction: 1 | -1): void
  /** BookModel 落定：父层据此换页（turned = 左侧页数）。 */
  (event: 'spread-changed', turned: number): void
  (event: 'next-chapter'): void
  (event: 'prev-chapter'): void
  /** 开始拖页：关闭 Reader 的选字工具条（参考站 beginDrag 会 clearSelection）。 */
  (event: 'clear-selection'): void
  /** 拖页开始：父组件据此把飞页挂出来（它才知道正反面是哪两页）。 */
  (event: 'peel-start', direction: 1 | -1, u?: number, v?: number): void
  /**
   * 拖页进度 0–1：纸跟着手走；grabV/pointerV 是起拖与当前手指在纸上的纵向位置（0–1），
   * u 是起拖时手捏在纸上的横向位置（参考站的 beginDrag(u)，决定纸绕哪一点卷）。
   */
  (event: 'peel-progress', progress: number, grabV: number, pointerV: number, u?: number): void
  /** 松手：complete 为真则落定翻页，否则纸回弹、页面不变。 */
  (event: 'peel-end', complete: boolean): void
  /** 点书口注释标签：交给父组件打开对应的批注。 */
  (event: 'edit-note', id: string): void
  /** 跨页选择完成：两端坐标 + 松手位置。 */
  (event: 'select-range', range: CrossSelectionRange): void
  /** 跨页选择请求翻页：只允许本章内翻页，不能触发续章。 */
  (event: 'cross-turn', direction: 1 | -1): void
  (event: 'unsupported'): void
}>()

const hostRef = ref<HTMLElement | null>(null)
const hitRef = ref<HTMLElement | null>(null)
const leftTextRef = ref<HTMLElement | null>(null)
const rightTextRef = ref<HTMLElement | null>(null)
const flipTextRef = ref<HTMLElement | null>(null)
const unsupported = ref(false)
let scene: RealBookWebGLScene | null = null
let resizeObserver: ResizeObserver | null = null
let hitRaf = 0
let mounted = true
let draggingTilt = false
let dragStartY = 0
let dragStartPitch = 0
let dragMoved = false
/** 参考站 BookModel 的拖页：按下即 beginDrag，移动 moveDrag，松开 endDrag。 */
let pageDrag: { id: number; startX: number; startY: number; lastX: number; lastT: number; vx: number; moved: boolean } | null = null
let turnQueue: (1 | -1)[] = []
let suppressMouseUp = false
/** 拖页状态：纸跟着手指走，松手时按走过的比例 + 甩动速度决定落定还是回弹。 */
interface PeelState {
  side: 1 | -1
  progress: number
  /** 起拖时手捏在纸上的位置（页宽 0–1）：参考站的 beginDrag(u) 决定纸绕哪一点卷。 */
  u: number
  /** 沿翻页方向的移动速度（px/ms）：快速小幅一甩也该翻页。 */
  speed: number
  lastDirectional: number
  lastAt: number
}
let peelState: PeelState | null = null

/** 章内图片：已解码的图片按文件名缓存，加载完成后加一轮 epoch 让纹理重画。 */
const images = shallowRef<ReadonlyMap<string, HTMLImageElement>>(new Map())
const imageEpoch = ref(0)
const imageLoaded = new Map<string, HTMLImageElement>()
const imageFailed = new Set<string>()

const textureStyle = computed<RealBookTextureStyle>(() => ({
  fontSize: props.fontSize,
  // 参考站 layout 的 CJK 行高是 fs × lineHeight × 1.16；页纹理按同一高度铺行，
  // 参考站排出的行数才能原样落在一页里。
  lineHeight: Math.max(1, props.fontSize * props.lineHeight * 1.16),
  fontFamily: props.fontFamily,
  // 参考站段与段之间没有额外间距，只靠 2em 首行缩进；页纹理不再加 paragraphGap。
  paragraphGap: 0,
  paper: props.paper,
  ink: props.ink,
  muted: props.muted,
  searchQuery: props.searchQuery,
  pageWidth: props.pageWidth,
  pageHeight: props.pageHeight,
  marginInner: props.marginInner,
  marginOuter: props.marginOuter,
  marginTop: props.marginTop,
  marginBottom: props.marginBottom,
  images: images.value,
  imageEpoch: imageEpoch.value,
  bookTitle: props.bookTitle,
  bookAuthor: props.bookAuthor,
}))

const pages = computed(() => ({
  left: props.leftPage,
  right: props.rightPage,
}))

/** 当前可见页与飞页上引用到的图片；页面换了才重新扫。 */
const imageFiles = computed<string[]>(() => {
  const set = new Set<string>()
  const add = (page: RealBookTexturePage | null | undefined): void => {
    for (const item of page?.items ?? []) if (item.kind === 'image') set.add(item.file)
  }
  add(props.leftPage)
  add(props.rightPage)
  for (const flip of props.flips) {
    add(flip.front)
    add(flip.back)
  }
  return [...set]
})

function ensureImages(): void {
  if (!props.bookId || typeof Image === 'undefined') return
  for (const file of imageFiles.value) {
    if (imageLoaded.has(file) || imageFailed.has(file)) continue
    const image = new Image()
    // 纹理要把图片画进 canvas：必须走 CORS，否则画布被污染、上传 WebGL 时整页变黑。
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => {
      imageLoaded.set(file, image)
      images.value = new Map(imageLoaded)
      imageEpoch.value += 1
    }
    image.onerror = () => {
      imageFailed.add(file)
    }
    image.src = `spbf-image://i/${encodeURIComponent(props.bookId)}/${encodeURIComponent(file)}`
  }
}

watch(() => `${props.bookId}|${imageFiles.value.join('|')}`, ensureImages, { immediate: true })

/*
 * 正文的 DOM 图层使用与分页器同一套逻辑页尺寸：桌面固定 640×920，窄屏单页用视口
 * 重排后的 pageWidth/pageHeight。若这里写死 640×920，手机会把超出 640 的行画到纸外。
 */
const textPageQuad = computed<PageScreenQuad>(() => [
  { x: 0, y: 0 },
  { x: Math.max(1, props.pageWidth), y: 0 },
  { x: Math.max(1, props.pageWidth), y: Math.max(1, props.pageHeight) },
  { x: 0, y: Math.max(1, props.pageHeight) },
])
const textLineHeight = computed(() => Math.max(1, props.fontSize * props.lineHeight))
const textPageStyle = computed(() => ({
  width: `${Math.max(1, props.pageWidth)}px`,
  height: `${Math.max(1, props.pageHeight)}px`,
  fontFamily: props.fontFamily,
  fontSize: `${props.fontSize}px`,
  lineHeight: `${textLineHeight.value}px`,
  color: props.ink,
}))
/**
 * 静态页的正文由这层 DOM 显示（纹理里不再画字）。
 *
 * 翻页时只藏“正在被翻走”的那一页：正面翻藏右页、往回翻藏左页；
 * 另一页仍是静态纸，字要一直可见，不能整层一起消失。
 */
const hasFlips = computed(() => props.flips.length > 0)
/** BookModel 翻页/开合中：参考站此时隐藏文字层，避免 DOM 字压在飞行纸上。 */
const sceneBusy = ref(false)
const flipDirection = computed<1 | -1>(() => props.flips[0]?.direction ?? 1)
const flipProgress = computed(() => props.flips[0]?.progress ?? 0)
const showTextLayer = computed(() => props.open && !sceneBusy.value)
/**
 * 飞页落到对面时会压在那一页的 DOM 正文上（DOM 永远在 canvas 之上），
 * 所以后半程把这侧的正文收掉；前 60% 纸还没盖过来，另一页的字必须可见。
 */
const showLeftTextPage = computed(() => props.open && (!hasFlips.value
  || (flipDirection.value === 1 && flipProgress.value < 0.6)))
const showRightTextPage = computed(() => props.open && (!hasFlips.value
  || (flipDirection.value === -1 && flipProgress.value < 0.6)))

function lineStyle(line: { x: number; y: number; height: number }): Record<string, string> {
  return { left: `${line.x}px`, top: `${line.y}px`, height: `${line.height}px` }
}

interface TextParagraphGroup {
  paragraphIndex: number
  lines: PageTextureLine[]
}

function groupTextLines(plan: { lines: PageTextureLine[] } | null): TextParagraphGroup[] {
  const groups = new Map<number, PageTextureLine[]>()
  for (const line of plan?.lines ?? []) {
    const list = groups.get(line.paragraphIndex)
    if (list) list.push(line)
    else groups.set(line.paragraphIndex, [line])
  }
  return [...groups.entries()].map(([paragraphIndex, lines]) => ({ paragraphIndex, lines }))
}

const leftPlan = computed(() => (props.leftPage
  ? buildPageTexturePlan(props.leftPage, { ...textureStyle.value, side: 'left' })
  : null))
const rightPlan = computed(() => (props.rightPage
  ? buildPageTexturePlan(props.rightPage, { ...textureStyle.value, side: 'right' })
  : null))
const leftTextParagraphs = computed(() => groupTextLines(leftPlan.value))
const rightTextParagraphs = computed(() => groupTextLines(rightPlan.value))

/**
 * 页眉页脚：与正文一样走 DOM，字是矢量的。
 *
 * 计划里给的是 alphabetic 基线（画布用），这里换成 DOM 行盒的 top：
 * 行盒高取 1.25 倍字号，基线在 `(行高 − (升部+降部)) / 2 + 升部` 处。
 */
interface ChromeLineBox {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}

function chromeBox(plan: PageTexturePlan, kind: 'header' | 'footer'): ChromeLineBox | null {
  const text = kind === 'header' ? plan.header : plan.footer
  if (!text) return null
  const fontSize = kind === 'header' ? plan.headerFontSize : plan.footerFontSize
  const baseline = kind === 'header' ? plan.headerBaseline : plan.footerBaseline
  const lineHeight = fontSize * 1.25
  const { ascent, descent } = fontLineMetrics(fontSize)
  const width = measureTextAt(fontSize, text)
  return {
    text,
    x: (plan.width - width) / 2,
    y: baseline - ((lineHeight - (ascent + descent)) / 2 + ascent),
    width,
    height: lineHeight,
    fontSize,
  }
}

function chromeBoxes(plan: PageTexturePlan | null): ChromeLineBox[] {
  if (!plan) return []
  return [chromeBox(plan, 'header'), chromeBox(plan, 'footer')]
    .filter((box): box is ChromeLineBox => Boolean(box))
}

const leftChrome = computed(() => chromeBoxes(leftPlan.value))
const rightChrome = computed(() => chromeBoxes(rightPlan.value))

/** 划线/搜索高亮的底色块与段内「注」点：与纹理同一套几何，改由 DOM 画。 */
const leftHighlightRects = computed(() => highlightRects(leftPlan.value?.lines ?? [], measureTextWidth))
const rightHighlightRects = computed(() => highlightRects(rightPlan.value?.lines ?? [], measureTextWidth))
const leftNoteDots = computed(() => noteDots(leftPlan.value?.lines ?? [], props.fontSize, measureTextWidth))
const rightNoteDots = computed(() => noteDots(rightPlan.value?.lines ?? [], props.fontSize, measureTextWidth))

function chromeStyle(box: ChromeLineBox): Record<string, string> {
  return {
    left: `${box.x}px`,
    top: `${box.y}px`,
    height: `${box.height}px`,
    lineHeight: `${box.height}px`,
    fontSize: `${box.fontSize}px`,
    color: props.muted,
  }
}

/** 与纹理同一套断行：批注卡在 DOM 里也必须是同样的行数、同样的断点。 */
function wrapTextAt(fontSize: number, text: string, maxWidth: number): string[] {
  const ctx = measureCanvas()
  if (!ctx) return text.trim() ? [text.trim()] : []
  ctx.font = `400 ${fontSize}px ${props.fontFamily}`
  return wrapTextureText(ctx, text, maxWidth).slice(0, 3)
}

const blockTools = {
  measure: (text: string, fontSize: number): number => measureTextAt(fontSize, text),
  wrap: (text: string, fontSize: number, maxWidth: number): string[] => wrapTextAt(fontSize, text, maxWidth),
}
const blockStyle = computed(() => ({ fontSize: props.fontSize, lineHeight: textLineHeight.value }))
const leftNoteBlocks = computed<PageNoteLayout[]>(() => (leftPlan.value
  ? leftPlan.value.notes.map((box) => noteBlockLayout(box, blockStyle.value, blockTools))
  : []))
const rightNoteBlocks = computed<PageNoteLayout[]>(() => (rightPlan.value
  ? rightPlan.value.notes.map((box) => noteBlockLayout(box, blockStyle.value, blockTools))
  : []))
const leftImageBlocks = computed<PageImageLayout[]>(() => (leftPlan.value
  ? leftPlan.value.images.map((box) => imageBlockLayout(box, blockStyle.value, blockTools))
  : []))
const rightImageBlocks = computed<PageImageLayout[]>(() => (rightPlan.value
  ? rightPlan.value.images.map((box) => imageBlockLayout(box, blockStyle.value, blockTools))
  : []))

/** 批注卡与图注的所有文字行，按页面坐标逐行绝对定位。 */
function allRuns(notes: PageNoteLayout[], images: PageImageLayout[]): PageTextRun[] {
  const runs: PageTextRun[] = []
  for (const note of notes) runs.push(...note.runs)
  for (const image of images) if (image.captionRun) runs.push(image.captionRun)
  return runs
}
const leftPageRuns = computed(() => allRuns(leftNoteBlocks.value, leftImageBlocks.value))
const rightPageRuns = computed(() => allRuns(rightNoteBlocks.value, rightImageBlocks.value))

/** 一行页内文字的行盒：基线换算成 top，行高留 1.35 倍字号。 */
function runBox(run: PageTextRun): { top: number; height: number } {
  const height = run.fontSize * 1.35
  const { ascent, descent } = fontLineMetrics(run.fontSize)
  return { top: run.baseline - ((height - (ascent + descent)) / 2 + ascent), height }
}

function runStyle(run: PageTextRun): Record<string, string> {
  const box = runBox(run)
  return {
    left: `${run.x}px`,
    top: `${box.top}px`,
    height: `${box.height}px`,
    lineHeight: `${box.height}px`,
    fontSize: `${run.fontSize}px`,
    color: run.role === 'note-body' ? props.ink : props.muted,
  }
}

function bookImageSrc(file: string): string {
  if (!props.bookId) return ''
  return `spbf-image://i/${encodeURIComponent(props.bookId)}/${encodeURIComponent(file)}`
}

function noteBoxStyle(note: PageNoteLayout): Record<string, string> {
  return {
    left: `${note.x}px`,
    top: `${note.y}px`,
    width: `${note.width}px`,
    height: `${note.height}px`,
  }
}

function imageBoxStyle(image: PageImageLayout): Record<string, string> {
  return {
    left: `${image.x}px`,
    top: `${image.y}px`,
    width: `${image.width}px`,
    height: `${image.height}px`,
  }
}
/** 书口注释标签：与页内注卡同一份排版结果，位置跟着纸页的 3D 变换走。 */
const leftNoteTabs = computed(() => leftPlan.value?.notes ?? [])
const rightNoteTabs = computed(() => rightPlan.value?.notes ?? [])

/**
 * 跨页选择：原生选区选中字后，把指针拖到书页外角并保持住 →
 * 先提示「保持按住，即将翻页…」，再自动翻一页，选区继续延伸。
 *
 * 翻页会重建文本层，原生选区活不过去，所以两端改成
 * 「段落原始下标 + 段内偏移」，翻页后在当前页画伪选区。
 */
const CROSS_HOLD_MS = 480
const CROSS_EDGE_PX = 46
const crossSel = ref<{
  /** 固定端：正向=选中的起点，反向=选中的终点。 */
  anchor: SelectionPoint
  /** 移动端：一直跟着指针/翻页方向延伸。 */
  end: SelectionPoint
  direction: 1 | -1
  pointer: { x: number; y: number }
  turnPending: boolean
  turnFrom: number | null
} | null>(null)
const crossHoldHint = ref(false)
const crossHintAt = ref({ x: 0, y: 0 })
let crossHoldTimer: ReturnType<typeof setTimeout> | null = null
let crossTurnTimer: ReturnType<typeof setTimeout> | null = null
let crossHoldPoint = { x: 0, y: 0 }
let measureCtx: CanvasRenderingContext2D | null = null
let measureCtxUnavailable = false

/** 与纹理绘制同一套字体量宽，伪选区/飞页贴面的盒子才不会和纸上的字错位。 */
function measureCanvas(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx
  if (measureCtxUnavailable || typeof document === 'undefined') return null
  try {
    measureCtx = document.createElement('canvas').getContext('2d')
  } catch {
    measureCtx = null
  }
  // jsdom 没有 canvas：失败一次就记住了，别每行字都去敲一遍（会刷屏）。
  if (!measureCtx) measureCtxUnavailable = true
  return measureCtx
}

function measureTextWidth(text: string): number {
  if (!text) return 0
  const ctx = measureCanvas()
  if (!ctx) return text.length * props.fontSize
  ctx.font = `400 ${props.fontSize}px ${props.fontFamily}`
  return ctx.measureText(text).width
}

/** 指定字号的量宽：页眉页脚比正文小，不能拿正文宽度估。 */
function measureTextAt(fontSize: number, text: string): number {
  if (!text) return 0
  const ctx = measureCanvas()
  if (!ctx) return text.length * fontSize
  ctx.font = `400 ${fontSize}px ${props.fontFamily}`
  return ctx.measureText(text).width
}

/** 字体升降部：把画布里的 alphabetic 基线换算成 DOM 行盒的 top。 */
function fontLineMetrics(fontSize: number): { ascent: number; descent: number } {
  const ctx = measureCanvas()
  if (!ctx) return { ascent: fontSize * 0.88, descent: fontSize * 0.22 }
  ctx.font = `400 ${fontSize}px ${props.fontFamily}`
  const metrics = ctx.measureText('中文Ag')
  const ascent = Number(metrics.fontBoundingBoxAscent) || Number(metrics.actualBoundingBoxAscent) || fontSize * 0.88
  const descent = Number(metrics.fontBoundingBoxDescent) || Number(metrics.actualBoundingBoxDescent) || fontSize * 0.22
  return { ascent, descent }
}

const leftCrossBoxes = computed<CrossLineBox[]>(() => {
  const sel = crossSel.value
  if (!sel || !leftPlan.value) return []
  return crossSelectionBoxes(leftPlan.value.lines, sel.anchor, sel.end, measureTextWidth)
})
const rightCrossBoxes = computed<CrossLineBox[]>(() => {
  const sel = crossSel.value
  if (!sel || !rightPlan.value) return []
  return crossSelectionBoxes(rightPlan.value.lines, sel.anchor, sel.end, measureTextWidth)
})

/** 选区一端 → 段落原始下标 + 段内偏移。行上有 data-start，段内有 data-p。 */
function pointInParagraph(container: Node, offset: number): SelectionPoint | null {
  const element = container.nodeType === Node.TEXT_NODE ? container.parentElement : container as Element | null
  const line = element?.closest('.real-book-text-line') as HTMLElement | null
  const paragraph = element?.closest('[data-p]') as HTMLElement | null
  if (!line || !paragraph) return null
  const lineStart = Number(line.dataset.start ?? '0')
  const index = Number(paragraph.dataset.p)
  if (!Number.isFinite(index)) return null
  return { paragraph: index, offset: lineStart + Math.max(0, offset) }
}

function caretPointAt(clientX: number, clientY: number): SelectionPoint | null {
  if (typeof document === 'undefined') return null
  type CaretDoc = Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const doc = document as CaretDoc
  const position = doc.caretPositionFromPoint?.(clientX, clientY)
  if (position) return pointInParagraph(position.offsetNode, position.offset)
  const range = doc.caretRangeFromPoint?.(clientX, clientY)
  if (range) return pointInParagraph(range.startContainer, range.startOffset)
  return null
}

/** 指针是否停在指定方向的外缘触发区（正向=右外缘，反向=左外缘）。 */
function isTurnEdge(clientX: number, clientY: number, direction: 1 | -1): boolean {
  const rect = hitRef.value?.getBoundingClientRect()
  if (!rect) return false
  const x = clientX - rect.left
  const y = clientY - rect.top
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return false
  if (y < rect.height * 0.1 || y > rect.height * 0.94) return false
  return direction === 1
    ? x > rect.width - CROSS_EDGE_PX
    : x < CROSS_EDGE_PX
}

function clearCrossTimer(): void {
  if (crossHoldTimer) clearTimeout(crossHoldTimer)
  crossHoldTimer = null
}

function cancelCrossHold(): void {
  clearCrossTimer()
  crossHoldHint.value = false
}

/** 可见两页里最早的一行（段落序 + 偏移取小）。 */
function earliestVisibleLine(): SelectionPoint | null {
  const candidates = [leftPlan.value?.lines[0], rightPlan.value?.lines[0]]
    .filter((line): line is NonNullable<typeof line> => Boolean(line))
  if (!candidates.length) return null
  const first = candidates.reduce((best, line) => {
    const cmp = line.paragraphIndex - best.paragraphIndex
    return cmp < 0 || (cmp === 0 && line.start < best.start) ? line : best
  }, candidates[0]!)
  return { paragraph: first.paragraphIndex, offset: first.start }
}

/** 可见两页里最晚的一行。 */
function latestVisibleLine(): SelectionPoint | null {
  const candidates = [
    leftPlan.value?.lines[leftPlan.value.lines.length - 1],
    rightPlan.value?.lines[rightPlan.value.lines.length - 1],
  ].filter((line): line is NonNullable<typeof line> => Boolean(line))
  if (!candidates.length) return null
  const last = candidates.reduce((best, line) => {
    const cmp = line.paragraphIndex - best.paragraphIndex
    return cmp > 0 || (cmp === 0 && line.end > best.end) ? line : best
  }, candidates[0]!)
  return { paragraph: last.paragraphIndex, offset: last.end }
}

function forwardPageEnd(): SelectionPoint | null {
  return latestVisibleLine()
}

function backwardPageStart(): SelectionPoint | null {
  return earliestVisibleLine()
}

/** 移动端的边界：正向 = 当前右页最后一行，反向 = 当前左页第一行。 */
function movingBoundary(direction: 1 | -1): SelectionPoint | null {
  return direction === 1 ? forwardPageEnd() : backwardPageStart()
}

/** 指针位置是否已经越过固定端、继续往翻页方向走。 */
function pointBeyondAnchor(point: SelectionPoint, anchor: SelectionPoint, direction: 1 | -1): boolean {
  const compare = point.paragraph === anchor.paragraph
    ? point.offset - anchor.offset
    : point.paragraph - anchor.paragraph
  return direction === 1 ? compare > 0 : compare < 0
}

function startCrossTimer(direction: 1 | -1): void {
  if (crossHoldTimer) return
  crossHintAt.value = { x: crossHoldPoint.x, y: crossHoldPoint.y }
  crossHoldHint.value = true
  crossHoldTimer = setTimeout(() => {
    crossHoldTimer = null
    beginCrossSelection(direction)
  }, CROSS_HOLD_MS)
}

function beginCrossSelection(direction: 1 | -1): void {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    cancelCrossHold()
    return
  }
  const range = selection.getRangeAt(0)
  const start = pointInParagraph(range.startContainer, range.startOffset)
  // 另一端拖到书页外缘时可能落在文字之外，按该方向的页边界收尾。
  const end = pointInParagraph(range.endContainer, range.endOffset) ?? movingBoundary(direction)
  if (!start || !end) {
    cancelCrossHold()
    return
  }
  const [from, to] = orderSelection(start, end)
  crossHoldHint.value = false
  crossSel.value = {
    // 正向：起点固定、终点移动；反向：终点固定、起点移动。
    anchor: direction === 1 ? from : to,
    end: direction === 1 ? to : from,
    direction,
    pointer: { ...crossHoldPoint },
    turnPending: false,
    turnFrom: null,
  }
  selection.removeAllRanges()
  requestCrossTurn()
}

function requestCrossTurn(): void {
  const sel = crossSel.value
  if (!sel || sel.turnPending) return
  sel.end = movingBoundary(sel.direction) ?? sel.end
  sel.turnPending = true
  sel.turnFrom = props.rightPage?.pageNumber ?? props.leftPage?.pageNumber ?? 0
  crossHoldHint.value = true
  crossHintAt.value = { ...sel.pointer }
  emit('cross-turn', sel.direction)
  // 本章边界时不会翻页，也就不会有页面变化；到点把等待收掉，选区停在边界。
  if (crossTurnTimer) clearTimeout(crossTurnTimer)
  crossTurnTimer = setTimeout(() => {
    crossTurnTimer = null
    const active = crossSel.value
    if (!active || !active.turnPending) return
    active.turnPending = false
    active.end = movingBoundary(active.direction) ?? active.end
    cancelCrossHold()
  }, 720)
}

function maybeHoldForCross(event: PointerEvent): void {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    cancelCrossHold()
    return
  }
  const direction: 1 | -1 = isTurnEdge(event.clientX, event.clientY, 1) ? 1 : (isTurnEdge(event.clientX, event.clientY, -1) ? -1 : 0)
  if (!direction) {
    cancelCrossHold()
    return
  }
  if (crossHoldTimer) return
  crossHoldPoint = { x: event.clientX, y: event.clientY }
  startCrossTimer(direction)
}

function handleCrossMove(event: PointerEvent): void {
  const sel = crossSel.value
  if (!sel) return
  sel.pointer = { x: event.clientX, y: event.clientY }
  const point = caretPointAt(event.clientX, event.clientY)
  if (point && pointBeyondAnchor(point, sel.anchor, sel.direction)) sel.end = point
  if (sel.turnPending) return
  if (isTurnEdge(event.clientX, event.clientY, sel.direction)) {
    if (!crossHoldTimer) {
      crossHoldPoint = { x: event.clientX, y: event.clientY }
      startCrossTimer(sel.direction)
    }
  } else {
    cancelCrossHold()
  }
}

function finishCrossSelection(): void {
  const sel = crossSel.value
  cancelCrossHold()
  if (crossTurnTimer) clearTimeout(crossTurnTimer)
  crossTurnTimer = null
  crossSel.value = null
  if (!sel) return
  const [from, to] = orderSelection(sel.anchor, sel.end)
  if (to.paragraph === from.paragraph && to.offset <= from.offset) return
  const range: CrossSelectionRange = {
    startParagraph: from.paragraph,
    startOffset: from.offset,
    endParagraph: to.paragraph,
    endOffset: to.offset,
    x: sel.pointer.x,
    y: sel.pointer.y,
  }
  // 紧随其后的 mouseup 不能落到 Reader 的选区处理上：原生选区已经被清掉，
  // 那一按会把刚抬起来的工具条又收回去。
  suppressMouseUp = true
  emit('select-range', range)
}

function cancelCrossSelection(): void {
  cancelCrossHold()
  if (crossTurnTimer) clearTimeout(crossTurnTimer)
  crossTurnTimer = null
  crossSel.value = null
}

// 一张纸落定后（flips 清空）把选区延伸到新页：指针还在外角就允许再翻一页。
watch(
  () => [props.leftPage?.pageNumber, props.rightPage?.pageNumber, props.flips.length] as const,
  () => {
    const sel = crossSel.value
    if (!sel || !sel.turnPending || props.flips.length > 0) return
    const pageNow = props.rightPage?.pageNumber ?? props.leftPage?.pageNumber ?? 0
    if (crossTurnTimer) clearTimeout(crossTurnTimer)
    crossTurnTimer = null
    sel.turnPending = false
    if (sel.turnFrom === pageNow) {
      // 本章边界：没有可翻的页，选区停在该方向的第一/最后一行。
      sel.end = movingBoundary(sel.direction) ?? sel.end
      cancelCrossHold()
      return
    }
    sel.end = caretPointAt(sel.pointer.x, sel.pointer.y) ?? movingBoundary(sel.direction) ?? sel.end
    crossHoldHint.value = false
    if (isTurnEdge(sel.pointer.x, sel.pointer.y, sel.direction)) {
      crossHoldPoint = { ...sel.pointer }
      startCrossTimer(sel.direction)
    }
  },
)

/**
 * 飞页正文的 DOM 贴面。
 *
 * 纹理里的字是位图，纸一卷就跟着糊；这里把最上面那张飞页的正文按行切段，
 * 每帧从场景的布料上取这一段三个角（左上、右上、左下）的屏幕位置，
 * 用 matrix3d 把一小段字贴到卷曲的纸面上。字是矢量的，卷到哪儿字就跟到哪儿。
 *
 * 只有最上面那张纸走 DOM：DOM 永远画在 canvas 之上，下面那张的字会盖到
 * 上面那张的纸面上；多张同飞时其余各张仍用带字的纹理。
 */
interface FlyerTextNode {
  kind: 'text'
  el: HTMLSpanElement
  piece: FlyerTextPiece
  /** 1 = 纸正面（起手朝上），-1 = 纸背。 */
  face: 1 | -1
  pageWidth: number
  pageHeight: number
  visible: boolean
}

/** 图片/注卡这类整块元素：一个矩阵贴整个块，内容在块内按本地坐标排。 */
interface FlyerBoxNode {
  kind: 'box'
  el: HTMLElement
  box: { x: number; y: number; width: number; height: number }
  face: 1 | -1
  pageWidth: number
  pageHeight: number
  visible: boolean
}

type FlyerNode = FlyerTextNode | FlyerBoxNode

let flyerTextNodes: FlyerNode[] = []
let flyerTextSignatureValue = ''
const flyerOrigin = { x: 0, y: 0, facing: 0 }
const flyerEdgeX = { x: 0, y: 0, facing: 0 }
const flyerEdgeY = { x: 0, y: 0, facing: 0 }

/** 页内容/版式变了才重建 DOM；翻页进度每帧都变，不能进签名。 */
function flyerTextSignature(): string {
  const head = props.flips[0]
  if (!head || !props.open) return ''
  return [
    head.id,
    head.direction,
    head.front?.pageNumber ?? 0,
    head.back?.pageNumber ?? 0,
    props.fontSize,
    props.lineHeight,
    props.fontFamily,
    props.paragraphGap,
    props.ink,
    props.muted,
    props.paper,
    props.searchQuery,
    props.pageWidth,
    props.pageHeight,
    props.marginInner,
    props.marginOuter,
    props.marginTop,
    props.marginBottom,
  ].join('|')
}

function rebuildFlyerText(signature: string, layer: HTMLElement): void {
  flyerTextSignatureValue = signature
  flyerTextNodes = []
  layer.textContent = ''
  const head = props.flips[0]
  if (!head) return
  // 与场景贴纹理共用同一套正反面分配，DOM 贴的字才不会和纸上的页心错开。
  const faces = flyerFacePages<RealBookTexturePage>(head.direction, head.front, head.back)
  const appendPiece = (piece: FlyerTextPiece, face: 1 | -1, plan: PageTexturePlan, fontSize: number, color: string): void => {
    const el = document.createElement('span')
    el.className = 'real-book-flip-line'
    el.dataset.face = face === 1 ? 'front' : 'back'
    el.textContent = piece.text
    el.style.fontFamily = props.fontFamily
    el.style.fontSize = `${fontSize}px`
    el.style.lineHeight = `${piece.height}px`
    el.style.color = color
    el.style.display = 'none'
    layer.appendChild(el)
    flyerTextNodes.push({
      kind: 'text',
      el,
      piece,
      face,
      pageWidth: plan.width,
      pageHeight: plan.height,
      visible: false,
    })
  }
  const appendBox = (el: HTMLElement, box: { x: number; y: number; width: number; height: number }, face: 1 | -1, plan: PageTexturePlan): void => {
    flyerTextNodes.push({
      kind: 'box',
      el,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      face,
      pageWidth: plan.width,
      pageHeight: plan.height,
      visible: false,
    })
  }
  const appendRun = (run: PageTextRun, face: 1 | -1, plan: PageTexturePlan): void => {
    const box = runBox(run)
    appendPiece({
      text: run.text,
      paragraphIndex: -1,
      start: 0,
      x: run.x,
      y: box.top,
      width: measureTextAt(run.fontSize, run.text),
      height: box.height,
    }, face, plan, run.fontSize, run.role === 'note-body' ? props.ink : props.muted)
  }
  const appendHighlight = (rect: PageMarkRect, face: 1 | -1, plan: PageTexturePlan): void => {
    const el = document.createElement('div')
    el.className = 'real-book-flip-mark'
    el.dataset.face = face === 1 ? 'front' : 'back'
    el.style.position = 'absolute'
    el.style.left = '0'
    el.style.top = '0'
    el.style.width = `${rect.width}px`
    el.style.height = `${rect.height}px`
    el.style.background = rect.color
    el.style.borderRadius = '1px'
    el.style.transformOrigin = '0 0'
    el.style.display = 'none'
    el.style.pointerEvents = 'none'
    layer.appendChild(el)
    appendBox(el, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, face, plan)
  }
  const appendNoteDot = (dot: PageNoteDot, face: 1 | -1, plan: PageTexturePlan): void => {
    const el = document.createElement('div')
    el.className = 'real-book-flip-note-dot'
    el.dataset.face = face === 1 ? 'front' : 'back'
    el.textContent = '注'
    el.style.position = 'absolute'
    el.style.left = '0'
    el.style.top = '0'
    el.style.width = `${dot.diameter}px`
    el.style.height = `${dot.diameter}px`
    el.style.lineHeight = `${dot.diameter}px`
    el.style.borderRadius = '50%'
    el.style.background = 'rgba(186, 112, 57, 0.9)'
    el.style.color = '#fff9ef'
    el.style.fontFamily = 'sans-serif'
    el.style.fontWeight = '500'
    el.style.fontSize = `${dot.fontSize}px`
    el.style.textAlign = 'center'
    el.style.transformOrigin = '0 0'
    el.style.display = 'none'
    el.style.pointerEvents = 'none'
    layer.appendChild(el)
    appendBox(el, {
      x: dot.x - dot.diameter / 2,
      y: dot.y - dot.diameter / 2,
      width: dot.diameter,
      height: dot.diameter,
    }, face, plan)
  }
  for (const entry of faces) {
    if (!entry.page) continue
    const plan = buildPageTexturePlan(entry.page, { ...textureStyle.value, side: entry.side })
    // 划线底色先铺，正文与注卡盖在上面。
    for (const rect of highlightRects(plan.lines, measureTextWidth)) appendHighlight(rect, entry.face, plan)
    for (const line of plan.lines) {
      for (const piece of splitFlyerLine(line, measureTextWidth)) {
        appendPiece(piece, entry.face, plan, props.fontSize, props.ink)
      }
    }
    // 页眉页脚同样切成小块贴上去：字号更小，量宽要用它自己的字号。
    for (const box of chromeBoxes(plan)) {
      const pieces = splitFlyerLine(
        { text: box.text, x: box.x, y: box.y, height: box.height, paragraphIndex: -1, start: 0 },
        (text) => measureTextAt(box.fontSize, text),
      )
      for (const piece of pieces) appendPiece(piece, entry.face, plan, box.fontSize, props.muted)
    }
    // 图片：块内用 object-fit: contain，整块由一个矩阵贴到纸面；图注单独按行贴。
    for (const box of plan.images) {
      const image = imageBlockLayout(box, blockStyle.value, blockTools)
      const figure = document.createElement('div')
      figure.className = 'real-book-flip-image'
      figure.dataset.face = entry.face === 1 ? 'front' : 'back'
      figure.style.position = 'absolute'
      figure.style.left = '0'
      figure.style.top = '0'
      figure.style.width = `${image.width}px`
      figure.style.height = `${image.height}px`
      figure.style.transformOrigin = '0 0'
      figure.style.display = 'none'
      figure.style.overflow = 'visible'
      figure.style.pointerEvents = 'none'
      const img = document.createElement('img')
      img.src = bookImageSrc(image.file)
      img.alt = image.caption
      img.draggable = false
      img.style.display = 'block'
      img.style.width = '100%'
      img.style.height = '100%'
      img.style.objectFit = 'contain'
      img.style.userSelect = 'none'
      img.style.pointerEvents = 'none'
      figure.appendChild(img)
      layer.appendChild(figure)
      appendBox(figure, image, entry.face, plan)
      if (image.captionRun) appendRun(image.captionRun, entry.face, plan)
    }
    // 注卡：底纹 + 左竖线是一整块，标签/正文/#tag 逐行贴在它上面。
    for (const box of plan.notes) {
      const note = noteBlockLayout(box, blockStyle.value, blockTools)
      const card = document.createElement('div')
      card.className = 'real-book-flip-note'
      card.dataset.face = entry.face === 1 ? 'front' : 'back'
      card.style.position = 'absolute'
      card.style.left = '0'
      card.style.top = '0'
      card.style.width = `${note.width}px`
      card.style.height = `${note.height}px`
      card.style.transformOrigin = '0 0'
      card.style.display = 'none'
      card.style.boxSizing = 'border-box'
      card.style.background = 'rgba(83, 67, 42, 0.055)'
      card.style.borderLeft = '1.5px solid rgba(120, 82, 47, 0.55)'
      layer.appendChild(card)
      appendBox(card, note, entry.face, plan)
      for (const run of note.runs) appendRun(run, entry.face, plan)
    }
    // 「注」点最后画，压在正文与注卡之上。
    for (const dot of noteDots(plan.lines, props.fontSize, measureTextWidth)) appendNoteDot(dot, entry.face, plan)
  }
}

/** 每帧把每一小段贴到布料当前形状上；侧成一条线、朝向不对时藏起来。 */
function updateFlipText(): void {
  const layer = flipTextRef.value
  if (!layer) return
  // 窄屏卷页的正文由纹理携带：卷曲处 DOM 小段会叠在一起。
  if (props.singlePage) {
    if (flyerTextNodes.length) {
      layer.textContent = ''
      flyerTextNodes = []
    }
    flyerTextSignatureValue = ''
    return
  }
  const signature = flyerTextSignature()
  if (!scene || !signature) {
    if (flyerTextNodes.length) {
      layer.textContent = ''
      flyerTextNodes = []
    }
    flyerTextSignatureValue = ''
    return
  }
  if (signature !== flyerTextSignatureValue) rebuildFlyerText(signature, layer)
  if (!flyerTextNodes.length || !hostRef.value || !hitRef.value) return
  const hostRect = hostRef.value.getBoundingClientRect()
  const hitRect = hitRef.value.getBoundingClientRect()
  const offsetX = hitRect.left - hostRect.left
  const offsetY = hitRect.top - hostRect.top
  const setVisible = (node: FlyerNode, visible: boolean): void => {
    if (node.visible === visible) return
    node.visible = visible
    node.el.style.display = visible ? '' : 'none'
  }
  for (const node of flyerTextNodes) {
    const { face, pageWidth, pageHeight } = node
    // 文字小段与整块（图片/注卡）都按同一个矩形贴面：左上 + 右上边 + 左下边。
    const area = node.kind === 'box' ? node.box : node.piece
    // 纸背的版心沿页宽镜像：与纸背材质 1−u 的贴图规则一致。
    const uAt = (x: number): number => (face === 1 ? x / pageWidth : 1 - x / pageWidth)
    const vAt = (y: number): number => 1 - y / pageHeight
    if (!scene.sampleFlipPage(0, uAt(area.x), vAt(area.y), flyerOrigin)) {
      setVisible(node, false)
      continue
    }
    // 正反面互斥：纸正面朝镜头时纸背的内容不画，翻过 90° 后反过来。
    if ((face === 1) !== (flyerOrigin.facing > 0)) {
      setVisible(node, false)
      continue
    }
    if (!scene.sampleFlipPage(0, uAt(area.x + area.width), vAt(area.y), flyerEdgeX)
      || !scene.sampleFlipPage(0, uAt(area.x), vAt(area.y + area.height), flyerEdgeY)) {
      setVisible(node, false)
      continue
    }
    flyerOrigin.x -= offsetX
    flyerOrigin.y -= offsetY
    flyerEdgeX.x -= offsetX
    flyerEdgeX.y -= offsetY
    flyerEdgeY.x -= offsetX
    flyerEdgeY.y -= offsetY
    const transform = flyerPieceMatrix(flyerOrigin, flyerEdgeX, flyerEdgeY, area.width, area.height)
    if (!transform) {
      setVisible(node, false)
      continue
    }
    setVisible(node, true)
    node.el.style.transform = transform
  }
}

function updateTextLayer(): void {
  if (!scene || !props.open || !hostRef.value || !hitRef.value) return
  const hostRect = hostRef.value.getBoundingClientRect()
  const hitRect = hitRef.value.getBoundingClientRect()
  const offsetX = hitRect.left - hostRect.left
  const offsetY = hitRect.top - hostRect.top
  const adjust = (quad: PageScreenQuad): PageScreenQuad => quad.map((point) => ({ x: point.x - offsetX, y: point.y - offsetY })) as PageScreenQuad
  const right = adjust(scene.getPageScreenQuad('right'))
  if (!props.singlePage) {
    const left = adjust(scene.getPageScreenQuad('left'))
    if (leftTextRef.value) leftTextRef.value.style.transform = quadToMatrix3d(textPageQuad.value, left)
  }
  if (rightTextRef.value) rightTextRef.value.style.transform = quadToMatrix3d(textPageQuad.value, right)
}

function onTextMouseup(event: MouseEvent): void {
  if (window.getSelection()?.toString()) event.stopPropagation()
}

function syncScene(): void {
  if (!scene) return
  scene.setPages(pages.value, textureStyle.value)
  scene.setPageSource(props.pageAt ?? null, Math.max(1, props.pageCount), props.singlePage, props.turned ?? 0)
  scene.setView(props.tilt, props.zoom)
  scene.setOpen(props.open, false)
  scene.setProgress(props.progress, props.totalChars, props.pageCount)
  scene.setAppearance(props.desk, props.endpaper)
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
  const busy = scene?.busy ?? false
  if (busy !== sceneBusy.value) sceneBusy.value = busy
  updateHitRect()
  updateTextLayer()
  updateFlipText()
  hitRaf = requestAnimationFrame(hitLoop)
}

function pageDragZone(event: PointerEvent): 1 | -1 | null {
  if (!hitRef.value) return null
  const rect = hitRef.value.getBoundingClientRect()
  const x = event.clientX - rect.left
  const outer = x < rect.width * 0.25 || x > rect.width * 0.75
  // 外缘是抓纸区，即使透明文本层覆盖也优先翻页；正文区仍留给选字。
  if (!outer) {
    const target = event.target as HTMLElement | null
    if (target?.closest('.real-book-text-para')) return null
  }
  const hit = event.target as HTMLElement | null
  if (hit?.closest('.real-book-note-tab')) return null
  if (x < rect.width * 0.25) return -1
  if (x > rect.width * 0.75) return 1
  return null
}

/** 沿翻页方向的位移：右侧往左拖是正向。 */
function directionalDx(side: 1 | -1): number {
  return side === 1 ? -pageDragDx : pageDragDx
}

/**
 * 手指在纸上的纵向位置（0–1）：窄屏卷页把折线按它倾斜。
 *
 * 用舞台的命中层做归一化，手机单页正好铺满命中层；取不到矩形时退回页心。
 */
function pageVAt(clientY: number): number {
  const rect = hitRef.value?.getBoundingClientRect()
  if (!rect || rect.height <= 0) return 0.5
  return Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
}

/** 起拖阈值（px）：小于它按点按处理，不让一次点击把纸掀一下再弹回去。 */
const PEEL_START_PX = 10
/**
 * 松手时的落定阈值：与参考站 BookModel.endDrag 同一条规则——
 * 纸角走过 π·0.46（即弦角的 46%），或者「走得不多但甩得快」。
 */
const PEEL_COMMIT_PROGRESS = 0.46
const PEEL_FLICK_PROGRESS = 0.12
const PEEL_FLICK_SPEED = 0.9

/** 起拖时手捏在纸上的位置（页宽 0–1）：参考站 clamp(zone.u, 0.55, 0.97)。 */
function grabU(side: 1 | -1, clientX: number): number {
  const rect = scene?.getBookScreenRect()
  if (!rect || rect.width <= 0) return 0.95
  if (props.singlePage) return 0.95
  const pagePx = rect.width / 2
  const center = rect.left + rect.width / 2
  const u = side === 1 ? (clientX - center) / pagePx : (center - clientX) / pagePx
  return Math.max(0.55, Math.min(0.97, u))
}

/**
 * 拖页的手进度 = 参考站的弦角相位。
 *
 * 参考站不是按「拖了多少像素」线性翻纸，而是解 `curlReach(phi).x == 手指 x`：
 * 被捏住的点在卷曲弧面的末端，手指的横向位置决定它现在在弧上的哪一段。
 * 在纸还平躺时，这个映射对横向移动更敏感；越立起来越线性。参考站再用一半
 * 线性映射压住近纸面处的敏感性，所以这里同样取 0.5×弦角解 + 0.5×线性。
 */
function dragPhase(side: 1 | -1, u: number, directional: number): number {
  const rect = scene?.getBookScreenRect()
  const widthPx = rect?.width ?? 600
  if (props.singlePage) {
    // 手机卷页：参考站 movePhoneDrag 的线性映射，满行程是两页宽。
    return Math.max(0, Math.min(1, directional / Math.max(1, widthPx * 2)))
  }
  const pagePx = Math.max(1, widthPx / 2)
  const d = BOOK_WIDTH * u
  const dxWorld = directional * (BOOK_WIDTH / pagePx)
  const x = side === 1 ? d - dxWorld : -d + dxWorld
  let lo = 0
  let hi = Math.PI
  for (let i = 0; i < 18; i += 1) {
    const mid = (lo + hi) / 2
    if (curlReach(mid, side, 0.5, u, BOOK_WIDTH).x > x) lo = mid
    else hi = mid
  }
  const curlPhi = (lo + hi) / 2
  // 线性映射与参考站一致：从起手的「满页臂」量到反方向的「满页臂」。
  const linearPhi = Math.PI * Math.max(0, Math.min(1, (d - x) / (2 * d)))
  const phi = 0.5 * curlPhi + 0.5 * linearPhi
  return Math.max(0, Math.min(1, side === 1 ? phi / Math.PI : 1 - phi / Math.PI))
}

function onPointerDown(event: PointerEvent): void {
  scene?.noteInteraction()
  // 左键拖外缘翻页；右键 / Alt 拖动调整视角；正文拖拽留给选字。
  if (event.button === 0 && !event.altKey) {
    // 与参考站一致：命中纸张抓取区就直接交给 BookModel 的解算器，纸跟手走。
    if (!scene?.beginDragAt(event.clientX, event.clientY)) return
    // 参考站 beginDrag 会清掉选区；否则松手后 Reader 的三分区会把这次拖页当成选字。
    window.getSelection()?.removeAllRanges()
    emit('clear-selection')
    pageDrag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastT: performance.now(),
      vx: 0,
      moved: false,
    }
    dragMoved = false
    suppressMouseUp = false
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    return
  }
  if (event.button !== 2 && !(event.button === 0 && event.altKey)) return
  event.preventDefault()
  draggingTilt = true
  dragMoved = false
  dragStartY = event.clientY
  dragStartPitch = props.tilt
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  scene?.noteInteraction()
  if (pageDrag) {
    const now = performance.now()
    const dt = Math.max(1, now - pageDrag.lastT) / 1000
    pageDrag.vx = pageDrag.vx * 0.6 + ((event.clientX - pageDrag.lastX) / dt) * 0.4
    pageDrag.lastX = event.clientX
    pageDrag.lastT = now
    if (Math.hypot(event.clientX - pageDrag.startX, event.clientY - pageDrag.startY) > 9) pageDrag.moved = true
    scene?.moveDragAt(event.clientX, event.clientY)
    return
  }
  if (!draggingTilt) {
    if (crossSel.value) {
      handleCrossMove(event)
      return
    }
    if (event.buttons & 1) {
      maybeHoldForCross(event)
      return
    }
    updateHoverPeel(event)
    return
  }
  const delta = event.clientY - dragStartY
  if (Math.abs(delta) > 2) dragMoved = true
  emit('update:pitch', clampPitch(dragStartPitch + delta * TILT_SENSITIVITY, MAX_TILT_DEG))
}

/**
 * 悬停预掀：指针靠近书页外角时请求场景把那一角翘起来。
 *
 * 只认外缘 30px 内的区域，越靠角强度越大；翻页中或合上时一律落回，
 * 免得飞页已经压在角落里，下面还翘着一块纸。
 */
function updateHoverPeel(event: PointerEvent): void {
  // 与参考站同一套：光标进入可抓取的外缘（非正文版心）就把那一页纸角掀起，
  // 离开就落回；不是按 30px 距离给一个渐变量。
  if (!scene || !props.open || scene.busy) {
    scene?.setHoverPeel(null, 0, 1)
    return
  }
  const hover = scene.hoverZoneAt(event.clientX, event.clientY)
  if (!hover) {
    scene.setHoverPeel(null, 0, 1)
    return
  }
  scene.setHoverPeel(hover.side === 1 ? 'right' : 'left', 1, 1, hover.v)
}

function onPointerLeave(): void {
  scene?.setHoverPeel(null, 0, 1)
  if (!crossSel.value) cancelCrossHold()
}

function onPointerUp(event: PointerEvent): void {
  scene?.noteInteraction()
  if (crossSel.value) {
    finishCrossSelection()
    event.stopPropagation()
    return
  }
  cancelCrossHold()
  if (pageDrag) {
    const drag = pageDrag
    pageDrag = null
    ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
    const height = hitRef.value?.getBoundingClientRect().height ?? 900
    const fresh = performance.now() - drag.lastT < 90
    const velocity = fresh ? (drag.vx / Math.max(1, height)) * 9 : 0
    suppressMouseUp = true
    scene?.endDrag(velocity, drag.moved, !drag.moved)
    event.stopPropagation()
    return
  }
  if (!draggingTilt) return
  draggingTilt = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
  if (dragMoved) event.stopPropagation()
}

/** 指针被系统抢走（切窗口、手势中断）：按取消处理，纸回弹。 */
function onPointerCancel(): void {
  cancelCrossSelection()
  if (pageDrag) scene?.cancelDrag()
  pageDrag = null
  draggingTilt = false
}

function onMouseUp(event: MouseEvent): void {
  if (!suppressMouseUp) return
  suppressMouseUp = false
  event.stopPropagation()
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
}

function setOpen(open: boolean): void {
  // 参考站 setOpen 是 psi 弹簧动画；落定后由 scene.onSettle 回报 update:open。
  scene?.setOpen(open, true)
}

function toggleOpen(): void {
  setOpen(!props.open)
}

function setPitch(value: number): void {
  emit('update:pitch', clampPitch(value, MAX_TILT_DEG))
}

/**
 * 翻页请求：与参考站 performTurn 同一套入口。
 *
 * BookModel 允许同方向多张纸同时在飞；如果此刻被一张反向纸/封面临时挡住，
 * 就排进本层的小队列，落定后再放出来。到达本章最后一叶才交给父层换章。
 */
function requestTurn(direction: 1 | -1): void {
  if (!scene) return
  if (!props.open) {
    setOpen(true)
    return
  }
  if (scene.turn(direction, 1, true)) return
  if (!scene.busy) {
    if (!scene.canTurn(direction)) {
      // 参考站：在第一叶继续往回翻是合上书，不是跳上一章。
      if (direction === -1 && scene.settledTurned === 0) {
        setOpen(false)
        return
      }
      emit(direction === 1 ? 'next-chapter' : 'prev-chapter')
      return
    }
  }
  if (turnQueue.length < 12) turnQueue.push(direction)
}

function drainTurns(): void {
  const next = turnQueue[0]
  if (!next || !scene) return
  if (scene.turn(next, 1, true)) {
    turnQueue.shift()
    return
  }
  if (!scene.busy && !scene.canTurn(next)) {
    turnQueue.shift()
    if (next === -1 && scene.settledTurned === 0) setOpen(false)
    else emit(next === 1 ? 'next-chapter' : 'prev-chapter')
  }
}

function nextPage(): void {
  requestTurn(1)
}

function prevPage(): void {
  requestTurn(-1)
}

defineExpose({
  /** 让 Reader 的三分区翻页按书体实际屏幕投影计算，而不是整块舞台。 */
  paperEl: hitRef,
  setOpen,
  toggleOpen,
  setPitch,
  nextPage,
  prevPage,
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
      pageAt: props.pageAt,
      turned: props.turned ?? 0,
      desk: props.desk,
      endpaper: props.endpaper,
      singlePage: props.singlePage,
      tiltDeg: props.tilt,
      zoom: props.zoom,
      open: props.open,
      totalChars: props.totalChars,
      pageCount: Math.max(1, props.pageCount),
      progress: props.progress,
      bookTitle: props.bookTitle,
      bookAuthor: props.bookAuthor,
    })
    scene.onSettle = (turned, open) => {
      emit('spread-changed', turned)
      emit('update:open', open)
      updateHitRect()
      drainTurns()
    }
    // 观感复核与自动化脚本要看到「纸现在转到哪、卷成什么样」：只挂一个只读探针，
    // 不参与渲染，也不写任何页面状态。没有它脚本就只能靠截图猜帧。
    ;(window as unknown as Record<string, unknown>).__rbSceneProbe = () => {
      const first = scene?.probeFlipState()[0]
      return first ?? null
    }
    ;(window as unknown as Record<string, unknown>).__rbSceneProbeAll = () => scene?.probeFlipState() ?? []
    ;(window as unknown as Record<string, unknown>).__rbBookProbe = () => scene?.probeBook() ?? null
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
watch(() => [props.singlePage, props.pageWidth, props.pageHeight], () => scene?.setSinglePage(props.singlePage, props.pageWidth, props.pageHeight))
watch(() => [props.open], () => scene?.setOpen(props.open, false))
watch(() => [props.desk, props.endpaper], () => scene?.setAppearance(props.desk, props.endpaper))
watch(
  () => [props.pageAt, props.pageCount, props.turned, props.singlePage],
  () => {
    scene?.setPageSource(props.pageAt ?? null, Math.max(1, props.pageCount), props.singlePage, props.turned ?? 0)
    updateHitRect()
  },
)
watch(() => [props.totalChars, props.progress], () => scene?.setProgress(props.progress, props.totalChars, props.pageCount))
watch(
  () => props.flips,
  () => {
    scene?.setFlips(props.flips)
    if (props.flips.length) scene?.setHoverPeel(null, 0, 1)
    // 飞页正文跟着这张纸的上下场立刻建/清，不等下一帧 rAF。
    // 窗口被切到后台时 Chromium 会停 rAF：只靠帧循环的话，纸已经掀起来、
    // 正文层却还是空的，回到前台前一直是一张白纸。
    updateFlipText()
  },
  { deep: true },
)
watch(() => props.open, (open) => {
  if (!open) scene?.setHoverPeel(null, 0, 1)
})

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
    @pointercancel="onPointerCancel"
    @pointerleave="onPointerLeave"
    @mouseup="onMouseUp"
    @contextmenu="onContextMenu"
  >
    <div ref="hitRef" class="real-book-webgl-hit" aria-hidden="true">
      <div v-show="showTextLayer" class="real-book-webgl-text-layer">
        <div
          ref="leftTextRef"
          v-show="!props.singlePage && showLeftTextPage"
          class="real-book-webgl-text-page"
          :style="textPageStyle"
          @mouseup="onTextMouseup"
        >
          <span
            v-for="(box, index) in leftChrome"
            :key="`left-chrome-${index}`"
            class="real-book-chrome-line"
            :style="chromeStyle(box)"
            aria-hidden="true"
          >{{ box.text }}</span>
          <div
            v-for="(rect, index) in leftHighlightRects"
            :key="`left-mark-${index}`"
            class="real-book-mark"
            :style="{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, background: rect.color }"
            aria-hidden="true"
          ></div>
          <div
            v-for="note in leftNoteBlocks"
            :key="`left-note-${note.id}`"
            class="real-book-note-card"
            :style="noteBoxStyle(note)"
            role="button"
            tabindex="0"
            :title="note.note.text"
            :aria-label="`查看批注：${note.note.text.slice(0, 16)}`"
            @click.stop="emit('edit-note', note.id)"
            @pointerdown.stop
            @mouseup.stop
            @keydown.enter.stop.prevent="emit('edit-note', note.id)"
            @keydown.space.stop.prevent="emit('edit-note', note.id)"
          ></div>
          <figure
            v-for="image in leftImageBlocks"
            :key="`left-image-${image.file}`"
            class="real-book-webgl-image"
            :style="imageBoxStyle(image)"
          >
            <img :src="bookImageSrc(image.file)" :alt="image.caption" draggable="false" />
          </figure>
          <span
            v-for="(run, index) in leftPageRuns"
            :key="`left-run-${index}`"
            class="real-book-page-run"
            :style="runStyle(run)"
            aria-hidden="true"
          >{{ run.text }}</span>
          <div
            v-for="group in leftTextParagraphs"
            :key="`left-p${group.paragraphIndex}`"
            class="real-book-text-para"
            :data-p="group.paragraphIndex"
          >
            <span
              v-for="(line, index) in group.lines"
              :key="index"
              class="real-book-text-line"
              :data-start="line.start"
              :style="lineStyle(line)"
            >{{ line.text }}</span>
          </div>
          <span
            v-for="(dot, index) in leftNoteDots"
            :key="`left-dot-${index}`"
            class="real-book-note-dot"
            :style="{ left: `${dot.x - dot.diameter / 2}px`, top: `${dot.y - dot.diameter / 2}px`, width: `${dot.diameter}px`, height: `${dot.diameter}px`, lineHeight: `${dot.diameter}px`, fontSize: `${dot.fontSize}px` }"
            aria-hidden="true"
          >注</span>
          <div
            v-for="(box, index) in leftCrossBoxes"
            :key="`left-cross-${index}`"
            class="real-book-cross-highlight"
            :style="{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }"
            aria-hidden="true"
          ></div>
          <button
            v-for="box in leftNoteTabs"
            :key="`left-tab-${box.note.id}`"
            type="button"
            class="real-book-note-tab is-left"
            :style="{ top: `${Math.round(box.y + box.height / 2)}px` }"
            :title="box.note.text"
            :aria-label="`查看批注：${box.note.text.slice(0, 16)}`"
            @click.stop="emit('edit-note', box.note.id)"
            @pointerdown.stop
            @mouseup.stop
          >注</button>
        </div>
        <div
          ref="rightTextRef"
          v-show="showRightTextPage"
          class="real-book-webgl-text-page"
          :style="textPageStyle"
          @mouseup="onTextMouseup"
        >
          <span
            v-for="(box, index) in rightChrome"
            :key="`right-chrome-${index}`"
            class="real-book-chrome-line"
            :style="chromeStyle(box)"
            aria-hidden="true"
          >{{ box.text }}</span>
          <div
            v-for="(rect, index) in rightHighlightRects"
            :key="`right-mark-${index}`"
            class="real-book-mark"
            :style="{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, background: rect.color }"
            aria-hidden="true"
          ></div>
          <div
            v-for="note in rightNoteBlocks"
            :key="`right-note-${note.id}`"
            class="real-book-note-card"
            :style="noteBoxStyle(note)"
            role="button"
            tabindex="0"
            :title="note.note.text"
            :aria-label="`查看批注：${note.note.text.slice(0, 16)}`"
            @click.stop="emit('edit-note', note.id)"
            @pointerdown.stop
            @mouseup.stop
            @keydown.enter.stop.prevent="emit('edit-note', note.id)"
            @keydown.space.stop.prevent="emit('edit-note', note.id)"
          ></div>
          <figure
            v-for="image in rightImageBlocks"
            :key="`right-image-${image.file}`"
            class="real-book-webgl-image"
            :style="imageBoxStyle(image)"
          >
            <img :src="bookImageSrc(image.file)" :alt="image.caption" draggable="false" />
          </figure>
          <span
            v-for="(run, index) in rightPageRuns"
            :key="`right-run-${index}`"
            class="real-book-page-run"
            :style="runStyle(run)"
            aria-hidden="true"
          >{{ run.text }}</span>
          <div
            v-for="group in rightTextParagraphs"
            :key="`right-p${group.paragraphIndex}`"
            class="real-book-text-para"
            :data-p="group.paragraphIndex"
          >
            <span
              v-for="(line, index) in group.lines"
              :key="index"
              class="real-book-text-line"
              :data-start="line.start"
              :style="lineStyle(line)"
            >{{ line.text }}</span>
          </div>
          <span
            v-for="(dot, index) in rightNoteDots"
            :key="`right-dot-${index}`"
            class="real-book-note-dot"
            :style="{ left: `${dot.x - dot.diameter / 2}px`, top: `${dot.y - dot.diameter / 2}px`, width: `${dot.diameter}px`, height: `${dot.diameter}px`, lineHeight: `${dot.diameter}px`, fontSize: `${dot.fontSize}px` }"
            aria-hidden="true"
          >注</span>
          <div
            v-for="(box, index) in rightCrossBoxes"
            :key="`right-cross-${index}`"
            class="real-book-cross-highlight"
            :style="{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }"
            aria-hidden="true"
          ></div>
          <button
            v-for="box in rightNoteTabs"
            :key="`right-tab-${box.note.id}`"
            type="button"
            class="real-book-note-tab is-right"
            :style="{ top: `${Math.round(box.y + box.height / 2)}px` }"
            :title="box.note.text"
            :aria-label="`查看批注：${box.note.text.slice(0, 16)}`"
            @click.stop="emit('edit-note', box.note.id)"
            @pointerdown.stop
            @mouseup.stop
          >注</button>
        </div>
      </div>
      <div
        ref="flipTextRef"
        v-show="showTextLayer"
        class="real-book-webgl-flip-text"
        aria-hidden="true"
      ></div>
    </div>
    <div
      v-if="crossHoldHint"
      class="real-book-cross-hint"
      :style="{ left: `${crossHintAt.x}px`, top: `${crossHintAt.y}px` }"
      role="status"
    >{{ crossSel?.turnPending ? '翻页中，请保持按住' : '保持按住，即将翻页…' }}</div>
    <div v-if="unsupported" class="real-book-webgl-fallback" role="status">
      WebGL 不可用，已保留 CSS 3D 回退
    </div>
  </div>
</template>

<style scoped>
/*
 * 参考站的正文、页眉页脚、批注卡、图片与划线都画在页面纹理里；DOM 层只负责
 * 原生选字/选区。文字用 transparent 而不是 opacity，选区底色仍然可见。
 */
.real-book-webgl-text-layer :deep(.real-book-text-line),
.real-book-webgl-text-layer :deep(.real-book-chrome-line),
.real-book-webgl-text-layer :deep(.real-book-page-run) {
  color: transparent !important;
  text-shadow: none !important;
}

.real-book-webgl-text-layer :deep(.real-book-webgl-image),
.real-book-webgl-text-layer :deep(.real-book-note-card),
.real-book-webgl-text-layer :deep(.real-book-mark),
.real-book-webgl-text-layer :deep(.real-book-note-dot),
.real-book-webgl-text-layer :deep(.real-book-note-tab) {
  opacity: 0;
}

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

/* 书口注释标签：贴在纸的外口，位置来自页内注卡的排版结果，随纸页一起做 3D 变换。 */
.real-book-note-tab {
  position: absolute;
  width: 26px;
  height: 64px;
  margin-top: -32px;
  padding: 0;
  border: 1px solid rgba(140, 96, 46, 0.42);
  border-radius: 3px;
  background: linear-gradient(180deg, #f4e6c8, #e3cda4);
  color: #8a5a2a;
  font: 500 16px/1 "LXGW WenKai Screen", "STSong", serif;
  display: grid;
  place-items: center;
  pointer-events: auto;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(80, 50, 20, 0.22);
}

.real-book-note-tab.is-left {
  left: -19px;
  transform: rotate(-1.5deg);
}

.real-book-note-tab.is-right {
  right: -19px;
  transform: rotate(1.5deg);
}

.real-book-note-tab:hover {
  background: linear-gradient(180deg, #f9edd4, #ecd9b2);
}

/* 跨页选区的伪高亮：原生选区翻页后活不下来，这里按行表画一层半透明条。 */
.real-book-cross-highlight {
  position: absolute;
  border-radius: 1px;
  background: rgba(240, 185, 90, 0.38);
  pointer-events: none;
}

.real-book-cross-hint {
  position: fixed;
  transform: translate(-50%, -150%);
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(34, 26, 18, 0.88);
  color: #f3e6cf;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
  /* 提示条就在指针下方，必须排除在原生选区之外；否则拖到页角时选区终点会落进提示文字里。 */
  user-select: none;
  -webkit-user-select: none;
  z-index: 20;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
}

.real-book-webgl-text-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.real-book-webgl-text-page {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  /* 正文由这层 DOM 显示：颜色走舞台传入的墨色，纹理里不再画字。 */
  pointer-events: auto;
  user-select: text;
  -webkit-user-select: text;
}

.real-book-text-para {
  position: absolute;
  inset: 0;
  /* 段落盒子按整页铺满（行是绝对定位的），它自己不能吃指针事件：
     否则光标在任何位置都先命中最后一个段落盒子，浏览器只能把落点吸到那个段落最近的一行，
     上半页拖选就会选到下半页的字。命中交给真正有字的行盒子。 */
  pointer-events: none;
}

.real-book-text-line {
  position: absolute;
  white-space: pre;
  background: transparent;
  overflow: hidden;
  pointer-events: auto;
}

/* 页眉页脚：与正文同一层、同一套页角投影，字是矢量清晰的。 */
.real-book-chrome-line {
  position: absolute;
  white-space: pre;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}

/* 划线/搜索高亮的底色块：与纹理同一套几何，压在字下面。 */
.real-book-mark {
  position: absolute;
  border-radius: 1px;
  pointer-events: none;
}

/* 段内「注」点：圆形暖褐底、米白字，和纹理里那颗一致。 */
.real-book-note-dot {
  position: absolute;
  display: block;
  border-radius: 50%;
  background: rgba(186, 112, 57, 0.9);
  color: #fff9ef;
  font-family: sans-serif;
  font-weight: 500;
  text-align: center;
  pointer-events: none;
}

/* 页内注卡：与纹理同一套浅底 + 左侧竖线；卡片可点开对应批注。 */
.real-book-note-card {
  position: absolute;
  box-sizing: border-box;
  background: rgba(83, 67, 42, 0.055);
  border-left: 1.5px solid rgba(120, 82, 47, 0.55);
  cursor: pointer;
}

.real-book-note-card:hover {
  background: rgba(83, 67, 42, 0.09);
}

/* 页内图片：DOM 里按 contain 装进版心块，图注由单独的 run 贴在下方。 */
.real-book-webgl-image {
  position: absolute;
  display: block;
  margin: 0;
  overflow: visible;
  pointer-events: none;
}

.real-book-webgl-image img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
}

/* 注卡正文与图注：与正文同一层，按页面坐标逐行贴。 */
.real-book-page-run {
  position: absolute;
  white-space: pre;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}

.real-book-webgl-text-page ::selection {
  background: rgba(240, 185, 90, 0.35);
}

/*
 * 飞页正文：一行切成几段，每段用自己的 matrix3d 贴到卷曲的纸面上。
 * 不加 will-change：变换里带缩放，提成合成层后字会被拉成位图；让它每帧重画才是矢量。
 */
.real-book-webgl-flip-text {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
}

/*
 * 这些 span 是运行时用 createElement 造的，拿不到 scoped 的 data-v 属性，
 * 必须走 :deep()，否则 position/transform-origin 全不生效，字会按行内流排成一团。
 */
.real-book-webgl-flip-text :deep(.real-book-flip-line) {
  position: absolute;
  left: 0;
  top: 0;
  white-space: pre;
  transform-origin: 0 0;
  user-select: none;
  -webkit-user-select: none;
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
