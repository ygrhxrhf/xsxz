<script setup lang="ts">
/**
 * 真实书籍渲染层（M2 MVP）。
 *
 * 与经典模式完全分开的一层：经典模式是滚动容器 + scrollTop，真实书籍是双页摊开 +
 * 断页页表 + 3D 翻页。两边共用同一份数据（章节正文、划线、搜索、偏好）。
 *
 * 为什么另开组件而不是写进 Reader.vue：`Reader.pagination.contract.test.ts` 断言
 * Reader.vue 源码不含 `column-count`，阅读体验方案也把「正文纯文本、禁 v-html」
 * 定为本项目约束——真实书籍的页面 DOM、分页缓存与拟物样式必须收在自己的文件里，
 * 才不会碰经典路径的既有契约。
 *
 * 位置真源仍是段落锚点（段落下标 + 段内偏移）：页码只是排版缓存，缩放、窗口变化、
 * 单双页切换都会让同一页码对应不同文字，所以对外只报锚点。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { decorateText } from '@shared/paragraphSearch'
import { createRealBookPaginator, findPageForInput, pageRatio, type RealBookAnchor, type RealBookPage } from './realBookPager'
import { MAX_SPINE_LAYERS, spineLayers, spineStack } from './realBookSpine'
import { measureLines } from './realBookMeasure'
import { clampPitch, pitchFromDrag, pitchResetTarget } from './realBookPitch'
import { FLIP_DURATION_MS, flipAngles, flipContentOpacity, flipFaceVisible, flipFacing, flipLight, flipPhases, flipPoses, flipSheetLift, flipSliceSpeeds, flipSway } from './realBookFlip'

interface HighlightSpan {
  /** 段落下标（原始下标，与经典模式一致） */
  index: number
  /** 段内起始偏移（含） */
  start: number
  /** 段内结束偏移（不含） */
  end: number
  color?: string
}

const props = withDefaults(defineProps<{
  /** 要排版的段落文本（已过滤尾巴净化） */
  paragraphs: string[]
  /** 与 paragraphs 等长：每段在原始正文里的下标 */
  paragraphIndexes: number[]
  /** 划线：段内局部坐标 */
  highlights?: HighlightSpan[]
  /** 本书搜索的关键词 */
  searchQuery?: string
  /** 字号（px） */
  fontSize?: number
  /** 行距（倍数） */
  lineHeight?: number
  /** 字体栈（CSS font-family 值） */
  fontFamily?: string
  /** 段间距（em） */
  paragraphGap?: number
  /** 页眉（章节眉题）；单行省略，长度不影响排版 */
  chapterTitle?: string
  /** 页眉占高（px）；不传按字号推导。占高是排版输入，会影响页数 */
  headHeight?: number
  /** 页脚（页码）占高（px）；不传按字号推导 */
  footHeight?: number
  /** 恢复位置：原始段落下标 + 段内偏移 */
  startAnchor?: RealBookAnchor | null
  /** 旧进度只有比例时用它换算页码 */
  startRatio?: number
  /** 会话内俯仰角，不参与分页签名、不落盘 */
  pitch?: number
  /** 每次换章/重进递增：即使锚点没变也要重新落位 */
  restoreToken?: number
  /** 整本书正文字符数：决定这本书的基础厚度。 */
  totalChars?: number
  /** 整本书阅读进度（0–1）：决定左右两侧厚度分配。 */
  bookProgressRatio?: number
  /** 翻过一页对应的全书进度增量。 */
  bookProgressStep?: number
  /** 版式：`book` 是双页 3D 书台，`sheet` 是单张书页（书页模式）。 */
  variant?: 'book' | 'sheet'
  /** 书页模式每页栏数：1 单栏、2 双栏；书台版式忽略。 */
  columns?: number
}>(), {
  highlights: () => [],
  searchQuery: '',
  fontSize: 18,
  lineHeight: 1.8,
  fontFamily: 'serif',
  paragraphGap: 0.45,
  chapterTitle: '',
  headHeight: 0,
  footHeight: 0,
  startAnchor: null,
  startRatio: 0,
  restoreToken: 0,
  variant: 'book',
  columns: 1,
  totalChars: 0,
  bookProgressStep: 0,
})

const emit = defineEmits<{
  (event: 'update:anchor', anchor: RealBookAnchor): void
  (event: 'update:page', page: number): void
  (event: 'update:page-count', count: number): void
  (event: 'select', event: MouseEvent): void
  (event: 'update:pitch', pitch: number): void
  (event: 'next-chapter'): void
}>()

const hostRef = ref<HTMLElement | null>(null)
const measureRef = ref<HTMLElement | null>(null)
/** 书页版式那张纸：分区翻页按它的横向位置算（纸面比舞台窄，用舞台会把纸外的桌面也算进去）。 */
const sheetRef = ref<HTMLElement | null>(null)
/** 书台版式的书体：分区按左右两页的实际位置算，而不是整个舞台。 */
const bookRef = ref<HTMLElement | null>(null)
const currentPage = ref(0)
const zoom = ref(1)
const pitchDragging = ref(false)
let pitchDragState: { startY: number; startPitch: number } | null = null
const flipping = ref<{ direction: 1 | -1; key: number } | null>(null)
/** 俯仰拖拽是否真的拖过：拖过之后松手的那一下 mouseup 不能被当成点按（否则拖完角就翻页）。 */
let pitchDragged = false
/** 翻页进度 0–1：由 rAF 推进，只驱动竖带卷曲，不参与任何排版计算。 */
const flipT = ref(0)
const pages = shallowRef<RealBookPage[]>([])

let flipTimer: ReturnType<typeof setTimeout> | null = null
let flipRaf = 0
let flipKey = 0
let observer: ResizeObserver | null = null

/** 版面尺寸：双页摊开，每页宽度取舞台的一半，页高按开本比例约束。 */
const layout = ref({ pageWidth: 480, pageHeight: 640, paddingX: 43, paddingY: 38, contentWidth: 420, contentHeight: 560 })
const lineHeightPx = computed(() => Math.max(1, props.fontSize) * Math.max(0.5, props.lineHeight))
const paragraphGapPx = computed(() => Math.max(0, props.fontSize) * Math.max(0, props.paragraphGap))
/** 书页模式的栏数与栏间距；栏间距跟着字号走，换字号不会把两栏挤到一起。 */
const pageColumns = computed(() => (props.columns === 2 ? 2 : 1))
const columnGapPx = computed(() => Math.round(Math.max(1, props.fontSize) * 3))
/** 一张书页折几栏就是一页翻几步：书台一页=一页，书页一页=栏数个分页器页。 */
const pageStep = computed(() => (props.variant === 'sheet' ? pageColumns.value : 1))
/**
 * 页眉页脚占高（px）：它们是排版输入，必须参与页表签名。
 * 不传时按字号推导；显式传入主要是为了让签名可测——同一字号下改占高，页数必须变。
 */
const headHeightPx = computed(() => props.headHeight > 0
  ? Math.round(props.headHeight)
  : Math.round(Math.max(1, props.fontSize) * 1.8))
const footHeightPx = computed(() => props.footHeight > 0
  ? Math.round(props.footHeight)
  : Math.round(Math.max(1, props.fontSize) * 1.6))
/** 书页页脚放翻页按钮，比书台的页码占高得多，必须单独算进版心高度。 */
const sheetFootHeightPx = computed(() => props.footHeight > 0
  ? Math.round(props.footHeight)
  : Math.round(Math.max(1, props.fontSize) * 3.2))

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true

/**
 * 纸面元素：书台版式是整个舞台，书页版式是那张纸。
 * 父组件按它的横向位置做三分区（左右翻页、中区显隐工具）。
 */
const paperEl = computed(() => {
  if (props.variant === 'sheet') return sheetRef.value
  return bookRef.value ?? hostRef.value
})

const pitch = computed(() => clampPitch(localPitch.value))

/**
 * 俯仰角的真源在组件内部；父组件的 pitch prop 只是「外部设定值」。
 *
 * 为什么不直接用 props.pitch 当真源：拖拽结束到父组件回传之间有一拍延迟，
 * 角度会在这一拍里弹回 0（父组件默认值）。改成「内部为准 + 外部变化才同步下来」，
 * 既不闪回，也仍然允许父组件（如「平放」）从外部改角度。
 */
const localPitch = ref(clampPitch(props.pitch ?? 0))

watch(() => props.pitch, (value) => {
  const next = clampPitch(value ?? 0)
  if (Math.abs(next - localPitch.value) > 0.001) localPitch.value = next
})

function setPitch(value: number): void {
  localPitch.value = clampPitch(value)
  emit('update:pitch', localPitch.value)
}

