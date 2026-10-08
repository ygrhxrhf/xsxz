<script setup lang="ts">
import { NButton, NCard, NEmpty, NInput, NSelect, NSpace, NSpin, NTag, NPopconfirm, NModal, NDropdown, NDrawer, NDrawerContent, NForm, NFormItem, NDynamicTags, useMessage } from 'naive-ui'
import type { DropdownOption, InputInst } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { BookListItem, ChapterMeta, DownloadProgress, FailCode, QualityIssue, QualityReport, TrashItem } from '@shared/types'
import { FAIL_CODE_ZH } from '@shared/types'
import { aiSaveRecoveryActive } from '../aiSaveRecoveryLock'
import {
  applyAddedChapterCount,
  checkUpdateMessage,
  checkUpdateNeedsBrowse,
  collectLibraryTags,
  createLibraryRefreshTracker,
  filterLibraryBooks,
  findLibraryDuplicateGroups,
  formatChapterOrdinal,
  formatLibraryProgress,
  formatLibraryProgressTime,
  isLibraryFindShortcut,
  libraryCoverHues,
  libraryCoverSrc,
  libraryCoverText,
  libraryFailureLabel,
  libraryMenuEntries,
  mapLibraryCoverError,
  normalizeEditTags,
  sortLibraryBooks,
  type LibraryMenuKey,
  type LibrarySortKey,
  type LibraryStatusFilter,
} from './libraryCard'

const props = defineProps<{ active?: boolean }>()

const emit = defineEmits<{
  (e: 'open-book', bookId: string): void
  (e: 'go-browse', url?: string): void
}>()

const message = useMessage()
const books = ref<BookListItem[]>([])
const expandedOverviews = ref<Set<string>>(new Set())
const loading = ref(true)
const retryingIds = ref<string[]>([])
const checkingIds = ref<string[]>([])
const exportingIds = ref<string[]>([])
const activeDownloadIds = ref<string[]>([])
const deleteConfirmId = ref<string | null>(null)
const checkMsg = ref<Record<string, string>>({})
const checkErr = ref<Record<string, boolean>>({})
const query = ref('')
const searchInputRef = ref<InputInst | null>(null)
const statusFilter = ref<LibraryStatusFilter>('all')
const selectedTag = ref('')
const sortKey = ref<LibrarySortKey>('updated')
const failedOpen = ref(false)
const failedTitle = ref('')
const failedBookId = ref('')
const failedRows = ref<ChapterMeta[]>([])
const recapOpen = ref(false)
const recapBook = ref<BookListItem | null>(null)
const recapText = ref('')
const recapJobId = ref('')
const recapStopping = ref(false)
const editOpen = ref(false)
const editSaving = ref(false)
const editCoverSaving = ref(false)
const editBookId = ref('')
const editTitle = ref('')
const editAuthor = ref('')
const editTags = ref<string[]>([])
const libraryPath = ref('')
const qualityOpen = ref(false)
const qualityLoading = ref(false)
const qualityReport = ref<QualityReport | null>(null)
const qualityBookTitle = ref('')
const qualityCounts = ref<Record<string, number>>({})
const repairOpen = ref(false)
const repairIssue = ref<QualityIssue | null>(null)
const repairBody = ref('')
const repairUrl = ref('')
const repairCanUndo = ref(false)
const repairSaving = ref(false)
let unsubProgress: (() => void) | null = null
let unsubOverview: (() => void) | null = null
let unsubCheckAll: (() => void) | null = null
let unsubAiChunk: (() => void) | null = null
let unsubAiDone: (() => void) | null = null
let lastErrorToast = ''
const refreshTracker = createLibraryRefreshTracker()

const visibleBooks = computed(() =>
  sortLibraryBooks(
    filterLibraryBooks(books.value, {
      q: query.value,
      status: statusFilter.value,
      selectedTag: selectedTag.value,
    }),
    sortKey.value,
  ),
)
const libraryTags = computed(() => collectLibraryTags(books.value))
const duplicateGroups = computed(() => findLibraryDuplicateGroups(books.value))
const duplicateOpen = ref(false)
const continueBook = computed(() => {
  const withProgress = books.value.filter((book) => book.progress?.chapterId)
  if (!withProgress.length) return null
  return [...withProgress].sort((a, b) => {
    const aTime = Date.parse(a.progress?.updatedAt || '') || 0
    const bTime = Date.parse(b.progress?.updatedAt || '') || 0
    return bTime - aTime
  })[0]
})
const initialLoading = computed(() => loading.value && books.value.length === 0)
const loadError = ref('')
const hasActiveFilter = computed(
  () => Boolean(query.value.trim()) || statusFilter.value !== 'all' || Boolean(selectedTag.value),
)
const deleteConfirmBook = computed(() => books.value.find((book) => book.id === deleteConfirmId.value) || null)

function toggleOverview(bookId: string) {
  const next = new Set(expandedOverviews.value)
  if (next.has(bookId)) next.delete(bookId)
  else next.add(bookId)
  expandedOverviews.value = next
}

async function retryOverview(bookId: string) {
  const result = await window.api.bookOverview.retry(bookId)
  if (!result.ok) message.error(result.message)
  await refresh()
}

const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '下载中', value: 'downloading' },
  { label: '完整', value: 'ready' },
  { label: '部分', value: 'partial' },
]
const sortOptions = [
  { label: '最近更新', value: 'updated' },
  { label: '书名', value: 'title' },
  { label: '作者', value: 'author' },
]

async function refresh() {
  const requestId = refreshTracker.begin()
  loading.value = refreshTracker.loading
  try {
    const res = await window.api.library.list()
    let nextLibraryPath = libraryPath.value
    try {
      const settings = await window.api.settings.get()
      nextLibraryPath = settings.libraryPath
    } catch {
      /* keep previous libraryPath */
    }
    if (refreshTracker.isLatest(requestId)) {
      books.value = res.books
      libraryPath.value = nextLibraryPath
      loadError.value = ''
    }
  } catch {
    if (refreshTracker.isLatest(requestId)) {
      loadError.value = '书库暂时打不开，请稍后重试。'
    }
  } finally {
    refreshTracker.end()
    loading.value = refreshTracker.loading
  }
}

