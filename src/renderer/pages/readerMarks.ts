import { computed, ref } from 'vue'
import type { Annotation, AiMemoryCharacter } from '@shared/types'
import { relocateRange } from '@shared/paragraphSearch'

/**
 * 阅读器的「标记」域：书签、划线、备注的存取与漂移校正。
 *
 * 从 `Reader.vue`（4000+ 行的单体）里整块搬出来，只做这一件事，便于单独测试。
 * 依赖全部由调用方注入，模板沿用同名变量，所以搬动不改变任何界面行为。
 * 刻意不在这里调用 `useMessage()`：那需要组件上下文，会把纯逻辑和 UI 绑死。
 */
export interface ReaderMarksDeps {
  /** 当前书的 id；没有打开书时返回 undefined。 */
  bookId: () => string | undefined
  /** 当前章 id；没有当前章时返回 undefined。 */
  currentChapterId: () => string | undefined
  /** 规范化正文（段落以空行连接）——划线坐标所在的空间。 */
  normalizedBody: () => string
  /** 章节在目录里的次序，用于把标记按阅读顺序排列。 */
  chapterOrder: () => Map<string, number>
  /** 已核实的人物，生词本视图用。 */
  memoryCharacters: () => AiMemoryCharacter[]
  /** 成功/提示/失败三种反馈。 */
  notify: (kind: 'success' | 'info' | 'error', text: string) => void
}

/** 选中的区间（规范化正文坐标 + 原文摘录）。 */
export interface ReaderSelectionRange {
  start: number
  end: number
  text: string
}

/** 生词本只展示前若干条：这是纯视图，不落盘、不加 IPC。 */
const WORDBOOK_TERM_LIMIT = 60