function beginPitchDrag(event: PointerEvent): void {
  if (event.button !== 0) return
  // 每次按下都先清掉上一次拖拽的痕迹：正文段落上不做拖拽（那里要留给划词选择），
  // 但标记必须重置，否则上一次拖完角会把这一次普通点按也当成拖拽。
  pitchDragged = false
  const target = event.target as HTMLElement | null
  if (target?.closest?.('.real-book-para')) return
  pitchDragging.value = true
  pitchDragState = { startY: event.clientY, startPitch: pitch.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function movePitchDrag(event: PointerEvent): void {
  if (!pitchDragging.value || !pitchDragState) return
  pitchDragged = true
  setPitch(pitchFromDrag(pitchDragState, event.clientY))
}

function endPitchDrag(event: PointerEvent): void {
  if (!pitchDragging.value) return
  pitchDragging.value = false
  pitchDragState = null
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
}

function resetPitch(): void {
  setPitch(pitchResetTarget())
}

/**
 * 舞台上的点按：拖过俯仰角的那一下不算点按（松手时的 mouseup 是拖拽的尾巴，
 * 当成点按会让读者拖完角莫名其妙翻一页）。
 */
function onStageMouseup(event: MouseEvent): void {
  if (pitchDragged) {
    pitchDragged = false
    return
  }
  emit('select', event)
}

/**
 * 书体上的 mouseup：拖过俯仰角的那一下要按住不往下传，
 * 否则宿主那一层的点按分区会把它当成翻页（拖完角就翻页）。
 */
function onBookMouseup(event: MouseEvent): void {
  if (!pitchDragged) return
  pitchDragged = false
  event.stopPropagation()
}

function updateLayout(): void {
  const host = hostRef.value
  if (!host) return
  const width = host.clientWidth || 960
  const height = host.clientHeight || 720
  if (props.variant === 'sheet') {
    // 纸面铺满舞台可用区：内边留白从宿主盒子扣掉。
    // 不能读 .real-book-viewport 的 clientWidth：那个 flex 项的基础尺寸由纸面自身撑出，
    // 拿它当输入会自反馈，纸面越量越小。
    const box = typeof getComputedStyle === 'function' ? getComputedStyle(host) : null
    const padX = Number.parseFloat(box?.paddingLeft ?? '') + Number.parseFloat(box?.paddingRight ?? '')
    const padY = Number.parseFloat(box?.paddingTop ?? '') + Number.parseFloat(box?.paddingBottom ?? '')
    const sheetWidth = Math.max(320, Math.min(1600, width - (Number.isFinite(padX) ? padX : 48)))
    const sheetHeight = Math.max(320, height - (Number.isFinite(padY) ? padY : 28))
    const paddingX = Math.round(Math.min(76, Math.max(28, sheetWidth * 0.06)))
    const paddingY = Math.round(Math.min(56, Math.max(28, sheetHeight * 0.055)))
    const innerWidth = Math.max(160, sheetWidth - paddingX * 2)
    // 栏宽必须与 CSS 的等分结果逐像素一致，否则离屏量出的断行与真实渲染错位、整章漂页。
    const columnWidth = Math.max(120, (innerWidth - columnGapPx.value * (pageColumns.value - 1)) / pageColumns.value)
    layout.value = {
      pageWidth: sheetWidth,
      pageHeight: sheetHeight,
      paddingX,
      paddingY,
      contentWidth: columnWidth,
      contentHeight: Math.max(120, sheetHeight - paddingY * 2 - headHeightPx.value - sheetFootHeightPx.value),
    }
    return
  }
  // 参考图的书本不是铺满舞台的矩形：左右要留出深色桌面，上方也要有呼吸空间。
  // 书的总展开宽度约占可用舞台的 76%；默认俯仰会把屏幕投影再放大，
  // 因此这里按 0.76 预留，而不是把整行宽度都塞给书页。
  const pageWidth = Math.max(240, Math.floor((width * 0.72 / 2) * 0.96))
  // 参考图是接近 3:4 的竖版开本；高度优先由可用视口决定，底部给纸垛留出厚度。
  // 开本比例固定，窗口变窄时只缩小书，不把纸压成横向卡片。
  // 再受舞台高度约束，并给下方书厚纸垛让出高度——
  // 视口是 overflow:hidden，不让出这一段，纸垛的切口会被裁在页面外边。
  const pageHeight = Math.max(320, Math.min(
    Math.floor(pageWidth * 1.42),
    Math.floor(height * 0.98) - BLOCK_THICKNESS_PX,
  ))
  const paddingX = Math.round(pageWidth * 0.09)
  // 垂直内边距与 CSS 共用同一变量：JS 算版心、CSS 排版，两处不一致就会裁字。
  const paddingY = Math.round(pageHeight * 0.06)
  layout.value = {
    pageWidth,
    pageHeight,
    paddingX,
    paddingY,
    contentWidth: Math.max(120, pageWidth - paddingX * 2),
    // 版心扣掉页眉页脚：它们占走的正是正文能用的高度。
    contentHeight: Math.max(120, pageHeight - paddingY * 2 - headHeightPx.value - footHeightPx.value),
  }
}

/** 排版签名：字号、行距、版面、段落集合任一变化就整表重算。 */
const paginator = shallowRef<ReturnType<typeof createRealBookPaginator> | null>(null)

/** 待落位：换章后要回到旧位置，等页表重排完再执行。 */
let pendingRestore = false

function applyRestore(): void {
  if (!pendingRestore) return
  pendingRestore = false
  if (props.startAnchor) {
    goToAnchor(props.startAnchor)
    return
  }
  if (props.startRatio > 0) {
    const step = pageStep.value
    const sheetCount = Math.max(1, Math.ceil(pages.value.length / step))
    const target = Math.round(props.startRatio * Math.max(0, sheetCount - 1)) * step
    goToPage(target, false)
  }
}

function rebuildPages(): void {
  const measure = measureRef.value
  if (!measure) return
  const { contentHeight } = layout.value
  const created = createRealBookPaginator(
    props.paragraphs,
    (text) => measureLines(text, measure),
    { pageHeight: contentHeight, lineHeight: lineHeightPx.value, paragraphGap: paragraphGapPx.value },
  )
  paginator.value = created
  created.ensure(Math.max(0, currentPage.value))
  pages.value = created.pages
  applyRestore()
  emit('update:page-count', pages.value.length)
  emit('update:page', currentPage.value)
}

/** 原始段落下标 → 输入数组下标（排版器只认输入下标）。 */
function inputIndexOf(paragraph: number): number {
  return props.paragraphIndexes.indexOf(paragraph)
}

function anchorOf(page: RealBookPage | undefined): RealBookAnchor | null {
  if (!page || !page.items.length) return null
  const first = page.items[0]!
  const original = props.paragraphIndexes[first.paragraph]
  if (original === undefined) return null
  return { paragraph: original, offset: first.start }
}

function syncAnchor(): void {
  const anchor = anchorOf(pages.value[currentPage.value])
  if (anchor) emit('update:anchor', anchor)
}

function goToPage(index: number, animate: boolean): void {
  const created = paginator.value
  if (!created) return
  const step = pageStep.value
  // 书页翻页按整页走：目标页永远对齐到这一页的第一栏。
  const aligned = step > 1 ? Math.floor(Math.max(0, index) / step) * step : Math.max(0, index)
  const count = created.ensure(aligned + step)
  const target = Math.max(0, Math.min(aligned, count - 1))
  pages.value = created.pages
  if (target === currentPage.value) {
    syncAnchor()
    emit('update:page-count', pages.value.length)
    emit('update:page', target)
    return
  }
  if (!animate || reducedMotion() || props.variant === 'sheet') {
    currentPage.value = target
    pages.value = created.pages
    syncAnchor()
    emit('update:page-count', pages.value.length)
    emit('update:page', target)
    return
  }
  // 翻页中态：那页纸卷起来，落定后才换页内容。
  flipping.value = { direction: target > currentPage.value ? 1 : -1, key: ++flipKey }
  startFlipAnimation()
  if (flipTimer) clearTimeout(flipTimer)
  flipTimer = setTimeout(() => {
    flipTimer = null
    stopFlipAnimation()
    currentPage.value = target
    flipping.value = null
    syncAnchor()
    emit('update:page-count', pages.value.length)
    emit('update:page', target)
  }, FLIP_DURATION_MS)
}

/**
 * 推进卷页进度。用 rAF 而不是 CSS 动画：竖带的位置是逐帧算的折线积分，
 * 只有进度这一个标量可以交给动画时钟，形状得自己算。
 */
function startFlipAnimation(): void {
  stopFlipAnimation()
  flipT.value = 0
  if (typeof requestAnimationFrame !== 'function') return
  const started = performance.now()
  const tick = () => {
    const t = Math.min(1, (performance.now() - started) / FLIP_DURATION_MS)
    flipT.value = t
    flipRaf = t < 1 ? requestAnimationFrame(tick) : 0
  }
  flipRaf = requestAnimationFrame(tick)
}

function stopFlipAnimation(): void {
  if (flipRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(flipRaf)
  flipRaf = 0
}

function nextPage(): void {
  // 已经是本章最后一页：把「下一页」交给父组件换下一章。
  if (!hasNextPage.value) {
    emit('next-chapter')
    return
  }
  goToPage(currentPage.value + pageStep.value, true)
}

function prevPage(): void {
  goToPage(currentPage.value - pageStep.value, true)
}

/** 按锚点跳页：真实书籍与经典模式互转位置的唯一接口。 */
function goToAnchor(anchor: RealBookAnchor | null): void {
  const created = paginator.value
  if (!created || !anchor) return
  const inputIndex = inputIndexOf(anchor.paragraph)
  if (inputIndex < 0) return
  // 先排到目标段所在位置，再查页——页表是惰性排的，没排到的段还不在页表里。
  created.ensureThroughParagraph(inputIndex)
  pages.value = created.pages
  const target = findPageForInput(created.pages, inputIndex, anchor.offset)
  goToPage(target, false)
}

function onWheel(e: WheelEvent): void {
  if (e.ctrlKey) {
    // 双指捏合在桌面端会带 ctrlKey；这是缩放，不翻页。
    const next = Math.min(1.8, Math.max(0.7, zoom.value - e.deltaY * 0.002))
    zoom.value = Math.round(next * 100) / 100
    e.preventDefault()
    return
  }
  if (Math.abs(e.deltaY) < 8) return
  e.preventDefault()
  if (e.deltaY > 0) nextPage()
  else prevPage()
}

function zoomIn(): void {
  zoom.value = Math.min(1.8, Math.round((zoom.value + 0.1) * 100) / 100)
}

function zoomOut(): void {
  zoom.value = Math.max(0.7, Math.round((zoom.value - 0.1) * 100) / 100)
}

function resetZoom(): void {
  zoom.value = 1
}

/** 一页里要渲染的片段：段内偏移 + 切出来的文字。 */
interface PagePiece {
  key: string
  paragraph: number
  original: number
  start: number
  end: number
  continued: boolean
  segs: ReturnType<typeof decorateText>
}

function piecesOf(page: RealBookPage | undefined): PagePiece[] {
  if (!page) return []
  const out: PagePiece[] = []
  for (const item of page.items) {
    const original = props.paragraphIndexes[item.paragraph]
    if (original === undefined) continue
    const text = props.paragraphs[item.paragraph] ?? ''
    const slice = text.slice(item.start, item.end)
    const local = props.highlights
      .filter((h) => h.index === original)
      .map((h) => ({
        start: Math.max(0, h.start - item.start),
        end: Math.max(0, h.end - item.start),
        color: h.color,
      }))
      .filter((h) => h.end > h.start)
    out.push({
      key: `${item.paragraph}-${item.start}-${item.end}`,
      paragraph: item.paragraph,
      original,
      start: item.start,
      end: item.end,
      continued: item.continued,
      segs: decorateText(slice, props.searchQuery, local),
    })
  }
  return out
}

/**
 * 摊开的两页各自显示第几页（0-based 页下标）。
 *
 * 翻页中要按纸的走向分开对待：纸正抬起的那一侧立刻换成翻页后的内容——纸一离开，
 * 下面露出来的就该是下一页（否则抬起的纸底下压着和自己一模一样的同一页，看着像没动）；
 * 纸要落下的那一侧保持旧内容到落定为止——它此刻还被纸压着，提前换等于凭空抠掉一页。
 */
const slotPage = computed(() => currentPage.value + (flipping.value?.direction ?? 0))
const leftViewIndex = computed(() => (flipping.value?.direction === 1
  ? currentPage.value - 1
  : slotPage.value - 1))
const rightViewIndex = computed(() => (flipping.value?.direction === -1
  ? currentPage.value
  : slotPage.value))
const leftViewPieces = computed(() => piecesOf(pages.value[leftViewIndex.value]))
const rightViewPieces = computed(() => piecesOf(pages.value[rightViewIndex.value]))

/**
 * 正被翻动的那张纸：往后翻它是右页、往前翻它是左页，正反面是同一张纸。
 *
 * 背面必须与正面同内容：翻页只前进一页，落定后左页显示的正是这张纸
 * （页表按页侧编号，旧右页落到左页）；若背面印下一页，落定那一帧左页会从下一页跳回这一页。
 */
const flipSheetIndex = computed(() => (flipping.value?.direction === -1
  ? currentPage.value - 1
  : currentPage.value))
const flipSheetPieces = computed(() => piecesOf(pages.value[flipSheetIndex.value]))
/**
 * 卷页竖带：角度与位置由 `flipPoses` 算（折线积分），这里只铺成 style。
 * 每条带各渲染一份整页内容、按 −i×带宽 错开，相当于把同一页切成一条条窗格。
 */
/** 翻动页的 1-based 页码：与静态页同一条公式（页下标 + 1），空页不印号。 */
const flipSheetPageNumber = computed(() => (flipSheetPieces.value.length ? flipSheetIndex.value + 1 : 0))
/**
 * 动态模糊的角速度阈值（0–1）：低于它的带保持清晰。
 *
 * 模糊要重做离屏表面，是翻页最大的开销。阈值把「需要模糊的带」压到少数几条：
 * 实测整段翻页从 29 帧（长帧 3）回到 40 帧上下，且没有长帧。
 */
const FLIP_BLUR_SPEED_THRESHOLD = 0.7
const flipSlices = computed(() => {
  const direction = flipping.value?.direction ?? 1
  const width = layout.value.pageWidth
  const { from, to } = flipAngles(direction, BEND_DEG)
  const options = { width, fromDeg: from, toDeg: to }
  const poses = flipPoses(flipT.value, options)
  const speeds = flipSliceSpeeds(flipT.value, options)
  return poses.map((pose, index) => {
    // 纸面侧对观者时把正文淡出：竖带是按平面拼的，越斜越糊。
    //
    // 判据是「纸面自己的转角」θ：θ 超过 90° 时，这条带已经转到纸的背面，
    // 它的正面内容必须整层停画。只靠 cos 淡出不够：60°–90° 时正面已经很淡，
    // 却仍和翻过来的背面同时存在，右半页上就会叠出一层半透明的上一页残影。
    // 阈值与背面字影的系数都收在 `realBookFlip` 里（那里有单测钉住）。
    const contentOpacity = flipContentOpacity(pose.angle)
    const sideOpacity = pose.angle < 90 ? 1 : 0
    // 正视程度：投影压缩的模糊量也按它给（侧对得越狠，竖条越明显）。
    const facing = flipFacing(pose.angle)
    // 动态模糊：快的那几条带在飞，字应该是糊的。每帧都清晰的翻页读成「贴图在转」。
    //
    // 只给**一条**带加模糊：飞得最快的那条（纸角附近）。
    //
    // 模糊要重做离屏表面，是翻页最大的开销——实测整段翻页 29 帧（长帧 3），
    // 去掉模糊后 41 帧（长帧 0）。而每条带的模糊只值约 0.3ms/帧：
    // 12 条带全加就是 3~4ms/帧，正好吃掉一帧的预算。
    //
    // 只糊一条带在视觉上也够：人眼读「纸在飞」靠的是那条最快带上的拖影，
    // 旁边的带本来就因侧对而被 opacity 淡出，糊不糊都看不清。
    const speed = speeds[index] ?? 0
    const speedBlur = Math.pow(speed, 1.8) * 1.8
    // 量化到 0.5px：相邻帧常常落到同一个值，浏览器就不用每帧重做模糊。
    // 不量化的话每帧的半径都是新值，模糊层每帧重算。
    const blurRaw = speed >= FLIP_BLUR_SPEED_THRESHOLD ? Math.min(1.5, speedBlur) : 0
    const blur = blurRaw >= 0.25 ? Math.round(blurRaw / 0.5) * 0.5 : 0
    return {
      index,
      // 作废一面交给转角自己决定：纸面转过 90° 后正面就不该再画，否则正反两层
      // 叠在同一张纸上；浏览器的 backface-visibility 在带裁剪的 3D 层里不可靠。
      ...flipFaceVisible(pose.angle),
      // 多出 0.5px 让相邻两条略搭接：亚像素缝隙会在纸上漏成一条亮线。
      style: {
        width: `${(pose.width + 0.5).toFixed(2)}px`,
        transform: `translate3d(${pose.x.toFixed(2)}px, 0, ${pose.z.toFixed(2)}px) rotateY(${pose.angle.toFixed(2)}deg)`,
        // 模糊量做成 CSS 变量而不是直接写 filter：
        // 落点（face / window / content）不同，开销差一倍——实测三种落点的帧数
        // 分别是 9 / 27 / 55。做成变量后可以在样式层自由切换落点做 A/B，
        // 不必改代码。样式里见 .real-book-flip-face 的 filter。
        //
        // 关键：**模糊量为 0 时给 none，而不是 blur(0px)**。
        // 带 filter 的层（哪怕半径是 0）会被浏览器当作需要离屏渲染的层，
        // 每一帧都要为 12 条带 × 2 面各做一次离屏合成——实测这一项就吃掉
        // 整段翻页的三分之一帧率。给 none 时浏览器把它当普通层处理。
        '--rb-flip-blur': blur > 0 ? `blur(${blur.toFixed(1)}px)` : 'none',
        // 明暗取这条带两端的边界角，而不是中间角：每条带自己涂一层渐变，
        // 相邻带的端点值相同，接起来就是沿弧面连续的光，不会浮出一层竖条纹。
        '--rb-flip-dark-a': (1 - flipLight(pose.startAngle)).toFixed(3),
        '--rb-flip-dark-b': (1 - flipLight(pose.endAngle)).toFixed(3),
        // 纸面的粗糙度：越侧对越哑光。反光面斜过去会亮，这条不能全靠明暗渐变。
        // 高光也必须**按边界角**给两端值：整条带用一个常数的话，每条带的
        // 高光起点都不一样，接起来就是一道道竖着的亮条——纸上浮出一层百叶窗，
        // 那正是「硬纸板」最扎眼的读感。
        '--rb-flip-spec-a': (0.1 + 0.5 * Math.abs(Math.cos(pose.startAngle * Math.PI / 180))).toFixed(3),
        '--rb-flip-spec-b': (0.1 + 0.5 * Math.abs(Math.cos(pose.endAngle * Math.PI / 180))).toFixed(3),
        '--rb-flip-side': sideOpacity.toFixed(3),
      } as Record<string, string>,
      contentStyle: {
        width: `${width}px`,
        // 内容窗按纸上的真实坐标错开：第 i 条带露出的是纸面 [offset, offset+width]
        // 那一段。带不等宽（纸角那侧更密），错开量必须跟着 offset 走，
        // 用等宽的 index×bandwidth 会整段错位——纸上的字与带缝对不上。
        transform: `translateX(${(-pose.offset).toFixed(2)}px)`,
        opacity: (contentOpacity * sideOpacity).toFixed(3),
      } as Record<string, string>,
    }
  })
})

/**
 * 翻动页整体离桌的程度：纸在飞行中「帆」起来。
 *
 * 位移与倾角都作用在整张纸上，不作用在单条竖带——否则页脚会变成锯齿状的阶梯。
 */
const flipSheetState = computed(() => flipSheetLift(flipT.value))

/**
 * 翻页时整本书的随动。
 *
 * 真书是用手指把页角甩过去，书身会被这一推带得微微侧倾、离桌一下，纸落定后还有余颤。
 * 只有纸在动、书钉在桌上，无论纸卷得多像都是「机械」——动画从头到尾没有一个整体。
 */
const flipSwayState = computed(() => {
  if (!flipping.value) return { rotateY: 0, lift: 0 }
  return flipSway(flipT.value, flipping.value.direction)
})

const bookStyle = computed(() => ({ transform: `scale(${zoom.value})` }))

/**
 * 翻动页投在下方纸页上的影子：纸抬起来的那一侧先暗下去，纸落下的那一侧在快到位时才变暗。
 *
 * 这是「纸真的离开了桌面」最直接的线索——纸不落影，卷得再好也像是浮着的一张皮。
 *
 * 影子的**宽度**也跟着纸走：纸离书脊越远，落在页面上的影子带就越宽。
 * 宽度固定的话，纸快落定时那条影子还是窄窄一条，与纸上已经不沾边的纸身脱节，
 * 看着像一道与纸无关的脏痕。
 */
const flipCast = computed(() => {
  // 投影吃的是**同一个纸角行程**：纸慢了影子也得跟着慢。
  // 影子早于纸出现、晚于纸消失，都是「几段各走各的动画拼在一起」的读感。
  const t = flipPhases(flipT.value).tip
  const direction = flipping.value?.direction ?? 1
  // 抬起侧：起手就压暗，纸离开后迅速转淡，翻过一半就几乎没了。
  const lift = Math.max(0, Math.sin(Math.PI * Math.min(1, t / 0.55))) * 0.34
  // 落下侧：纸快到时才开始压暗，落定前收回，免得落定那一帧突然变亮。
  const land = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.45) / 0.55)))) * 0.3
  // 影子带的宽度（占页宽的百分比）：纸越贴近落位，压在页面上的影子越宽。
  const landWidth = 6 + 26 * Math.min(1, Math.max(0, (t - 0.3) / 0.7))
  const liftWidth = 4 + 14 * Math.min(1, Math.max(0, t / 0.55))
  return direction === 1
    ? { right: lift, left: land, rightWidth: liftWidth, leftWidth: landWidth }
    : { right: land, left: lift, rightWidth: landWidth, leftWidth: liftWidth }
})
const pageCount = computed(() => pages.value.length)
const currentLabel = computed(() => `第 ${Math.min(currentPage.value + 1, pageCount.value || 1)} / ${Math.max(1, pageCount.value)} 页`)
/** 页码跟着「这一侧此刻显示哪一页」走：抬起的那一侧已经换成新页，号也得跟着换。 */
const leftPageNumber = computed(() => (leftViewPieces.value.length ? leftViewIndex.value + 1 : 0))
const rightPageNumber = computed(() => (rightViewPieces.value.length ? rightViewIndex.value + 1 : 0))

