import { ref, watch } from 'vue'
import { selectionRangeOffsets } from './selectionOffsets'
import { selectionPopupPosition } from './readerHelpers'

/**
 * 阅读器的「选区工具条」域：选中正文后浮出的那条工具条，以及选区 → 规范化坐标的接线。
 *
 * 从 Reader.vue 搬出来便于单独维护。坐标换算本身是纯函数（见 selectionOffsets.ts，
 * 有独立单测），这里只管状态与点击动作；依赖（段落下标表、规范化正文、提示、划线接口）
 * 由 Reader.vue 注入，模板沿用同名变量。
 * 注意：AI 相关的三个动作（问 AI / 存回批注）留在阅读器里调用助手域，不在这个模块内。
 */
export interface ReaderSelectionDeps {
  /** 每段在规范化正文里的起始下标 */
  paragraphStarts: () => number[]
  /** 规范化正文（段落以空行连接） */
  normalizedBody: () => string
  /** 正文容器是否就绪：没就绪就不认选区 */
  hasContent: () => boolean
  /**
   * @deprecated 已不再使用：俯仰时也把工具条放在选区下方。
   * 保留参数是为了不打断既有调用方，行为已改为统一读选区几何。
   */
  fixedAnchor?: () => boolean
  /** naive-ui 的 message API：同形注入，搬来的代码不用改调用姿势 */
  message: { error: (text: string) => void; success: (text: string) => void; warning: (text: string) => void; info: (text: string) => void }
  /** 标记域（同形注入：被搬代码里的 marks.addHighlight / marks.addNote 原样可用） */
  marks: {
    addHighlight: (range: { start: number; end: number; text: string } | null) => Promise<boolean>
    addNote: (range: { start: number; end: number; text: string } | null, note: string) => Promise<boolean>
  }
}

/** 划词菜单可用的动作 id。 */
export type SelectionActionId =
  | 'ask' | 'copy' | 'highlight' | 'note' | 'read'
  | 'explainWord' | 'explain-text' | 'translate'
  | 'who' | 'backstory' | 'chat'

export interface SelectionAction {
  id: SelectionActionId
  label: string
  /** 工具栏上的短标题，无文字时用 aria-label */
  aria: string
}

/**
 * 划词菜单里的动作。工具栏只展示被「钉住」的那几项，其余收在「⋯」菜单里。
 * 这是 Sider 的行为：菜单项右侧图钉可切换，钉住后直接出现在划词工具条上。
 */
export const SELECTION_ACTIONS: readonly SelectionAction[] = [
  { id: 'ask', label: '询问 AI', aria: '询问 AI' },
  { id: 'copy', label: '复制', aria: '复制' },
  { id: 'highlight', label: '高亮', aria: '高亮' },
  { id: 'note', label: '批注', aria: '批注' },
  { id: 'read', label: '朗读', aria: '朗读' },
  { id: 'explainWord', label: '解释字词', aria: '解释字词' },
  { id: 'explain-text', label: '解释这段', aria: '解释这段' },
  { id: 'translate', label: '翻译成简体中文', aria: '翻译' },
  { id: 'who', label: '这个人物是谁', aria: '这个人是谁' },
  { id: 'backstory', label: '这件事之前发生了什么', aria: '之前发生了什么' },
  { id: 'chat', label: '继续追问', aria: '继续追问' },
]

/** 默认钉住「询问 AI」与翻译、继续追问：第一个按钮就是行内问答入口。 */
export const DEFAULT_PINNED: readonly SelectionActionId[] = ['ask', 'translate', 'chat']

const SEL_PIN_STORAGE_KEY = 'spbf:selection-pinned'

function readPinned(): SelectionActionId[] {
  try {
    const raw = localStorage.getItem(SEL_PIN_STORAGE_KEY)
    if (!raw) return [...DEFAULT_PINNED]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_PINNED]
    const known = new Set(SELECTION_ACTIONS.map((action) => action.id))
    const kept = parsed.filter((id): id is SelectionActionId => typeof id === 'string' && known.has(id as SelectionActionId))
    return kept.length ? kept : [...DEFAULT_PINNED]
  } catch {
    return [...DEFAULT_PINNED]
  }
}



