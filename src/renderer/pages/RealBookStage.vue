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
import type { ReaderHandwritingFont } from '@shared/types'
import {
  createRealBookPaginator,
  findPageForInput,
  pageRatio,
  type RealBookAnchor,
  type RealBookNoteBlock,
  type RealBookPage,
} from './realBookPager'
import {
  estimateInlineNoteHeight,
  INLINE_NOTE_GAP_PX,
  type RealBookNote,
} from './realBookNotes'
import { MAX_SPINE_LAYERS, spineLayers, spineStack } from './realBookSpine'
import { measureLines } from './realBookMeasure'
import { clampPitch, pitchFromDrag, pitchResetTarget } from './realBookPitch'
import { FLIP_DURATION_MS, flipAngles, flipBackContentOpacity, flipContentOpacity, flipFaceVisible, flipLight, flipPhases, flipPoses, flipSheetLift, flipSway, valleyBands } from './realBookFlip'

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
  /** 当前章的页内批注；只在真实书籍 variant 下显示 */
  notes?: RealBookNote[]
  /** 批注模式开关；关掉后只留划线 */
  showNotes?: boolean
  /** 批注手写体；只影响批注呈现 */
  handwritingFont?: ReaderHandwritingFont
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
  /** 新写或刚编辑的批注 id：重排后跳到它所在页 */
  revealNoteId?: string
  /** 每次要求露出批注时递增 */
  revealNoteToken?: number
}>(), {
  highlights: () => [],
  notes: () => [],
  showNotes: true,
  handwritingFont: 'none',
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
  revealNoteId: '',
  revealNoteToken: 0,
})

const emit = defineEmits<{
  (event: 'update:anchor', anchor: RealBookAnchor): void
  (event: 'update:page', page: number): void
  (event: 'update:page-count', count: number): void
  (event: 'select', event: MouseEvent): void
  (event: 'update:pitch', pitch: number): void
  (event: 'update:show-notes', show: boolean): void
  (event: 'edit-note', noteId: string): void
  (event: 'next-chapter'): void
}>()

const hostRef = ref<HTMLElement | null>(null)
const measureRef = ref<HTMLElement | null>(null)
const noteMeasureRef = ref<HTMLElement | null>(null)
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
let lastRevealToken = 0

let flipTimer: ReturnType<typeof setTimeout> | null = null
let flipRaf = 0
let flipKey = 0
let observer: ResizeObserver | null = null

/** 版面尺寸：双页摊开，每页宽度取舞台的一半，页高按开本比例约束。 */
const layout = ref({ pageWidth: 480, pageHeight: 640, paddingX: 43, paddingY: 38, contentWidth: 420, contentHeight: 560 })
const lineHeightPx = computed(() => Math.max(1, props.fontSize) * Math.max(0.5, props.lineHeight))
const paragraphGapPx = computed(() => Math.max(0, props.fontSize) * Math.max(0, props.paragraphGap))
const handwritingNoteClass = computed(() => `handwriting-${props.handwritingFont}`)
/** 书页模式的栏数与栏间距；栏间距跟着字号走，换字号不会把两栏挤到一起。 */
const pageColumns = computed(() => (props.columns === 2 ? 2 : 1))
const columnGapPx = computed(() => Math.round(Math.max(1, props.fontSize) * 3))
/** 一张书页折几栏就是一页翻几步：书台一页=一页，书页一页=栏数个分页器页。 */
const pageStep = computed(() => (props.variant === 'sheet' ? pageColumns.value : 1))
/**
 * 一次翻页前进多少页。
 *
 * 书台是**双页摊开**：翻一张纸会同时换掉左右两页——旧右页翻到对面成为新的左页，
 * 新的右页是再往后一页。所以一次翻页要前进 2 页。若只前进 1 页，读者会看到
 * 旧右页滑到左页、右页换成下一页，那是「挪一个窗口」，不是「翻一张纸」。
 *
 * 书页模式一张纸折几栏就是翻几步，用 pageStep。
 */
const advance = computed(() => (props.variant === 'book' ? 2 : pageStep.value))
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
  if (target?.closest?.('.real-book-para, .real-book-note')) return
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
  // 书尽量铺满可用宽度，只留一圈窄桌边：阅读面积优先。
  // 默认俯仰会把投影再放大，因此按 0.88 预留，而不是把整行宽度都塞给书页。
  const availableHeight = Math.floor(height * 0.99) - BLOCK_THICKNESS_PX
  const widthLimit = Math.floor((width * 0.88 / 2) * 0.99)
  // 开本固定为约 3:4 的竖版（1:1.42）。宽度同时受高度约束：
  // 只按宽度算会在矮窗口里把书压成横向卡片——那不是书。
  const heightLimit = Math.floor(availableHeight / 1.42)
  const pageWidth = Math.max(260, Math.min(widthLimit, heightLimit))
  const pageHeight = Math.max(320, Math.min(
    Math.floor(pageWidth * 1.42),
    availableHeight,
  ))
  const paddingX = Math.round(pageWidth * 0.08)
  // 垂直内边距与 CSS 共用同一变量：JS 算版心、CSS 排版，两处不一致就会裁字。
  const paddingY = Math.round(pageHeight * 0.055)
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

/**
 * 把 Reader 的原始段落下标映射成排版器输入下标，并量出每张卡的真实高度。
 * 无布局环境（jsdom）或卡还没挂载时退回估算，保证页表仍可计算。
 */
function measuredNoteBlocks(): RealBookNoteBlock[] {
  if (props.variant !== 'book' || !props.showNotes || !props.notes.length) return []
  const root = noteMeasureRef.value
  if (root) root.style.width = `${layout.value.contentWidth}px`
  const measured = new Map<string, number>()
  if (root) {
    for (const el of root.querySelectorAll<HTMLElement>('[data-measure-note-id]')) {
      const id = el.dataset.measureNoteId
      const height = el.getBoundingClientRect().height
      if (id && Number.isFinite(height) && height > 0) measured.set(id, height)
    }
  }
  const out: RealBookNoteBlock[] = []
  for (const note of props.notes) {
    const paragraph = inputIndexOf(note.paragraph)
    if (paragraph < 0) continue
    const height = measured.get(note.id)
      ?? estimateInlineNoteHeight(note.text, layout.value.contentWidth, props.fontSize)
    out.push({
      id: note.id,
      paragraph,
      anchorOffset: note.offset,
      height: height + INLINE_NOTE_GAP_PX,
    })
  }
  return out
}

function rebuildPages(): void {
  const measure = measureRef.value
  if (!measure) return
  const previousAnchor = pendingRestore ? null : anchorOf(pages.value[currentPage.value])
  const { contentHeight } = layout.value
  const created = createRealBookPaginator(
    props.paragraphs,
    (text) => measureLines(text, measure),
    { pageHeight: contentHeight, lineHeight: lineHeightPx.value, paragraphGap: paragraphGapPx.value },
    measuredNoteBlocks(),
  )
  paginator.value = created
  created.ensure(Math.max(0, currentPage.value))
  pages.value = created.pages
  if (pendingRestore) applyRestore()
  else if (previousAnchor) goToAnchor(previousAnchor)
  applyReveal()
  emit('update:page-count', pages.value.length)
  emit('update:page', currentPage.value)
}

/** 原始段落下标 → 输入数组下标（排版器只认输入下标）。 */
function inputIndexOf(paragraph: number): number {
  return props.paragraphIndexes.indexOf(paragraph)
}