/** 书页模式：这一张纸上从左到右的每一栏内容（单栏只有一栏）。 */
const sheetPieces = computed<PagePiece[][]>(() => {
  const out: PagePiece[][] = []
  for (let i = 0; i < pageColumns.value; i += 1) out.push(piecesOf(pages.value[currentPage.value + i]))
  return out
})
/**
 * 有没有下一页：页表是惰性排的，先排到下一页再判断。
 * 排出来的页会被紧接着的翻页直接复用，不额外排版。
 */
const hasNextPage = computed(() => {
  const created = paginator.value
  if (!created) return false
  const target = currentPage.value + pageStep.value
  return created.ensure(target) > target
})
const sheetPageCount = computed(() => Math.max(1, Math.ceil(pages.value.length / pageStep.value)))
const sheetPageIndex = computed(() => Math.floor(currentPage.value / pageStep.value))
const sheetLabel = computed(() => `第 ${Math.min(sheetPageIndex.value + 1, sheetPageCount.value)} / ${sheetPageCount.value} 页`)

/**
 * 书厚伪页：左右两半各一条纸堆，层数由当前页在章内的比例驱动。
 *
 * 左半是「读过的部分」，右半是「剩下的部分」，两侧层数之和恒等于上限：
 * 书本总厚度不变，只是随阅读进度从右往左转移，就像真的翻书一样。
 * 位置只跟「读到哪儿」有关，与页表具体行数无关——缩放、字号、窗口变化都不会
 * 让纸堆跳变；只有翻页才重新分配左右厚度。
 */