async function handleImport() {
  const { filePaths } = await window.api.dialog.openFile()
  if (!filePaths?.length) return
  const res = await window.api.library.import(filePaths[0])
  if (res.ok) {
    await refresh()
    emit('open-book', res.bookId!)
  } else {
    message.error(res.message || '导入失败')
  }
}

async function checkQuality(bookId: string, show = true) {
  qualityLoading.value = true
  try {
    const res = await window.api.library.audit(bookId)
    if (!res.ok) { message.error(res.message); return }
    qualityReport.value = res.report
    qualityBookTitle.value = books.value.find((book) => book.id === bookId)?.title || ''
    qualityCounts.value = { ...qualityCounts.value, [bookId]: res.report.issues.length }
    if (show) qualityOpen.value = true
  } finally { qualityLoading.value = false }
}

async function openRepair(issue: QualityIssue) {
  const bookId = qualityReport.value?.bookId
  if (!bookId) return
  const [chapter, book] = await Promise.all([
    window.api.library.readChapter(bookId, issue.chapterId),
    window.api.library.get(bookId),
  ])
  repairIssue.value = issue
  repairBody.value = chapter.chapter?.body || ''
  repairCanUndo.value = Boolean(chapter.chapter?.bodyRaw && chapter.chapter.bodyRaw !== chapter.chapter.body)
  repairUrl.value = book.book?.chapters.find((item) => item.id === issue.chapterId)?.url || ''
  repairOpen.value = true
}

async function saveRepairBody() {
  const bookId = qualityReport.value?.bookId
  const issue = repairIssue.value
  if (!bookId || !issue || !repairBody.value.trim()) return
  repairSaving.value = true
  try {
    const res = await window.api.library.repairChapterBody(bookId, issue.chapterId, repairBody.value)
    if (!res.ok) { message.error(res.message || '保存失败'); return }
    message.success('正文已保存；原有标记会在打开章节时重新定位')
    repairOpen.value = false
    await checkQuality(bookId, false)
    await refresh()
  } finally { repairSaving.value = false }
}

async function redownloadRepairChapter() {
  const bookId = qualityReport.value?.bookId
  const issue = repairIssue.value
  if (!bookId || !issue) return
  repairSaving.value = true
  try {
    const res = await window.api.download.redownloadChapter(bookId, issue.chapterId, repairUrl.value)
    if (!res.ok) { message.error(res.message || '重新提取失败；旧正文已保留'); return }
    message.success('本章已重新提取')
    repairOpen.value = false
    await checkQuality(bookId, false)
    await refresh()
  } finally { repairSaving.value = false }
}

async function undoRepairBody() {
  const bookId = qualityReport.value?.bookId
  const issue = repairIssue.value
  if (!bookId || !issue || !repairCanUndo.value) return
  repairSaving.value = true
  try {
    const res = await window.api.library.updateChapterBody(bookId, issue.chapterId, '', true)
    if (res?.ok === false) { message.error(res.message || '撤销失败'); return }
    const chapter = await window.api.library.readChapter(bookId, issue.chapterId)
    repairBody.value = chapter.chapter?.body || ''
    repairCanUndo.value = false
    await checkQuality(bookId, false)
    message.success('已恢复原始正文')
  } finally { repairSaving.value = false }
}

async function handleDelete(bookId: string) {
  const res = await window.api.library.delete(bookId)
  if (res && 'ok' in res && res.ok === false) {
    message.error(res.message || '删除失败')
    return
  }
  message.success('已移入回收站')
  await refresh()
}

// 回收站
const trashOpen = ref(false)
const trashLoading = ref(false)
const trashItems = ref<TrashItem[]>([])

async function openTrash() {
  trashOpen.value = true
  await reloadTrash()
}

async function reloadTrash() {
  trashLoading.value = true
  try {
    const res = await window.api.library.listTrash()
    if (res.ok) trashItems.value = res.items
    else message.error(res.message || '读取回收站失败')
  } finally {
    trashLoading.value = false
  }
}

function fmtTrashedAt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN')
}

async function handleRestore(name: string) {
  const res = await window.api.library.restoreTrash(name)
  if (res.ok) {
    message.success('已还原到书库')
    await Promise.all([reloadTrash(), refresh()])
  } else {
    message.error(res.message || '还原失败')
  }
}

async function handlePurge(name?: string) {
  const res = await window.api.library.purgeTrash(name)
  if (res.ok) {
    message.success(name ? '已彻底清除' : `已清空回收站（${res.purged} 项）`)
    await reloadTrash()
  } else {
    message.error(res.message || '清除失败')
  }
}

// 全部检查更新
const checkAllLoading = ref(false)
const checkAllStatus = ref('')

function checkAllSummary(res: import('@shared/types').CheckAllResult): string {
  const updated = res.results.filter((r) => r.ok && r.added > 0)
  const failed = res.results.filter((r) => !r.ok)
  const parts: string[] = []
  parts.push(`共 ${res.total} 本可更新`)
  if (updated.length) parts.push(`${updated.length} 本有新章 +${updated.reduce((n, r) => n + (r.ok ? r.added : 0), 0)} 章`)
  else parts.push('暂无新章')
  if (failed.length) parts.push(`${failed.length} 本失败`)
  if (res.checked < res.total) parts.push('已中止')
  return parts.join('，')
}

async function handleCheckAll() {
  checkAllLoading.value = true
  try {
    const res = await window.api.download.checkAll()
    checkAllStatus.value = ''
    if (!res.ok) {
      message.warning(res.message || '无法开始批量检查')
      return
    }
    const summary = checkAllSummary(res)
    const hasFail = res.results.some((r) => !r.ok)
    if (hasFail) message.warning(summary)
    else message.success(summary)
    await refresh()
  } finally {
    checkAllLoading.value = false
  }
}

function handleCancelCheckAll() {
  void window.api.download.cancelCheckAll()
}

function failLabel(ch: ChapterMeta): string {
  const message = ch.failMessage?.trim()
  if (message) return message
  if (ch.failCode && FAIL_CODE_ZH[ch.failCode]) return FAIL_CODE_ZH[ch.failCode]
  return '正文为空或过短'
}