function anchorOf(page: RealBookPage | undefined): RealBookAnchor | null {
  if (!page || !page.items.length) return null
  const original = props.paragraphIndexes[page.paragraph]
  if (original === undefined) return null
  return { paragraph: original, offset: page.offset }
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
  goToPage(currentPage.value + advance.value, true)
}

function prevPage(): void {
  goToPage(currentPage.value - advance.value, true)
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

/**
 * 新写/编辑批注后：找到批注卡片实际所在的页。锚点落在段落末尾时，
 * `findPageForInput` 可能仍指向正文最后一页，而卡片已被挤到下一页，
 * 所以这里优先按 noteId 查页。
 */
function applyReveal(): void {
  const token = props.revealNoteToken
  if (token <= 0 || token === lastRevealToken) return
  lastRevealToken = token
  if (!props.showNotes) return
  const note = props.notes.find((item) => item.id === props.revealNoteId)
  if (!note) return
  const inputIndex = inputIndexOf(note.paragraph)
  if (inputIndex < 0) return
  const created = paginator.value
  if (!created) return
  created.ensureThroughParagraph(inputIndex)
  pages.value = created.pages
  const notePage = pages.value.findIndex((page) =>
    page.items.some((item) => item.kind === 'note' && item.noteId === note.id),
  )
  if (notePage >= 0) {
    goToPage(notePage, false)
    return
  }
  goToAnchor({ paragraph: note.paragraph, offset: note.offset })
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

/** 一页里要渲染的文字片段。 */
interface PageTextPiece {
  kind: 'text'
  key: string
  paragraph: number
  original: number
  start: number
  end: number
  continued: boolean
  segs: ReturnType<typeof decorateText>
}

interface PageNotePiece {
  kind: 'note'
  key: string
  note: RealBookNote
}

type PagePiece = PageTextPiece | PageNotePiece

function blockOfNote(noteId: string, key: string): PageNotePiece | null {
  const note = props.notes.find((item) => item.id === noteId)
  return note ? { kind: 'note', key, note } : null
}

function piecesOf(page: RealBookPage | undefined): PagePiece[] {
  if (!page) return []
  const out: PagePiece[] = []
  for (const item of page.items) {
    if (item.kind === 'note') {
      const block = blockOfNote(item.noteId, `note-${item.noteId}-${item.paragraph}`)
      if (block) out.push(block)
      continue
    }
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
      kind: 'text',
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
const slotPage = computed(() => currentPage.value + (flipping.value ? flipping.value.direction * advance.value : 0))
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
 * 正面是抬起的那一页（旧右页 / 旧左页）。背面只画纸：纸背若是半透明字影，
 * 铺在落点那一页上会读成一块灰影，翻页时看着像左边多了个影子。背面保持
 * 不透明纸面，落定后静态页再一次性换成新内容，读者不会看到半透明旧字。
 */
const flipSheetIndex = computed(() => (flipping.value?.direction === -1
  ? currentPage.value - 1
  : currentPage.value))
const flipSheetPieces = computed(() => piecesOf(pages.value[flipSheetIndex.value]))
/**
 * 翻动纸背的内容：一张纸的正面是右页，背面就是落到对面后露出的左页。
 *
 * 之前因为“纸背透字会在落点页上叠出灰影”把背面正文整层去掉了，结果翻页中
 * 看到一整块空白纸板——这正是僵硬感的来源之一。正确的做法不是不画，而是
 * 只在转角越过 90° 后画**另一页**内容，并沿纸面镜像；正反面互斥后不会再重影。
 */
const flipBackIndex = computed(() => {
  const direction = flipping.value?.direction
  if (!direction) return -1
  return direction === 1 ? currentPage.value + 1 : currentPage.value - 2
})
const flipBackPieces = computed(() => piecesOf(pages.value[flipBackIndex.value]))
/**
 * 卷页竖带：角度与位置由 `flipPoses` 算（折线积分），这里只铺成 style。
 * 每条带各渲染一份整页内容、按 −i×带宽 错开，相当于把同一页切成一条条窗格。
 */
/** 翻动页的 1-based 页码：与静态页同一条公式（页下标 + 1），空页不印号。 */
const flipSheetPageNumber = computed(() => (flipSheetPieces.value.length ? flipSheetIndex.value + 1 : 0))
const flipBackPageNumber = computed(() => (flipBackPieces.value.length ? flipBackIndex.value + 1 : 0))
/**
 * 动态模糊的角速度阈值（0–1）：低于它的带保持清晰。
 *
 * 模糊要重做离屏表面，是翻页最大的开销。阈值把「需要模糊的带」压到少数几条：
 * 实测整段翻页从 29 帧（长帧 3）回到 40 帧上下，且没有长帧。
 */
const flipSlices = computed(() => {
  const direction = flipping.value?.direction ?? 1
  const width = layout.value.pageWidth
  const { from, to } = flipAngles(direction, BEND_DEG)
  const options = { width, fromDeg: from, toDeg: to }
  const poses = flipPoses(flipT.value, options)
  return poses.map((pose, index) => {
    // 纸面侧对观者时把正文淡出：竖带是按平面拼的，越斜越糊。
    //
    // 判据是「纸面自己的转角」θ：θ 超过 90° 时，这条带已经转到纸的背面，
    // 它的正面内容必须整层停画。只靠 cos 淡出不够：60°–90° 时正面已经很淡，
    // 却仍和翻过来的背面同时存在，右半页上就会叠出一层半透明的上一页残影。
    // 阈值与背面字影的系数都收在 `realBookFlip` 里（那里有单测钉住）。
    const contentOpacity = flipContentOpacity(pose.angle)
    const visible = flipFaceVisible(pose.angle)
    // 转角是负的（向右翻的外缘是 -180°），必须按绝对值判侧：直接写 angle < 90
    // 会把所有负角都当成正面，纸转过去后仍画着旧正文。
    const sideOpacity = visible.showFront ? 1 : 0
    return {
      index,
      // 作废一面交给转角自己决定：纸面转过 90° 后正面就不该再画，否则正反两层
      // 叠在同一张纸上；浏览器的 backface-visibility 在带裁剪的 3D 层里不可靠。
      ...visible,
      // 多出 0.5px 让相邻两条略搭接：亚像素缝隙会在纸上漏成一条亮线。
      style: {
        width: `${(pose.width + 0.5).toFixed(2)}px`,
        transform: `translate3d(${pose.x.toFixed(2)}px, 0, ${pose.z.toFixed(2)}px) rotateY(${pose.angle.toFixed(2)}deg)`,
        // 竖带保持整页高度，不在上下缘裁内收轮廓：裁掉的那一块会直接露出
        // 下面的静态页，起手时就像纸先被撕开一条横缝，再开始翻。
        // 动态模糊会为每条带重建一次离屏表面，实测把整段翻页压到 10–17 帧。
        // 现在纸页本身有连续曲率与外角侧滚，动画的“速度感”由几何承担；
        // 保住 60Hz 的连续帧，比给快带糊一层拖影更像真纸。
        '--rb-flip-blur': 'none',
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
      backContentStyle: {
        width: `${width}px`,
        transformOrigin: '0 0',
        // 纸背可见时切片上的 --rb-flip-side 正好是 0（正面停画）。
        // 纸背正文按转角淡入：90° 边界两侧不能一边旧页正文、一边新页正文，
        // 否则纸上会出现一条竖着换字的「撕缝」。纸背本身仍是整张不透明纸。
        opacity: flipBackContentOpacity(pose.angle).toFixed(3),
        // 纸背沿竖带镜像：竖带转过 90° 后局部 x 轴在屏幕上是反的，
        // 先把内容预翻一次，纸背上的下一页才不会左右颠倒。
        transform: `translateX(${(width - pose.offset).toFixed(2)}px) scaleX(-1)`,
      } as Record<string, string>,
    }
  })
})

/**
 * 翻动页整体离桌的程度：纸在飞行中「帆」起来。
 *
 * 位移与倾角都作用在整张纸上，不作用在单条竖带——否则页脚会变成锯齿状的阶梯。
 */
const flipSheetState = computed(() => flipSheetLift(flipT.value, flipping.value?.direction ?? 1))

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
  const lift = Math.max(0, Math.sin(Math.PI * Math.min(1, t / 0.55))) * 0.12
  // 落下侧：纸快到时才开始压暗，落定前收回，免得落定那一帧突然变亮。
  const land = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.45) / 0.55)))) * 0.15
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
  const target = currentPage.value + advance.value
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
 * 每层纸的纵深（px）。纯模块里的默认值同样是 4；
 * 书台要的是「看得见层、但整体薄」——一层 4px，整本最多 12 层也才 48px。
 */