/**
 * 每层纸的纵深（px）。纯模块里的默认值是 5，那里是「逻辑层间距」；
 * 书台要的是看得见的书厚，按一页纸能读出层数来定，所以这里另给一个更厚的值。
 */
const BLOCK_DEPTH_PER_LAYER_PX = 10

/**
 * V 形摊开角（deg）：两页以书脊为轴向外掀起的角度。
 * 翻页的起翻角与落位角都由它推出来——两处必须同一个数，否则落定时会错开一个折角。
 */
const BEND_DEG = 9

/** 书厚纸垛占用的高度：页面在下方让出这一段，纸垛的切口才不会被视口裁掉。 */
const BLOCK_THICKNESS_PX = MAX_SPINE_LAYERS * BLOCK_DEPTH_PER_LAYER_PX + 12

const readRatio = computed(() => pageRatio(currentPage.value, Math.max(1, pageCount.value)))
const stackProgress = computed(() => {
  const base = Number.isFinite(props.bookProgressRatio) ? props.bookProgressRatio : readRatio.value
  if (!flipping.value) return Math.max(0, Math.min(1, base))
  const signedStep = (props.bookProgressStep ?? 0) * flipping.value.direction
  return Math.max(0, Math.min(1, base + signedStep * flipT.value))
})
const spine = computed(() => spineStack(props.totalChars, stackProgress.value))
/** 左半：已经读过的页，层向下叠、纵深向后。 */
const leftBlockLayers = computed(() => spineLayers(spine.value.read, { direction: 1, depth: BLOCK_DEPTH_PER_LAYER_PX }))
/** 右半：还没读的页。 */
const rightBlockLayers = computed(() => spineLayers(spine.value.remaining, { direction: 1, depth: BLOCK_DEPTH_PER_LAYER_PX }))
/** 纸垛进深（px）：层数 × 单层纵深。挤出块的厚度必须与层偏移同源，否则纸垛会和纸边对不上。 */
const leftBlockDepth = computed(() => Math.max(0, spine.value.read) * BLOCK_DEPTH_PER_LAYER_PX)
const rightBlockDepth = computed(() => Math.max(0, spine.value.remaining) * BLOCK_DEPTH_PER_LAYER_PX)