async function reloadFailedRows(bookId: string) {
  const res = await window.api.library.get(bookId)
  failedRows.value = (res.book?.chapters || []).filter((c) => c.status === 'failed' || c.status === 'empty')
}

async function openFailedList(bookId: string, title: string) {
  failedBookId.value = bookId
  failedTitle.value = title
  failedOpen.value = true
  await reloadFailedRows(bookId)
}

function hasTask(ids: string[], bookId: string): boolean {
  return ids.includes(bookId)
}

function startTask(ids: typeof retryingIds | typeof checkingIds | typeof exportingIds | typeof activeDownloadIds, bookId: string) {
  if (!ids.value.includes(bookId)) ids.value = [...ids.value, bookId]
}

function endTask(ids: typeof retryingIds | typeof checkingIds | typeof exportingIds | typeof activeDownloadIds, bookId: string) {
  ids.value = ids.value.filter((id) => id !== bookId)
}

async function handleRetry(bookId: string) {
  if (hasTask(retryingIds.value, bookId) || hasTask(activeDownloadIds.value, bookId)) return
  startTask(retryingIds, bookId)
  const res = await window.api.download.retryFailed(bookId)
  if (!res.ok) {
    message.error(res.message || '重试失败')
    endTask(retryingIds, bookId)
  }
}

async function handleCheckUpdate(bookId: string) {
  if (hasTask(checkingIds.value, bookId) || hasTask(activeDownloadIds.value, bookId)) return
  startTask(checkingIds, bookId)
  try {
    const res = await window.api.download.checkUpdate(bookId)
    endTask(checkingIds, bookId)
    if (res.ok && res.added > 0) {
      startTask(activeDownloadIds, bookId)
      const i = books.value.findIndex((b) => b.id === bookId)
      if (i >= 0) {
        const cur = books.value[i]
        books.value[i] = {
          ...cur,
          chapterCount: applyAddedChapterCount(cur.chapterCount, res.added),
        }
      }
    }
    checkMsg.value = { ...checkMsg.value, [bookId]: checkUpdateMessage(res) }
    checkErr.value = { ...checkErr.value, [bookId]: !res.ok }
    if (!res.ok && checkUpdateNeedsBrowse((res as { code?: FailCode }).code)) {
      message.warning(res.message)
      const detail = await window.api.library.get(bookId)
      emit('go-browse', detail.book?.sourceUrl)
    }
    if (res.ok && res.added > 0) await refresh()
  } catch (e: unknown) {
    const text = e instanceof Error ? e.message : String(e)
    checkMsg.value = { ...checkMsg.value, [bookId]: text || '检查更新失败' }
    checkErr.value = { ...checkErr.value, [bookId]: true }
  } finally {
    endTask(checkingIds, bookId)
  }
}

async function handleExport(bookId: string, format: 'txt' | 'epub') {
  if (hasTask(exportingIds.value, bookId)) return
  const { filePaths } = await window.api.dialog.openDirectory()
  const dest = filePaths?.[0]
  if (!dest) return
  startTask(exportingIds, bookId)
  try {
    const res = await window.api.library.export(bookId, format, dest)
    if (res.ok) message.success(`已导出到 ${res.path}`)
    else message.error(res.message || '导出失败')
  } finally {
    endTask(exportingIds, bookId)
  }
}

function openEdit(book: BookListItem) {
  if (editSaving.value || editCoverSaving.value) return
  editBookId.value = book.id
  editTitle.value = book.title
  editAuthor.value = book.author || ''
  editTags.value = normalizeEditTags(book.tags || [])
  editOpen.value = true
}

function closeEdit() {
  if (editSaving.value || editCoverSaving.value) return
  editOpen.value = false
  editBookId.value = ''
}

function onEditShow(show: boolean) {
  if (show) return
  if (editSaving.value || editCoverSaving.value) {
    editOpen.value = true
    return
  }
  closeEdit()
}

function onEditTagsUpdate(next: string[]) {
  editTags.value = normalizeEditTags(next)
}

function onTagInputKeydown(e: KeyboardEvent) {
  if (e.key !== ',' && e.key !== '，') return
  e.preventDefault()
  const target = e.target as HTMLInputElement | null
  const draft = target?.value || ''
  editTags.value = normalizeEditTags([...editTags.value, draft])
  if (target) target.value = ''
}

async function pickCover() {
  if (editSaving.value || editCoverSaving.value || !editBookId.value) return
  let sourcePath: string | null
  try {
    sourcePath = await window.api.library.pickCoverFile()
  } catch {
    message.error('保存失败，已保留原来的信息')
    return
  }
  if (sourcePath == null) return
  editCoverSaving.value = true
  try {
    const res = await window.api.library.setCover({
      bookId: editBookId.value,
      sourcePath,
    })
    if (res && 'ok' in res && res.ok) {
      message.success('已保存')
      await refresh()
    } else {
      message.error(mapLibraryCoverError(res && 'message' in res ? res.message : ''))
    }
  } catch {
    message.error('保存失败，已保留原来的信息')
  } finally {
    editCoverSaving.value = false
  }
}

async function saveEdit() {
  if (editSaving.value || editCoverSaving.value || !editBookId.value) return
  const title = editTitle.value.trim()
  if (!title) {
    message.error('书名不能为空')
    return
  }
  editSaving.value = true
  try {
    const res = await window.api.library.updateMeta({
      bookId: editBookId.value,
      title,
      author: editAuthor.value.trim(),
      tags: normalizeEditTags(editTags.value),
    })
    if (res && 'ok' in res && res.ok) {
      message.success('已保存')
      editOpen.value = false
      editBookId.value = ''
      await refresh()
    } else {
      message.error('保存失败，已保留原来的信息')
    }
  } catch {
    message.error('保存失败，已保留原来的信息')
  } finally {
    editSaving.value = false
  }
}

function statusLabel(status: BookListItem['status']): string {
  if (status === 'downloading') return '下载中'
  if (status === 'ready') return '完整'
  return '部分'
}

function coverStyle(id: string): Record<string, string> {
  const hues = libraryCoverHues(id)
  return {
    '--cover-hue': String(hues.primary),
    '--cover-hue-secondary': String(hues.secondary),
  }
}