const BLOCK_DEPTH_PER_LAYER_PX = 4

/**
 * V 形摊开角（deg）：两页以书脊为轴向外掀起的角度。
 * 翻页的起翻角与落位角都由它推出来——两处必须同一个数，否则落定时会错开一个折角。
 */
const BEND_DEG = 9

/**
 * 书脊谷的宽度（px）：从书脊向外这一段纸是弯的，其余部分摊平。
 *
 * 取页宽的一个固定比例：书心塌下去的宽度与书的大小成正比，
 * 固定像素会让大书看着谷太浅、小书谷太深。
 *
 * 比例要够大才有「弯」可看：谷只占 16% 时，纸面横向只压缩几像素，
 * 肉眼看过去仍是平的一张纸。参考图里书脊的弯一直铺到半页，
 * 取 42% 才读得出连续的曲面。
 */
const VALLEY_WIDTH_RATIO = 0.42

/** 书脊谷的深度角（deg）：谷底的最大倾角。比整页折角大：谷是一段急弯，不是一个缓坡。 */
const VALLEY_DEG = 30

/** 谷的竖带条数：条数越多谷越顺，但每条都要画一份整页内容。 */
const VALLEY_SLICE_COUNT = 5

/**
 * 靠脊暖影：整页一张横向渐变，所有竖带共享同一坐标。
 *
 * 每条带各自画渐变的话，接缝处会因坐标不同而断开，变成一道道竖纹；
 * 共享同一张整页渐变，明暗就跨带连续，像一张弯下去的纸上的光。
 * 渐变只用纸的暖阴影色，纯灰暗压在奶油纸上会发脏。
 */
const VALLEY_SHADE_GRADIENT = 'linear-gradient(90deg, transparent 0%, transparent 100%)'

const ENABLE_VALLEY_STRIPS = ref(false)

interface ValleySlice {
  index: number
  style: Record<string, string>
  contentStyle: Record<string, string>
}

const rightValleySlices = computed<ValleySlice[]>(() => {
  if (!ENABLE_VALLEY_STRIPS.value) return []
  const width = layout.value.pageWidth
  const valleyWidth = Math.max(10, Math.round(width * VALLEY_WIDTH_RATIO))
  return valleyBands({ pageWidth: width, valleyWidth, valleyDeg: VALLEY_DEG, slices: VALLEY_SLICE_COUNT, spineAt: 'left' })
    .map((band) => ({
      index: band.index,
      style: {
        width: `${(band.width + 0.5).toFixed(2)}px`,
        transform: `translate3d(${band.x.toFixed(2)}px, 0, ${band.z.toFixed(2)}px) rotateY(${band.tilt.toFixed(2)}deg)`,
        transformOrigin: '0 0',
      },
      contentStyle: {
        width: `${width}px`,
        transform: `translateX(${-band.paperLeft.toFixed(2)}px)`,
        backgroundImage: VALLEY_SHADE_GRADIENT,
      },
    }))
})

const leftValleySlices = computed<ValleySlice[]>(() => {
  if (!ENABLE_VALLEY_STRIPS.value) return []
  const width = layout.value.pageWidth
  const valleyWidth = Math.max(10, Math.round(width * VALLEY_WIDTH_RATIO))
  return valleyBands({ pageWidth: width, valleyWidth, valleyDeg: VALLEY_DEG, slices: VALLEY_SLICE_COUNT, spineAt: 'right' })
    .map((band) => ({
      index: band.index,
      style: {
        width: `${(band.width + 0.5).toFixed(2)}px`,
        transform: `translate3d(${band.x.toFixed(2)}px, 0, ${band.z.toFixed(2)}px) rotateY(${band.tilt.toFixed(2)}deg)`,
        transformOrigin: '0 0',
      },
      contentStyle: {
        width: `${width}px`,
        transform: `translateX(${-band.paperLeft.toFixed(2)}px)`,
        backgroundImage: VALLEY_SHADE_GRADIENT,
      },
    }))
})

/**
 * 翻动页转轴到摊开中心线的距离（px）。
 *
 * 书心不占宽度（见 `.real-book-gutter`）：两页以各自的装订边为 3D 轴心，
 * 内缘正好落在中心线上，所以翻动页就直接绕中心线翻。
 */
const FLIP_ANCHOR_OFFSET_PX = 0

