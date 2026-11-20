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
import type { ReaderHandwritingFont, ReaderTheme } from '@shared/types'
import { chapterImageHeight, parseChapterImage } from '@shared/chapterImages'
import {
  createRealBookPaginator,
  findPageForInput,
  pageRatio,
  type RealBookAnchor,
  type RealBookLine,
  type RealBookNoteBlock,
  type RealBookPage,
} from './realBookPager'
import {
  decorateTextWithNotes,
  estimateInlineNoteHeight,
  INLINE_NOTE_GAP_PX,
  type NoteTextMark,
  type NoteTextPart,
  type RealBookNote,
} from './realBookNotes'
import { spineLayers, spineStack, spineTotalLayers } from './realBookSpine'
import { measureLines } from './realBookMeasure'
import { clampPitch, MAX_PITCH_DEG, MAX_TILT_DEG, pitchFromDrag, pitchResetTarget, TILT_SENSITIVITY } from './realBookPitch'
import { flyerPageIndexes } from './realBookFlyerText'
import { FLIP_DURATION_MS, flipAngles, flipBackContentOpacity, flipContentOpacity, flipFaceVisible, flipLight, flipPhases, flipPoses, flipSheetLift, flipSway } from './realBookFlip'
import RealBookWebGLStage from './RealBookWebGLStage.vue'
import type { RealBookSceneFlip } from './realBookWebGLScene'
import type { CrossSelectionRange } from './realBookCrossSelection'
import {
  PAGE_TEXTURE_HEIGHT,
  PAGE_TEXTURE_MARGIN_BOTTOM,
  PAGE_TEXTURE_MARGIN_INNER,
  PAGE_TEXTURE_MARGIN_OUTER,
  PAGE_TEXTURE_MARGIN_TOP,
  PAGE_TEXTURE_WIDTH,
  type RealBookTexturePage,
} from './realBookTexture'
import {
  DEFAULT_ZOOM as WEBGL_DEFAULT_ZOOM,
  MAX_ZOOM as WEBGL_MAX_ZOOM,
  MIN_ZOOM as WEBGL_MIN_ZOOM,
  type RealBookDesk,
  type RealBookEndpaper,
} from './realBookWebGLModel'

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
  /** 当前章的页内批注；书页模式和真实书籍模式共用 */
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
  /** 阅读主题：只影响拟物书页的纸色与桌面，不参与分页 */
  theme?: ReaderTheme
  /** 是否显示舞台内悬浮工具条（书台版式；Reader 的真实书籍底栏会接管这些控件） */
  showToolbar?: boolean
  /** 是否露出左上角圆形返回键：Reader 顶栏本身也有「书架」，顶栏展开时让位给它 */
  backVisible?: boolean
  /** 版式：`book` 是双页 3D 书台，`sheet` 是单张书页（书页模式）。 */
  variant?: 'book' | 'sheet'
  /** 书台渲染层：WebGL 复刻，CSS 3D 保留为回退。 */
  renderer?: 'css' | 'webgl'
  /** WebGL 桌面材质；CSS 3D 回退忽略。 */
  desk?: RealBookDesk
  /** WebGL 封内衬纸；CSS 3D 回退忽略。 */
  endpaper?: RealBookEndpaper
  /** 合上时的封面书名与作者。 */
  bookTitle?: string
  bookAuthor?: string
  /** 书 id：章内图片按它拼 spbf-image:// 协议地址。 */
  bookId?: string
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
  theme: 'paper',
  showToolbar: true,
  backVisible: true,
  variant: 'book',
  renderer: 'css',
  desk: 'walnut',
  endpaper: 'ivory',
  bookTitle: '',
  bookAuthor: '',
  bookId: '',
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
  (event: 'update:zoom', zoom: number): void
  /** WebGL 开合状态：Reader 底栏据此切换“合上/打开书籍”图标。 */
  (event: 'update:open', open: boolean): void
  (event: 'update:show-notes', show: boolean): void
  (event: 'edit-note', noteId: string): void
  /** WebGL 跨页选择完成：两端是段落原始下标 + 段内偏移。 */
  (event: 'select-range', range: CrossSelectionRange): void
  (event: 'next-chapter'): void
  /** 左上角圆形返回键：回到书库 */
  (event: 'back'): void
}>()

/**
 * 真实书籍的专属色板：浅暖桌面 + 暖象牙纸 + 深灰绿布壳。
 *
 * 参考图是一张实拍感的书桌照：书摊在一张浅暖色桌面上，光从上方来，
 * 四周略沉、画面下缘压出一道暗带；纸页是偏暖的旧纸；封面只从纸页四边
 * 露出一圈深灰绿布壳。所以桌面取浅暖灰，不再用深色桌布。
 *
 * 夜间主题仍给深纸、深封面与近黑的桌面，保证暗环境阅读不刺眼。
 */
interface RealBookPalette {
  /** 纸身 */
  paper: string
  /** 受光面（纸心微亮） */
  lit: string
  /** 暖阴影（纸边与切口） */
  shade: string
  /** 桌面 */
  desk: string
  /** 桌面中央的柔光 */
  deskLit: string
  /** 画面下缘的暗带与四周压暗 */
  deskDeep: string
  /** 封面布壳 */
  cover: string
  /** 布壳受光面 */
  coverLit: string
  /** 布壳背光与包边 */
  coverDeep: string
}

const REALBOOK_PALETTE: Record<ReaderTheme, RealBookPalette> = {
  paper: {
    // 参考站纸色是偏灰的米白（受光后约 #EDD7BA），不是偏橙的牛皮纸；
    // 纹理底色要留出灯光乘色的余量，所以取比成品更亮、更不饱和的米白。
    paper: '#FAF1E1', lit: '#FFF9ED', shade: '#D8BE98',
    desk: '#C8B8A1', deskLit: '#DCCDB8', deskDeep: '#6C6255',
    cover: '#48554C', coverLit: '#58665B', coverDeep: '#2A332D',
  },
  sepia: {
    paper: '#F1D7A9', lit: '#FAECD3', shade: '#C0995F',
    desk: '#CBB79A', deskLit: '#E2CFAE', deskDeep: '#6E604D',
    cover: '#4C554B', coverLit: '#5D685A', coverDeep: '#2C332C',
  },
  gray: {
    paper: '#EEEDE7', lit: '#FAF9F4', shade: '#C2C1B7',
    desk: '#C7C4BD', deskLit: '#E0DCD5', deskDeep: '#6B6862',
    cover: '#4A5255', coverLit: '#5B6467', coverDeep: '#2A3133',
  },
  night: {
    paper: '#1B1D20', lit: '#24262A', shade: '#111317',
    desk: '#20241F', deskLit: '#2E332C', deskDeep: '#0B0E0C',
    cover: '#1D2521', coverLit: '#2A342E', coverDeep: '#0A0E0C',
  },
}

const realbookColors = computed<RealBookPalette>(() => REALBOOK_PALETTE[props.theme] ?? REALBOOK_PALETTE.paper)

const hostRef = ref<HTMLElement | null>(null)
const measureRef = ref<HTMLElement | null>(null)
const noteMeasureRef = ref<HTMLElement | null>(null)
/** 书页版式那张纸：分区翻页按它的横向位置算（纸面比舞台窄，用舞台会把纸外的桌面也算进去）。 */
const sheetRef = ref<HTMLElement | null>(null)
/** 书台版式的书体：分区按左右两页的实际位置算，而不是整个舞台。 */
const bookRef = ref<HTMLElement | null>(null)
const webglRef = ref<{
  paperEl?: HTMLElement | null
  setOpen: (open: boolean) => void
  toggleOpen: () => void
  setPitch: (value: number) => void
} | null>(null)
const webglFailed = ref(false)
const webglOpen = ref(true)
const effectiveRenderer = computed(() => props.variant === 'book' && props.renderer === 'webgl' && !webglFailed.value)
/** WebGL 用参考站的 62° 上限；CSS 3D 仍限 35° 以避免 DOM 正文被透视压糊。 */
const pitchLimit = computed(() => (effectiveRenderer.value ? MAX_TILT_DEG : MAX_PITCH_DEG))
/**
 * WebGL 用参考站的 0.4s quick 翻页；CSS 3D 保留 900ms 的纸页行程。
 * 早先 WebGL 是 1.5s，会把「翻一张纸」读成慢动作，连翻时更难分辨是第几张。
 */
const WEBGL_FLIP_DURATION_MS = 400
const flipDurationMs = computed(() => (effectiveRenderer.value ? WEBGL_FLIP_DURATION_MS : FLIP_DURATION_MS))
const currentPage = ref(0)
const defaultZoom = computed(() => (effectiveRenderer.value ? WEBGL_DEFAULT_ZOOM : 1))
const minZoom = computed(() => (effectiveRenderer.value ? WEBGL_MIN_ZOOM : 0.7))
const maxZoom = computed(() => (effectiveRenderer.value ? WEBGL_MAX_ZOOM : 1.8))
const zoom = ref(defaultZoom.value)
/** 窄屏单页：窗口宽度小于 768 或本机调试开关打开时启用。 */
const phone = ref(false)
/** 手机单页走参考站的固定 20px 档：桌面字号偏好（18→22）在窄屏上会把一页挤成两行。 */
const layoutFontSize = computed(() => (phone.value ? 20 : Math.max(1, props.fontSize)))
const forcePhone = (() => {
  try {
    return localStorage.getItem('spore:reader-realbook-phone:v1') === '1'
  } catch {
    return false
  }
})()
const pitchDragging = ref(false)
let pitchDragState: { startY: number; startPitch: number } | null = null
/**
 * 一次翻页：从哪一页起到哪一页落，进度自己走。
 *
 * 快速连按时会同时有好几张纸在飞，所以这里按「一张纸」而不是「一次翻页」记。
 * `from` 是起翻时所在的页，`to` 是这张纸落定后要提交的页；后起的纸从前一张的
 * `to` 接着数，整条链按顺序提交，页面内容就不会被后来的纸提前改写。
 */
interface FlipRun {
  id: number
  direction: 1 | -1
  from: number
  to: number
  progress: number
  /** 已经走过的时长（ms）。用累计而不是「开始时间戳」：rAF 的时间原点与 performance.now() 不一定同源。 */
  elapsed: number
  duration: number
  /** 拖页中：进度由手指写，rAF 不推进它。 */
  follow: boolean
  /** 拖页时手指在纸上的纵向位置（0–1，页顶为 0）：窄屏卷页的折线按它倾斜。 */
  grabV?: number
  pointerV?: number
  /**
   * 起纸那一刻的页快照（正反面）。翻页途中若页表重排（字体分片晚到、窗口缩放、
   * 划线/批注变化），页下标会整体挪位，甚至越界返回 null——那样飞页就成了白纸。
   * 纸既然已经从书上掀起来，就该一直印着掀起来时的内容，所以这里冻结快照。
   */
  front: RealBookTexturePage | null
  back: RealBookTexturePage | null
}
const flips = ref<FlipRun[]>([])
/** 同时在飞的纸上限：WebGL 场景有 6 个飞页槽位，CSS 3D 回退只有一张纸。 */
const MAX_RUNS_WEBGL = 6
const flipping = computed<{ direction: 1 | -1; key: number } | null>(() => {
  const head = flips.value[0]
  return head ? { direction: head.direction, key: head.id } : null
})
/** 翻页进度 0–1：驱动竖带卷曲与飞页，不参与任何排版计算。 */
const flipT = computed(() => flips.value[0]?.progress ?? 0)
/** 快速连按/连点时的翻页队列：超出同时在飞的上限才排队，最多 12 条。 */
const turnQueue = ref<(1 | -1)[]>([])
/** 俯仰拖拽是否真的拖过：拖过之后松手的那一下 mouseup 不能被当成点按（否则拖完角就翻页）。 */
let pitchDragged = false
const pages = shallowRef<RealBookPage[]>([])
let lastRevealToken = 0

let flipRaf = 0
let flipKey = 0
let observer: ResizeObserver | null = null