function coverImgSrc(book: BookListItem): string | null {
  return libraryCoverSrc(libraryPath.value, book.id, book.coverPath)
}

function isSelectedLibraryTag(tag: string): boolean {
  return Boolean(selectedTag.value) && selectedTag.value.toLowerCase() === tag.toLowerCase()
}

function toggleLibraryTag(tag: string) {
  selectedTag.value = isSelectedLibraryTag(tag) ? '' : tag
}

function focusLibrarySearch() {
  searchInputRef.value?.focus()
}

function onLibraryKeydown(e: KeyboardEvent) {
  if (!props.active) return
  if (!isLibraryFindShortcut(e)) return
  e.preventDefault()
  focusLibrarySearch()
}

function cardTaskLabel(book: BookListItem): string {
  if (hasTask(checkingIds.value, book.id)) return '正在检查更新…'
  if (hasTask(retryingIds.value, book.id)) return '正在重试失败章…'
  if (hasTask(exportingIds.value, book.id)) return '正在导出…'
  if (hasTask(activeDownloadIds.value, book.id)) return '正在下载新章节…'
  return checkMsg.value[book.id] || libraryFailureLabel(book)
}

function cardMenuOptions(book: BookListItem): DropdownOption[] {
  return libraryMenuEntries(book).map((entry) => {
    if (entry.startsWith('divider-')) return { type: 'divider', key: entry }
    if (entry === 'recap') return { label: '前情提要', key: entry }
    if (entry === 'check-update') {
      const running = hasTask(checkingIds.value, book.id) || hasTask(activeDownloadIds.value, book.id)
      return { label: running ? '正在检查更新…' : '检查更新', key: entry, disabled: running }
    }
    if (entry === 'retry-failed') {
      const running = hasTask(retryingIds.value, book.id) || hasTask(activeDownloadIds.value, book.id)
      return { label: running ? '正在重试失败章…' : '重试失败章', key: entry, disabled: running }
    }
    if (entry === 'view-failed') return { label: '查看失败章', key: entry }
    if (entry === 'export-txt' || entry === 'export-epub') {
      const running = hasTask(exportingIds.value, book.id)
      const format = entry === 'export-txt' ? 'txt' : 'epub'
      return { label: running ? `正在导出 ${format}…` : `导出 ${format}`, key: entry, disabled: running }
    }
    return { label: '移入回收站', key: entry }
  })
}

function handleCardMenu(book: BookListItem, key: string | number) {
  const action = String(key) as LibraryMenuKey
  if (action === 'recap') void openRecap(book)
  else if (action === 'check-update') void handleCheckUpdate(book.id)
  else if (action === 'retry-failed') void handleRetry(book.id)
  else if (action === 'view-failed') void openFailedList(book.id, book.title)
  else if (action === 'export-txt') void handleExport(book.id, 'txt')
  else if (action === 'export-epub') void handleExport(book.id, 'epub')
  else if (action === 'trash') deleteConfirmId.value = book.id
}

async function confirmDelete(bookId: string) {
  deleteConfirmId.value = null
  await handleDelete(bookId)
}

function statusType(status: BookListItem['status']): 'info' | 'success' | 'warning' {
  if (status === 'downloading') return 'info'
  if (status === 'ready') return 'success'
  return 'warning'
}

function fmtProgress(b: BookListItem): string {
  return formatLibraryProgress(b)
}

function fmtProgressTime(b: BookListItem): string {
  return formatLibraryProgressTime(b)
}

watch(
  () => props.active,
  (active) => {
    if (active) void refresh()
  },
)

async function openRecap(item: BookListItem) {
  recapBook.value = item
  recapOpen.value = true
  if (!item.progress?.chapterId) {
    recapText.value = '还没有阅读进度，打开阅读器读几章再来。'
    return
  }
  const res = await window.api.ai.getSummaries(item.id)
  recapText.value = res.ok ? (res.summaries.storySoFar?.text || '还没有前情提要。请先「生成本章摘要」，再点「刷新看到这里」。') : res.message
}

function stopRecap() {
  if (!recapJobId.value) return
  recapStopping.value = true
  void window.api.ai.cancel(recapJobId.value)
}

function openRecapBook() {
  if (recapBook.value) emit('open-book', recapBook.value.id)
}

function openDuplicateBook(bookId: string) {
  emit('open-book', bookId)
}

function continueReading() {
  if (continueBook.value) emit('open-book', continueBook.value.id)
}

async function refreshRecap() {
  const item = recapBook.value
  if (!item?.progress?.chapterId || aiSaveRecoveryActive.value) return
  const res = await window.api.ai.storySoFar(item.id, item.progress.chapterId)
  if (!res.ok) return message.error(res.message)
  recapStopping.value = false
  recapJobId.value = res.jobId
  recapText.value = ''
}

onMounted(() => {
  unsubOverview = window.api.bookOverview.onChanged(() => { void refresh() })
  window.addEventListener('keydown', onLibraryKeydown)
  unsubAiChunk = window.api.ai.onChunk(({ jobId, delta }) => { if (jobId === recapJobId.value) recapText.value += delta })
  unsubAiDone = window.api.ai.onDone((event) => {
    if (event.jobId !== recapJobId.value) return
    recapJobId.value = ''
    if (recapStopping.value) {
      recapStopping.value = false
      if (recapBook.value) void openRecap(recapBook.value)
      return
    }
    recapText.value = event.ok ? event.text : `错误：${event.message}`
  })
  refresh()
  unsubProgress = window.api.download.onProgress((p: DownloadProgress) => {
    if (p.status === 'running' && p.bookId) {
      startTask(activeDownloadIds, p.bookId)
      const i = books.value.findIndex((b) => b.id === p.bookId)
      if (i < 0) {
        void refresh()
      } else {
        const cur = books.value[i]
        books.value[i] = {
          ...cur,
          status: 'downloading',
          chapterCount: p.total > 0 ? p.total : cur.chapterCount,
          readyCount: p.done,
        }
      }
    }
    if (p.status === 'error') {
      const text = p.lastError || '下载有失败章，可在书库重试'
      if (text !== lastErrorToast) {
        lastErrorToast = text
        message.warning(text)
      }
    }
    if (p.status === 'done' || p.status === 'cancelled' || p.status === 'error') {
      if (p.bookId) {
        endTask(retryingIds, p.bookId)
        endTask(checkingIds, p.bookId)
        endTask(activeDownloadIds, p.bookId)
        if (failedOpen.value && failedBookId.value === p.bookId) void reloadFailedRows(p.bookId)
      }
      void refresh()
      if (p.bookId && p.status !== 'cancelled') void checkQuality(p.bookId, false)
    }
  })
  unsubCheckAll = window.api.download.onCheckAllProgress((p) => {
    checkAllStatus.value = `正在检查 ${p.current}/${p.total}：《${p.title}》`
  })
})

