import { ref } from 'vue'
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
  /** naive-ui 的 message API：同形注入，搬来的代码不用改调用姿势 */
  message: { error: (text: string) => void; success: (text: string) => void; warning: (text: string) => void; info: (text: string) => void }
  /** 标记域（同形注入：被搬代码里的 marks.addHighlight / marks.addNote 原样可用） */
  marks: {
    addHighlight: (range: { start: number; end: number; text: string } | null) => Promise<boolean>
    addNote: (range: { start: number; end: number; text: string } | null, note: string) => Promise<boolean>
  }
}

export function useReaderSelection(deps: ReaderSelectionDeps) {
  const { paragraphStarts, normalizedBody, hasContent, message, marks } = deps

const selPopupX = ref(0)
const selPopupY = ref(0)
const lastSelRect = ref({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 })
function applySelPopupPosition(popup: { width: number; height: number }) {
  const pos = selectionPopupPosition({
    range: lastSelRect.value,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    popup,
  })
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
    applySelPopupPosition({ width: 360, height: 88 })
    showSelPopup.value = true
  }, 0)
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
    showSelPopup,
    selectedExcerpt,
    selectedRange,
    showDirectNote,
    directNoteDraft,
    selectionOffsets,
    onContentMouseup,
    closeSelectionTools,
    copySelectedText,
    openDirectNote,
    saveDirectNote,
    addHighlight,
  }
}