/** 书厚纸垛占用的高度：页面在下方让出这一段，纸垛的切口才不会被视口裁掉。 */
const BLOCK_THICKNESS_PX = MAX_SPINE_LAYERS * BLOCK_DEPTH_PER_LAYER_PX + 8

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
  () => [
    props.paragraphs,
    props.fontSize,
    props.lineHeight,
    props.paragraphGap,
    props.notes,
    props.showNotes,
    props.handwritingFont,
    headHeightPx.value,
    footHeightPx.value,
  ],
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
watch(() => props.revealNoteToken, () => {
  void nextTick(() => applyReveal())
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
  const last = [...page.items].reverse().find((item) => item.kind === 'text')
  if (!last) return null
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
    <!-- 批注卡量高：与真实卡片同一套宽度、字体与三行截断，只把结果交给分页器。 -->
    <div ref="noteMeasureRef" class="real-book-note-measure" :style="{ width: `${layout.contentWidth}px` }" aria-hidden="true">
      <aside
        v-for="note in notes"
        :key="`measure-${note.id}`"
        :class="['real-book-note', handwritingNoteClass]"
        :data-measure-note-id="note.id"
      >
        <span class="real-book-note-label">批注</span>
        <span class="real-book-note-text">{{ note.text }}</span>
      </aside>
    </div>

    <div v-if="variant === 'book'" class="real-book-toolbar">
      <span class="real-book-page-label" role="status">{{ currentLabel }}</span>
      <span class="real-book-zoom">
        <button type="button" class="real-book-btn" aria-label="缩小" @click="zoomOut">－</button>
        <span class="real-book-zoom-value">{{ Math.round(zoom * 100) }}%</span>
        <button type="button" class="real-book-btn" aria-label="放大" @click="zoomIn">＋</button>
        <button type="button" class="real-book-btn" aria-label="重置缩放" @click="resetZoom">复原</button>
        <button type="button" class="real-book-btn" aria-label="平放" @click="resetPitch">平放</button>
        <button
          type="button"
          :class="['real-book-btn', 'real-book-note-toggle', { 'is-active': showNotes }]"
          :aria-pressed="showNotes"
          :aria-label="showNotes ? '关闭批注模式' : '开启批注模式'"
          :title="showNotes ? '关闭批注模式：只保留划线' : '开启批注模式：在页面上显示批注'"
          @click="emit('update:show-notes', !showNotes)"
        >批注</button>
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
            <template v-for="piece in col" :key="piece.key">
              <p
                v-if="piece.kind === 'text'"
                class="real-book-para"
                :data-p="piece.original"
                :class="{ 'para-continued': piece.continued }"
              ><template v-for="(s, j) in piece.segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
              <aside
                v-else
                :class="['real-book-note', handwritingNoteClass, { 'is-ai': piece.note.source === 'ai' }]"
                :data-note-id="piece.note.id"
                role="button"
                tabindex="0"
                :aria-label="`编辑批注：${piece.note.text}`"
                @click.stop="emit('edit-note', piece.note.id)"
                @mouseup.stop
                @keydown.enter.stop.prevent="emit('edit-note', piece.note.id)"
                @keydown.space.stop.prevent="emit('edit-note', piece.note.id)"
              >
                <span class="real-book-note-label">批注<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                <span class="real-book-note-text">{{ piece.note.text }}</span>
              </aside>
            </template>
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
        :style="{
          ...bookStyle,
          '--rb-valley-clip': `${Math.max(10, Math.round(layout.pageWidth * VALLEY_WIDTH_RATIO))}px`,
          '--rb-valley-active': ENABLE_VALLEY_STRIPS.value ? 1 : 0,
        }"
        @pointerdown="beginPitchDrag"
        @pointermove="movePitchDrag"
        @pointerup="endPitchDrag"
        @pointercancel="endPitchDrag"
        @mouseup="onBookMouseup"
      >
        <div class="real-book-spread">
          <!-- 书下投影：让书体有落地的重量，而不是浮在底色上 -->
          <div class="real-book-shadow" aria-hidden="true"></div>
          <!-- 硬壳封面：左右两块沿书脊轴掀起，只从纸页外缘露出一圈包边。
               没有这层，页面再卷也只是两张纸，读不出「一本装订好的书」。 -->
          <div class="real-book-board real-book-board-left" aria-hidden="true"></div>
          <div class="real-book-board real-book-board-right" aria-hidden="true"></div>
          <!-- 书厚：左半是已读、右半是剩余，层数之和恒定，厚度随阅读进度从右往左转移。
               零层的半边连块都不渲染，免得只剩一块空纸板。 -->
          <div v-if="leftBlockLayers.length" class="real-book-block real-book-block-left" aria-hidden="true">
            <span class="real-book-block-top"></span>
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
            <span class="real-book-block-top"></span>
            <i
              v-for="layer in rightBlockLayers"
              :key="layer.index"
              :style="{
                transform: `translate3d(0, ${layer.translateY}px, ${layer.translateZ}px)`,
                opacity: String(layer.opacity),
              }"
            ></i>
          </div>
          <section :class="['real-book-page', 'real-book-left', { 'has-valley-strips': ENABLE_VALLEY_STRIPS && leftValleySlices.length }]" aria-label="左页">
            <header class="real-book-page-head">{{ chapterTitle }}</header>
            <div class="real-book-page-body">
              <div v-if="!leftViewPieces.length" class="real-book-empty">书页已到开头</div>
              <template v-for="piece in leftViewPieces" :key="piece.key">
                <p
                  v-if="piece.kind === 'text'"
                  class="real-book-para"
                  :data-p="piece.original"
                  :class="{ 'para-continued': piece.continued }"
                ><template v-for="(s, j) in piece.segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
                <aside
                  v-else
                  :class="['real-book-note', handwritingNoteClass, { 'is-ai': piece.note.source === 'ai' }]"
                  :data-note-id="piece.note.id"
                  role="button"
                  tabindex="0"
                  :aria-label="`编辑批注：${piece.note.text}`"
                  @click.stop="emit('edit-note', piece.note.id)"
                  @mouseup.stop
                  @keydown.enter.stop.prevent="emit('edit-note', piece.note.id)"
                  @keydown.space.stop.prevent="emit('edit-note', piece.note.id)"
                >
                  <span class="real-book-note-label">批注<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                  <span class="real-book-note-text">{{ piece.note.text }}</span>
                </aside>
              </template>
            </div>
            <footer class="real-book-page-foot">{{ leftPageNumber || '' }}</footer>
            <div class="real-book-page-cast" aria-hidden="true"></div>
            <!-- 视觉谷竖带层：文字随书脊弧面弯曲，不可交互、不带 data-p -->
            <div v-if="ENABLE_VALLEY_STRIPS && leftValleySlices.length" class="real-book-valley-layer" aria-hidden="true">
              <div
                v-for="slice in leftValleySlices"
                :key="`l-slice-${slice.index}`"
                class="real-book-valley-slice"
                :style="slice.style"
              >
                <div class="real-book-valley-window">
                  <div class="real-book-valley-content" :style="slice.contentStyle">
                    <header class="real-book-valley-head">{{ chapterTitle }}</header>
                    <div class="real-book-valley-body">
                      <div v-if="!leftViewPieces.length" class="real-book-empty">书页已到开头</div>
                      <template v-for="piece in leftViewPieces" :key="`lv-${piece.key}`">
                        <p
                          v-if="piece.kind === 'text'"
                          class="real-book-valley-para"
                          :class="{ 'para-continued': piece.continued }"
                        ><template v-for="(s, j) in piece.segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
                        <aside
                          v-else
                          :class="['real-book-note', handwritingNoteClass, { 'is-ai': piece.note.source === 'ai' }]"
                        >
                          <span class="real-book-note-label">批注<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                          <span class="real-book-note-text">{{ piece.note.text }}</span>
                        </aside>
                      </template>
                    </div>
                    <footer class="real-book-valley-foot">{{ leftPageNumber || '' }}</footer>
                  </div>
                </div>
              </div>
            </div>
            <!-- 翻动页投在这一页上的影子 -->
            <span
              v-if="flipping"
              class="real-book-cast"
              :style="{ opacity: String(flipCast.left), '--rb-cast-width': `${flipCast.leftWidth.toFixed(1)}%` }"
              aria-hidden="true"
            ></span>
          </section>

          <div class="real-book-gutter" aria-hidden="true">
            <span class="real-book-fold-bridge"></span>
          </div>

          <section :class="['real-book-page', 'real-book-right', { 'has-valley-strips': ENABLE_VALLEY_STRIPS && rightValleySlices.length }]" aria-label="右页">
            <header class="real-book-page-head">{{ chapterTitle }}</header>
            <div class="real-book-page-body">
              <div v-if="!rightViewPieces.length" class="real-book-empty">本章没有正文了</div>
              <template v-for="piece in rightViewPieces" :key="piece.key">
                <p
                  v-if="piece.kind === 'text'"
                  class="real-book-para"
                  :data-p="piece.original"
                  :class="{ 'para-continued': piece.continued }"
                ><template v-for="(s, j) in piece.segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
                <aside
                  v-else
                  :class="['real-book-note', handwritingNoteClass, { 'is-ai': piece.note.source === 'ai' }]"
                  :data-note-id="piece.note.id"
                  role="button"
                  tabindex="0"
                  :aria-label="`编辑批注：${piece.note.text}`"
                  @click.stop="emit('edit-note', piece.note.id)"
                  @mouseup.stop
                  @keydown.enter.stop.prevent="emit('edit-note', piece.note.id)"
                  @keydown.space.stop.prevent="emit('edit-note', piece.note.id)"
                >
                  <span class="real-book-note-label">批注<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                  <span class="real-book-note-text">{{ piece.note.text }}</span>
                </aside>
              </template>
            </div>
            <footer class="real-book-page-foot">{{ rightPageNumber || '' }}</footer>
            <div class="real-book-page-cast" aria-hidden="true"></div>
            <!-- 视觉谷竖带层：文字随书脊弧面弯曲，不可交互、不带 data-p -->
            <div v-if="ENABLE_VALLEY_STRIPS && rightValleySlices.length" class="real-book-valley-layer" aria-hidden="true">
              <div
                v-for="slice in rightValleySlices"
                :key="`r-slice-${slice.index}`"
                class="real-book-valley-slice"
                :style="slice.style"
              >
                <div class="real-book-valley-window">
                  <div class="real-book-valley-content" :style="slice.contentStyle">
                    <header class="real-book-valley-head">{{ chapterTitle }}</header>
                    <div class="real-book-valley-body">
                      <div v-if="!rightViewPieces.length" class="real-book-empty">本章没有正文了</div>
                      <template v-for="piece in rightViewPieces" :key="`rv-${piece.key}`">
                        <p
                          v-if="piece.kind === 'text'"
                          class="real-book-valley-para"
                          :class="{ 'para-continued': piece.continued }"
                        ><template v-for="(s, j) in piece.segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
                        <aside
                          v-else
                          :class="['real-book-note', handwritingNoteClass, { 'is-ai': piece.note.source === 'ai' }]"
                        >
                          <span class="real-book-note-label">批注<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                          <span class="real-book-note-text">{{ piece.note.text }}</span>
                        </aside>
                      </template>
                    </div>
                    <footer class="real-book-valley-foot">{{ rightPageNumber || '' }}</footer>
                  </div>
                </div>
              </div>
            </div>
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
              left: flipping.direction === 1
                ? `calc(50% + ${FLIP_ANCHOR_OFFSET_PX}px)`
                : `calc(50% - ${FLIP_ANCHOR_OFFSET_PX}px)`,
              transform: `translateZ(${flipSheetState.lift.toFixed(2)}px) rotateX(${(-flipSheetState.tilt).toFixed(2)}deg) rotateZ(${flipSheetState.roll.toFixed(2)}deg)`,
            }"
            aria-hidden="true"
          >
            <div
              v-for="slice in flipSlices"
              :key="`slice-${slice.index}`"
              :class="['real-book-flip-slice', { 'is-outer': slice.index === flipSlices.length - 1 }]"
              :style="slice.style"
            >
              <div class="real-book-flip-face real-book-flip-front" v-if="slice.showFront">
                <div class="real-book-flip-window">
                  <div class="real-book-flip-content" :style="slice.contentStyle">
                  <header class="real-book-page-head">{{ chapterTitle }}</header>
                  <div class="real-book-page-body">
                    <template v-for="piece in flipSheetPieces" :key="`front-${piece.key}`">
                      <p
                        v-if="piece.kind === 'text'"
                        class="real-book-para"
                        :data-p="piece.original"
                      ><template v-for="(s, j) in piece.segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
                      <aside
                        v-else
                        :class="['real-book-note', handwritingNoteClass, { 'is-ai': piece.note.source === 'ai' }]"
                        :data-note-id="piece.note.id"
                      >
                        <span class="real-book-note-label">批注<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                        <span class="real-book-note-text">{{ piece.note.text }}</span>
                      </aside>
                    </template>
                  </div>
                  <footer class="real-book-page-foot">{{ flipSheetPageNumber || '' }}</footer>
                  </div>
                </div>
              </div>
              <!-- 纸背：转过 90° 后显示同一张纸的另一面（落地页）。 -->
              <div class="real-book-flip-face real-book-flip-back" v-if="slice.showBack">
                <div class="real-book-flip-window">
                  <div class="real-book-flip-content" :style="slice.backContentStyle">
                    <header class="real-book-page-head">{{ chapterTitle }}</header>
                    <div class="real-book-page-body">
                      <template v-for="piece in flipBackPieces" :key="`back-${piece.key}`">
                        <p
                          v-if="piece.kind === 'text'"
                          class="real-book-para"
                          :data-p="piece.original"
                        ><template v-for="(s, j) in piece.segs" :key="j"><mark v-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
                        <aside
                          v-else
                          :class="['real-book-note', handwritingNoteClass, { 'is-ai': piece.note.source === 'ai' }]"
                          :data-note-id="piece.note.id"
                        >
                          <span class="real-book-note-label">批注<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                          <span class="real-book-note-text">{{ piece.note.text }}</span>
                        </aside>
                      </template>
                    </div>
                    <footer class="real-book-page-foot">{{ flipBackPageNumber || '' }}</footer>
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
  /* 桌边收窄：把省下来的空间还给书页（阅读面积优先）。 */
  padding: 10px 14px 18px;
  background: var(--reader-outer, #e9e3d7);
  color: var(--reader-paper-text, #2f2a24);
  /* 纸的三层色：暖底、受光面、暖阴影。
     三层都从主题纸色派生，所以夜间主题下纸仍然是深色的，不会被暖色洗白。
     真实书页不是纯白：它是带一点黄的老纸色，纸背比纸面更暗更黄。 */
  --rb-paper-warm: color-mix(in srgb, var(--reader-paper, #f7f3e8) 72%, #d7a56c);
  --rb-paper-lit: color-mix(in srgb, var(--reader-paper, #f7f3e8) 78%, #fff0c9);
  --rb-paper-shade: color-mix(in srgb, var(--reader-paper, #f7f3e8) 76%, #6b4b27);
  /* 封面色固定为一套深暖皮壳：它不与纸色联动，夜间主题才不会把封面洗成浅灰。 */
  --rb-cover-lit: #6a4a30;
  --rb-cover-mid: #452e1e;
  --rb-cover-deep: #24150d;
  /* 纸垛的切口、折缝与书心的暗色：比纸自身的暖阴影深一档。
     纸的暖阴影是「纸的暗面」，折缝是纸弯下去被遮住的那一面，
     必须更深才读得出谷，否则整本书读成两块平贴的纸板。 */
  --rb-fold-shadow: 58 36 16;
  /* 页内批注：墨色跟着主题变亮/变深，底色仍从纸色派生，夜里不会出现一张白卡。 */
  --rb-note-ink: color-mix(in srgb, #a34230 62%, var(--reader-paper-text, #2f2a24));
  --rb-note-line: color-mix(in srgb, #a34230 44%, transparent);
  --rb-note-bg: color-mix(in srgb, var(--rb-paper-lit) 64%, transparent);
}

/* 书台：书摊在一张深色桌面上。
   设计图里暖奶油色的纸是压在深色桌布上的——深底把纸的厚度、弧度与投影
   托了出来；浅底上摊开的书只是一块浅色矩形，读不出「一本有厚度的书」。 */
.real-book-stage:not(.is-sheet) {
  background:
    /* 桌面不是一块纯色：低对比布纹 + 中央柔光 + 四周暗角，
       把书从「放在色块上」变成「放在有反射的桌面上」。 */
    radial-gradient(70% 58% at 50% 36%, rgba(148, 104, 62, 0.18), transparent 72%),
    repeating-linear-gradient(96deg, rgba(255, 229, 190, 0.018) 0 1px, transparent 1px 5px),
    repeating-linear-gradient(7deg, rgba(0, 0, 0, 0.02) 0 2px, transparent 2px 11px),
    radial-gradient(
      120% 96% at 50% 24%,
      #4a3420 0%,
      #352215 58%,
      #22150c 100%
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

/* 批注量测区：与真实卡片同一套宽度、字体与三行截断，只把高度交给分页器。 */
.real-book-note-measure {
  position: absolute;
  left: -100000px;
  top: 0;
  visibility: hidden;
  pointer-events: none;
  font-size: var(--rb-font-size);
  line-height: var(--rb-line-height);
  font-family: var(--rb-font-family);
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
.real-book-note-toggle.is-active {
  border-color: rgba(242, 216, 135, 0.4);
  background: rgba(242, 216, 135, 0.14);
  color: #f2d887;
}

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
  border-radius: 10px 3px 8px 4px;
  /* 纸页自身几乎不投影：它压在书垛与封面上，真正的重量由书下投影表达。
     这里只留一道极薄的纸边暗线，避免纸页像贴纸一样浮起来。 */
  box-shadow:
    0 1px 1px rgba(30, 22, 12, 0.12),
    inset 0 1px 0 rgba(255, 250, 234, 0.32);
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
      color-mix(in srgb, var(--rb-paper-lit) 86%, transparent) 0%,
      color-mix(in srgb, var(--rb-paper-lit) 28%, transparent) 10%,
      transparent 32%,
      transparent 84%,
      color-mix(in srgb, var(--rb-paper-shade) 22%, transparent) 95%,
      color-mix(in srgb, var(--rb-paper-shade) 52%, transparent) 100%
    ),
    radial-gradient(
      115% 86% at 42% 10%,
      color-mix(in srgb, var(--rb-paper-lit) 48%, transparent),
      transparent 64%
    ),
    radial-gradient(
      72% 62% at 88% 88%,
      color-mix(in srgb, var(--rb-paper-shade) 14%, transparent),
      transparent 72%
    ),
    var(--rb-page-curve, none);
  color: var(--reader-paper-text, #2f2a24);
  font-size: var(--rb-font-size);
  line-height: var(--rb-line-height);
  font-family: var(--rb-font-family);
  text-align: justify;
  font-kerning: normal;
  text-rendering: optimizeLegibility;
}

/* 正文与页眉页脚压在纸纹之上：纤维只做纸的背景，不糊字。 */
.real-book-page > * {
  position: relative;
  z-index: 2;
}

/* 纸纹：三组不同尺度的纤维与斑点。全部由 CSS 生成，不加载贴图，
   缩放与夜间主题都不会出现位图拉伸或发灰。 */
.real-book-page::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  opacity: 0.6;
  background-image:
    repeating-linear-gradient(93deg, rgba(78, 51, 24, 0.012) 0 1px, transparent 1px 5px),
    repeating-linear-gradient(3deg, rgba(255, 252, 238, 0.02) 0 1px, transparent 1px 8px),
    radial-gradient(circle at 3px 4px, rgba(72, 45, 20, 0.032) 0 0.55px, transparent 0.9px),
    radial-gradient(circle at 11px 13px, rgba(255, 250, 235, 0.045) 0 0.55px, transparent 0.9px);
  background-size: auto, auto, 17px 19px, 23px 29px;
}

/* 外书口不是裁纸刀切出来的直边：极窄的深浅断续线给纸边一点手工裁切感。
   它被放在正文内边距里，不会压到字。 */
.real-book-page::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 3;
  width: 3px;
  pointer-events: none;
  opacity: 0.7;
  background:
    repeating-linear-gradient(
      180deg,
      rgba(255, 250, 234, 0.28) 0 1px,
      rgba(100, 68, 34, 0.06) 1px 2px,
      transparent 2px 7px,
      rgba(100, 68, 34, 0.04) 7px 8px
    );
}

.real-book-left::before {
  left: 0;
  border-radius: 10px 0 0 8px;
}

.real-book-right::before {
  right: 0;
  border-radius: 0 3px 4px 0;
}

/* 页眉：章节眉题。必须单行省略——占高是排版输入，不能随标题长短变。
   居中：设计图里的页眉是骑在版心上方的眉题，左右对齐读成正文标题。 */
.real-book-page-head {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: center;
  font-size: 0.72em;
  letter-spacing: 0.085em;
  color: color-mix(in srgb, var(--reader-paper-text, #2f2a24) 45%, transparent);
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
  letter-spacing: 0.04em;
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
  /* alpha 0.16 × JS max(0.12/0.15) ≈ net 0.02–0.024 */
  background: color-mix(in srgb, rgba(58, 36, 16, 0.16) var(--rb-cast-width, 12%), transparent);
}

.real-book-left .real-book-cast {
  background: color-mix(in srgb, rgba(58, 36, 16, 0.16) var(--rb-cast-width, 12%), transparent);
}

/* V 形摊开：两页以书脊为轴向外掀起，外侧先靠近观者，透视下因此向书脊收拢。
   这是「摊开的书」和「两个并排矩形」的全部区别，扭转量只走 3D 变换、不动排版。 */
.real-book-left {
  border-radius: 10px 2px 9px 2px;
  /* 靠脊不再压暗：中间只留纸面本身与一条极浅折缝，避免书心出现黑带。 */
  box-shadow: inset 0 1px 0 rgba(255, 250, 234, 0.3);
  transform-origin: right center;
  transform: rotateY(var(--rb-bend, 0deg));
  /* 靠脊一侧（右缘）压入一层暖色暗部：纸向折缝弯下去时，内侧先落入阴影，
     宽度约占页宽 8–12%，强度约 15%，只用纸的暖阴影色，不用纯黑。
     暗部外侧再补一段滚出的高光（12%–22%）：纸从谷里翻出来时接住光，
     有了这层「暗—亮」的连续过渡，折缝才读成圆弧而不是一刀切开的直角。 */
  --rb-page-curve: linear-gradient(
    270deg,
    color-mix(in srgb, var(--rb-paper-shade) 15%, transparent) 0%,
    color-mix(in srgb, var(--rb-paper-shade) 9%, transparent) 4%,
    color-mix(in srgb, var(--rb-paper-shade) 3%, transparent) 8%,
    transparent 11%,
    color-mix(in srgb, var(--rb-paper-lit) 11%, transparent) 15%,
    color-mix(in srgb, var(--rb-paper-lit) 4%, transparent) 22%,
    transparent 29%,
    color-mix(in srgb, var(--rb-paper-lit) 5%, transparent) 92%,
    color-mix(in srgb, var(--rb-paper-lit) 12%, transparent) 100%
  );
}

.real-book-right {
  border-radius: 2px 10px 2px 9px;
  box-shadow: inset 0 1px 0 rgba(255, 250, 234, 0.3);
  transform-origin: left center;
  transform: rotateY(calc(-1 * var(--rb-bend, 0deg)));
  /* 右页靠脊一侧（左缘）同样压入暖色暗部与滚出高光，与左页镜像对称。 */
  --rb-page-curve: linear-gradient(
    90deg,
    color-mix(in srgb, var(--rb-paper-shade) 15%, transparent) 0%,
    color-mix(in srgb, var(--rb-paper-shade) 9%, transparent) 4%,
    color-mix(in srgb, var(--rb-paper-shade) 3%, transparent) 8%,
    transparent 11%,
    color-mix(in srgb, var(--rb-paper-lit) 11%, transparent) 15%,
    color-mix(in srgb, var(--rb-paper-lit) 4%, transparent) 22%,
    transparent 29%,
    color-mix(in srgb, var(--rb-paper-lit) 5%, transparent) 92%,
    color-mix(in srgb, var(--rb-paper-lit) 12%, transparent) 100%
  );
}

/* 书心不占宽度：左右页的装订边直接落在中心线上。
   折缝的谷影画在两页之上，宽度只有 30px（每页 15px），把硬折读成一条圆弧。 */
.real-book-gutter {
  position: relative;
  width: 0;
  margin: 0;
  background: none;
  box-shadow: none;
  z-index: 3;
}

/* 折缝的谷影：两页在书脊处形成一个谷，谷底最暗，谷壁接光。
   这层画在两页之上、宽度只有 30px（每页 15px），把硬折读成一条圆弧；
   宽度受控就不会变成一条贯穿的黑缝。 */
.real-book-gutter::before {
  display: none;
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -15px;
  right: -15px;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--rb-paper-shade) 8%, transparent) 26%,
    color-mix(in srgb, var(--rb-paper-shade) 20%, transparent) 50%,
    color-mix(in srgb, var(--rb-paper-shade) 8%, transparent) 74%,
    transparent 100%
  );
}

/* 折缝的桥：书脊处那条把左右两页连起来的弯折纸面。
   两页各自绕中线转 9°，交界的内缘本是一道尖角；这道桥盖住尖角，
   画出纸从一页弯到另一页的那段圆弧——谷底最暗、两侧转亮，
   于是书脊读成连续弯下去的纸，而不是两张平贴的纸板。 */
.real-book-fold-bridge {
  display: none;
  position: absolute;
  top: -1px;
  bottom: -1px;
  left: -13px;
  width: 26px;
  pointer-events: none;
  /* 圆弧桥：左右两侧的边缘是纸翻过去时的高光，中间是谷底。
     宽度只有 26px，遮住的正是两页内缘那道 9° 硬折的交线。 */
  border-radius: 46% 46% 46% 46% / 3% 3% 3% 3%;
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--rb-paper-lit) 26%, transparent) 0%,
      color-mix(in srgb, var(--rb-paper-shade) 22%, transparent) 34%,
      color-mix(in srgb, var(--rb-paper-shade) 34%, transparent) 50%,
      color-mix(in srgb, var(--rb-paper-shade) 22%, transparent) 66%,
      color-mix(in srgb, var(--rb-paper-lit) 26%, transparent) 100%
    );
  /* 桥两侧的落影：纸离开谷底时在两侧各留一道细影，
     圆弧才有厚度，而不是一条画上去的线。 */
  box-shadow:
    -1px 0 3px rgba(58, 36, 16, 0.22),
    1px 0 3px rgba(58, 36, 16, 0.22);
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
  height: calc(58px + var(--rb-lift, 0px) * 0.8);
  /* 三层影：贴着纸垛的接触暗影、向左右摊开的柔影、向桌面深处拖长的投影。 */
  background:
    radial-gradient(50% 46% at 50% 0%, rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0) 76%),
    radial-gradient(72% 80% at 50% 16%, rgba(0, 0, 0, 0.25), rgba(0, 0, 0, 0) 72%),
    radial-gradient(94% 96% at 50% 30%, rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0) 78%);
  filter: blur(calc(14px + var(--rb-lift, 0px) * 0.5));
  opacity: calc(1 - var(--rb-lift, 0px) * 0.018);
  pointer-events: none;
}

/* 硬壳封面：比纸页每边多出几像素。它藏在纸页之下（translateZ 为负），
   只从外缘露一圈深色皮壳、压印线与厚度高光，页面本身仍是主角。
   两块封面各自跟随本半页的 V 形折角，避免书脊处翘出一条平直的黑边。 */
.real-book-board {
  position: absolute;
  top: -7px;
  width: calc(var(--rb-page-width) + 8px);
  height: calc(var(--rb-page-height) + 14px);
  border-radius: 13px 4px 10px 5px;
  background:
    linear-gradient(180deg, rgba(255, 222, 174, 0.12), transparent 12%, transparent 86%, rgba(0, 0, 0, 0.24)),
    repeating-linear-gradient(96deg, rgba(255, 224, 184, 0.025) 0 1px, transparent 1px 4px),
    linear-gradient(180deg, var(--rb-cover-lit), var(--rb-cover-mid) 42%, var(--rb-cover-deep));
  box-shadow:
    inset 0 0 0 1px rgba(255, 226, 184, 0.14),
    inset 0 0 0 4px rgba(0, 0, 0, 0.08),
    inset 0 1px 0 rgba(255, 238, 205, 0.18),
    0 8px 18px rgba(14, 8, 4, 0.3);
  transform-style: preserve-3d;
  pointer-events: none;
}

.real-book-board::after {
  content: '';
  position: absolute;
  inset: 5px;
  border: 1px solid rgba(235, 199, 145, 0.16);
  border-radius: 9px 2px 7px 3px;
  box-shadow: 0 0 0 1px rgba(20, 12, 7, 0.18);
  pointer-events: none;
}

.real-book-board-left {
  left: -8px;
  transform-origin: right center;
  transform: rotateY(var(--rb-bend, 0deg)) translateZ(-10px);
}

.real-book-board-right {
  right: -8px;
  transform-origin: left center;
  transform: rotateY(calc(-1 * var(--rb-bend, 0deg))) translateZ(-10px);
  border-radius: 4px 13px 5px 10px;
}

.real-book-board-right::after {
  border-radius: 2px 9px 3px 7px;
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
  box-shadow: inset 0 2px 3px -1px rgba(58, 36, 16, 0.25);
  background:
    /* 切口是**暖的**：一层层纸叠在一起的断面，每层之间压一道暖影。 */
    linear-gradient(180deg, rgba(58, 36, 16, 0.44), rgba(58, 36, 16, 0.04) 18%, rgba(58, 36, 16, 0.2) 66%, rgba(58, 36, 16, 0.42)),
    repeating-linear-gradient(
      180deg,
      color-mix(in srgb, var(--rb-paper-warm) 50%, #67451e) 0 1px,
      color-mix(in srgb, var(--rb-paper-warm) 88%, #f4e8ca) 1px 2.1px,
      color-mix(in srgb, var(--rb-paper-warm) 70%, #8b6434) 2.1px 2.6px
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
    linear-gradient(90deg, rgba(58, 36, 16, 0.52), rgba(58, 36, 16, 0.05) 44%, rgba(58, 36, 16, 0.22)),
    /* 逐张纸的边：竖着的细纹，一层层数得出来。
       这一面是**侧着**看的书口，看到的是一页叠一页的厚度，
       所以纹路要竖着走（沿进深方向分���层），不是一道道横线。 */
    repeating-linear-gradient(
      90deg,
      color-mix(in srgb, var(--rb-paper-warm) 52%, #5b401e) 0 0.9px,
      color-mix(in srgb, var(--rb-paper-warm) 86%, #f0e1bf) 0.9px 2.4px,
      color-mix(in srgb, var(--rb-paper-warm) 72%, #8c6738) 2.4px 2.9px
    );
}

.real-book-block-right::after {
  left: auto;
  right: 0;
  transform-origin: right center;
  transform: rotateY(-90deg);
  border-radius: 3px 0 0 3px;
}

/* 上切口：书页顶端那一面。它和底切口使用同一套纸层线，
   只是绕页顶向后倒过去；没有它，俯看时书的上缘仍是一条剪纸边。 */
.real-book-block-top {
  position: absolute;
  top: calc(-1 * var(--rb-page-height));
  left: 0;
  right: 0;
  height: max(1px, var(--rb-block-h, 0px));
  transform-origin: center bottom;
  transform: rotateX(60deg);
  border-radius: 3px 3px 0 0;
  background:
    linear-gradient(180deg, rgba(255, 247, 224, 0.13), rgba(58, 36, 16, 0.1) 24%, rgba(58, 36, 16, 0.34)),
    repeating-linear-gradient(
      90deg,
      color-mix(in srgb, var(--rb-paper-warm) 52%, #5b401e) 0 0.9px,
      color-mix(in srgb, var(--rb-paper-warm) 88%, #f1e3c4) 0.9px 2.3px,
      color-mix(in srgb, var(--rb-paper-warm) 74%, #8c6738) 2.3px 2.8px
    );
  box-shadow:
    inset 0 1px 0 rgba(255, 245, 218, 0.22),
    inset 0 -1px 2px rgba(50, 31, 14, 0.3);
}

/* 逐层纸边：每层沿页脚向下、向后错开一点，叠成数得清层数的纸摞。 */
.real-book-block i {
  position: absolute;
  left: 1px;
  right: 1px;
  height: 2px;
  border-radius: 0 0 2px 2px;
  /* 纸边比纸面略深：从暖纸色里压出来，四套主题下都不会发灰或发紫。 */
  background: color-mix(in srgb, var(--rb-paper-warm) 76%, #7a5a30);
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--reader-paper-text, #2f2a24) 10%, transparent),
    0 -1px 0 rgba(255, 245, 220, 0.08);
}

.real-book-para {
  margin: 0 0 0.45em;
  text-indent: 2em;
}

.real-book-para.para-continued {
  text-indent: 0;
}

/*
 * 页内批注：像读者用铅笔写在段落下面的旁批。
 * 卡片高度由三行截断固定，完整内容在点击后的编辑浮层里看。
 */
.real-book-note {
  display: block;
  margin: 0;
  padding: 0.42em 0.68em 0.5em;
  border-left: 2px solid var(--rb-note-line, #a34230);
  border-radius: 2px 6px 6px 2px;
  background: var(--rb-note-bg, rgba(255, 240, 201, 0.24));
  color: var(--rb-note-ink, #9c3f2f);
  font-size: 0.8em;
  line-height: 1.5;
  text-align: left;
  text-indent: 0;
  cursor: pointer;
  user-select: none;
}

.real-book-note + .real-book-note {
  margin-top: 8px;
}

.real-book-note:focus-visible {
  outline: 2px solid var(--r-focus, #2f7fd0);
  outline-offset: 2px;
}

.real-book-note-label {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  margin-bottom: 0.18em;
  font-size: 0.78em;
  letter-spacing: 0.08em;
  opacity: 0.72;
}

.real-book-note-source {
  padding: 0 0.35em;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 0.86em;
  letter-spacing: 0;
  line-height: 1.35;
}

.real-book-note-text {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.real-book-note.handwriting-kai { font-family: 'KaiTi', '楷体', serif; }
.real-book-note.handwriting-xingshu { font-family: 'STXingkai', '华文行楷', 'KaiTi', serif; }

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
  /* 每条带是独立的裁剪+3D 变换层：把布局与重绘范围关在带内，
     翻页时不会互相触发整页重排。 */
  contain: layout paint style;
  /* 逐帧只改 transform/clip-path：提升为独立合成层，避免每帧重画带内正文。 */
  will-change: transform;
}

/* 纸页外缘的一线受光：它跟着裁切后的弧边一起走，让最外侧那几条带读成
   一张纸的边，而不是一排刚好齐平的矩形。 */
.real-book-flip-slice.is-outer::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 2px;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 248, 230, 0.24) 55%,
    rgba(96, 63, 30, 0.08)
  );
  box-shadow: -1px 0 2px rgba(255, 250, 238, 0.12);
  pointer-events: none;
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
}

/* 正面停画的兜底只落在正面：带子转过 90° 后 `--rb-flip-side` 为 0，正面整层停画。
   不这样做时，侧过去的那半张仍按 opacity 叠在下方页面上，看起来像整页残影。

   绝不能写成不限面的 `.real-book-flip-content`：纸背可见时同一条带上的
   `--rb-flip-side` 正好是 0，那条规则会连纸背正文一起清零，纸上就只剩一条空白纸带。
   纸背的可见度由 `flipBackContentOpacity` 通过内联 opacity 下发（见 flipSlices）。 */
.real-book-flip-front .real-book-flip-content {
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
    );
}

/* 背面：与正面共面，靠 JS 显隐互斥（见 flipSlices 的 showFront / showBack），
   所以同一条带上永远只有一面挂载——正反两面的字不会叠在同一块纸上。
   不给背面加 rotateY(180deg)：那层带着 3D 变换时窗格裁剪会失效，
   整页正文会从窄缝里整片漏出来且方向是镜像的。

   背面印的是落定后的那一页（flipBackPieces），方向靠内容层的 scaleX(-1) 预翻，
   可见度由 flipBackContentOpacity 逐帧下发：转过 90° 时接在正面那层薄字上，
   再随纸转平升到全显。纸背与正面同一种纸色。 */
.real-book-flip-back {
  backface-visibility: visible;
}

/* 静态书页具有 3D 变换上下文，使得谷竖带在 3D 空间内沿书脊下弯 */
.real-book-page {
  transform-style: preserve-3d;
}

.real-book-page.has-valley-strips {
  overflow: visible;
}

.real-book-page.has-valley-strips > .real-book-page-head,
.real-book-page.has-valley-strips > .real-book-page-body,
.real-book-page.has-valley-strips > .real-book-page-foot {
  opacity: 0 !important;
}

.real-book-page.has-valley-strips > .real-book-page-body .real-book-note {
  opacity: 0 !important;
}

.real-book-page.has-valley-strips > .real-book-page-body mark {
  opacity: 0 !important;
}

/* 谷区延伸：整页纸底由竖带层提供，原页不再画任何纸面。 */
.real-book-page.has-valley-strips .real-book-page-cast,
.real-book-right.has-valley-strips::before,
.real-book-left.has-valley-strips::before {
  display: none;
}

.real-book-valley-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  user-select: none;
  transform-style: preserve-3d;
  z-index: 4;
}

.real-book-valley-slice {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  transform-style: flat;
  overflow: hidden;
  contain: layout paint style;
  will-change: transform;
}

.real-book-valley-window {
  position: absolute;
  inset: 0;
}

.real-book-valley-content {
  height: 100%;
  padding: var(--rb-pad-y) var(--rb-pad-x);
  box-sizing: border-box;
  display: grid;
  grid-template-rows: var(--rb-head-height) 1fr var(--rb-foot-height);
  /* 竖带自己就是纸：不画纸底的带一旦错位，漏出的就是桌面。 */
  background-color: var(--rb-paper-warm);
  background-image: linear-gradient(
    180deg,
    color-mix(in srgb, var(--rb-paper-lit) 70%, transparent) 0%,
    transparent 14%,
    transparent 84%,
    color-mix(in srgb, var(--rb-paper-shade) 26%, transparent) 100%
  );
  color: var(--reader-paper-text, #2f2a24);
  font-size: var(--rb-font-size);
  line-height: var(--rb-line-height);
  font-family: var(--rb-font-family);
  text-align: justify;
  font-kerning: normal;
  text-rendering: optimizeLegibility;
}

.real-book-valley-head {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: center;
  font-size: 0.72em;
  letter-spacing: 0.085em;
  color: color-mix(in srgb, var(--reader-paper-text, #2f2a24) 45%, transparent);
  padding-bottom: 0.3em;
}

.real-book-valley-body {
  min-height: 0;
  overflow: hidden;
}

.real-book-valley-para {
  margin: 0 0 0.45em;
  text-indent: 2em;
}

.real-book-valley-para.para-continued {
  text-indent: 0;
}

.real-book-valley-foot {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  font-size: 0.7em;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--reader-paper-text, #2f2a24) 45%, transparent);
  padding-top: 0.3em;
}

@media (prefers-reduced-motion: reduce) {
  .real-book-book { transition: none !important; }
}
</style>