export function useReaderSelection(deps: ReaderSelectionDeps) {
  const { paragraphStarts, normalizedBody, hasContent, message, marks } = deps

// 钉住是「这个阅读器实例」的状态：多个 Reader 实例（多窗口、测试）不能共享一份。
const pinnedActions = ref<SelectionActionId[]>(readPinned())

/** 钉住是个人偏好：写盘失败不影响当前会话，下次启动回退到默认。 */
watch(pinnedActions, (value) => {
  try { localStorage.setItem(SEL_PIN_STORAGE_KEY, JSON.stringify(value)) } catch { /* 配额或隐私模式 */ }
}, { deep: true })

function isPinned(id: SelectionActionId): boolean {
  return pinnedActions.value.includes(id)
}

/**
 * 钉住/取消。返回 false 表示操作被拒绝（至少得留一项，否则工具栏会变成空条）。
 * 提示文案由调用方发，这个模块不直接依赖注入的 message。
 */
function togglePinned(id: SelectionActionId): boolean {
  if (pinnedActions.value.includes(id)) {
    if (pinnedActions.value.length === 1) return false
    pinnedActions.value = pinnedActions.value.filter((item) => item !== id)
    return true
  }
  pinnedActions.value = [...pinnedActions.value, id]
  return true
}
const selPopupX = ref(0)
const selPopupY = ref(0)
/**
 * 划词工具条的实际尺寸（取自 Sider 注入工具条的真实 DOM：191×30）。
 * 定位要按真实尺寸算，否则会偏左、并多让出一段空白。
 */
const SEL_BAR_SIZE = { width: 191, height: 30 }
const lastSelRect = ref({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 })

/**
 * 工具条总在所划文字的**下方**：从选区底边往下放，水平居中于选区。
 * 下方放不下时才翻到上方——那是边界情况，不是默认。
 */
function applySelPopupPosition(popup: { width: number; height: number }) {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  const pos = selectionPopupPosition({ range: lastSelRect.value, viewport, popup, gap: 8, margin: 8 })
  // selectionPopupPosition 默认优先放在下方，只有下方确实放不下才返回 'above'；
  // 这里不覆盖它的返回值，保证「下方优先」的语义由同一个纯函数决定。
  selPopupX.value = pos.x
  selPopupY.value = pos.y
}
const showSelPopup = ref(false)
const selectedExcerpt = ref('')
const selectedRange = ref<{ start: number; end: number; text: string } | null>(null)
const showDirectNote = ref(false)
const directNoteDraft = ref('')


function selectionOffsets(): { start: number; end: number; text: string } | null {
  if (!hasContent()) return null
  // 算法本身在 readerSelection.ts（纯函数，单独有 jsdom 单测）：这里只喂当前选区与下标表
  return selectionRangeOffsets(window.getSelection(), paragraphStarts(), normalizedBody())
}

function onContentMouseup(_e: MouseEvent) {
  setTimeout(() => {
    const sel = selectionOffsets()
    if (!sel) {
      showSelPopup.value = false
      selectedExcerpt.value = ''
      selectedRange.value = null
      return
    }
    selectedRange.value = sel
    selectedExcerpt.value = sel.text.trim()
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null
    const rect = range?.getBoundingClientRect()
    lastSelRect.value = rect
      ? { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height }
      : { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }
    applySelPopupPosition(SEL_BAR_SIZE)
    showSelPopup.value = true
  }, 0)
}

/**
 * 跨页选择：翻页后原生选区已经不存在，两端坐标由书台算好（段落原始下标 + 段内偏移），
 * 这里换算成规范化正文的 start/end，直接把工具条抬起来。
 */
function presentSelectionRange(range: { start: number; end: number }, anchor?: { x: number; y: number }): boolean {
  if (!hasContent()) return false
  const text = normalizedBody().slice(range.start, range.end)
  if (!text.trim()) return false
  selectedRange.value = { ...range, text }
  selectedExcerpt.value = text.trim()
  const point = anchor ?? { x: window.innerWidth / 2, y: window.innerHeight * 0.6 }
  lastSelRect.value = {
    top: point.y - 12,
    right: point.x + 40,
    bottom: point.y + 12,
    left: point.x - 40,
    width: 80,
    height: 24,
  }
  showDirectNote.value = false
  directNoteDraft.value = ''
  applySelPopupPosition({ width: 360, height: 88 })
  showSelPopup.value = true
  return true
}

function closeSelectionTools(clearBrowserSelection = true) {
  showSelPopup.value = false
  showDirectNote.value = false
  directNoteDraft.value = ''
  selectedExcerpt.value = ''
  selectedRange.value = null
  if (clearBrowserSelection) window.getSelection()?.removeAllRanges()
}

async function copySelectedText() {
  const excerpt = selectedExcerpt.value
  if (!excerpt) return
  try {
    await navigator.clipboard.writeText(excerpt)
    message.success('已复制')
    closeSelectionTools()
  } catch {
    message.error('复制失败，请重试')
  }
}

function openDirectNote() {
  if (!selectedRange.value) return
  showSelPopup.value = false
  showDirectNote.value = true
  directNoteDraft.value = ''
  applySelPopupPosition({ width: 340, height: 220 })
}

async function saveDirectNote() {
  const selection = selectedRange.value
  if (!selection) return
  if (await marks.addNote(selection, directNoteDraft.value)) closeSelectionTools()
}

async function addHighlight() {
  const sel = selectedRange.value ?? selectionOffsets()
  showSelPopup.value = false
  if (await marks.addHighlight(sel)) closeSelectionTools()
}

  return {
    selPopupX,
    selPopupY,
    lastSelRect,
    applySelPopupPosition,
    SELECTION_ACTIONS,
    pinnedActions,
    isPinned,
    togglePinned,
    showSelPopup,
    selectedExcerpt,
    selectedRange,
    showDirectNote,
    directNoteDraft,
    selectionOffsets,
    onContentMouseup,
    presentSelectionRange,
    closeSelectionTools,
    copySelectedText,
    openDirectNote,
    saveDirectNote,
    addHighlight,
  }
}