const stageStyle = computed(() => ({
  '--rb-pitch': `${pitch.value}deg`,
  // 翻页时书被手托起的量：投影随之变淡、变散（离桌面越远，影子越虚）。
  '--rb-lift': `${flipSwayState.value.lift.toFixed(2)}px`,
  // 翻页时整本书的侧倾：必须挂在书台上（有 perspective 的父层），挂在书体自身的
  // transform 上不吃透视，侧倾会退化成横向压扁——那正是「没有 3D」的读感。
  '--rb-sway': `${flipSwayState.value.rotateY.toFixed(3)}deg`,
  '--rb-page-width': `${layout.value.pageWidth}px`,
  '--rb-page-height': `${layout.value.pageHeight}px`,
  '--rb-pad-x': `${layout.value.paddingX}px`,
  '--rb-pad-y': `${layout.value.paddingY}px`,
  '--rb-head-height': `${headHeightPx.value}px`,
  '--rb-foot-height': `${footHeightPx.value}px`,
  // 书页版式：栏数、栏间距与页脚占高都和 JS 算版心时用的同一组数。
  '--rb-columns': String(pageColumns.value),
  '--rb-column-gap': `${columnGapPx.value}px`,
  '--rb-sheet-foot-height': `${sheetFootHeightPx.value}px`,
  // 阅读进度是书厚的唯一驱动量；层数另行下发，便于 CSS 调试与截图对照。
  '--rb-read-ratio': String(readRatio.value),
  '--rb-stack-read': String(spine.value.read),
  '--rb-stack-remaining': String(spine.value.remaining),
  // V 形摊开角：纯视觉量，不进页表签名——它只改变 3D 变换，排出来还是同一页。
  '--rb-bend': `${BEND_DEG}deg`,
  // 纸垛挤出块的进深：跟着层数走，读到哪儿厚到哪儿。
  '--rb-block-left': `${leftBlockDepth.value}px`,
  '--rb-block-right': `${rightBlockDepth.value}px`,
  // 书脚下面要留出的高度：参考图底边有明显纸垛与软影，不让它贴到视口边缘。
  '--rb-block-band': `${Math.round(BLOCK_THICKNESS_PX * 0.86)}px`,
  '--rb-font-size': `${props.fontSize}px`,
  // 必须是长度：CSS 用它当 line-height，裸数字会被当成「字号的倍数」，一行会被撑成几十倍高。
  '--rb-line-height': `${lineHeightPx.value}px`,
  '--rb-font-family': props.fontFamily,
}))

const measureStyle = computed(() => ({
  width: `${layout.value.contentWidth}px`,
  fontSize: `${props.fontSize}px`,
  lineHeight: `${lineHeightPx.value}px`,
  fontFamily: props.fontFamily,
  // 正文段落有 2em 首行缩进（.real-book-para）；量断行不带它，首行就会多盛两个字，
  // 算出的行数比实际少一行，最后一页的末行会被栏底裁掉。
  textIndent: '2em',
}))

// 只盯会改变排版的输入；版面尺寸由 ResizeObserver 负责，避免 layout 自身变化触发重排死循环。
// 页眉页脚占高显式进签名：它们在 CSS 里只是页内装饰，但占走的是正文高度。
watch(
  () => [props.paragraphs, props.fontSize, props.lineHeight, props.paragraphGap, headHeightPx.value, footHeightPx.value],
  () => {
    void nextTick(() => {
      updateLayout()
      rebuildPages()
    })
  },
  { deep: false },
)

watch(() => props.startAnchor, (anchor) => {
  if (anchor) goToAnchor(anchor)
}, { deep: true })

// 换章：页表要重排，落位必须等重排完，否则会跳到旧页表的页。
watch(() => props.restoreToken, () => {
  pendingRestore = true
  void nextTick(() => rebuildPages())
})
onMounted(() => {
  updateLayout()
  observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    updateLayout()
    rebuildPages()
  })
  if (observer && hostRef.value) observer.observe(hostRef.value)
  pendingRestore = true
  void nextTick(() => rebuildPages())
  // 字体就绪后重排一次：量测依赖字体度量，自定义手写字体加载完成前量出的换行会偏。
  void document.fonts?.ready?.then(() => {
    updateLayout()
    rebuildPages()
  }).catch(() => { /* 字体未就绪：用当前度量排版 */ })
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  stopFlipAnimation()
  if (flipTimer) clearTimeout(flipTimer)
})

/** 已读上界：右页最后一段的末尾（段落下标 + 段内偏移），与经典模式同构。 */
function readEnd(): { paragraphIndex: number; characterOffset: number } | null {
  // 书页一页折几栏：已读上界要取这张纸最后一栏的末尾。
  const step = pageStep.value
  const page = pages.value[currentPage.value + step - 1]
    ?? pages.value[currentPage.value]
    ?? pages.value[currentPage.value - 1]
  if (!page || !page.items.length) return null
  const last = page.items[page.items.length - 1]!
  const original = props.paragraphIndexes[last.paragraph]
  if (original === undefined) return null
  return { paragraphIndex: original, characterOffset: last.end }
}

defineExpose({
  nextPage,
  prevPage,
  hasNextPage,
  /** 纸面元素：父组件按它的横向位置做三分区（左右翻页、中区显隐工具）。 */
  paperEl,
  goToAnchor,
  zoomIn,
  zoomOut,
  resetZoom,
  currentPage,
  pageCount,
  readEnd,
})
</script>