/** 版面尺寸：双页摊开，每页宽度取舞台的一半，页高按开本比例约束。 */
const layout = ref({ pageWidth: 480, pageHeight: 640, paddingX: 43, paddingY: 38, contentWidth: 420, contentHeight: 560 })
const lineHeightPx = computed(() => Math.max(1, layoutFontSize.value) * Math.max(0.5, props.lineHeight))
const paragraphGapPx = computed(() => Math.max(0, layoutFontSize.value) * Math.max(0, props.paragraphGap))
const handwritingNoteClass = computed(() => `handwriting-${props.handwritingFont}`)
/** 原始段落下标 → 段内「注」标记。批注关闭时不挂标记，和卡片一起消失。 */
const noteMarksByParagraph = computed(() => {
  const groups = new Map<number, NoteTextMark[]>()
  if (!props.showNotes) return groups
  for (const note of props.notes) {
    const list = groups.get(note.paragraph)
    if (list) list.push({ id: note.id, offset: note.offset })
    else groups.set(note.paragraph, [{ id: note.id, offset: note.offset }])
  }
  return groups
})
/** 书页模式的栏数与栏间距；栏间距跟着字号走，换字号不会把两栏挤到一起。 */
const pageColumns = computed(() => (props.columns === 2 ? 2 : 1))
const columnGapPx = computed(() => Math.round(Math.max(1, layoutFontSize.value) * 3))
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
const advance = computed(() => (props.variant === 'book' ? (phone.value ? 1 : 2) : pageStep.value))
/**
 * 页眉页脚占高（px）：它们是排版输入，必须参与页表签名。
 * 不传时按字号推导；显式传入主要是为了让签名可测——同一字号下改占高，页数必须变。
 */
const headHeightPx = computed(() => props.headHeight > 0
  ? Math.round(props.headHeight)
  : Math.round(Math.max(1, layoutFontSize.value) * 1.8))
const footHeightPx = computed(() => props.footHeight > 0
  ? Math.round(props.footHeight)
  : Math.round(Math.max(1, layoutFontSize.value) * 1.6))
/** 书页页脚放翻页按钮，比书台的页码占高得多，必须单独算进版心高度。 */
const sheetFootHeightPx = computed(() => props.footHeight > 0
  ? Math.round(props.footHeight)
  : Math.round(Math.max(1, layoutFontSize.value) * 3.2))

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true

/**
 * 纸面元素：书台版式是整个舞台，书页版式是那张纸。
 * 父组件按它的横向位置做三分区（左右翻页、中区显隐工具）。
 */
const paperEl = computed(() => {
  if (props.variant === 'sheet') return sheetRef.value
  if (effectiveRenderer.value) return webglRef.value?.paperEl ?? hostRef.value
  return bookRef.value ?? hostRef.value
})

const webglInk = computed(() => (props.theme === 'night' ? '#d8d1c4' : '#241c15'))
const webglMuted = computed(() => (props.theme === 'night' ? 'rgba(216,209,196,0.58)' : 'rgba(36,28,21,0.52)'))

const pitch = computed(() => clampPitch(localPitch.value, pitchLimit.value))

/**
 * 俯仰角的真源在组件内部；父组件的 pitch prop 只是「外部设定值」。
 *
 * 为什么不直接用 props.pitch 当真源：拖拽结束到父组件回传之间有一拍延迟，
 * 角度会在这一拍里弹回 0（父组件默认值）。改成「内部为准 + 外部变化才同步下来」，
 * 既不闪回，也仍然允许父组件（如「平放」）从外部改角度。
 */
const localPitch = ref(clampPitch(props.pitch ?? 0, pitchLimit.value))

watch(() => props.pitch, (value) => {
  const next = clampPitch(value ?? 0, pitchLimit.value)
  if (Math.abs(next - localPitch.value) > 0.001) localPitch.value = next
})

// 缩放的真源在舞台内（它要逐帧换算页面尺寸），但 Reader 的底栏要显示当前倍率，
// 所以变化时向外报一次。
watch(zoom, (value) => emit('update:zoom', value))