onUnmounted(() => {
  unsubOverview?.()
  window.removeEventListener('keydown', onLibraryKeydown)
  unsubProgress?.()
  unsubCheckAll?.()
  unsubAiChunk?.()
  unsubAiDone?.()
})
</script>

<template>
  <div class="page library-page">
    <header class="library-header">
      <div>
        <h2 class="page-title">我的书库</h2>
        <p class="library-subtitle">收藏、阅读并维护保存在本机的书。</p>
      </div>
      <div class="library-header-actions">
        <span v-if="loading && books.length" class="library-refresh-status" role="status" aria-label="正在加载书库">
          <n-spin size="small" />
          正在刷新
        </span>
        <span v-if="checkAllStatus" class="checkall-status">{{ checkAllStatus }}</span>
        <n-button
          v-if="continueBook"
          class="shelf-action"
          type="primary"
          :title="`继续读《${continueBook.title}》`"
          @click="continueReading"
        >
          继续读
        </n-button>
        <n-button class="shelf-action" @click="emit('go-browse')">浏览下载</n-button>
        <n-button v-if="checkAllLoading" class="shelf-action" size="small" @click="handleCancelCheckAll">停止</n-button>
        <n-button v-else class="shelf-action" :disabled="!books.length" @click="handleCheckAll">全部检查更新</n-button>
        <n-button v-if="duplicateGroups.length" class="shelf-action" @click="duplicateOpen = true">可能重复 {{ duplicateGroups.length }} 组</n-button>
        <n-button class="shelf-action" @click="openTrash">回收站</n-button>
        <n-button class="shelf-action" @click="handleImport">导入 txt / epub</n-button>
      </div>
    </header>
    <div v-if="books.length" class="lib-toolbar">
      <n-input ref="searchInputRef" v-model:value="query" clearable placeholder="按书名、作者或标签筛选" style="max-width:240px" />
      <n-select v-model:value="statusFilter" :options="statusOptions" style="width:120px" />
      <n-select v-model:value="sortKey" :options="sortOptions" style="width:132px" />
      <div v-if="libraryTags.length" class="lib-tag-chips" role="list" aria-label="按标签筛选">
        <n-tag
          v-for="tag in libraryTags"
          :key="tag"
          role="listitem"
          checkable
          size="small"
          :checked="isSelectedLibraryTag(tag)"
          :aria-pressed="isSelectedLibraryTag(tag)"
          @update:checked="toggleLibraryTag(tag)"
        >
          {{ tag }}
        </n-tag>
      </div>
    </div>

    <div v-if="initialLoading" class="book-grid library-skeletons" role="status" aria-label="正在加载书库">
      <div v-for="index in 6" :key="index" class="book-card skeleton-card" aria-hidden="true">
        <div class="skeleton-block skeleton-cover" />
        <div class="skeleton-block skeleton-title" />
        <div class="skeleton-block skeleton-line" />
        <div class="skeleton-block skeleton-line short" />
      </div>
    </div>

    <section v-else-if="loadError && !books.length" class="library-empty empty-state library-error" role="alert">
      <h3>书库暂时打不开</h3>
      <p>{{ loadError }}</p>
      <div class="empty-actions">
        <n-button type="primary" @click="refresh">重试</n-button>
      </div>
    </section>

    <section v-else-if="!books.length && !hasActiveFilter" class="library-empty empty-state">
      <h3>还没有书</h3>
      <p>导入一本 txt 或 epub，或去浏览里下载。</p>
      <div class="empty-actions">
        <n-button type="primary" @click="emit('go-browse')">去浏览</n-button>
      </div>
    </section>

    <section v-else-if="!visibleBooks.length" class="library-empty empty-state">
      <h3>没有匹配的书</h3>
    </section>

    <template v-else>
      <p v-if="loadError" class="library-inline-error" role="alert">{{ loadError }}</p>
      <div class="book-grid">
      <n-card v-for="b in visibleBooks" :key="b.id" hoverable class="book-card">
        <button class="book-open-area" type="button" :aria-label="`打开《${b.title}》`" @click="emit('open-book', b.id)">
          <div class="book-cover" :style="coverStyle(b.id)" aria-hidden="true">
            <img v-if="b.coverPath" class="book-cover-img" :src="coverImgSrc(b) || undefined" alt="" />
            <span v-else>{{ libraryCoverText(b.title) }}</span>
          </div>
          <div class="book-title" :title="b.title">{{ b.title }}</div>
          <div v-if="b.author" class="book-author" :title="b.author">{{ b.author }}</div>
          <div class="book-meta">
            <n-tag size="small" :type="statusType(b.status)">
              {{ statusLabel(b.status) }}
            </n-tag>
          </div>
          <div class="book-progress" :title="fmtProgress(b)">{{ fmtProgress(b) }}</div>
          <div class="book-progress-time" :title="fmtProgressTime(b)">{{ fmtProgressTime(b) }}</div>
          <div
            v-if="cardTaskLabel(b)"
            class="check-msg"
            :class="{ error: checkErr[b.id] }"
            :title="cardTaskLabel(b)"
          >
            {{ cardTaskLabel(b) }}
          </div>
        </button>
        <div class="book-overview">
          <div class="book-overview-heading">全书概览 <span>含剧透</span></div>
          <p
            v-if="b.overview?.text"
            class="book-overview-text"
            :class="{ 'book-overview-clamped': !expandedOverviews.has(b.id) }"
          >{{ b.overview.text }}</p>
          <p v-if="b.overview?.message" class="book-overview-status" role="status">{{ b.overview.message }}</p>
          <n-button v-if="b.overview?.text" size="tiny" quaternary @click="toggleOverview(b.id)">
            {{ expandedOverviews.has(b.id) ? '收起概览' : '展开概览' }}
          </n-button>
          <n-button v-if="b.overview?.status === 'failed'" size="tiny" @click="retryOverview(b.id)">重试概览</n-button>
        </div>
        <n-button class="card-edit" size="small" @click="openEdit(b)">编辑信息</n-button>
        <n-button v-if="b.importType === 'download'" size="small" quaternary :loading="qualityLoading && qualityReport?.bookId === b.id" @click="checkQuality(b.id)">
          检查质量<span v-if="qualityCounts[b.id]">（{{ qualityCounts[b.id] }}）</span>
        </n-button>
        <n-dropdown
          trigger="click"
          :options="cardMenuOptions(b)"
          @select="(key: string | number) => handleCardMenu(b, key)"
        >
          <n-button class="card-more" size="small" quaternary :aria-label="`更多操作：《${b.title}》`">
            更多
          </n-button>
        </n-dropdown>
      </n-card>
      </div>
    </template>
    <n-modal
      :show="editOpen"
      preset="card"
      title="编辑信息"
      style="width:440px"
      :mask-closable="!editSaving && !editCoverSaving"
      :closable="!editSaving && !editCoverSaving"
      @update:show="onEditShow"
    >
      <n-form label-placement="top">
        <n-form-item label="书名">
          <n-input v-model:value="editTitle" :disabled="editSaving || editCoverSaving" />
        </n-form-item>
        <n-form-item label="作者">
          <n-input v-model:value="editAuthor" :disabled="editSaving || editCoverSaving" />
        </n-form-item>
        <n-form-item label="标签">
          <n-dynamic-tags
            :value="editTags"
            :disabled="editSaving || editCoverSaving"
            :input-props="{ onKeydown: onTagInputKeydown }"
            @update:value="onEditTagsUpdate"
          />
        </n-form-item>
        <n-form-item>
          <n-button :disabled="editSaving || editCoverSaving" :loading="editCoverSaving" @click="pickCover">选择封面</n-button>
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button :disabled="editSaving || editCoverSaving" @click="closeEdit">取消</n-button>
          <n-button type="primary" :loading="editSaving" :disabled="editCoverSaving" @click="saveEdit">保存</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="qualityOpen" preset="card" :title="`质量检查 · ${qualityBookTitle}`" style="width:min(720px, 92vw)">
      <p>已检查 {{ qualityReport?.checked || 0 }} 章。以下均为疑似问题，请核对后修复。</p>
      <n-empty v-if="!qualityReport?.issues.length" description="没有发现疑似问题" />
      <div v-else class="fail-list" style="max-height:55vh;overflow:auto">
        <div v-for="(issue, index) in qualityReport.issues" :key="`${issue.chapterId}-${issue.kind}-${index}`" class="fail-row">
          <div><div class="fail-title">第 {{ issue.chapterIndex }} 章 · {{ issue.chapterTitle }}</div><div class="fail-reason">{{ issue.reason }}</div></div>
          <n-button size="small" @click="openRepair(issue)">修复</n-button>
        </div>
      </div>
    </n-modal>
    <n-modal v-model:show="repairOpen" preset="card" :title="`修复章节 · ${repairIssue?.chapterTitle || ''}`" style="width:min(760px, 92vw)">
      <n-space vertical>
        <label>章节链接</label>
        <n-input v-model:value="repairUrl" placeholder="https://…" />
        <n-button :disabled="repairSaving || !repairUrl" :loading="repairSaving" @click="redownloadRepairChapter">按此链接重新提取</n-button>
        <label>纯文本正文</label>
        <n-input v-model:value="repairBody" type="textarea" :rows="12" />
        <n-space justify="end">
          <n-button v-if="repairCanUndo" :disabled="repairSaving" @click="undoRepairBody">恢复原始正文</n-button>
          <n-button type="primary" :disabled="!repairBody.trim()" :loading="repairSaving" @click="saveRepairBody">保存正文</n-button>
        </n-space>
      </n-space>
    </n-modal>
    <n-modal
      :show="Boolean(deleteConfirmBook)"
      preset="dialog"
      type="warning"
      title="移入回收站"
      positive-text="移入回收站"
      negative-text="取消"
      @update:show="(show: boolean) => { if (!show) deleteConfirmId = null }"
      @positive-click="deleteConfirmId && confirmDelete(deleteConfirmId)"
    >
      把《{{ deleteConfirmBook?.title }}》移入回收站？之后可在回收站还原。
    </n-modal>
    <n-drawer v-model:show="recapOpen" placement="right" :width="420">
      <n-drawer-content title="前情提要" closable>
        <div class="ai-result">{{ recapText }}</div>
        <template #footer>
          <n-space>
            <n-button v-if="recapJobId" type="warning" @click="stopRecap">停止</n-button>
            <n-button v-else :disabled="!recapBook?.progress?.chapterId || aiSaveRecoveryActive" type="primary" @click="refreshRecap">刷新看到这里</n-button>
            <n-button v-if="!recapBook?.progress?.chapterId" @click="openRecapBook">打开该书</n-button>
          </n-space>
        </template>
      </n-drawer-content>
    </n-drawer>
    <n-modal v-model:show="failedOpen" preset="card" :title="`失败章 · ${failedTitle}`" style="width:480px">
      <n-empty v-if="!failedRows.length" description="没有失败章节" />
      <div v-else class="fail-list">
        <div v-for="ch in failedRows" :key="ch.id" class="fail-row">
          <div>
            <div class="fail-title">{{ formatChapterOrdinal(ch.id, ch.index) }} {{ ch.title }}</div>
            <div class="fail-reason">{{ failLabel(ch) }}</div>
          </div>
        </div>
      </div>
      <template #footer>
        <n-space justify="end">
          <n-button size="small" @click="emit('go-browse')">去浏览页</n-button>
          <n-button
            size="small"
            type="warning"
            :loading="hasTask(retryingIds, failedBookId)"
            :disabled="hasTask(activeDownloadIds, failedBookId)"
            @click="handleRetry(failedBookId)"
          >
            只补失败章
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="duplicateOpen" preset="card" title="可能重复的书" style="width:520px">
      <div class="fail-list">
        <div v-for="group in duplicateGroups" :key="group.key" class="dup-group">
          <div class="fail-title">{{ group.title }}{{ group.author ? ` · ${group.author}` : '' }}</div>
          <div v-for="book in group.books" :key="book.id" class="fail-row dup-row">
            <div>
              <div class="fail-title">{{ book.title }}{{ book.author ? ` · ${book.author}` : '' }}</div>
            </div>
            <n-button size="tiny" @click="openDuplicateBook(book.id)">打开</n-button>
          </div>
        </div>
      </div>
      <template #footer>
        <n-space justify="end">
          <n-button size="small" @click="duplicateOpen = false">关闭</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="trashOpen" preset="card" title="回收站" style="width:520px">
      <n-empty v-if="!trashItems.length && !trashLoading" description="回收站是空的" />
      <div v-else class="fail-list">
        <div v-for="t in trashItems" :key="t.name" class="fail-row">
          <div>
            <div class="fail-title">《{{ t.title }}》{{ t.author ? ` · ${t.author}` : '' }}（{{ t.chapterCount }} 章）</div>
            <div class="fail-reason">删除于 {{ fmtTrashedAt(t.trashedAt) }}</div>
          </div>
          <n-space>
            <n-button size="tiny" @click="handleRestore(t.name)">还原</n-button>
            <n-popconfirm @positive-click="handlePurge(t.name)">
              <template #trigger>
                <n-button size="tiny" type="error" quaternary>彻底清除</n-button>
              </template>
              彻底删除《{{ t.title }}》？此操作不可撤销。
            </n-popconfirm>
          </n-space>
        </div>
      </div>
      <template #footer>
        <n-space justify="end">
          <n-popconfirm v-if="trashItems.length" @positive-click="handlePurge()">
            <template #trigger>
              <n-button size="small" type="error">清空回收站</n-button>
            </template>
            彻底删除回收站里的全部 {{ trashItems.length }} 本？此操作不可撤销。
          </n-popconfirm>
          <n-button size="small" @click="trashOpen = false">关闭</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.library-page {
  --shelf-paper: #f7f3e8;
  --shelf-ink: #2f2a24;
  --shelf-ink-soft: #6d6458;
  --shelf-line: rgba(47, 42, 36, 0.14);
  --shelf-focus: #8a5a32;
  overflow: auto;
  padding: var(--space-6) var(--space-6) var(--space-8);
  color: var(--shelf-ink);
  background:
    linear-gradient(180deg, rgba(255, 252, 245, 0.55), transparent 180px),
    var(--shelf-paper);
  font-family: "Source Han Serif SC", "Noto Serif SC", "Songti SC", "SimSun", "Microsoft YaHei UI", serif;
}