<template>
  <div ref="hostRef" :class="['real-book-stage', { 'is-sheet': variant === 'sheet' }]" :style="stageStyle" @mouseup="onStageMouseup">
    <!-- 离屏量测容器：宽度与版心一致，量出来的断行与真实渲染一致 -->
    <div ref="measureRef" class="real-book-measure" :style="measureStyle" aria-hidden="true"></div>

    <div v-if="variant === 'book'" class="real-book-toolbar">
      <span class="real-book-page-label" role="status">{{ currentLabel }}</span>
      <span class="real-book-zoom">
        <button type="button" class="real-book-btn" aria-label="缩小" @click="zoomOut">－</button>
        <span class="real-book-zoom-value">{{ Math.round(zoom * 100) }}%</span>
        <button type="button" class="real-book-btn" aria-label="放大" @click="zoomIn">＋</button>
        <button type="button" class="real-book-btn" aria-label="重置缩放" @click="resetZoom">复原</button>
        <button type="button" class="real-book-btn" aria-label="平放" @click="resetPitch">平放</button>
      </span>
    </div>

    <div class="real-book-viewport" @wheel="onWheel">
      <!-- 书页版式：一整张纸，栏数由偏好决定；没有书脊、伪页与俯仰 -->
      <section v-if="variant === 'sheet'" ref="sheetRef" class="rb-sheet" aria-label="书页">
        <header class="rb-sheet-head">{{ chapterTitle }}</header>
        <div class="rb-sheet-body">
          <div
            v-for="(col, ci) in sheetPieces"
            :key="`sheet-${sheetPageIndex}-${ci}`"
            class="rb-sheet-column"
          >
            <div v-if="ci === 0 && !col.length" class="real-book-empty">本章没有正文</div>
            <p
              v-for="piece in col"
              :key="piece.key"
              class="real-book-para"
              :data-p="piece.original"
              :class="{ 'para-continued': piece.continued }"
            ><template v-for="(s, j) in piece.segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
          </div>
        </div>
        <footer class="rb-sheet-foot">
          <span class="rb-sheet-page-label" role="status">{{ sheetLabel }}</span>
        </footer>
      </section>
      <div
        v-else
        ref="bookRef"
        :class="['real-book-book', { 'is-flipping': Boolean(flipping) }]"
        :style="bookStyle"
        @pointerdown="beginPitchDrag"
        @pointermove="movePitchDrag"
        @pointerup="endPitchDrag"
        @pointercancel="endPitchDrag"
        @mouseup="onBookMouseup"
      >
        <div class="real-book-spread">
          <!-- 书下投影：让书体有落地的重量，而不是浮在底色上 -->
          <div class="real-book-shadow" aria-hidden="true"></div>
          <!-- 书厚：左半是已读、右半是剩余，层数之和恒定，厚度随阅读进度从右往左转移。
               零层的半边连块都不渲染，免得只剩一块空纸板。 -->
          <div v-if="leftBlockLayers.length" class="real-book-block real-book-block-left" aria-hidden="true">
            <i
              v-for="layer in leftBlockLayers"
              :key="layer.index"
              :style="{
                transform: `translate3d(0, ${layer.translateY}px, ${layer.translateZ}px)`,
                opacity: String(layer.opacity),
              }"
            ></i>
          </div>
          <div v-if="rightBlockLayers.length" class="real-book-block real-book-block-right" aria-hidden="true">
            <i
              v-for="layer in rightBlockLayers"
              :key="layer.index"
              :style="{
                transform: `translate3d(0, ${layer.translateY}px, ${layer.translateZ}px)`,
                opacity: String(layer.opacity),
              }"
            ></i>
          </div>
          <section class="real-book-page real-book-left" aria-label="左页">
            <header class="real-book-page-head">{{ chapterTitle }}</header>
            <div class="real-book-page-body">
              <div v-if="!leftViewPieces.length" class="real-book-empty">书页已到开头</div>
              <p
                v-for="piece in leftViewPieces"
                :key="piece.key"
                class="real-book-para"
                :data-p="piece.original"
                :class="{ 'para-continued': piece.continued }"
              ><template v-for="(s, j) in piece.segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
            </div>
            <footer class="real-book-page-foot">{{ leftPageNumber || '' }}</footer>
            <!-- 翻动页投在这一页上的影子 -->
            <span
              v-if="flipping"
              class="real-book-cast"
              :style="{ opacity: String(flipCast.left), '--rb-cast-width': `${flipCast.leftWidth.toFixed(1)}%` }"
              aria-hidden="true"
            ></span>
          </section>

          <div class="real-book-gutter" aria-hidden="true"></div>

          <section class="real-book-page real-book-right" aria-label="右页">
            <header class="real-book-page-head">{{ chapterTitle }}</header>
            <div class="real-book-page-body">
              <div v-if="!rightViewPieces.length" class="real-book-empty">本章没有正文了</div>
              <p
                v-for="piece in rightViewPieces"
                :key="piece.key"
                class="real-book-para"
                :data-p="piece.original"
                :class="{ 'para-continued': piece.continued }"
              ><template v-for="(s, j) in piece.segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
            </div>
            <footer class="real-book-page-foot">{{ rightPageNumber || '' }}</footer>
            <!-- 翻动页投在这一页上的影子 -->
            <span
              v-if="flipping"
              class="real-book-cast"
              :style="{ opacity: String(flipCast.right), '--rb-cast-width': `${flipCast.rightWidth.toFixed(1)}%` }"
              aria-hidden="true"
            ></span>
          </section>

          <!-- 翻页中态：那页纸切成竖带逐帧卷起；背面是翻过去后要露出的那一页正文（E3） -->
          <div
            v-if="flipping"
            :key="flipping.key"
            class="real-book-flip"
            :style="{
              transform: `translateZ(${flipSheetState.lift.toFixed(2)}px) rotateX(${(-flipSheetState.tilt).toFixed(2)}deg)`,
            }"
            aria-hidden="true"
          >
            <div
              v-for="slice in flipSlices"
              :key="`slice-${slice.index}`"
              class="real-book-flip-slice"
              :style="slice.style"
            >
              <div class="real-book-flip-face real-book-flip-front" v-show="slice.showFront">
                <div class="real-book-flip-window">
                  <div class="real-book-flip-content" :style="slice.contentStyle">
                  <header class="real-book-page-head">{{ chapterTitle }}</header>
                  <div class="real-book-page-body">
                    <p
                      v-for="piece in flipSheetPieces"
                      :key="`front-${piece.key}`"
                      class="real-book-para"
                      :data-p="piece.original"
                    ><template v-for="(s, j) in piece.segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
                  </div>
                  <footer class="real-book-page-foot">{{ flipSheetPageNumber || '' }}</footer>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.real-book-stage {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding: 18px 24px 26px;
  background: var(--reader-outer, #e9e3d7);
  color: var(--reader-paper-text, #2f2a24);
  /* 纸的三层色：暖底、受光面、暖阴影。
     三层都从主题纸色派生，所以夜间主题下纸仍然是深色的，不会被暖色洗白。
     真实书页不是纯白：它是带一点黄的老纸色，纸背比纸面更暗更黄。 */
  --rb-paper-warm: color-mix(in srgb, var(--reader-paper, #f7f3e8) 72%, #d7a56c);
  --rb-paper-lit: color-mix(in srgb, var(--reader-paper, #f7f3e8) 78%, #fff0c9);
  --rb-paper-shade: color-mix(in srgb, var(--reader-paper, #f7f3e8) 76%, #6b4b27);
}

/* 书台：书摊在一张深色桌面上。
   设计图里暖奶油色的纸是压在深色桌布上的——深底把纸的厚度、弧度与投影
   托了出来；浅底上摊开的书只是一块浅色矩形，读不出「一本有厚度的书」。 */
.real-book-stage:not(.is-sheet) {
  background:
    radial-gradient(
      120% 96% at 50% 24%,
      #2b4038 0%,
      #1d302a 58%,
      #14231f 100%
    );
}

.real-book-measure {
  position: absolute;
  left: -10000px;
  top: 0;
  visibility: hidden;
  /* 与正文段落一致：默认换行规则。pre-wrap 会把空白差异带进断行结果。 */
  white-space: normal;
  word-break: break-word;
  overflow-wrap: break-word;
  pointer-events: none;
}

.real-book-toolbar {
  position: absolute;
  left: 50%;
  bottom: 18px;
  z-index: 12;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 6px 9px;
  transform: translateX(-50%);
  font-size: 12px;
  color: rgba(244, 235, 211, 0.82);
  border: 1px solid rgba(233, 220, 188, 0.16);
  border-radius: 16px;
  background: rgba(24, 28, 25, 0.88);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 245, 216, 0.08);
  backdrop-filter: blur(14px) saturate(0.82);
}

.real-book-btn {
  border: 1px solid rgba(244, 235, 211, 0.14);
  background: rgba(244, 235, 211, 0.06);
  color: rgba(244, 235, 211, 0.86);
  border-radius: 9px;
  padding: 3px 9px;
  font: inherit;
  cursor: pointer;
}

.real-book-btn:disabled { opacity: 0.5; cursor: default; }
.real-book-btn:focus-visible { outline: 2px solid var(--r-focus, #2f7fd0); outline-offset: 2px; }

.real-book-page-label { color: rgba(244, 235, 211, 0.62); min-width: 70px; }

.real-book-zoom { margin-left: 0; display: flex; align-items: center; gap: 5px; }
.real-book-zoom-value { color: rgba(244, 235, 211, 0.62); min-width: 40px; text-align: center; }

/* 书页版式：一整张纸铺在画布上，去掉书脊、伪页与俯仰，只留页眉 / 版心 / 页脚三行。 */
.real-book-stage.is-sheet {
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 14px 24px;
}

.rb-sheet {
  width: var(--rb-page-width);
  height: var(--rb-page-height);
  max-width: 100%;
  max-height: 100%;
  box-sizing: border-box;
  padding: var(--rb-pad-y) var(--rb-pad-x);
  display: grid;
  grid-template-rows: var(--rb-head-height) 1fr var(--rb-sheet-foot-height);
  border-radius: 14px;
  background: var(--reader-paper, #fff);
  box-shadow: var(--shadow-card, 0 12px 32px rgba(0, 0, 0, 0.08));
  color: var(--reader-paper-text, #2f2a24);
  font-size: var(--rb-font-size);
  line-height: var(--rb-line-height);
  font-family: var(--rb-font-family);
  text-align: justify;
}

.rb-sheet-head {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 0.72em;
  letter-spacing: 0.06em;
  color: color-mix(in srgb, var(--reader-paper-text, #2f2a24) 45%, transparent);
}

.rb-sheet-body {
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(var(--rb-columns, 1), minmax(0, 1fr));
  column-gap: var(--rb-column-gap, 48px);
  overflow: hidden;
}

.rb-sheet-column {
  min-width: 0;
  overflow: hidden;
}

.rb-sheet-foot {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 12px;
  padding-top: 0.6em;
}

.rb-sheet-page-label {
  color: color-mix(in srgb, var(--reader-paper-text, #2f2a24) 45%, transparent);
  font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .bottom-panel { animation: none; }
}

@media (max-width: 900px) {
  .real-book-stage.is-sheet { padding: 12px 12px; }
  .rb-sheet { border-radius: 10px; }
}

.real-book-viewport {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  /* 书台版式把书整体上移这一段：书脚下面还要露出纸垛切口与投影，
     视口是 overflow:hidden，不留这段余量切口就被切在底边。 */
  padding-bottom: var(--rb-block-band, 0px);
}

.real-book-stage.is-sheet .real-book-viewport { padding-bottom: 0; }

.real-book-book {
  /* 透视提到书体层：缩放、俯仰与两页的 V 形折角都在同一层，页面（子级）才吃得到同一个透视。 */
  perspective: 1750px;
  perspective-origin: 50% 42%;
  transform-style: preserve-3d;
  touch-action: none;
  transform-origin: center center;
  transition: transform 120ms ease-out;
}

/* 翻页中：书体的随动是逐帧算的，CSS 过渡会把快慢抹平。
   开着过渡时书会慢半拍地跟上纸——那正是「机械感」的一半。 */
.real-book-book.is-flipping {
  transition: none;
}

/* 翻页中书被手托起一点：地面投影随之变淡变散（离桌面越远，影子越虚）。 */

.real-book-spread {
  /* 俯仰只转书体：选区与标注仍落在页面的内层平面元素上。
     翻页时再叠一点侧倾与抬起（--rb-sway / --rb-lift）：书是被手甩的，
     不该像钉在桌上的一块板。 */
  transform: rotateX(var(--rb-pitch, 0deg)) rotateY(var(--rb-sway, 0deg)) translateZ(var(--rb-lift, 0px));
  transform-origin: center center;
  position: relative;
  display: flex;
  align-items: stretch;
  transform-style: preserve-3d;
}

.real-book-page {
  position: relative;
  width: var(--rb-page-width);
  height: var(--rb-page-height);
  padding: var(--rb-pad-y) var(--rb-pad-x);
  box-sizing: border-box;
  overflow: hidden;
  border-radius: 7px 3px 5px 4px;
  box-shadow: 0 10px 16px rgba(30, 22, 12, 0.12);
  display: grid;
  grid-template-rows: var(--rb-head-height) 1fr var(--rb-foot-height);
  /* 纸面质感：上缘受光 + 版心一团柔光 + 下缘转沉 + 沿页宽的弧面明暗。
     全部从主题纸色派生（暖底 / 受光面 / 暖阴影），不直接叠纯白纯黑：
     纯白高光在夜间主题下会把深色纸洗成灰纸，纯黑阴影在暖纸上会发脏。
     弧面明暗画在纸面背景层（文字之下）而不是盖在文字上——光影是纸的属性，
     不是盖在字上的一层膜。 */
  background-color: var(--rb-paper-warm);
  background-image:
    linear-gradient(
      180deg,
      var(--rb-paper-lit) 0%,
      color-mix(in srgb, var(--rb-paper-lit) 42%, transparent) 11%,
      transparent 30%,
      transparent 82%,
      color-mix(in srgb, var(--rb-paper-shade) 40%, transparent) 94%,
      var(--rb-paper-shade) 100%
    ),
    radial-gradient(
      120% 70% at 50% 20%,
      color-mix(in srgb, var(--rb-paper-lit) 55%, transparent),
      transparent 62%
    ),
    var(--rb-page-curve, none);
  color: var(--reader-paper-text, #2f2a24);
  font-size: var(--rb-font-size);
  line-height: var(--rb-line-height);
  font-family: var(--rb-font-family);
  text-align: justify;
}

/* 页眉：章节眉题。必须单行省略——占高是排版输入，不能随标题长短变。
   居中：设计图里的页眉是骑在版心上方的眉题，左右对齐读成正文标题。 */
.real-book-page-head {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: center;
  font-size: 0.72em;
  letter-spacing: 0.06em;
  color: color-mix(in srgb, var(--reader-paper-text, #2f2a24) 45%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--reader-paper-text, #2f2a24) 12%, transparent);
  padding-bottom: 0.3em;
}

.real-book-page-body {
  min-height: 0;
  overflow: hidden;
}

/* 页脚：页码，居中小字，与页眉同一弱色。 */
.real-book-page-foot {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  font-size: 0.7em;
  color: color-mix(in srgb, var(--reader-paper-text, #2f2a24) 45%, transparent);
  padding-top: 0.3em;
}

/* 翻动页投在下面纸页上的影子：纸从书脊那张开，所以越靠近书脊越深。
   浓淡由 JS 按翻页进度下发，方向固定朝书脊（左页的脊在右边，故渐变反向）。

   影子必须**贴着书脊**：翻动页只压在书脊那一侧，投下来的影子就是书脊边上
   一小团软影。铺到半页那么宽就不是投影，是把半张纸涂脏了——尤其影子是
   椭圆渐变，铺开后会变成一块边缘发亮的脏斑。 */
.real-book-cast {
  position: absolute;
  inset: 0;
  pointer-events: none;
  /* 影子带贴着书脊，宽度由 JS 按纸的位置下发（--rb-cast-width）。 */
  background: radial-gradient(
    var(--rb-cast-width, 18%) 84% at 0% 50%,
    rgba(58, 36, 16, 0.34),
    rgba(58, 36, 16, 0) 78%
  );
}

.real-book-left .real-book-cast {
  background: radial-gradient(
    var(--rb-cast-width, 18%) 84% at 100% 50%,
    rgba(58, 36, 16, 0.34),
    rgba(58, 36, 16, 0) 78%
  );
}

/* V 形摊开：两页以书脊为轴向外掀起，外侧先靠近观者，透视下因此向书脊收拢。
   这是「摊开的书」和「两个并排矩形」的全部区别，扭转量只走 3D 变换、不动排版。 */
.real-book-left {
  border-radius: 4px 0 0 4px;
  /* 书脊侧的暗：纸从谷里抬起来，靠脊那一小段落进阴影。 */
  box-shadow: inset -10px 0 18px -14px rgba(58, 36, 16, 0.5);
  transform-origin: right center;
  transform: rotateY(var(--rb-bend, 0deg));
  /* 左页的弧面：书脊在右边，所以越靠右越深地落进谷里，外缘受光。
     暗部必须**收在书脊那一小段**：摊开的书是书脊最低、纸面从谷里缓缓抬起，
     暗只占靠近书脊的窄带；暗摊开一整页就不是谷，是一张脏纸。
     阴影是暖的：纯灰的暗部压在奶油色纸上会发脏。 */
  --rb-page-curve: linear-gradient(
    90deg,
    transparent 56%,
    color-mix(in srgb, var(--rb-paper-shade) 14%, transparent) 78%,
    color-mix(in srgb, var(--rb-paper-shade) 42%, transparent) 92%,
    color-mix(in srgb, var(--rb-paper-shade) 66%, transparent) 100%
  );
}

.real-book-right {
  border-radius: 0 4px 4px 0;
  box-shadow: inset 10px 0 18px -14px rgba(58, 36, 16, 0.5);
  transform-origin: left center;
  transform: rotateY(calc(-1 * var(--rb-bend, 0deg)));
  /* 右页的弧面：书脊在左边，谷口朝内，外缘抬起受光。与左页同一套光。 */
  --rb-page-curve: linear-gradient(
    90deg,
    color-mix(in srgb, var(--rb-paper-shade) 66%, transparent) 0%,
    color-mix(in srgb, var(--rb-paper-shade) 42%, transparent) 8%,
    color-mix(in srgb, var(--rb-paper-shade) 14%, transparent) 22%,
    transparent 44%
  );
}

.real-book-gutter {
  width: 18px;
  /* 书脊是全书最低的一点：它是**谷**，不是一道缝，更不是一根黑棒。
     谷的结构是：两侧的纸往中间落、落进谷里，所以紧靠脊的那一小段最暗；
     再往里（脊心）纸页叠在一起，反而被上方折过来的纸缘挡出一道亮线。
     这一层必须**不透明**：书台是深色桌面，谷一旦半透明，深色桌面从底下透上来，
     谷就读成「这里裂开一条缝，缝里是黑的」，而不是纸落下去的凹面。 */
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--rb-paper-shade) 84%, #1d1207) 0%,
      color-mix(in srgb, var(--rb-paper-shade) 66%, #33210e) 26%,
      color-mix(in srgb, var(--rb-paper-shade) 40%, #53381a) 43%,
      color-mix(in srgb, var(--rb-paper-lit) 58%, var(--rb-paper-warm)) 50%,
      color-mix(in srgb, var(--rb-paper-shade) 42%, #513718) 57%,
      color-mix(in srgb, var(--rb-paper-shade) 68%, #33210e) 74%,
      color-mix(in srgb, var(--rb-paper-shade) 84%, #1d1207) 100%
    );
  /* 谷口的两侧各有一道细亮边：那是纸页折过来时露出的纸缘。 */
  box-shadow:
    inset 2px 0 3px -1px rgba(255, 246, 226, 0.42),
    inset -2px 0 3px -1px rgba(255, 246, 226, 0.34);
}

/* 书下投影：书体与纸垛落在地面上的影子。退到书体后方（translateZ），
   所以永远压在页面底下，只在书脚外露出来，不会糊到正文上。
   翻页时书被手托起来一点（--rb-lift），影子随之变淡变散——离桌面越远，影子越虚。 */
.real-book-shadow {
  position: absolute;
  left: 0;
  right: 0;
  /* 锚在页脚下沿、顺着页面平面往下长：投影的最深处正好落在书脚，
     俯仰时它跟着页面一起转，不必另算屏幕坐标。 */
  top: 100%;
  height: calc(56px + var(--rb-lift, 0px) * 0.8);
  background: radial-gradient(58% 62% at 50% 0%, rgba(0, 0, 0, 0.54), rgba(0, 0, 0, 0) 76%);
  filter: blur(calc(14px + var(--rb-lift, 0px) * 0.5));
  opacity: calc(1 - var(--rb-lift, 0px) * 0.018);
  pointer-events: none;
}

/* 书厚：左右两半各一摞纸。纸垛必须跟着本半页折同一个角，
   否则会从页脚错开成一截浮空的纸板。 */
.real-book-block {
  position: absolute;
  bottom: 0;
  width: var(--rb-page-width);
  height: 0;
  pointer-events: none;
  transform-style: preserve-3d;
  transform-origin: right center;
  transform: rotateY(var(--rb-bend, 0deg));
}

.real-book-block-left {
  left: 0;
  --rb-block-h: var(--rb-block-left, 0px);
}

.real-book-block-right {
  right: 0;
  --rb-block-h: var(--rb-block-right, 0px);
  transform-origin: left center;
  transform: rotateY(calc(-1 * var(--rb-bend, 0deg)));
}

/* 切口：从页脚下沿向后倒过去的一面，一摞纸的厚度就画在这个面上。
   平放时只露一道细边，俯仰后整面立起来，厚度才读得出来。 */
.real-book-block::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: max(1px, var(--rb-block-h, 0px));
  transform-origin: center top;
  transform: rotateX(-60deg);
  border-radius: 0 0 3px 3px;
  /* 上缘贴着纸面要压深一点，否则纸垛会像是平铺在页脚的一张旧纸；
     每条 1px 暗线就是一页纸的纸边。 */
  box-shadow: inset 0 3px 4px -2px rgba(58, 36, 16, 0.5);
  background:
    /* 切口是**暖的**：一层层纸叠在一起的断面，每层之间压一道暖影。 */
    linear-gradient(180deg, rgba(58, 36, 16, 0.48), rgba(58, 36, 16, 0.06) 18%, rgba(58, 36, 16, 0.22) 66%, rgba(58, 36, 16, 0.46)),
    repeating-linear-gradient(
      180deg,
      color-mix(in srgb, var(--rb-paper-warm) 52%, #6a471d) 0 1px,
      color-mix(in srgb, var(--rb-paper-warm) 90%, #f2e5c6) 1px 2.5px
    );
}

/* 外侧书口：贴着外缘向后立起来的一面。左右两半的外缘不在同一边，旋转方向相反。
   书口是书的外轮廓：它必须看得出是一��摞纸的边，而不是一条亮边。
   亮边读起来像「页面镶了一道边」，暗边读起来才像「纸叠起来的厚度」。 */
.real-book-block::after {
  content: '';
  position: absolute;
  top: calc(-1 * var(--rb-page-height));
  left: 0;
  width: max(1px, var(--rb-block-h, 0px));
  height: var(--rb-page-height);
  transform-origin: left center;
  transform: rotateY(90deg);
  border-radius: 0 3px 3px 0;
  background:
    /* 里侧贴着纸面那一段压深：那是纸叠进去的那一侧。 */
    linear-gradient(90deg, rgba(58, 36, 16, 0.55), rgba(58, 36, 16, 0.08) 44%, rgba(58, 36, 16, 0.26)),
    /* 逐张纸的边：竖着的细纹，一层层数得出来。
       这一面是**侧着**看的书口，看到的是一页叠一页的厚度，
       所以纹路要竖着走（沿进深方向分���层），不是一道道横线。 */
    repeating-linear-gradient(
      90deg,
      color-mix(in srgb, var(--rb-paper-warm) 54%, #5d4320) 0 1px,
      color-mix(in srgb, var(--rb-paper-warm) 84%, #efdfbe) 1px 3px
    );
}

.real-book-block-right::after {
  left: auto;
  right: 0;
  transform-origin: right center;
  transform: rotateY(-90deg);
  border-radius: 3px 0 0 3px;
}

/* 逐层纸边：每层沿页脚向下、向后错开一点，叠成数得清层数的纸摞。 */
.real-book-block i {
  position: absolute;
  left: 1px;
  right: 1px;
  height: 2px;
  border-radius: 0 0 2px 2px;
  /* 纸边比纸面略深：从暖纸色里压出来，四套主题下都不会发灰或发紫。 */
  background: color-mix(in srgb, var(--rb-paper-warm) 80%, #7a5a30);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--reader-paper-text, #2f2a24) 12%, transparent);
}

.real-book-para {
  margin: 0 0 0.45em;
  text-indent: 2em;
}

.real-book-para.para-continued {
  text-indent: 0;
}

.real-book-empty {
  color: var(--r-muted, #6b6257);
  font-size: 13px;
}

/* 翻页中态：那页纸切成竖带，每条带各自转角，连线就是弧面；背面朝上时露出下一面 */
.real-book-flip {
  position: absolute;
  top: 0;
  left: 50%;
  width: var(--rb-page-width);
  height: var(--rb-page-height);
  transform-style: preserve-3d;
  pointer-events: none;
  z-index: 2;
  /* 纸的「帆」起来是以**下缘**为轴翻出去的：下缘还压在书上，上缘朝观者倾过去。
     若以中心为轴（默认），下半张纸会往后沉到静态页平面之后——3D 上下文里
     深度优先于 z-index，那半张纸就被下面的静态页盖住，纸上多出一块楔形的缺口。
     轴放在下缘，纸才会整片抬在页面之上。 */
  transform-origin: 50% 100%;
}

/* 竖带：位置与转角都由 JS 逐帧下发；弯曲只来自相邻带的转角差。

   裁剪放在竖带自己身上，而不是更里层的窗格：3D 变换过的一层里再套
   overflow:hidden，浏览器实测会把裁剪丢掉，整页正文从窄缝里整片漏出来
   （而且方向是镜像的，看着像一整块反着印的板子）。
   竖带自己 flat（不再 preserve-3d）：带内只需要一个平面，平面里才好裁。 */
.real-book-flip-slice {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  transform-origin: left center;
  transform-style: flat;
  overflow: hidden;
}

/* 纸面：正反面的显隐由 JS 按竖带转角下发（见 flipSlices 的 showFront / showBack）。
   不靠 backface-visibility：实测转过 90° 后正面照旧在画、背面从不露面，两面内容就叠成一片糊字。 */
.real-book-flip-face {
  position: absolute;
  inset: 0;
  background: var(--rb-paper-warm, #f7f3e8);
  color: var(--reader-paper-text, #2f2a24);
  font-size: var(--rb-font-size);
  line-height: var(--rb-line-height);
  font-family: var(--rb-font-family);
  text-align: justify;
  backface-visibility: hidden;
  /* 动态模糊落在**面层**（带宽尺寸），不落在内容层（整页宽）。
     模糊要重做离屏表面：作用面积是整页宽时，12 条带各要模糊一整张整页位图。
     实测：面层（带宽）55 帧、内容层（整页宽）27 帧、竖带层 9 帧。

     模糊量为 0 时变量给的是 none 而不是 blur(0px)：带 filter 的层会被浏览器
     当作需要离屏渲染的层，每帧为 24 个面层各做一次离屏合成，白吃一大截帧率。 */
  filter: var(--rb-flip-blur, none);
}

/* 窗格裁剪夹在中间这一层：竖带层要 preserve-3d（裁剪会把背面压平），
   面层要留着做显隐与照明，只有这一层可以放心裁。 */
.real-book-flip-window {
  position: absolute;
  inset: 0;
}

/* 每条带里放一整页内容、横向错开一条带宽，于是这条带只露出自己那一段。
   三行网格与静态页同构（页眉 / 版心 / 页脚），翻动中的纸才不会缺页眉页码。 */
.real-book-flip-content {
  height: 100%;
  padding: var(--rb-pad-y) var(--rb-pad-x);
  box-sizing: border-box;
  display: grid;
  grid-template-rows: var(--rb-head-height) 1fr var(--rb-foot-height);
  /* 带子转过 90° 后，正面整层停画；只剩背面（或纸背）参与合成。
     不这样做时，侧过去的那半张仍按 opacity 叠在下方页面上，看起来像整页残影。 */
  opacity: var(--rb-flip-side, 1);
}

/* 纸面明暗：沿弧面连续变化——每条带用自己两端的边界角做一层渐变，
   相邻带端点值相同，接起来就是一道连续的光。按条带平涂会在纸上浮出竖条纹。
   渐变画在纸面背景层（文字之下）：光影是纸的属性，不是盖在字上的一层膜。 */
.real-book-flip-face {
  background-image:
    /* 纸色：上缘受光、下缘转沉，与静态页同一套暖色三层。
       翻动中的纸必须与桌面上的纸是同一种纸；两面颜色不一致时，
       纸一离开桌面就像换了一张纸。 */
    linear-gradient(
      180deg,
      var(--rb-paper-lit) 0%,
      color-mix(in srgb, var(--rb-paper-lit) 42%, transparent) 11%,
      transparent 30%,
      transparent 82%,
      color-mix(in srgb, var(--rb-paper-shade) 40%, transparent) 94%,
      var(--rb-paper-shade) 100%
    ),
    /* 高光：纸面斜对观者时反光，正对时几乎不反。一道窄带的光贴在纸上，
       纸才像有光泽的纸，而不是一块贴了字的板子。 */
    linear-gradient(
      90deg,
      rgb(255 250 238 / calc(var(--rb-flip-spec-a, 0) * 0.22)),
      rgb(255 250 238 / calc(var(--rb-flip-spec-b, 0) * 0.22))
    ),
    /* 暗部：侧过去的那一半沉进阴影。阴影偏暖，纯灰的暗压在奶油纸上发脏。 */
    linear-gradient(
      90deg,
      rgb(58 36 16 / calc(var(--rb-flip-dark-a, 0) * 0.26)),
      rgb(58 36 16 / calc(var(--rb-flip-dark-b, 0) * 0.26))
    ),
    /* 纸纹：与静态页同源的极淡竖向纹理，翻动中的纸才不是一张白板。 */
    repeating-linear-gradient(90deg, rgba(58, 36, 16, 0.014) 0 1px, transparent 1px 3px);
}

@media (prefers-reduced-motion: reduce) {
  .real-book-book { transition: none !important; }
}
</style>