export function useReaderMarks(deps: ReaderMarksDeps) {
  const annotations = ref<Annotation[]>([])
  const lostHighlightIds = ref<Set<string>>(new Set())
  const showMarks = ref(false)
  const editingNoteId = ref('')
  const noteDraft = ref('')

  /** 本章仍然有效的划线（漂移校正后仍找不到的会被标为丢失）。 */
  const currentHighlightRanges = computed(() => {
    const chapterId = deps.currentChapterId()
    if (!chapterId) return []
    return annotations.value.filter(
      (item) => item.chapterId === chapterId && item.kind === 'highlight' && !lostHighlightIds.value.has(item.id),
    )
  })

  /** 本章的书签（每章最多一条）。 */
  const chapterBookmark = computed(
    () => annotations.value.find(
      (item) => item.kind === 'bookmark' && item.chapterId === deps.currentChapterId(),
    ) ?? null,
  )

  /** 按目录顺序排列的全部标记（书签 + 划线）。 */
  const sortedMarks = computed(() => {
    const order = deps.chapterOrder()
    return [...annotations.value].sort(
      (a, b) => (order.get(a.chapterId) ?? 1e9) - (order.get(b.chapterId) ?? 1e9) || a.start - b.start,
    )
  })

  /** 生词本是纯视图：读者划过的词句加上记忆里已核实的人物，都不另建存储。 */
  const wordbookHighlights = computed(() => annotations.value
    .filter((item) => item.kind === 'highlight' && item.excerpt.trim()))
  const wordbookTerms = computed(() => wordbookHighlights.value.slice(0, WORDBOOK_TERM_LIMIT))
  const wordbookTrimmed = computed(() => wordbookHighlights.value.length > wordbookTerms.value.length)
  const wordbookPeople = computed(() => deps.memoryCharacters().filter((item) => item.accuracy === 'normal'))

  async function reload(): Promise<void> {
    const bookId = deps.bookId()
    if (!bookId) return
    const res = await window.api.annotations.list(bookId)
    if (res.ok) annotations.value = res.items
  }

  /** 章节打开后校正本章划线：偏移漂移时按摘录重定位，找不到则标记丢失。 */
  function resolveCurrentChapter(): void {
    const bookId = deps.bookId()
    const chapterId = deps.currentChapterId()
    if (!bookId || !chapterId) return
    const body = deps.normalizedBody()
    for (const item of annotations.value) {
      if (item.chapterId !== chapterId || item.kind !== 'highlight') continue
      const fixed = relocateRange(body, item.start, item.end, item.excerpt)
      if (!fixed) {
        lostHighlightIds.value.add(item.id)
        continue
      }
      if (lostHighlightIds.value.has(item.id)) {
        lostHighlightIds.value = new Set([...lostHighlightIds.value].filter((id) => id !== item.id))
      }
      if (fixed.start !== item.start || fixed.end !== item.end) {
        void window.api.annotations.update(bookId, item.id, { start: fixed.start, end: fixed.end })
        item.start = fixed.start
        item.end = fixed.end
      }
    }
  }

  /** 划线。返回是否成功（失败由调用方决定要不要收起选区工具条）。 */
  async function addHighlight(range: ReaderSelectionRange | null): Promise<boolean> {
    const bookId = deps.bookId()
    const chapterId = deps.currentChapterId()
    if (!range || !bookId || !chapterId) return false
    const res = await window.api.annotations.add({
      bookId,
      chapterId,
      kind: 'highlight',
      start: range.start,
      end: range.end,
      excerpt: range.text,
    })
    if (!res.ok) {
      deps.notify('error', res.message || '划线失败')
      return false
    }
    annotations.value.push(res.item)
    deps.notify('success', '已划线')
    return true
  }

  /** 划线 + 备注。`source` 为 'ai' 表示这条备注是 AI 的结论（读者随后可改写或删掉）。 */
  async function addNote(
    range: ReaderSelectionRange | null,
    note: string,
    options: { source?: 'user' | 'ai'; successText?: string; failureText?: string } = {},
  ): Promise<boolean> {
    const bookId = deps.bookId()
    const chapterId = deps.currentChapterId()
    const text = note.trim()
    if (!range || !text || !bookId || !chapterId) return false
    const res = await window.api.annotations.add({
      bookId,
      chapterId,
      kind: 'highlight',
      start: range.start,
      end: range.end,
      excerpt: range.text,
      note: text,
      ...(options.source === 'ai' ? { noteSource: 'ai' as const } : {}),
    })
    if (!res.ok) {
      deps.notify('error', res.message || options.failureText || '保存失败')
      return false
    }
    annotations.value.push(res.item)
    deps.notify('success', options.successText ?? '备注已保存')
    return true
  }

  /** 每章最多一条书签：已在就删掉，没有就加上。 */
  async function toggleBookmark(): Promise<void> {
    const bookId = deps.bookId()
    const chapterId = deps.currentChapterId()
    if (!bookId || !chapterId) return
    const existing = chapterBookmark.value
    if (existing) {
      const res = await window.api.annotations.remove(bookId, existing.id)
      if (res.ok) {
        annotations.value = annotations.value.filter((item) => item.id !== existing.id)
        deps.notify('info', '已移除书签')
      } else {
        deps.notify('error', res.message || '移除失败')
      }
      return
    }
    const res = await window.api.annotations.add({
      bookId,
      chapterId,
      kind: 'bookmark',
      start: 0,
      end: 0,
      excerpt: '',
    })
    if (res.ok) {
      annotations.value.push(res.item)
      deps.notify('success', '已加书签')
    } else {
      deps.notify('error', res.message || '加书签失败')
    }
  }

  /** 保存对已有标记备注的编辑；改写过的备注按读者手写算（出处跟着落盘结果走）。 */
  async function saveNote(annotation: Annotation): Promise<void> {
    const bookId = deps.bookId()
    if (!bookId) return
    const res = await window.api.annotations.update(bookId, annotation.id, { note: noteDraft.value })
    if (res.ok) {
      annotation.note = res.item.note
      annotation.noteSource = res.item.noteSource
      deps.notify('success', '备注已保存')
    } else {
      deps.notify('error', res.message || '保存失败')
    }
    editingNoteId.value = ''
  }

  async function remove(annotation: Annotation): Promise<void> {
    const bookId = deps.bookId()
    if (!bookId) return
    const res = await window.api.annotations.remove(bookId, annotation.id)
    if (res.ok) annotations.value = annotations.value.filter((item) => item.id !== annotation.id)
    else deps.notify('error', res.message || '删除失败')
  }

  function deleteConfirmText(annotation: Annotation): string {
    if (annotation.kind === 'bookmark') return '删除这条书签？删除后无法恢复。'
    if (annotation.note) return '删除这条划线与备注？删除后无法恢复。'
    return '删除这条划线？删除后无法恢复。'
  }

  return {
    annotations,
    lostHighlightIds,
    showMarks,
    editingNoteId,
    noteDraft,
    currentHighlightRanges,
    chapterBookmark,
    sortedMarks,
    wordbookHighlights,
    wordbookTerms,
    wordbookTrimmed,
    wordbookPeople,
    reload,
    resolveCurrentChapter,
    addHighlight,
    addNote,
    toggleBookmark,
    saveNote,
    remove,
    deleteConfirmText,
  }
}