.library-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--shelf-line);
}

.library-page :deep(.page-title) {
  margin: 0;
  color: var(--shelf-ink);
  font-size: 28px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: 0.01em;
}

.library-subtitle {
  margin: var(--space-2) 0 0;
  color: var(--shelf-ink-soft);
  font-size: 14px;
  line-height: 1.5;
}

.library-header-actions,
.library-refresh-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.library-header-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.library-refresh-status {
  color: var(--shelf-ink-soft);
  font-size: 12px;
  white-space: nowrap;
}

.library-page :deep(.n-button) {
  --n-color: #fffdf8;
  --n-color-hover: #f3ecdf;
  --n-color-pressed: #efe6d4;
  --n-color-focus: #fffdf8;
  --n-text-color: var(--shelf-ink);
  --n-text-color-hover: var(--shelf-ink);
  --n-text-color-pressed: var(--shelf-ink);
  --n-text-color-focus: var(--shelf-ink);
  --n-text-color-disabled: #a89884;
  --n-border: 1px solid #e3d9c6;
  --n-border-hover: 1px solid #c9b89a;
  --n-border-pressed: 1px solid var(--shelf-focus);
  --n-border-focus: 1px solid var(--shelf-focus);
  --n-border-disabled: 1px solid #eadfce;
  --n-ripple-color: var(--shelf-focus);
  min-height: 32px;
  border-radius: var(--radius-control);
}