function setPitch(value: number): void {
  localPitch.value = clampPitch(value, pitchLimit.value)
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
  setPitch(pitchFromDrag(
    pitchDragState,
    event.clientY,
    effectiveRenderer.value ? TILT_SENSITIVITY : undefined,
    pitchLimit.value,
  ))
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
  phone.value = props.variant === 'book' && (width < 768 || forcePhone)
  if (props.variant === 'book' && props.renderer === 'webgl' && !webglFailed.value) {
    if (phone.value) {
      // 窄屏单页：逻辑页就是视口，版心四边留 24/44，字号固定参考站的 20px 档。
      const marginX = 24
      const marginTop = 44
      const marginBottom = 44
      const foot = Math.max(1, Math.round(layoutFontSize.value * 1.6))
      layout.value = {
        pageWidth: width,
        pageHeight: height,
        paddingX: marginX,
        paddingY: marginTop,
        contentWidth: Math.max(80, width - marginX * 2),
        contentHeight: Math.max(120, height - marginTop - marginBottom - foot),
      }
      return
    }
    // WebGL 使用固定 640×920 逻辑页，再由相机适配视口；分页输入必须与纹理绘制
    // 使用同一组边距，否则页面底部会多一行/少一行。
    const foot = Math.max(1, Math.round(layoutFontSize.value * 1.6))
    const contentWidth = PAGE_TEXTURE_WIDTH - PAGE_TEXTURE_MARGIN_INNER - PAGE_TEXTURE_MARGIN_OUTER
    layout.value = {
      pageWidth: PAGE_TEXTURE_WIDTH,
      pageHeight: PAGE_TEXTURE_HEIGHT,
      paddingX: PAGE_TEXTURE_MARGIN_INNER,
      paddingY: PAGE_TEXTURE_MARGIN_TOP,
      contentWidth,
      contentHeight: Math.max(120, PAGE_TEXTURE_HEIGHT - PAGE_TEXTURE_MARGIN_TOP - PAGE_TEXTURE_MARGIN_BOTTOM - foot),
    }
    return
  }
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
  const availableHeight = Math.floor(height * 0.99) - REALBOOK_STAGE_PADDING_Y_PX
    - maxStackLiftPx.value - blockBandPx.value
  const widthLimit = Math.floor((width * 0.88 / 2) * 0.99)
  // 开本按参考图取接近正方形的单页（宽高约 1:1）：摊开后是一本横向的宽书，
  // 和参考图里「双页几乎占满画面宽度、上下留出桌面」的构图一致。
  // 宽度同时受高度约束：只按宽度算会在矮窗口里把书压成横向卡片。
  const heightLimit = Math.floor(availableHeight / BOOK_PAGE_ASPECT)
  const pageWidth = Math.max(260, Math.min(widthLimit, heightLimit))
  const pageHeight = Math.max(320, Math.min(
    Math.floor(pageWidth * BOOK_PAGE_ASPECT),
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
/** 字体是否已经等过一次：没有 WebFont 的环境（jsdom）视为已就绪。 */
const fontsPrimed = ref(typeof document === 'undefined' || !document.fonts?.load)
let rebuildPending = false

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
  if (!props.showNotes || !props.notes.length) return []
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
      ?? estimateInlineNoteHeight(note.text, layout.value.contentWidth, layoutFontSize.value, note.tags?.length ?? 0)
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
  // 首屏量断行必须等正文分片就位：字体没落下来时量出的是回退字体的页表，
  // 页数和断行都会在分片载入后跳一次——翻页翻到一半页数变了就是这么来的。
  if (!fontsPrimed.value) {
    rebuildPending = true
    return
  }
  const previousAnchor = pendingRestore ? null : anchorOf(pages.value[currentPage.value])
  const { contentHeight } = layout.value
  // 「注」标记会占一个全角字符的宽度；量断行必须带上它，否则页表会少算一行。
  const noteOffsetsByInput = new Map<number, number[]>()
  if (props.showNotes) {
    for (const note of props.notes) {
      const paragraph = inputIndexOf(note.paragraph)
      if (paragraph < 0) continue
      const list = noteOffsetsByInput.get(paragraph)
      if (list) list.push(note.offset)
      else noteOffsetsByInput.set(paragraph, [note.offset])
    }
  }
  const created = createRealBookPaginator(
    props.paragraphs,
    (text, index) => {
      // 图片段落按「占多少行」参与分页：显示高度按版心宽度换算，图注再占一行。
      const image = parseChapterImage(text)
      if (image) {
        const displayHeight = chapterImageHeight(image, layout.value.contentWidth, layout.value.contentHeight * 0.7)
        const count = Math.max(1, Math.ceil(displayHeight / Math.max(1, lineHeightPx.value)) + (image.caption ? 1 : 0))
        return Array.from({ length: count }, () => ({ start: 0, end: 0 }))
      }
      return measureLines(text, measure, noteOffsetsByInput.get(index) ?? [])
    },
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

/**
 * 把页下标对齐到整页并对齐页表：书页按整页翻，目标页永远落在这一页的第一栏。
 *
 * 页表是惰性排的，`ensure` 会顺手把目标页排出来并更新 `pages`。
 */
function alignPageIndex(index: number): number {
  const created = paginator.value
  if (!created) return currentPage.value
  const step = pageStep.value
  const aligned = step > 1 ? Math.floor(Math.max(0, index) / step) * step : Math.max(0, index)
  const count = created.ensure(aligned + step)
  pages.value = created.pages
  return Math.max(0, Math.min(aligned, count - 1))
}

function goToPage(index: number, animate: boolean): void {
  const created = paginator.value
  if (!created) return
  const target = alignPageIndex(index)
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
  startFlipRun(target > currentPage.value ? 1 : -1, target)
}

/** 这一侧还能不能再起一张纸：链尾之后还有页可翻。 */
function flipTargetFor(direction: 1 | -1): number | null {
  const created = paginator.value
  if (!created) return null
  const tail = flips.value[flips.value.length - 1]
  const from = tail ? tail.to : currentPage.value
  const to = alignPageIndex(from + direction * advance.value)
  return to === from ? null : to
}

/**
 * 起一张新纸。
 *
 * 后起的纸从前一张的落点接着数，几张贴在空中的纸因此是一条连续的页链；
 * 提交仍然按顺序来——只有最前面那张落定了才真的换页。
 */
function startFlipRun(direction: 1 | -1, explicitTarget?: number, follow = false): FlipRun | null {
  const created = paginator.value
  if (!created) return null
  const tail = flips.value[flips.value.length - 1]
  const from = tail ? tail.to : currentPage.value
  const to = explicitTarget ?? flipTargetFor(direction)
  if (to === null || to === from) return null
  if (tail && tail.direction !== direction) {
    // 先往后翻、立刻又往回翻：两张纸的落点会互相盖住，这种只按一张纸串（排队）。
    return null
  }
  const duration = Math.max(1, flipDurationMs.value)
  // 后起的纸不跟前面那张同时起步：等前面那张走了这么远再动，几张纸才是「追着翻」的，
  // 而不是三张纸并排一起飞、一起落。
  const delay = tail && !follow ? FLIP_START_GAP * duration : 0
  // 页快照必须在这里取：`alignPageIndex` 已经把落点页排出来了。
  const single = phone.value
  const { front: frontIndex, back: backIndex } = flyerPageIndexes(direction, from, to, single)
  const run: FlipRun = {
    id: ++flipKey,
    direction,
    from,
    to,
    progress: 0,
    elapsed: -delay,
    duration,
    follow,
    front: texturePageOf(frontIndex, single ? rightHeader.value : (direction === -1 ? leftHeader.value : rightHeader.value)),
    back: texturePageOf(backIndex, single ? rightHeader.value : (direction === 1 ? leftHeader.value : rightHeader.value)),
  }
  flips.value = [...flips.value, run]
  if (!follow) {
    ensureFlipLoop()
    scheduleRunFinish(run, delay + duration)
  }
  return run
}

/** 后一张纸等前一张走过多远才开始动（0–1）：参考站 0.07s / 0.4s = 0.175。 */
const FLIP_START_GAP = 0.175

/**
 * 落定的兜底定时器。
 *
 * 进度靠 rAF 推进，但窗口被切到后台时 rAF 会停——只靠 rAF 的话，翻到一半切走再回来
 * 才会发现这一页还没落定。定时器到点直接把纸按到位并提交，画面回来时已经是新的一页。
 */
const runTimers = new Map<number, ReturnType<typeof setTimeout>>()

function scheduleRunFinish(run: FlipRun, delayMs: number): void {
  const existing = runTimers.get(run.id)
  if (existing) clearTimeout(existing)
  runTimers.set(run.id, setTimeout(() => {
    runTimers.delete(run.id)
    const current = flips.value.find((item) => item.id === run.id)
    if (!current || current.follow) return
    updateRun(run.id, { progress: 1, elapsed: current.duration })
    commitFinishedFlips()
    if (flips.value.length) ensureFlipLoop()
  }, Math.max(0, delayMs)))
}

function clearRunTimer(id: number): void {
  const timer = runTimers.get(id)
  if (timer) clearTimeout(timer)
  runTimers.delete(id)
}

/** 本轮最多同时飞几张纸：CSS 3D 回退只画一张，WebGL 层有 3 个槽位。 */
function maxFlipRuns(): number {
  return effectiveRenderer.value ? MAX_RUNS_WEBGL : 1
}

function updateRun(id: number, patch: Partial<FlipRun>): void {
  flips.value = flips.value.map((run) => (run.id === id ? { ...run, ...patch } : run))
}

/**
 * 翻页时钟：用 rAF 而不是 CSS 动画——竖带的位置是逐帧算的折线积分，
 * 只有进度这一个标量可以交给动画时钟，形状得自己算。
 *
 * 所有在飞的纸共用这一个循环，各自的进度按自己的 `startedAt`/`duration` 走。
 */
function ensureFlipLoop(): void {
  if (flipRaf || typeof requestAnimationFrame !== 'function') return
  flipRaf = requestAnimationFrame(tickFlips)
}

/** 上一帧的 rAF 时间戳：每张纸按帧间隔累加自己走过的时长。 */
let flipFrameAt = 0

function tickFlips(now: number): void {
  flipRaf = 0
  const dt = flipFrameAt ? Math.max(0, Math.min(100, now - flipFrameAt)) : 16
  flipFrameAt = now
  if (!flips.value.length) return
  let list = flips.value
  let changed = false
  for (let index = 0; index < list.length; index += 1) {
    const run = list[index]!
    if (run.follow || run.progress >= 1) continue
    const elapsed = run.elapsed + dt
    // elapsed 可以是负的：后起的纸要等前面那张走一段才开始动。
    const t = Math.max(0, Math.min(1, elapsed / Math.max(1, run.duration)))
    if (!changed) {
      list = list.slice()
      changed = true
    }
    list[index] = { ...run, elapsed, progress: t }
  }
  if (changed) flips.value = list
  commitFinishedFlips()
  if (flips.value.length) ensureFlipLoop()
}

/** 最前面那张纸落定：换页，然后把排队的方向接着放出来。 */
function commitFinishedFlips(): void {
  const head = flips.value[0]
  if (!head || head.follow || head.progress < 1) return
  flips.value = flips.value.slice(1)
  currentPage.value = head.to
  syncAnchor()
  emit('update:page-count', pages.value.length)
  emit('update:page', head.to)
  const next = turnQueue.value.shift()
  if (next === 1) nextPage()
  else if (next === -1) prevPage()
}

function stopFlipAnimation(): void {
  if (flipRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(flipRaf)
  flipRaf = 0
  // 下一轮用自己的第一帧当基准，中间停了多久都不算进纸的行程。
  flipFrameAt = 0
}

function nextPage(): void {
  // WebGL 合上的书：第一次“下一页”只负责把封面打开。
  if (effectiveRenderer.value && !webglOpen.value) {
    webglRef.value?.setOpen(true)
    webglOpen.value = true
    return
  }
  // 空中有位置就直接再起一张纸：这就是连翻时几页同时在飞的那条路。
  if (!instantFlip() && flips.value.length < maxFlipRuns()) {
    const target = flipTargetFor(1)
    if (target === null) {
      // 链上已经到本章最后一页：把「下一页」交给父组件换下一章。
      if (!flips.value.length) emit('next-chapter')
      return
    }
    if (startFlipRun(1, target)) return
  }
  if (instantFlip()) {
    // 减动效 / 书页版式没有飞页：直接换页（goToPage 自己会走瞬间分支）。
    if (!hasNextPage.value) {
      emit('next-chapter')
      return
    }
    goToPage(currentPage.value + advance.value, true)
    return
  }
  if (turnQueue.value.length < 12) turnQueue.value.push(1)
}

function prevPage(): void {
  if (!instantFlip() && flips.value.length < maxFlipRuns()) {
    const target = flipTargetFor(-1)
    // 已经在第一页：没有可往回翻的页，什么也不做（不要留在队列里反复触发）。
    if (target === null) return
    if (startFlipRun(-1, target)) return
  }
  if (instantFlip()) {
    goToPage(currentPage.value - advance.value, true)
    return
  }
  if (turnQueue.value.length < 12) turnQueue.value.push(-1)
}

/** 这一档不画飞页：书页版式只有一张纸，减动效则根本不要动画。 */
function instantFlip(): boolean {
  return reducedMotion() || props.variant === 'sheet'
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

function clampZoom(value: number): number {
  return Math.min(maxZoom.value, Math.max(minZoom.value, Math.round(value * 1000) / 1000))
}

function onWheel(e: WheelEvent): void {
  // WebGL 复刻沿用参考站：滚轮缩放，翻页交给按钮/方向键/拖页。
  if (effectiveRenderer.value) {
    const delta = Math.max(-120, Math.min(120, e.deltaY))
    zoom.value = clampZoom(zoom.value * Math.exp(-delta * 0.001))
    e.preventDefault()
    return
  }
  if (e.ctrlKey) {
    // CSS 3D 回退：双指捏合在桌面端会带 ctrlKey；这是缩放，不翻页。
    zoom.value = clampZoom(zoom.value - e.deltaY * 0.002)
    e.preventDefault()
    return
  }
  if (Math.abs(e.deltaY) < 8) return
  e.preventDefault()
  if (e.deltaY > 0) nextPage()
  else prevPage()
}

function zoomIn(): void {
  zoom.value = clampZoom(effectiveRenderer.value ? zoom.value * 1.25 : zoom.value + 0.1)
}

function zoomOut(): void {
  zoom.value = clampZoom(effectiveRenderer.value ? zoom.value * 0.8 : zoom.value - 0.1)
}

function resetZoom(): void {
  zoom.value = defaultZoom.value
}

/**
 * 适应屏幕：整本书收进视口。
 *
 * WebGL 的倍率以「整书适配」为 100%（`cameraPose` 里 `dist = fitDistance / zoom`），
 * 所以适应屏幕就是 1；CSS 3D 回退的 1 也是舞台原尺寸。参考站底栏的 fit-book
 * 与 0 键是同一个动作——复原（90%）比整书略微推近，两者不是一回事。
 */
function fitBook(): void {
  zoom.value = clampZoom(1)
}

function onWebglPageTurn(direction: 1 | -1): void {
  if (direction === 1) nextPage()
  else prevPage()
}

/**
 * 跨页选择请求的翻页：只在本章内翻。
 *
 * 走 `nextPage()` 会在本章最后一页把「下一页」交给父组件续章——跨页选择拖到章末
 * 就突然跳章，选区也跟着没了。这里拿不到下一页就什么也不做，书台那边 720ms 后自己收尾。
 */
function onWebglCrossTurn(direction: 1 | -1): void {
  if (flips.value.length >= maxFlipRuns()) return
  const target = flipTargetFor(direction)
  if (target === null) return
  startFlipRun(direction, target)
}

/**
 * 拖页：纸跟着手走，松手时按手指走过的比例决定落定还是回弹。
 *
 * 这里只维护「翻页中态 + 进度」两个量，几何、纹理、明暗仍由 `flipT` 和 `flipping`
 * 一路派生——拖页不是另一套动画，只是把同一个进度交给手指来写。
 */
const peel = ref<{ direction: 1 | -1; accepted: boolean; runId: number } | null>(null)

/**
 * 这一侧此刻还有没有页可翻。
 *
 * 拖页只在空中一张纸都没有时起手——手上只有一根手指，同时再拖一张纸说不清是谁跟谁。
 */
function canPeel(direction: 1 | -1): boolean {
  if (flips.value.length) return false
  if (reducedMotion() || props.variant === 'sheet') return false
  return direction === 1 ? hasNextPage.value : currentPage.value > 0
}

function onPeelStart(direction: 1 | -1): void {
  if (peel.value) return
  if (!canPeel(direction)) {
    peel.value = { direction, accepted: false, runId: 0 }
    return
  }
  const target = flipTargetFor(direction)
  const run = target === null ? null : startFlipRun(direction, target, true)
  peel.value = { direction, accepted: Boolean(run), runId: run?.id ?? 0 }
}

function onPeelProgress(progress: number, grabV = 0.5, pointerV = grabV): void {
  const active = peel.value
  if (!active?.accepted) return
  updateRun(active.runId, { progress: Math.max(0, Math.min(1, progress)), grabV, pointerV })
}

function onPeelEnd(complete: boolean): void {
  const active = peel.value
  peel.value = null
  if (!active) return
  if (!active.accepted) {
    if (complete) onWebglPageTurn(active.direction)
    return
  }
  const run = flips.value.find((item) => item.id === active.runId)
  if (!run) return
  if (complete) {
    // 松手后剩下的行程走快一点：纸已经在手上掀起来了，不该再慢慢挪完。
    const duration = Math.max(80, flipDurationMs.value * (1 - run.progress) * 0.55)
    updateRun(run.id, { follow: false, elapsed: run.progress * duration, duration })
    ensureFlipLoop()
    scheduleRunFinish(run, duration)
    return
  }
  settlePeelBack(run.id)
}

/** 取消拖页：纸收回原位，页面内容不变。 */
function settlePeelBack(runId: number): void {
  const run = flips.value.find((item) => item.id === runId)
  if (!run) return
  const from = run.progress
  clearRunTimer(runId)
  if (from <= 0.002 || typeof requestAnimationFrame !== 'function') {
    flips.value = flips.value.filter((item) => item.id !== runId)
    return
  }
  const started = performance.now()
  // 回弹比落定快：手松开之后纸是被弹回去的，不是又慢慢飘回去。
  const duration = Math.max(120, flipDurationMs.value * 0.32 * from)
  const tick = () => {
    const t = Math.min(1, (performance.now() - started) / duration)
    const eased = 1 - Math.pow(1 - t, 3)
    updateRun(runId, { progress: from * (1 - eased) })
    if (t < 1) {
      flipRaf = requestAnimationFrame(tick)
      return
    }
    flipRaf = 0
    flips.value = flips.value.filter((item) => item.id !== runId)
  }
  flipRaf = requestAnimationFrame(tick)
}

function handleWebglUnsupported(): void {
  webglFailed.value = true
  void nextTick(() => {
    updateLayout()
    rebuildPages()
  })
}

function onWebglOpen(value: boolean): void {
  webglOpen.value = value
  emit('update:open', value)
}

function toggleOpen(): void {
  if (!effectiveRenderer.value) return
  webglOpen.value = !webglOpen.value
  webglRef.value?.setOpen(webglOpen.value)
  emit('update:open', webglOpen.value)
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
  lines: readonly RealBookLine[]
  segs: NoteTextPart[]
}

interface PageNotePiece {
  kind: 'note'
  key: string
  note: RealBookNote
}

/** CSS 3D 回退里的页内图片块。 */
interface PageImagePiece {
  kind: 'image'
  key: string
  file: string
  width: number
  height: number
  caption: string
  displayHeight: number
}

type PagePiece = PageTextPiece | PageNotePiece | PageImagePiece

/** CSS 3D 回退的图片地址：与 WebGL 同一套 spbf-image 协议。 */
function bookImageSrc(file: string): string {
  if (!props.bookId || !file) return ''
  return `spbf-image://i/${encodeURIComponent(props.bookId)}/${encodeURIComponent(file)}`
}

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
    const paragraphText = props.paragraphs[item.paragraph] ?? ''
    const image = parseChapterImage(paragraphText)
    if (image) {
      // 图片段落被拆到续页时只画一次：后面的片段是空占位。
      if (!item.continued) {
        out.push({
          kind: 'image',
          key: `img-${item.paragraph}`,
          file: image.file,
          width: image.width,
          height: image.height,
          caption: image.caption,
          displayHeight: chapterImageHeight(image, layout.value.contentWidth, layout.value.contentHeight * 0.7),
        })
      }
      continue
    }
    const original = props.paragraphIndexes[item.paragraph]
    if (original === undefined) continue
    const text = paragraphText
    const slice = text.slice(item.start, item.end)
    const local = props.highlights
      .filter((h) => h.index === original)
      .map((h) => ({
        start: Math.max(0, h.start - item.start),
        end: Math.max(0, h.end - item.start),
        color: h.color,
      }))
      .filter((h) => h.end > h.start)
    // 「注」标记只在真正包含锚点的那一段片段里出现；跨页续排时不能每页都挂一个。
    const marks = (noteMarksByParagraph.value.get(original) ?? [])
      .map((mark) => ({ id: mark.id, offset: mark.offset - item.start }))
      .filter((mark) => mark.offset >= 0 && mark.offset <= slice.length && (mark.offset > 0 || item.start === 0))
    out.push({
      kind: 'text',
      key: `${item.paragraph}-${item.start}-${item.end}`,
      paragraph: item.paragraph,
      original,
      start: item.start,
      end: item.end,
      continued: item.continued,
      lines: item.lines ?? [{ start: item.start, end: item.end }],
      segs: decorateTextWithNotes(slice, props.searchQuery, local, marks),
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
const flipHead = computed(() => flips.value[0] ?? null)
const flipTail = computed(() => flips.value[flips.value.length - 1] ?? null)
/**
 * 静态页此刻摊开的是哪一页。
 *
 * 空中有纸时按**整条纸链**算：抬起的那一侧显示最终落点（每张纸都是从它上面掀起来的），
 * 落下的那一侧一直停在翻页前的内容，直到最前面那张纸落定才换——两张纸同时飞的时候
 * 中间那张的落点还压在旧内容上，提前换会让纸底下凭空多出一页。
 */
const slotPage = computed(() => flipTail.value?.to ?? currentPage.value)
const leftViewIndex = computed(() => {
  const head = flipHead.value
  if (!head) return currentPage.value - 1
  return head.direction === 1 ? head.from - 1 : slotPage.value - 1
})
const rightViewIndex = computed(() => {
  const head = flipHead.value
  if (!head) return currentPage.value
  return head.direction === 1 ? slotPage.value : head.from
})
const leftViewPieces = computed(() => piecesOf(pages.value[leftViewIndex.value]))
const rightViewPieces = computed(() => piecesOf(pages.value[rightViewIndex.value]))

/**
 * 正被翻动的那张纸：往后翻它是右页、往前翻它是左页，正反面是同一张纸。
 *
 * 正面是抬起的那一页（旧右页 / 旧左页）。背面只画纸：纸背若是半透明字影，
 * 铺在落点那一页上会读成一块灰影，翻页时看着像左边多了个影子。背面保持
 * 不透明纸面，落定后静态页再一次性换成新内容，读者不会看到半透明旧字。
 */
const flipSheetIndex = computed(() => {
  const head = flipHead.value
  if (!head) return currentPage.value
  return head.direction === -1 ? head.from - 1 : head.from
})
const flipSheetPieces = computed(() => piecesOf(pages.value[flipSheetIndex.value]))
/**
 * 翻动纸背的内容：一张纸的正面是右页，背面就是落到对面后露出的左页。
 *
 * 之前因为“纸背透字会在落点页上叠出灰影”把背面正文整层去掉了，结果翻页中
 * 看到一整块空白纸板——这正是僵硬感的来源之一。正确的做法不是不画，而是
 * 只在转角越过 90° 后画**另一页**内容，并沿纸面镜像；正反面互斥后不会再重影。
 */
const flipBackIndex = computed(() => {
  const head = flipHead.value
  if (!head) return -1
  return head.direction === 1 ? head.from + 1 : head.from - 2
})
const flipBackPieces = computed(() => piecesOf(pages.value[flipBackIndex.value]))
/** 飞页页眉也随纸的侧面：左页印书名、右页印章节名。 */
const flipSheetHeader = computed(() => (flipSheetIndex.value % 2 === 1 ? leftHeader.value : rightHeader.value))
const flipBackHeader = computed(() => (flipBackIndex.value % 2 === 1 ? leftHeader.value : rightHeader.value))

/**
 * 把分页结果投影成 WebGL 纹理数据。
 *
 * 注意这里不再走 `decorateTextWithNotes` 的 DOM 片段，而是把整段文本和行区间
 * 一起交给纹理层，让 Canvas 按与分页完全相同的断行绘制。
 */
function texturePageOf(index: number, header = props.chapterTitle): RealBookTexturePage | null {
  const page = pages.value[index]
  if (!page || !page.items.length) return null
  const items: Array<RealBookTexturePage['items'][number]> = []
  for (const item of page.items) {
    if (item.kind === 'note') {
      const note = props.notes.find((candidate) => candidate.id === item.noteId)
      if (note) items.push({ kind: 'note', note, height: item.height })
      continue
    }
    const paragraphText = props.paragraphs[item.paragraph] ?? ''
    const image = parseChapterImage(paragraphText)
    if (image) {
      items.push({
        kind: 'image',
        file: image.file,
        width: image.width,
        height: image.height,
        caption: image.caption,
        displayHeight: chapterImageHeight(image, layout.value.contentWidth, layout.value.contentHeight * 0.7),
      })
      continue
    }
    const original = props.paragraphIndexes[item.paragraph]
    if (original === undefined) continue
    const highlights = props.highlights
      .filter((highlight) => highlight.index === original)
      .map((highlight) => ({ start: highlight.start, end: highlight.end, color: highlight.color }))
    const noteMarks = (noteMarksByParagraph.value.get(original) ?? []).map((mark) => mark.offset)
    items.push({
      kind: 'text',
      text: props.paragraphs[item.paragraph] ?? '',
      originalIndex: original,
      start: item.start,
      end: item.end,
      continued: item.continued,
      lines: item.lines ?? [{ start: item.start, end: item.end }],
      highlights,
      noteMarks,
    })
  }
  return {
    pageNumber: index + 1,
    chapterTitle: props.chapterTitle,
    header,
    items,
  }
}

/** 参考站的书页页眉：左页印书名，右页印章节名；手机单页印章节名。 */
const leftHeader = computed(() => props.bookTitle || props.chapterTitle)
const rightHeader = computed(() => props.chapterTitle)
const webglLeftPage = computed(() => (phone.value ? null : texturePageOf(leftViewIndex.value, leftHeader.value)))
const webglRightPage = computed(() => (phone.value
  ? texturePageOf(slotPage.value, rightHeader.value)
  : texturePageOf(rightViewIndex.value, rightHeader.value)))
/**
 * 交给 WebGL 层的飞页列表（从旧到新）。
 *
 * 每张纸自带正反面该印哪一页：正面是起手朝上的那一页，背面是落定后朝上的那一页。
 * 单页模式下没有"对面"，正面就是当前页、背面就是落点页。
 */
const webglFlips = computed<RealBookSceneFlip[]>(() => flips.value.map((run) => ({
  id: run.id,
  direction: run.direction,
  progress: run.progress,
  follow: run.follow,
  grabV: run.grabV,
  pointerV: run.pointerV,
  // 用起纸时的快照，不每帧回查页表：页表在翻页途中重排不会让飞页变白纸。
  front: run.front,
  back: run.back,
})))
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
 * 翻动页整体离桌的程度：纸在飞行中整体抬离纸面。
 *
 * 位移作用在整张纸上，不作用在单条竖带——否则页脚会变成锯齿状的阶梯。
 * 只有沿观者方向的平移：纸的书脊侧必须始终留在书缝里（见 `flipSheetLift`），
 * 后仰与屏面内滚都会把那条边推开，中缝就会露出一道「撕开」的空白带。
 */
const flipSheetState = computed(() => flipSheetLift(flipT.value))

/**
 * 翻动页的竖向起点与落点：静态页被自己那一摞纸托起，翻动页若从 y=0 起飞，
 * 起翻那一帧会向下跳一截（深俯仰下可达几十像素）。这里按翻页进度把抬升量
 * 从「出发页的抬升」连续过渡到「落点页的抬升」，起落都不跳。
 */
const flipLiftY = computed(() => {
  if (!flipping.value) return 0
  const from = flipping.value.direction === 1 ? rightStackLiftPx.value : leftStackLiftPx.value
  const to = flipping.value.direction === 1 ? leftStackLiftPx.value : rightStackLiftPx.value
  return -(from + (to - from) * flipT.value)
})

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
  // 空中有纸时，「下一页」是从最后那张纸的落点往后数。
  const tail = flips.value[flips.value.length - 1]
  const target = (tail ? tail.to : currentPage.value) + advance.value
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
 * 每层纸的纵深（px）。参考图是一本厚书：书脚露出的纸垛接近半指高，
 * 一层 3.4px，整本最多 12 层约 41px，书脚才读得出「一摞纸」。
 */
const BLOCK_DEPTH_PER_LAYER_PX = 3.4

/**
 * 真实书籍的开本：单页宽高比。参考图是一本接近正方形的书（单页约 1:1），
 * 摊开后的双页近乎占满画面宽度，上下留出一条桌面——这就是它「方」的来源。
 */
const BOOK_PAGE_ASPECT = 1

/**
 * V 形摊开角（deg）：两页以书脊为轴向外掀起的角度。
 * 翻页的起翻角与落位角都由它推出来——两处必须同一个数，否则落定时会错开一个折角。
 *
 * 参考图里摊开的纸几乎是平的，只在书脊有一条极浅的折痕；9° 的 V 形会把书脊
 * 读成一道深谷，所以压到 4°。透视下两页外缘仍会微微向观者掀起来。
 */
const BEND_DEG = 4

/**
 * 翻动页转轴到摊开中心线的距离（px）。
 *
 * 书心不占宽度（见 `.real-book-gutter`）：两页以各自的装订边为 3D 轴心，
 * 内缘正好落在中心线上，所以翻动页就直接绕中心线翻。
 */
const FLIP_ANCHOR_OFFSET_PX = 0

/**
 * 底栏让位（px）：真实书籍的图标底栏常驻在视口底部，
 * 书要在它上方留出一段，封面下沿、纸垛切口的层线才看得见，
 * 不会被底栏压住。参考图里书脚与底栏之间也有一段空桌。
 */
const REALBOOK_BAR_CLEARANCE_PX = 56

/**
 * 俯仰角到纸垛可见高度的换算：以 16° 为基准（此时纸垛的屏幕高度≈纸垛纵深），
 * 俯仰越深，纸垛与页面拱起在屏幕上越高。35° 约为 2.05 倍。
 * 参考图 2 是浅俯仰（纸垛只露一窄条），参考图 1 是深俯仰（纸垛与拱起都很高），
 * 两张图对应的是同一条连续曲线。
 */
const MAX_PITCH_VIEW_FACTOR = Math.sin(35 * Math.PI / 180) / Math.sin(16 * Math.PI / 180)

/**
 * 这本书在最深俯仰下页面被纸垛抬起的最大高度（px）。
 * 页面抬起会把整本书向上顶，版面上要同时让出顶部这一截和书脚的一小截。
 */
const maxStackLiftPx = computed(() =>
  Math.round(spineTotalLayers(props.totalChars) * BLOCK_DEPTH_PER_LAYER_PX * MAX_PITCH_VIEW_FACTOR))

/** 书脚让位：封面包边 + 投影 + 常驻底栏。 */
const REALBOOK_STAGE_PADDING_Y_PX = 28
const blockBandPx = computed(() => REALBOOK_BAR_CLEARANCE_PX + 20)

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

/**
 * 纸垛在屏幕上的可见度：随俯仰角的正弦连续增长。
 * 平放（0°）时为 0，默认俯仰（16°）约 0.68，高俯仰（32°–35°）约 1.3–1.4，
 * 同一本书在浅俯仰（图 2）与深俯仰（图 1）下自然呈现对应的纸垛高度与页面拱起量。
 */
const edgeVisibility = computed(() => {
  const radians = Math.max(0, pitch.value) * Math.PI / 180
  return Math.max(0, Math.sin(radians) / Math.sin(16 * Math.PI / 180))
})
const leftStackLiftPx = computed(() => leftBlockDepth.value * edgeVisibility.value)
const rightStackLiftPx = computed(() => rightBlockDepth.value * edgeVisibility.value)

const stageStyle = computed(() => ({
  '--rb-pitch': `${pitch.value}deg`,
  '--rb-edge-visibility': edgeVisibility.value.toFixed(3),
  '--rb-lift-left': `${leftStackLiftPx.value.toFixed(2)}px`,
  '--rb-lift-right': `${rightStackLiftPx.value.toFixed(2)}px`,
  '--rb-arch-left': `${(leftStackLiftPx.value * 0.68).toFixed(2)}px`,
  '--rb-arch-right': `${(rightStackLiftPx.value * 0.68).toFixed(2)}px`,
  // 拟物书页的纸色与桌面来自主题色板：经典模式的纸白在书台上会读成白纸，
  // 参考图要的是偏黄的旧纸与深绿灰桌面。
  '--rb-paper-warm': realbookColors.value.paper,
  '--rb-paper-lit': realbookColors.value.lit,
  '--rb-paper-shade': realbookColors.value.shade,
  '--rb-desk': realbookColors.value.desk,
  '--rb-desk-lit': realbookColors.value.deskLit,
  '--rb-desk-deep': realbookColors.value.deskDeep,
  // 封面是深灰绿布壳：只从纸页四边露出一圈，书脚再露出一段纸垛。
  '--rb-cover-lit': realbookColors.value.coverLit,
  '--rb-cover-mid': realbookColors.value.cover,
  '--rb-cover-deep': realbookColors.value.coverDeep,
  // 浮在桌面上的描边控件（左上返回键）：日间是浅色半透明胶囊、夜间转深。
  '--rb-ui-bg': props.theme === 'night' ? 'rgba(26, 30, 27, 0.72)' : 'rgba(250, 244, 232, 0.78)',
  '--rb-ui-ink': props.theme === 'night' ? 'rgba(238, 232, 220, 0.90)' : 'rgba(46, 44, 38, 0.82)',
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
  // 书脚下面要留出的高度：参考图底边有软影与常驻底栏，不让它贴到视口边缘。
  '--rb-block-band': `${blockBandPx.value}px`,
  // 页面被纸垛抬起后整本书会向上顶：顶部要预留这一截，书页顶缘才不会被视口裁掉。
  '--rb-lift-max': `${maxStackLiftPx.value}px`,
  '--rb-font-size': `${layoutFontSize.value}px`,
  // 必须是长度：CSS 用它当 line-height，裸数字会被当成「字号的倍数」，一行会被撑成几十倍高。
  '--rb-line-height': `${lineHeightPx.value}px`,
  '--rb-font-family': props.fontFamily,
}))

const measureStyle = computed(() => ({
  width: `${layout.value.contentWidth}px`,
  fontSize: `${layoutFontSize.value}px`,
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
    layoutFontSize.value,
    props.lineHeight,
    props.fontFamily,
    props.paragraphGap,
    props.notes,
    props.showNotes,
    props.handwritingFont,
    props.totalChars,
    props.renderer,
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

// 换书页字体/字号时要重新等分片：先按回退字体量出来的页表会在字体就位后整体跳。
watch(
  () => [props.fontFamily, layoutFontSize.value],
  () => {
    if (typeof document === 'undefined' || !document.fonts?.load) return
    fontsPrimed.value = false
    void ensureBookFont().then(() => {
      fontsPrimed.value = true
      void nextTick(() => {
        updateLayout()
        rebuildPages()
      })
    })
  },
)

watch(() => props.renderer, (renderer) => {
  webglFailed.value = false
  webglOpen.value = true
  zoom.value = renderer === 'webgl' ? WEBGL_DEFAULT_ZOOM : 1
  localPitch.value = clampPitch(localPitch.value, pitchLimit.value)
  void nextTick(() => {
    updateLayout()
    rebuildPages()
  })
})

watch(() => props.startAnchor, (anchor) => {
  if (anchor) goToAnchor(anchor)
}, { deep: true })

// 换章：页表要重排，落位必须等重排完，否则会跳到旧页表的页。
watch(() => props.restoreToken, () => {
  turnQueue.value = []
  peel.value = null
  pendingRestore = true
  void nextTick(() => rebuildPages())
})
watch(() => props.revealNoteToken, () => {
  void nextTick(() => applyReveal())
})
let fontListener: (() => void) | null = null
let fontReloadTimer = 0

/**
 * 等当前页字体真正可用。
 *
 * 霞鹜文楷是按 unicode-range 分片的 webfont：等到用到某个字才去下载那一片。
 * 量断行发生在字体就绪之前时，页表会按回退字体算出一版（页数、断行都不同），
 * 等分片落下来又整体跳一次——翻页翻到一半页数从 3 变成 5 就是这么来的。
 * 所以首屏排版先等一次 load；拿不到（离线/字体缺失）就按回退字体继续，不阻塞阅读。
 */
async function ensureBookFont(): Promise<void> {
  const fonts = typeof document === 'undefined' ? null : document.fonts
  if (!fonts?.load) return
  const sample = props.paragraphs.join('').slice(0, 6000) || '书页'
  const timeout = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })
  try {
    await Promise.race([
      fonts.load(`400 ${layoutFontSize.value}px ${props.fontFamily}`, sample),
      timeout(1500),
    ])
  } catch { /* 字体不可用：按回退字体排版 */ }
  await Promise.race([fonts.ready, timeout(400)]).catch(() => {})
}

onMounted(() => {
  updateLayout()
  observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    updateLayout()
    rebuildPages()
  })
  if (observer && hostRef.value) observer.observe(hostRef.value)
  pendingRestore = true
  // 首屏先等正文用到的分片落下来，再量断行；否则页表会先按回退字体算一版。
  void ensureBookFont().then(() => {
    fontsPrimed.value = true
    rebuildPending = false
    return nextTick(() => {
      updateLayout()
      rebuildPages()
    })
  })
  // 后续分片（换章后出现的新字）载入完成时，字体度量变了，重排一次。
  fontListener = () => {
    if (fontReloadTimer) clearTimeout(fontReloadTimer)
    const retry = (attempt: number): void => {
      fontReloadTimer = window.setTimeout(() => {
        fontReloadTimer = 0
        // 翻页中重排会改页数、改落点，等纸落定后再排。
        if (flips.value.length && attempt < 40) { retry(attempt + 1); return }
        updateLayout()
        rebuildPages()
      }, 120)
    }
    retry(0)
  }
  document.fonts?.addEventListener?.('loadingdone', fontListener)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (fontListener) document.fonts?.removeEventListener?.('loadingdone', fontListener)
  fontListener = null
  if (fontReloadTimer) clearTimeout(fontReloadTimer)
  fontReloadTimer = 0
  stopFlipAnimation()
  for (const id of [...runTimers.keys()]) clearRunTimer(id)
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
  fitBook,
  resetPitch,
  currentPage,
  pageCount,
  readEnd,
  toggleOpen,
  isOpen: webglOpen,
})
</script>

<template>
  <div ref="hostRef" :class="['real-book-stage', { 'is-sheet': variant === 'sheet', 'is-phone': phone }]" :style="stageStyle" @mouseup="onStageMouseup">
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
        <span class="real-book-note-label">笔记</span>
        <span class="real-book-note-text">{{ note.text }}</span>
        <span v-if="note.tags?.length" class="real-book-note-tags">
          <span v-for="tag in note.tags" :key="tag" class="real-book-note-tag">#{{ tag }}</span>
        </span>
      </aside>
    </div>

    <div v-if="variant === 'book' && showToolbar" class="real-book-toolbar">
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

    <!-- 参考图左上角的圆形返回键：一直浮在桌面左上角，不随工具栏显隐。 -->
    <button
      v-if="variant === 'book' && backVisible"
      class="real-book-back"
      type="button"
      title="返回书库"
      aria-label="返回书库"
      @click.stop="emit('back')"
      @mouseup.stop
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5" /></svg>
    </button>

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
              ><template v-for="(s, j) in piece.segs" :key="j"><span v-if="s.noteId" class="real-book-note-anchor" :data-note-anchor-id="s.noteId" role="button" tabindex="0" aria-label="查看这条批注" @click.stop="emit('edit-note', s.noteId)" @mouseup.stop @keydown.enter.stop.prevent="emit('edit-note', s.noteId)" @keydown.space.stop.prevent="emit('edit-note', s.noteId)"></span><mark v-else-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
              <figure v-else-if="piece.kind === 'image'" class="real-book-image" :style="{ height: `${piece.displayHeight}px` }">
                <img v-if="bookImageSrc(piece.file)" :src="bookImageSrc(piece.file)" :alt="piece.caption" draggable="false" />
                <figcaption v-if="piece.caption">{{ piece.caption }}</figcaption>
              </figure>
              <aside
                v-else-if="piece.kind === 'note'"
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
                <span class="real-book-note-label">笔记<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                <span class="real-book-note-text">{{ piece.note.text }}</span>
                <span v-if="piece.note.tags?.length" class="real-book-note-tags">
                  <span v-for="tag in piece.note.tags" :key="tag" class="real-book-note-tag">#{{ tag }}</span>
                </span>
              </aside>
            </template>
          </div>
        </div>
        <footer class="rb-sheet-foot">
          <span class="rb-sheet-page-label" role="status">{{ sheetLabel }}</span>
        </footer>
      </section>
      <RealBookWebGLStage
        v-if="effectiveRenderer"
        ref="webglRef"
        :left-page="webglLeftPage"
        :right-page="webglRightPage"
        :flips="webglFlips"
        :font-size="layoutFontSize"
        :line-height="lineHeight"
        :font-family="fontFamily"
        :paragraph-gap="paragraphGap"
        :search-query="searchQuery"
        :paper="realbookColors.paper"
        :ink="webglInk"
        :muted="webglMuted"
        :desk="desk"
        :endpaper="endpaper"
        :single-page="phone"
        :page-width="layout.pageWidth"
        :page-height="layout.pageHeight"
        :margin-inner="phone ? 24 : 80"
        :margin-outer="phone ? 24 : 58"
        :margin-top="phone ? 44 : 78"
        :margin-bottom="phone ? 44 : 100"
        :tilt="pitch"
        :zoom="zoom"
        :open="webglOpen"
        :total-chars="totalChars"
        :page-count="pageCount"
        :progress="stackProgress"
        :book-title="bookTitle || chapterTitle"
        :book-author="bookAuthor"
        :book-id="bookId"
        @update:pitch="setPitch"
        @update:open="onWebglOpen"
        @page-turn="onWebglPageTurn"
        @peel-start="onPeelStart"
        @peel-progress="onPeelProgress"
        @peel-end="onPeelEnd"
        @edit-note="emit('edit-note', $event)"
        @select-range="emit('select-range', $event)"
        @cross-turn="onWebglCrossTurn"
        @unsupported="handleWebglUnsupported"
      />
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
          <!-- 硬壳封面：左右两块沿书脊轴掀起，只从纸页外缘露出一圈包边。
               没有这层，页面再卷也只是两张纸，读不出「一本装订好的书」。 -->
          <div class="real-book-board real-book-board-left" aria-hidden="true"></div>
          <div class="real-book-board real-book-board-right" aria-hidden="true"></div>
          <!-- 书脊：一条藏在两页之间的圆弧脊背，只在上下两端的封面外露处露头。 -->
          <div class="real-book-spine" aria-hidden="true"></div>
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
          <section class="real-book-page real-book-left" aria-label="左页">
            <header class="real-book-page-head">{{ leftHeader }}</header>
            <div class="real-book-page-body">
              <div v-if="!leftViewPieces.length" class="real-book-empty">书页已到开头</div>
              <template v-for="piece in leftViewPieces" :key="piece.key">
                <p
                  v-if="piece.kind === 'text'"
                  class="real-book-para"
                  :data-p="piece.original"
                  :class="{ 'para-continued': piece.continued }"
                ><template v-for="(s, j) in piece.segs" :key="j"><span v-if="s.noteId" class="real-book-note-anchor" :data-note-anchor-id="s.noteId" role="button" tabindex="0" aria-label="查看这条批注" @click.stop="emit('edit-note', s.noteId)" @mouseup.stop @keydown.enter.stop.prevent="emit('edit-note', s.noteId)" @keydown.space.stop.prevent="emit('edit-note', s.noteId)"></span><mark v-else-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
                <figure v-else-if="piece.kind === 'image'" class="real-book-image" :style="{ height: `${piece.displayHeight}px` }">
                  <img v-if="bookImageSrc(piece.file)" :src="bookImageSrc(piece.file)" :alt="piece.caption" draggable="false" />
                  <figcaption v-if="piece.caption">{{ piece.caption }}</figcaption>
                </figure>
                <aside
                  v-else-if="piece.kind === 'note'"
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
                  <span class="real-book-note-label">笔记<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                  <span class="real-book-note-text">{{ piece.note.text }}</span>
                  <span v-if="piece.note.tags?.length" class="real-book-note-tags">
                    <span v-for="tag in piece.note.tags" :key="tag" class="real-book-note-tag">#{{ tag }}</span>
                  </span>
                </aside>
              </template>
            </div>
            <footer class="real-book-page-foot">{{ leftPageNumber || '' }}</footer>
            <div class="real-book-page-cast" aria-hidden="true"></div>
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

          <section class="real-book-page real-book-right" aria-label="右页">
            <header class="real-book-page-head">{{ rightHeader }}</header>
            <div class="real-book-page-body">
              <div v-if="!rightViewPieces.length" class="real-book-empty">本章没有正文了</div>
              <template v-for="piece in rightViewPieces" :key="piece.key">
                <p
                  v-if="piece.kind === 'text'"
                  class="real-book-para"
                  :data-p="piece.original"
                  :class="{ 'para-continued': piece.continued }"
                ><template v-for="(s, j) in piece.segs" :key="j"><span v-if="s.noteId" class="real-book-note-anchor" :data-note-anchor-id="s.noteId" role="button" tabindex="0" aria-label="查看这条批注" @click.stop="emit('edit-note', s.noteId)" @mouseup.stop @keydown.enter.stop.prevent="emit('edit-note', s.noteId)" @keydown.space.stop.prevent="emit('edit-note', s.noteId)"></span><mark v-else-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
                <figure v-else-if="piece.kind === 'image'" class="real-book-image" :style="{ height: `${piece.displayHeight}px` }">
                  <img v-if="bookImageSrc(piece.file)" :src="bookImageSrc(piece.file)" :alt="piece.caption" draggable="false" />
                  <figcaption v-if="piece.caption">{{ piece.caption }}</figcaption>
                </figure>
                <aside
                  v-else-if="piece.kind === 'note'"
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
                  <span class="real-book-note-label">笔记<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                  <span class="real-book-note-text">{{ piece.note.text }}</span>
                  <span v-if="piece.note.tags?.length" class="real-book-note-tags">
                    <span v-for="tag in piece.note.tags" :key="tag" class="real-book-note-tag">#{{ tag }}</span>
                  </span>
                </aside>
              </template>
            </div>
            <footer class="real-book-page-foot">{{ rightPageNumber || '' }}</footer>
            <div class="real-book-page-cast" aria-hidden="true"></div>
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
              // 竖向起点跟着本半页的纸垛抬升走（见 flipLiftY）：起翻与落位都不能跳。
              // 只沿观者方向抬离纸面：书脊侧那条边必须一直落在书缝里。
              // 后仰（rotateX）与屏面内滚（rotateZ）会把这条边推离书脊，
              // 中缝上就露出一条两边带硬边的空白纸带——就是「书被撕开」的读感。
              transform: `translateY(${flipLiftY.toFixed(2)}px) translateZ(${flipSheetState.lift.toFixed(2)}px)`,
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
                  <header class="real-book-page-head">{{ flipSheetHeader }}</header>
                  <div class="real-book-page-body">
                    <template v-for="piece in flipSheetPieces" :key="`front-${piece.key}`">
                      <p
                        v-if="piece.kind === 'text'"
                        class="real-book-para"
                        :data-p="piece.original"
                      ><template v-for="(s, j) in piece.segs" :key="j"><span v-if="s.noteId" class="real-book-note-anchor" :data-note-anchor-id="s.noteId" role="button" tabindex="0" aria-label="查看这条批注" @click.stop="emit('edit-note', s.noteId)" @mouseup.stop @keydown.enter.stop.prevent="emit('edit-note', s.noteId)" @keydown.space.stop.prevent="emit('edit-note', s.noteId)"></span><mark v-else-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
                      <figure v-else-if="piece.kind === 'image'" class="real-book-image" :style="{ height: `${piece.displayHeight}px` }">
                        <img v-if="bookImageSrc(piece.file)" :src="bookImageSrc(piece.file)" :alt="piece.caption" draggable="false" />
                        <figcaption v-if="piece.caption">{{ piece.caption }}</figcaption>
                      </figure>
                      <aside
                        v-else-if="piece.kind === 'note'"
                        :class="['real-book-note', handwritingNoteClass, { 'is-ai': piece.note.source === 'ai' }]"
                        :data-note-id="piece.note.id"
                      >
                        <span class="real-book-note-label">笔记<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                        <span class="real-book-note-text">{{ piece.note.text }}</span>
                        <span v-if="piece.note.tags?.length" class="real-book-note-tags">
                          <span v-for="tag in piece.note.tags" :key="tag" class="real-book-note-tag">#{{ tag }}</span>
                        </span>
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
                    <header class="real-book-page-head">{{ flipBackHeader }}</header>
                    <div class="real-book-page-body">
                      <template v-for="piece in flipBackPieces" :key="`back-${piece.key}`">
                        <p
                          v-if="piece.kind === 'text'"
                          class="real-book-para"
                          :data-p="piece.original"
                        ><template v-for="(s, j) in piece.segs" :key="j"><span v-if="s.noteId" class="real-book-note-anchor" :data-note-anchor-id="s.noteId" role="button" tabindex="0" aria-label="查看这条批注" @click.stop="emit('edit-note', s.noteId)" @mouseup.stop @keydown.enter.stop.prevent="emit('edit-note', s.noteId)" @keydown.space.stop.prevent="emit('edit-note', s.noteId)"></span><mark v-else-if="s.hit" class="search-hit">{{ s.text }}</mark><mark v-else-if="s.hl" :class="['hl-mark', 'hl-' + (s.color ?? 'yellow')]">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></p>
                        <figure v-else-if="piece.kind === 'image'" class="real-book-image" :style="{ height: `${piece.displayHeight}px` }">
                          <img v-if="bookImageSrc(piece.file)" :src="bookImageSrc(piece.file)" :alt="piece.caption" draggable="false" />
                          <figcaption v-if="piece.caption">{{ piece.caption }}</figcaption>
                        </figure>
                        <aside
                          v-else-if="piece.kind === 'note'"
                          :class="['real-book-note', handwritingNoteClass, { 'is-ai': piece.note.source === 'ai' }]"
                          :data-note-id="piece.note.id"
                        >
                          <span class="real-book-note-label">笔记<span v-if="piece.note.source === 'ai'" class="real-book-note-source">AI</span></span>
                          <span class="real-book-note-text">{{ piece.note.text }}</span>
                          <span v-if="piece.note.tags?.length" class="real-book-note-tags">
                            <span v-for="tag in piece.note.tags" :key="tag" class="real-book-note-tag">#{{ tag }}</span>
                          </span>
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
  /* 纸的三层色：纸身、受光面、暖阴影。
     真值由 JS 按主题下发（见 REALBOOK_PALETTE）；这里只留兜底，
     保证组件脱离 Reader 单独渲染时仍是一张象牙纸。夜间主题下发深纸。 */
  --rb-paper-warm: #efd8b3;
  --rb-paper-lit: #f9e9cc;
  --rb-paper-shade: #c6a374;
  /* 桌面：参考图是一张浅暖色的书桌，光从上方来，画面下缘压出一道暗带。 */
  --rb-desk: #c8b8a1;
  --rb-desk-lit: #e0d1bb;
  --rb-desk-deep: #6c6255;
  /* 封面与书脊：参考图是一本深灰绿布壳书——封面只从纸页四边露出一圈，
     书脊在上下两端露出一小截脊头。日间主题不用浅色纸壳。 */
  --rb-cover-lit: #58665b;
  --rb-cover-mid: #48554c;
  --rb-cover-deep: #2a332d;
  /* 纸垛的切口、折缝与书心的暗色：比纸自身的暖阴影深一档。 */
  --rb-fold-shadow: 58 36 16;
  /* 页内批注：墨色跟着主题变亮/变深，底色仍从纸色派生，夜里不会出现一张白卡。 */
  --rb-note-ink: color-mix(in srgb, #a33e2f 72%, var(--reader-paper-text, #2f2a24));
  --rb-note-label: color-mix(in srgb, #8a6648 76%, var(--reader-paper-text, #2f2a24));
  --rb-note-tag: color-mix(in srgb, #8b5e3c 82%, var(--reader-paper-text, #2f2a24));
  --rb-note-line: color-mix(in srgb, #a9552e 52%, transparent);
  --rb-note-anchor-bg: color-mix(in srgb, #a9552e 88%, var(--reader-paper-text, #2f2a24));
  --rb-note-anchor-ink: color-mix(in srgb, #fff7e6 94%, var(--rb-paper-lit));
}

/* 书台：参考图是一张实拍感的书桌照——浅暖色桌面、顶光、四周轻压暗，
   画面下缘还压着一道深色带。层次由暖纸页与桌面阴影共同承担。 */
.real-book-stage:not(.is-sheet) {
  background-color: var(--rb-desk, #c8b8a1);
  background-image:
    /* 顶光：中上方一片柔光，桌面四角自然收暗。 */
    radial-gradient(92% 80% at 48% 3%, color-mix(in srgb, var(--rb-desk-lit, #dccdb8) 82%, transparent) 0%, transparent 64%),
    /* 书桌四周的压暗：让书从桌面里浮出来，而不是贴在一张平色卡上。 */
    radial-gradient(136% 116% at 50% 40%, transparent 44%, color-mix(in srgb, var(--rb-desk-deep, #6c6255) 30%, transparent) 100%),
    /* 画面下缘的暗带：参考图底部是一条沉下去的深色边。 */
    linear-gradient(180deg, transparent 82%, color-mix(in srgb, var(--rb-desk-deep, #6c6255) 62%, transparent) 100%),
    /* 桌面细纹：极淡的直纹，只在放大时看得出，不做成布纹。 */
    repeating-linear-gradient(94deg, rgba(255, 255, 255, 0.022) 0 1px, transparent 1px 5px),
    linear-gradient(180deg, color-mix(in srgb, var(--rb-desk-lit, #e0d1bb) 30%, transparent), transparent 34%);
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

/* 左上角的圆形返回键：参考图里它浮在桌面左上角，浅色半透明圆钮 + 深色箭头。
   它属于「看书的场景」而不是工具栏，不随顶栏一起收起。 */
.real-book-back {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 14;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--rb-ui-ink, #2e2c26) 10%, transparent);
  border-radius: 50%;
  background: var(--rb-ui-bg, rgba(250, 244, 232, 0.78));
  color: var(--rb-ui-ink, rgba(46, 44, 38, 0.82));
  box-shadow:
    0 2px 10px rgba(52, 44, 32, 0.14),
    inset 0 1px 0 rgba(255, 252, 243, 0.40);
  backdrop-filter: blur(8px) saturate(0.9);
  cursor: pointer;
  transition: background 140ms ease, transform 140ms ease;
}

.real-book-back:hover {
  background: color-mix(in srgb, var(--rb-ui-bg, rgba(250, 244, 232, 0.78)) 84%, var(--rb-ui-ink, #2e2c26) 16%);
}

.real-book-back:active { transform: scale(0.96); }
.real-book-back:focus-visible { outline: 2px solid var(--r-focus, #2f7fd0); outline-offset: 2px; }
.real-book-back svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
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

/* 手机单页：舞台必须是纵向 flex，视口才能撑满剩余高度。
   桌面沿用画布固有高度反撑的老构图（书更大、超出视口的一截由 overflow 裁掉），
   只在单页时切换，避免改动桌面已校好的画面。 */
.real-book-stage.is-phone {
  display: flex;
  flex-direction: column;
}
.real-book-viewport {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  /* 页面浮在纸垛上会把整本书向上顶：顶部让出这一截，书页顶缘才不会被裁掉。
     书脚下面还要露出封面包边与投影，同样留出一段。 */
  padding-top: var(--rb-lift-max, 0px);
  padding-bottom: var(--rb-block-band, 0px);
}

.real-book-stage.is-sheet .real-book-viewport { padding-bottom: 0; }

.real-book-book {
  /* 透视提到书体层：缩放、俯仰与两页的 V 形折角都在同一层，页面（子级）才吃得到同一个透视。
     视距取 2800px：1750px 是贴着桌面拍特写的近距广角，翻动页一离开桌面就被放大两三成，
     纸的上下缘伸到书外，看着像一张被撕下来的纸。拉远到 2800px 后，纸绕书脊转一整程，
     投影尺寸与静止页只差几个百分点，翻页才像「同一页纸在转」而不是「另一张纸盖上来」。 */
  perspective: 2800px;
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
  /* 硬壳书的书页四角是裁切出来的硬角：只留 2px 防锯齿，不做圆角卡片。 */
  border-radius: 2px;
  /* 纸页浮在纸垛上：外缘落到桌面上留一道柔影，纸页自身的边再收一线暗边，
     浅色桌面上才看得出纸的边界。 */
  box-shadow:
    0 2px 8px rgba(64, 52, 36, 0.20),
    0 12px 26px rgba(64, 52, 36, 0.10),
    inset 0 1px 0 rgba(255, 251, 240, 0.34),
    inset 0 -1px 0 rgba(96, 74, 46, 0.10);
  display: grid;
  grid-template-rows: var(--rb-head-height) 1fr var(--rb-foot-height);
  /* 纸面质感：参考图是一张几乎均匀的象牙纸，只有中央微亮、四周略沉。
     不再用「上缘强光 + 下缘强沉」的塑形光——那会把纸读成一块立起来的板。
     纸色与明暗都从主题纸派生；弧面明暗仍画在背景层（文字之下）。 */
  background-color: var(--rb-paper-warm);
  background-image:
    /* 上下缘的老纸暗边：参考图的页顶与页脚都压着一道暖影。 */
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--rb-paper-shade) 15%, transparent) 0%,
      transparent 8%,
      transparent 90%,
      color-mix(in srgb, var(--rb-paper-shade) 17%, transparent) 100%
    ),
    /* 页脚与纸垛的交界只压一线接触影：更深的影子由纸垛自己的上缘承担。 */
    linear-gradient(
      0deg,
      color-mix(in srgb, var(--rb-paper-shade) 8%, transparent) 0%,
      transparent 3.5%
    ),
    /* 纸心微亮、四角收暗：参考图的纸面几乎是一个均匀的暖乳色，
       只在四角极轻地压一点，不能读成打了聚光灯。 */
    radial-gradient(
      68% 60% at 50% 42%,
      color-mix(in srgb, var(--rb-paper-lit) 16%, transparent) 0%,
      transparent 52%,
      color-mix(in srgb, var(--rb-paper-shade) 18%, transparent) 100%
    ),
    /* 纸面受光：光从上方斜落，纸的上半页偏亮、下半页转暖沉下去。
       参考图的纸不是一张均匀的色卡，这条极缓的斜面光是「纸有弧面」的线索。 */
    linear-gradient(
      172deg,
      color-mix(in srgb, var(--rb-paper-lit) 12%, transparent) 0%,
      transparent 38%,
      color-mix(in srgb, var(--rb-paper-shade) 5%, transparent) 82%,
      color-mix(in srgb, var(--rb-paper-shade) 9%, transparent) 100%
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
  /* 参考图的纸面有一层很淡的纤维与斑点：只做质感，不参与塑形。 */
  opacity: 0.52;
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
  width: 2px;
  pointer-events: none;
  opacity: 0.42;
  background:
    repeating-linear-gradient(
      180deg,
      rgba(255, 250, 234, 0.20) 0 1px,
      rgba(100, 82, 55, 0.05) 1px 2px,
      transparent 2px 8px,
      rgba(100, 82, 55, 0.04) 8px 9px
    );
}

.real-book-left::before {
  left: 0;
  border-radius: 2px 0 0 2px;
}

.real-book-right::before {
  right: 0;
  border-radius: 0 2px 2px 0;
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
  /* 硬壳书的书页：外缘两角是硬角。靠书脊的上角按纸垛厚度拱起一段，
     从书脊到平直段画出一道圆弧——这是参考图里右页（或左页）上缘的弯。
     整页还按本半摞纸的厚度向上抬起（--rb-lift-left），页面才浮在纸垛上。 */
  border-radius: 2px;
  /* 书脊侧的上角不是一小截圆角：纸页从书脊向外是一段很长的缓拱，
     横向半径取页宽的三分之一，才画得出参考图那条横跨近半页的弧。 */
  border-top-right-radius: calc(var(--rb-page-width) * 0.34) var(--rb-arch-left, 0px);
  box-shadow: inset 0 1px 0 rgba(255, 250, 234, 0.28);
  transform-origin: right center;
  transform: translateY(calc(-1 * var(--rb-lift-left, 0px))) rotateY(var(--rb-bend, 0deg));
  /* 外缘（左侧）的弯折：纸边伏向桌面，最外一线受光，随即转暗再散开；
     靠脊折痕只留页宽 4–6% 的一小段柔暗，外侧补一层极浅滚光。
     参考图的折缝是一条窄软影（约一手掌宽），不是一条宽暗带；
     暗部再宽就回到「两块纸板拼在一起」的读感。 */
  --rb-page-curve:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--rb-paper-shade) 16%, transparent) 0%,
      color-mix(in srgb, var(--rb-paper-lit) 18%, transparent) 1.4%,
      color-mix(in srgb, var(--rb-paper-lit) 8%, transparent) 4%,
      transparent 9%
    ),
    linear-gradient(
      270deg,
      color-mix(in srgb, var(--rb-paper-shade) 10%, transparent) 0%,
      color-mix(in srgb, var(--rb-paper-shade) 5%, transparent) 2.5%,
      transparent 6%,
      color-mix(in srgb, var(--rb-paper-lit) 4%, transparent) 9%,
      transparent 14%
    );
}

.real-book-right {
  /* 右上 / 右下是外缘，硬角；靠脊的左上角按纸垛厚度拱起一段。 */
  border-radius: 2px;
  border-top-left-radius: calc(var(--rb-page-width) * 0.34) var(--rb-arch-right, 0px);
  box-shadow: inset 0 1px 0 rgba(255, 250, 234, 0.28);
  transform-origin: left center;
  transform: translateY(calc(-1 * var(--rb-lift-right, 0px))) rotateY(calc(-1 * var(--rb-bend, 0deg)));
  /* 右页靠脊一侧（左缘）同样只留一段窄柔影与极浅滚光，与左页镜像；
     外缘（右侧）也有一道弯折的明暗，纸边伏向桌面。 */
  --rb-page-curve:
    linear-gradient(
      270deg,
      color-mix(in srgb, var(--rb-paper-shade) 16%, transparent) 0%,
      color-mix(in srgb, var(--rb-paper-lit) 18%, transparent) 1.4%,
      color-mix(in srgb, var(--rb-paper-lit) 8%, transparent) 4%,
      transparent 9%
    ),
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--rb-paper-shade) 10%, transparent) 0%,
      color-mix(in srgb, var(--rb-paper-shade) 5%, transparent) 2.5%,
      transparent 6%,
      color-mix(in srgb, var(--rb-paper-lit) 4%, transparent) 9%,
      transparent 14%
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
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -9px;
  right: -9px;
  pointer-events: none;
  /* 参考图的折缝是一条窄软影：约 18px 宽，中心只比两侧略深，
     没有贯穿的黑缝。它画在两页之上，让 4° 的硬折读成一条纸缝。 */
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--rb-paper-shade) 5%, transparent) 30%,
    color-mix(in srgb, var(--rb-paper-shade) 12%, transparent) 50%,
    color-mix(in srgb, var(--rb-paper-shade) 5%, transparent) 70%,
    transparent 100%
  );
}

/* 折缝中心的一线：两页在书脊处对折的脊线，只有 1px，避免把书心画成一条黑缝。 */
.real-book-gutter::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -0.5px;
  width: 1px;
  background: color-mix(in srgb, var(--rb-paper-shade) 30%, transparent);
  pointer-events: none;
}

/* 书脚的桥：左右两摞纸各自绕书脊转 4°，中间会裂开一道 V 形缝，
   书脊从缝里露出来。这道窄桥按同一套页边纹理补住书心，让纸垛在书脊下连成一片。 */
.real-book-fold-bridge {
  display: none;
  position: absolute;
  top: 100%;
  left: -18px;
  width: 36px;
  height: calc(max(1px, var(--rb-block-left, 0px), var(--rb-block-right, 0px)) * 2.1 * var(--rb-edge-visibility, 1));
  pointer-events: none;
  border-radius: 0 0 50% 50% / 0 0 20px 20px;
  background:
    linear-gradient(180deg, rgba(72, 60, 42, 0.18) 0%, rgba(72, 60, 42, 0.01) 18%, rgba(255, 252, 240, 0.10) 52%, rgba(72, 60, 42, 0.08) 86%, rgba(72, 60, 42, 0.16) 100%),
    repeating-linear-gradient(
      180deg,
      color-mix(in srgb, var(--rb-paper-warm) 86%, #a89273) 0 0.6px,
      color-mix(in srgb, var(--rb-paper-lit) 96%, #fffdf3) 0.6px 1.5px,
      color-mix(in srgb, var(--rb-paper-warm) 90%, #c3ac86) 1.5px 1.8px
    ),
    linear-gradient(180deg, var(--rb-paper-warm), var(--rb-paper-lit) 34%, var(--rb-paper-warm) 78%, var(--rb-paper-shade));
  box-shadow: 0 3px 7px rgba(58, 46, 30, 0.20);
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
  /* 参考图里的书压在浅暖桌面上：书脚一圈接触影较实，远处散开成一片柔灰。
     深色桌布下那种厚重的黑边在这里会显得脏。 */
  background:
    radial-gradient(52% 34% at 50% 0%, rgba(54, 46, 34, 0.26), rgba(0, 0, 0, 0) 76%),
    radial-gradient(74% 66% at 50% 10%, rgba(54, 46, 34, 0.12), rgba(0, 0, 0, 0) 72%),
    radial-gradient(96% 92% at 50% 22%, rgba(54, 46, 34, 0.07), rgba(0, 0, 0, 0) 78%);
  filter: blur(calc(13px + var(--rb-lift, 0px) * 0.5));
  opacity: calc(1 - var(--rb-lift, 0px) * 0.018);
  pointer-events: none;
}

/* 深灰绿布壳：参考图里封面只从纸页四边露出一圈，书脊侧包边更宽。
   布壳比页面多出「纸垛厚度」那一段，书脚下面才看得到它兜着整本书。 */
.real-book-board {
  position: absolute;
  top: -6px;
  width: calc(var(--rb-page-width) + 18px);
  /* 封面是平摊在桌面上的硬壳：高度固定，纸页浮在纸垛上时从封面包边上方露头。
     若跟着纸垛加高，书脚会出现一道台阶——参考图的封面下沿始终是一条直线。 */
  height: calc(var(--rb-page-height) + 16px);
  border-radius: 4px;
  background:
    /* 布面受光与包边：上缘提亮一线，下缘压深，四周有一圈布纹的细边。 */
    linear-gradient(180deg, rgba(255, 255, 255, 0.13), transparent 10%, transparent 86%, rgba(0, 0, 0, 0.20)),
    repeating-linear-gradient(96deg, rgba(255, 255, 255, 0.028) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(6deg, rgba(0, 0, 0, 0.05) 0 1px, transparent 1px 4px),
    linear-gradient(180deg, var(--rb-cover-lit, #58665b), var(--rb-cover-mid, #48554c) 52%, var(--rb-cover-deep, #2a332d));
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    0 2px 5px rgba(44, 38, 28, 0.26),
    0 16px 34px rgba(48, 40, 30, 0.16);
  transform-style: preserve-3d;
  pointer-events: none;
}

/* 包边压槽：布壳比纸页大一整圈，槽线贴着纸页外缘，读起来才像「纸页装进壳里」。 */
/* 封面包边只有 3px：参考图的封面是一条很窄的深色边，不是一圈厚壳。 */
.real-book-board::after {
  content: '';
  position: absolute;
  inset: 5px;
  border: 1px solid rgba(0, 0, 0, 0.30);
  border-radius: 2px;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.05),
    inset 0 0 5px rgba(0, 0, 0, 0.18);
  pointer-events: none;
}

.real-book-board-left {
  left: -9px;
  transform-origin: right center;
  transform: rotateY(var(--rb-bend, 0deg)) translateZ(-12px);
}

.real-book-board-right {
  right: -9px;
  transform-origin: left center;
  transform: rotateY(calc(-1 * var(--rb-bend, 0deg))) translateZ(-12px);
}

/* 书脊：封面在中间折成的圆弧脊背。它藏在两页后面，只在封面高出纸页的
   上下两端露出来——正是参考图里书脊头那一小截。 */
.real-book-spine {
  position: absolute;
  left: 50%;
  top: -5px;
  /* 脊背只到封面的下缘：参考图的书脊顶与书脚都被封面包边压平，不另凸出一截。 */
  bottom: -8px;
  width: 22px;
  transform: translateX(-50%) translateZ(-6px);
  /* 书脊下端与封面平齐：画成圆头会在书脚正中出现一个半圆的小凸起。 */
  border-radius: 11px 11px 0 0;
  background:
    /* 脊背的圆弧：中间被压深，两侧滚出受光。 */
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--rb-cover-deep) 24%, transparent) 0%,
      color-mix(in srgb, var(--rb-cover-deep) 68%, transparent) 34%,
      color-mix(in srgb, var(--rb-cover-deep) 88%, transparent) 50%,
      color-mix(in srgb, var(--rb-cover-deep) 68%, transparent) 66%,
      color-mix(in srgb, var(--rb-cover-deep) 24%, transparent) 100%
    ),
    linear-gradient(180deg, var(--rb-cover-lit), var(--rb-cover-mid));
  box-shadow:
    inset 0 0 0 1px rgba(255, 249, 234, 0.16),
    0 3px 8px rgba(60, 48, 30, 0.20);
  pointer-events: none;
}

/* 脊头：参考图里书脊在上下两端露出的一小截锁线。一圈深色细边 + 虚线，
   只有 14×5px，不抢正文，但让「这是装订起来的」有一个落点。 */
.real-book-spine::before,
.real-book-spine::after {
  content: '';
  position: absolute;
  left: 50%;
  width: 14px;
  height: 5px;
  transform: translateX(-50%);
  border-radius: 2px;
  background:
    repeating-linear-gradient(
      90deg,
      color-mix(in srgb, var(--rb-cover-deep) 62%, transparent) 0 1px,
      transparent 1px 3px
    ),
    color-mix(in srgb, var(--rb-cover-lit) 78%, #fffdf4);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--rb-cover-deep) 38%, transparent);
}

/* 书脊顶与书脚都被包边压住，不再画外露的脊头锁线。 */
.real-book-spine::before { display: none; }
.real-book-spine::after { display: none; }

.real-book-board-right::after {
  border-radius: 2px 13px 13px 2px;
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
  /* 本半摞纸的可见高度 = 页面抬起的量：书脚那一面正好从页脚长到封面。
     靠书脊的上角按拱起量削掉一块，纸页的纸色从缺口里露出来。 */
  --rb-block-h: var(--rb-lift-left, 0px);
  --rb-block-arch: var(--rb-arch-left, 0px);
}

.real-book-block-right {
  right: 0;
  --rb-block-h: var(--rb-lift-right, 0px);
  --rb-block-arch: var(--rb-arch-right, 0px);
  transform-origin: left center;
  transform: rotateY(calc(-1 * var(--rb-bend, 0deg)));
}

/* 纸垫：书页被纸垛抬起后，页脚下面是纸页的延续。书脊侧的拱起缺口露出的是
   这层纸（而不是封面），所以参考图里页脚在书脊一侧是「纸往下多弯了一段」。 */
.real-book-block::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* 纸垫在下、断面在上：::after 默认会盖在 ::before 上，必须显式压回去。 */
  z-index: 0;
  /* 多出 2px 压进页脚：纸页与纸垫之间不能留一道发白的分界线。 */
  height: calc(max(1px, var(--rb-block-h, 0px)) + 2px);
  background:
    linear-gradient(90deg, rgba(255, 252, 240, 0.16) 0%, transparent 16%, transparent 84%, rgba(96, 74, 46, 0.06) 100%),
    linear-gradient(
      180deg,
      var(--rb-paper-warm) 0%,
      color-mix(in srgb, var(--rb-paper-warm) 90%, var(--rb-paper-shade)) 70%,
      color-mix(in srgb, var(--rb-paper-warm) 86%, var(--rb-paper-shade)) 100%
    );
  pointer-events: none;
}

/* 书口（纸垛断面）：参考图里书脚是一摞很厚的纸——几百道细页边叠成一条
   沉下去的暖褐色带子，靠书脊一侧的顶边向上拱起，落在封面上的下缘是一条直线。

   面画在**书页同一平面**里：立面在俯看时会被纸页自己挡掉；而参考图的厚纸垛
   正好是书页被托起后、页脚到封面之间露出的那一条带子，高度就是页面的抬升量。
   靠书脊的上角用椭圆圆角削开，露出底下那层纸——就是参考图页脚下缘的拱弯。 */
.real-book-block::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  height: max(1px, var(--rb-block-h, 0px));
  border-radius: 0;
  /* 页脚与纸垛的交界压一道窄影；整摞纸落在封面上再留一道接触影。 */
  box-shadow:
    inset 0 2px 3px rgba(60, 44, 26, 0.34),
    0 2px 5px rgba(50, 38, 24, 0.26);
  background:
    /* 断面受光：上缘贴着纸页有一线亮边，往下沉入阴影，落到封面再收一道暗边。 */
    linear-gradient(180deg, rgba(255, 250, 236, 0.14) 0%, rgba(60, 44, 26, 0.02) 10%, rgba(60, 44, 26, 0.04) 64%, rgba(60, 44, 26, 0.16) 100%),
    /* 逐张纸的页边：极低对比的细线，远看是一条沉静的纸边，近看数得出层数。 */
    repeating-linear-gradient(
      180deg,
      rgba(46, 36, 22, 0.10) 0 1px,
      rgba(255, 250, 235, 0.035) 1px 2.6px
    ),
    /* 整面墙比页面的纸暗一大截：它是侧对光的纸边，不是又一张纸。 */
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--rb-paper-warm) 48%, #3a352a),
      color-mix(in srgb, var(--rb-paper-warm) 44%, #373328) 60%,
      color-mix(in srgb, var(--rb-paper-warm) 40%, #333026)
    );
}

/* 靠书脊一侧的上角拱起：纸垛在书脊处最薄，往外逐渐长到满高。
   横向半径同样取页宽的三分之一，与纸页上缘的缓拱对齐，交界才是一条连续的弧。 */
.real-book-block-left::before {
  border-top-right-radius: calc(var(--rb-page-width) * 0.34) var(--rb-block-arch, 0px);
}

.real-book-block-right::before {
  border-top-left-radius: calc(var(--rb-page-width) * 0.34) var(--rb-block-arch, 0px);
}

/* 上切口：书页顶端那一面。它和底切口使用同一套纸层线，
   只是绕页顶向后倒过去；没有它，俯看时书的上缘仍是一条剪纸边。 */
.real-book-block-top {
  /* 上切口被封面的上包边压住；纸页顶端不露断面，画出来反而像书顶开了一条口。 */
  display: none;
  position: absolute;
  top: calc(-1 * var(--rb-page-height));
  left: 0;
  right: 0;
  height: max(1px, var(--rb-block-h, 0px));
  transform-origin: center bottom;
  transform: rotateX(60deg);
  border-radius: 3px 3px 0 0;
  background:
    linear-gradient(180deg, rgba(255, 250, 235, 0.16), rgba(72, 60, 42, 0.06) 26%, rgba(72, 60, 42, 0.18)),
    repeating-linear-gradient(
      90deg,
      color-mix(in srgb, var(--rb-paper-warm) 82%, #ab9270) 0 0.8px,
      color-mix(in srgb, var(--rb-paper-lit) 97%, #fdf9ec) 0.8px 2.1px,
      color-mix(in srgb, var(--rb-paper-warm) 90%, #c1a97f) 2.1px 2.6px
    );
  box-shadow:
    inset 0 1px 0 rgba(255, 248, 230, 0.20),
    inset 0 -1px 1px rgba(72, 60, 42, 0.14);
}

/* 逐层纸边：每层沿页脚向下、向后错开一点，叠成数得清层数的纸摞。
   断面现在由 ::before 的密线一次画完，这些逐层片只保留 DOM 与偏移量
   （书厚读数、测试与调试都还认它们），视觉上不再重复画一遍。 */
.real-book-block i {
  display: none;
  position: absolute;
  left: 1px;
  right: 1px;
  height: 2px;
  border-radius: 0 0 2px 2px;
  /* 纸边比纸面略深：从象牙纸里压出来，四套主题下都不会发灰或发紫。 */
  background: color-mix(in srgb, var(--rb-paper-warm) 86%, #9a825c);
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--reader-paper-text, #2f2a24) 10%, transparent),
    0 -1px 0 rgba(255, 248, 232, 0.12);
}

.real-book-para {
  margin: 0 0 0.45em;
  text-indent: 2em;
}

.real-book-para.para-continued {
  text-indent: 0;
}

/* CSS 3D 回退的页内图片：高度由书台按版心换算，图按 contain 装进去。 */
.real-book-image {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  margin: 0.2em 0;
  overflow: hidden;
}

.real-book-image img {
  display: block;
  max-width: 100%;
  max-height: calc(100% - 1.5em);
  object-fit: contain;
}

.real-book-image figcaption {
  max-width: 100%;
  margin-top: 0.25em;
  overflow: hidden;
  font-size: 0.72em;
  line-height: 1.3;
  color: color-mix(in srgb, var(--reader-paper-text, #2f2a24) 55%, transparent);
  text-align: center;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/*
 * 页内批注：读者写在段落下面的旁批。
 *
 * 不是卡片：不铺底色、不画圆角，只用左侧一道竖线把批注和正文分开。
 * 竖线从行首缩进处起笔，标签、批注、#tag 都排在线的右边，像书页边缘的手写批注。
 */
.real-book-note {
  display: block;
  margin: 0.08em 0 0 2em;
  padding: 0.02em 0 0.08em 0.8em;
  border-left: 1.5px solid var(--rb-note-line, rgba(169, 85, 46, 0.52));
  border-radius: 0;
  background: none;
  color: var(--rb-note-ink, #8f3d2d);
  font-size: 0.92em;
  line-height: 1.68;
  text-align: left;
  text-indent: 0;
  cursor: pointer;
  user-select: none;
}

.real-book-note + .real-book-note {
  margin-top: 0.38em;
}

.real-book-note:focus-visible {
  outline: 2px solid var(--r-focus, #2f7fd0);
  outline-offset: 2px;
}

.real-book-note-label {
  display: block;
  margin-bottom: 0.2em;
  color: var(--rb-note-label, #8a6648);
  font-size: 0.62em;
  letter-spacing: 0.08em;
  line-height: 1.4;
  opacity: 1;
}

.real-book-note-source {
  display: inline-block;
  margin-left: 0.35em;
  padding: 0 0.35em;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 0.9em;
  letter-spacing: 0;
  line-height: 1.3;
}

.real-book-note-text {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.real-book-note-tags {
  display: flex;
  flex-direction: column;
  gap: 0.08em;
  margin-top: 0.28em;
  color: var(--rb-note-tag, #8b5e3c);
  font-family: var(--rb-font-family);
  font-size: 0.72em;
  line-height: 1.45;
}

.real-book-note-tag {
  display: block;
  white-space: pre-wrap;
}

.real-book-note.handwriting-kai { font-family: 'KaiTi', '楷体', serif; }
.real-book-note.handwriting-xingshu { font-family: 'STXingkai', '华文行楷', 'KaiTi', serif; }

/* 行内「注」标记：圆形暖褐底、米白字，贴在划线末尾。
   文字用伪元素给，正文文本节点里没有这个字——否则选区与进度坐标会整体偏移。 */
.real-book-note-anchor {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.32em;
  height: 2.32em;
  margin: 0 0.16em;
  border: 0;
  border-radius: 50%;
  background: var(--rb-note-anchor-bg, #a9552e);
  color: var(--rb-note-anchor-ink, #fff7e6);
  font-family: var(--rb-font-family);
  font-size: 0.58em;
  font-weight: 600;
  line-height: 1;
  text-indent: 0;
  vertical-align: 0.18em;
  cursor: pointer;
  user-select: none;
}

.real-book-note-anchor::before { content: '注'; }
.real-book-note-anchor:focus-visible { outline: 2px solid var(--r-focus, #2f7fd0); outline-offset: 2px; }

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
  /* 纸的书脊侧钉在书缝里：整张纸只沿观者方向平移（translateZ，逐帧下发），
     不做倾斜与屏面内转动——那会把书脊侧那条边推离书缝，中缝上露出空白纸带。
     平移不改变 x/y，书脊侧始终落在 `left: 50%` 这条折缝上。 */
  transform-origin: 0 0;
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

@media (prefers-reduced-motion: reduce) {
  .real-book-book { transition: none !important; }
}
</style>