.library-page :deep(.n-button.n-button--primary-type) {
  --n-color: var(--shelf-focus);
  --n-color-hover: #744b29;
  --n-color-pressed: #633f22;
  --n-color-focus: var(--shelf-focus);
  --n-text-color: #fffaf3;
  --n-text-color-hover: #fffaf3;
  --n-text-color-pressed: #fffaf3;
  --n-text-color-focus: #fffaf3;
  --n-text-color-disabled: rgba(255, 250, 243, 0.72);
  --n-border: 1px solid transparent;
  --n-border-hover: 1px solid transparent;
  --n-border-pressed: 1px solid transparent;
  --n-border-focus: 1px solid transparent;
  --n-border-disabled: 1px solid transparent;
}

.library-page :deep(.n-button.n-button--error-type) {
  --n-color: transparent;
  --n-color-hover: rgba(156, 59, 50, 0.08);
  --n-color-pressed: rgba(156, 59, 50, 0.14);
  --n-text-color: #9c3b32;
  --n-text-color-hover: #9c3b32;
  --n-text-color-pressed: #9c3b32;
  --n-border: 1px solid transparent;
}

.library-page :deep(.n-button.n-button--warning-type) {
  --n-text-color: #8a5a12;
  --n-text-color-hover: #8a5a12;
  --n-text-color-pressed: #8a5a12;
  --n-border: 1px solid #e3d0a4;
}

.library-page :deep(.n-button:not(.n-button--disabled):focus-visible) {
  outline: 2px solid var(--shelf-focus);
  outline-offset: 2px;
}

.lib-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-6);
}

.lib-tag-chips {
  display: flex;
  flex-wrap: wrap;
  flex: 1 0 100%;
  gap: var(--space-2);
}

.checkall-status {
  max-width: 280px;
  overflow: hidden;
  color: var(--shelf-ink-soft);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: var(--space-4);
}

.book-card {
  min-width: 0;
  border-radius: var(--radius-card);
  background: #fffdf8;
  transition: transform var(--motion-duration) var(--motion-easing), box-shadow var(--motion-duration) var(--motion-easing), border-color var(--motion-duration) var(--motion-easing);
}

.book-card:hover {
  transform: translateY(-2px);
  border-color: rgba(138, 90, 50, 0.45);
  box-shadow: 0 10px 22px rgba(74, 52, 28, 0.12);
}

:deep(.book-card > .n-card__content) {
  position: relative;
  display: flex;
  height: 100%;
  flex-direction: column;
  padding: var(--space-4);
}

.book-open-area {
  width: 100%;
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: stretch;
  border: 0;
  border-radius: calc(var(--radius-card) - 4px);
  padding: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.book-open-area:focus-visible {
  outline: 2px solid var(--shelf-focus);
  outline-offset: 3px;
}

.book-cover {
  position: relative;
  width: 104px;
  height: 142px;
  flex: 0 0 142px;
  align-self: center;
  display: grid;
  place-items: center;
  overflow: hidden;
  margin-bottom: var(--space-4);
  border-radius: 3px 8px 8px 3px;
  color: #f7f3e8;
  background: linear-gradient(
    160deg,
    hsl(calc(var(--cover-hue) * 1deg) 28% 32%),
    hsl(calc(var(--cover-hue-secondary) * 1deg) 34% 24%)
  );
  box-shadow: 2px 6px 14px rgba(74, 52, 28, 0.16);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-shadow: 0 1px 2px rgba(47, 42, 36, 0.35);
}

.book-cover-img {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.book-cover:has(.book-cover-img)::before,
.book-cover:has(.book-cover-img)::after {
  display: none;
}

.book-cover::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 6px;
  border-right: 1px solid rgba(247, 243, 232, 0.28);
  background: rgba(47, 42, 36, 0.28);
}

.book-cover::after {
  content: '';
  position: absolute;
  inset: 5px;
  border: 1px solid rgba(247, 243, 232, 0.18);
  border-radius: 5px;
  pointer-events: none;
}

:global(body[data-skin='minimal']) .book-cover,
:global(body[data-skin='white']) .book-cover {
  color: hsl(calc(var(--cover-hue) * 1deg) 22% 24%);
  background: linear-gradient(
    160deg,
    hsl(calc(var(--cover-hue) * 1deg) 24% 90%),
    hsl(calc(var(--cover-hue-secondary) * 1deg) 20% 78%)
  );
  text-shadow: none;
}

.book-title {
  min-height: 48px;
  display: -webkit-box;
  overflow: hidden;
  color: var(--shelf-ink);
  font-size: 17px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: 0.01em;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.book-author,
.book-progress,
.book-progress-time,
.check-msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-author {
  margin-top: var(--space-1);
  color: var(--shelf-ink-soft);
  font-size: 13px;
}

.book-meta {
  min-height: 22px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.book-progress,
.book-progress-time {
  margin-top: var(--space-2);
  color: var(--shelf-ink-soft);
  font-size: 12px;
}

.book-progress-time {
  margin-top: var(--space-1);
}

.check-msg {
  margin-top: var(--space-2);
  color: #2f6b45;
  font-size: 12px;
  line-height: 1.4;
}

.check-msg.error {
  color: #9c3b32;
}

.card-edit,
.card-more {
  align-self: flex-start;
  min-height: 32px;
  border-radius: var(--radius-control);
}

.card-edit {
  margin-top: var(--space-3);
}

.card-more {
  position: absolute;
  z-index: 2;
  top: var(--space-2);
  right: var(--space-2);
  background: rgba(247, 243, 232, 0.92);
}

.library-empty {
  min-height: 280px;
  display: grid;
  justify-items: center;
  align-content: center;
  gap: var(--space-3);
  padding: var(--space-8) var(--space-4);
  border: 1px solid var(--shelf-line);
  border-radius: var(--radius-card);
  background: rgba(255, 253, 248, 0.72);
  text-align: center;
}

.library-empty h3,
.library-empty p {
  margin: 0;
}

.library-empty h3 {
  color: var(--shelf-ink);
  font-size: 22px;
  font-weight: 700;
  line-height: 1.3;
}

.library-empty p {
  max-width: 36ch;
  color: var(--shelf-ink-soft);
  font-size: 14px;
  line-height: 1.6;
}

.library-error {
  border-color: rgba(156, 59, 50, 0.35);
}

.library-inline-error {
  margin: 0 0 var(--space-3);
  color: #9c3b32;
  font-size: 13px;
  line-height: 1.5;
}

.empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
}

.library-skeletons {
  pointer-events: none;
}

.skeleton-card {
  min-height: 330px;
  padding: var(--space-4);
  border: 1px solid var(--shelf-line);
  border-radius: var(--radius-card);
  background: rgba(255, 253, 248, 0.72);
}

.library-page :deep(.skeleton-block) {
  background: rgba(138, 90, 50, 0.12);
}

.skeleton-cover {
  width: 104px;
  height: 142px;
  margin: 0 auto var(--space-3);
}

.skeleton-title {
  width: 78%;
  height: 20px;
  margin-bottom: var(--space-3);
}

.skeleton-line {
  width: 100%;
  height: 12px;
  margin-top: var(--space-2);
}

.skeleton-line.short {
  width: 58%;
}

@media (max-width: 1180px) {
  .library-header {
    flex-direction: column;
  }

  .library-header-actions {
    justify-content: flex-start;
  }
}

@media (max-width: 720px) {
  .library-page {
    padding: var(--space-4);
  }

  .library-page :deep(.page-title) {
    font-size: 22px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .book-card,
  .book-open-area,
  .library-page :deep(.n-button) {
    transition: none;
  }

  .book-card:hover {
    transform: none;
  }
}

.fail-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 360px;
  overflow: auto;
}

.fail-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--shelf-line);
}

.fail-title {
  font-size: 13px;
}

.fail-reason {
  font-size: 12px;
  color: #9c3b32;
  margin-top: 4px;
}

.dup-group {
  padding-bottom: 8px;
}

.dup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
</style>
