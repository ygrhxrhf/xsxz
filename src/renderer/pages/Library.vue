<script setup lang="ts">
import { NButton, NCard, NEmpty, NInput, NSelect, NSpace, NSpin, NTag, NPopconfirm, NModal, NDropdown, NDrawer, NDrawerContent, NForm, NFormItem, NDynamicTags, useMessage } from 'naive-ui'
import type { DropdownOption, InputInst } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { BookListItem, ChapterMeta, DownloadBlocked, DownloadProgress, FailCode, QualityIssue, QualityReport, ReadingStatsView, TrashItem, WebShelfBook } from '@shared/types'
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
  libraryUnlockedNote,
  groupFailedChaptersByCode,
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
  (e: 'open-web-book', url: string): void
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
/** 多选标签：点多个标签看并集，像按标签分组浏览。空数组表示不筛。 */
const selectedTags = ref<string[]>([])
const tagsExpanded = ref(false)
const sortKey = ref<LibrarySortKey>('updated')
const failedOpen = ref(false)
const failedTitle = ref('')
const failedBookId = ref('')
const failedRows = ref<ChapterMeta[]>([])
/** 撞墙暂停的那一章：由用户本人在浏览页处理，软件只负责导航和续跑。 */
const blockedByBook = ref<Record<string, DownloadBlocked>>({})
const unblockingIds = ref<string[]>([])
const failedGroups = computed(() => groupFailedChaptersByCode(failedRows.value))
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
const qualityCleanPreview = ref('')
const qualityCleanLoading = ref(false)
const qualityCleanConfirmation = ref('')
let unsubProgress: (() => void) | null = null
let unsubBlocked: (() => void) | null = null
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
      selectedTags: selectedTags.value,
    }),
    sortKey.value,
  ),
)
const libraryTags = computed(() => collectLibraryTags(books.value))
const duplicateGroups = computed(() => findLibraryDuplicateGroups(books.value))
const duplicateOpen = ref(false)
function shelfProgress(book: BookListItem): number {
  if (!book.chapterCount || !book.progress?.chapterId) return 0
  const match = /^c(\d+)$/.exec(book.progress.chapterId)
  const index = match ? Number(match[1]) : 1
  return Math.max(2, Math.min(100, Math.round((index / book.chapterCount) * 100)))
}

const shelfRows = computed(() => {
  const rows: BookListItem[][] = []
  visibleBooks.value.forEach((book, index) => {
    if (index % 8 === 0) rows.push([])
    rows[rows.length - 1].push(book)
  })
  return rows
})

/**
 * 书多时开「跳过屏外卡片渲染」：卡片是响应式网格 + 变高内容（卡墙横幅、展开概览），
 * 不适合固定行高的虚拟列表；用 content-visibility 让浏览器跳过屏外卡片的布局与绘制，
 * 首屏更快、滚动更稳，且不破坏变高卡片。阈值取一屏多一点，小书库不受影响。
 */
const virtualizeBooks = computed(() => visibleBooks.value.length > 60)

const continueBook = computed(() => {
  const withProgress = books.value.filter((book) => book.progress?.chapterId)
  if (!withProgress.length) return null
  return [...withProgress].sort((a, b) => {
    const aTime = Date.parse(a.progress?.updatedAt || '') || 0
    const bTime = Date.parse(b.progress?.updatedAt || '') || 0
    return bTime - aTime
  })[0]
})
// 网页书架：只存书目、目录快照与阅读位置，正文留在站点上。
const webBooks = ref<WebShelfBook[]>([])
const webRefreshing = ref(false)
const webBusyId = ref('')
let unsubShelf: (() => void) | null = null
// 网页书架刷新也要防竞态：shelf.onChanged 与手动刷新交错时，慢的旧结果会覆盖新列表。
let webRefreshSeq = 0

async function refreshWebShelf(): Promise<void> {
  const seq = ++webRefreshSeq
  try {
    const res = await window.api.shelf.list()
    if (seq !== webRefreshSeq) return
    webBooks.value = res.ok ? res.books : []
  } catch {
    if (seq !== webRefreshSeq) return
    webBooks.value = []
  }
}

function continueWebBook(book: WebShelfBook): void {
  emit('open-web-book', book.lastChapter.url || book.catalogUrl)
}

async function refreshWebBook(book: WebShelfBook): Promise<void> {
  if (webBusyId.value) return
  webBusyId.value = book.id
  try {
    const res = await window.api.shelf.refresh(book.id)
    if (!res.ok) { message.warning(res.message || '刷新失败'); return }
    message.success(res.added > 0 ? `《${book.title}》更新 ${res.added} 章` : `《${book.title}》暂无更新`)
    await refreshWebShelf()
  } catch { message.error('刷新失败') }
  finally { webBusyId.value = '' }
}

async function refreshAllWebBooks(): Promise<void> {
  if (webRefreshing.value) return
  webRefreshing.value = true
  try {
    const res = await window.api.shelf.refreshAll()
    message.success(`已检查 ${res.checked} 本，${res.updated} 本有更新`)
    await refreshWebShelf()
  } catch { message.error('刷新失败') }
  finally { webRefreshing.value = false }
}

async function removeWebBook(book: WebShelfBook): Promise<void> {
  try {
    await window.api.shelf.remove(book.id)
    await refreshWebShelf()
    message.success(`已从网页书架移除《${book.title}》`)
  } catch { message.error('移除失败') }
}

/** 章节序号优先，没有目录快照时退回滚动比例。 */
function webProgress(book: WebShelfBook): number {
  const total = book.chapters.length
  if (total > 0) {
    const index = book.chapters.findIndex((chapter) => chapter.url === book.lastChapter.url)
    if (index >= 0) return Math.max(2, Math.min(100, Math.round(((index + 1) / total) * 100)))
  }
  if (!book.progress) return 0
  return Math.max(2, Math.min(100, Math.round(book.progress.scrollRatio * 100) || 2))
}

function webTime(raw: string): string {
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function webProgressLabel(book: WebShelfBook): string {
  const total = book.chapters.length
  const index = total > 0 ? book.chapters.findIndex((chapter) => chapter.url === book.lastChapter.url) : -1
  const where = index >= 0 ? `读到第 ${index + 1} / ${total} 章` : book.lastChapter.title || '还没读过'
  const stamp = webTime(book.progress?.updatedAt || book.createdAt)
  return stamp ? `${where} · ${stamp}` : where
}

function webChapterCountLabel(book: WebShelfBook): string {
  return book.chapters.length ? `${book.chapters.length} 章` : '目录待识别'
}

const initialLoading = computed(() => loading.value && books.value.length === 0)
const loadError = ref('')
const hasActiveFilter = computed(
  () => Boolean(query.value.trim()) || statusFilter.value !== 'all' || selectedTags.value.length > 0,
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
  { label: '最近读过', value: 'updated' },
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
  // 大型 txt / epub 要写几十秒盘，按钮不置灰时用户会以为没反应而反复点
  if (importing.value) return
  let filePaths: string[] | undefined
  try {
    ({ filePaths } = await window.api.dialog.openFile())
  } catch {
    message.error('打开文件选择器失败')
    return
  }
  if (!filePaths?.length) return
  importing.value = true
  try {
    const res = await window.api.library.import(filePaths[0])
    if (res.ok) {
      await refresh()
      if (res.bookId) emit('open-book', res.bookId)
    } else {
      message.error(res.message || '导入失败')
    }
  } catch {
    message.error('导入失败，请确认文件可用后重试')
  } finally {
    importing.value = false
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
  let chapter: Awaited<ReturnType<typeof window.api.library.readChapter>>
  let book: Awaited<ReturnType<typeof window.api.library.get>>
  try {
    [chapter, book] = await Promise.all([
      window.api.library.readChapter(bookId, issue.chapterId),
      window.api.library.get(bookId),
    ])
  } catch {
    // 任一 IPC reject 都要给反馈，否则弹窗永不打开，用户点了「修复」像没反应。
    message.error('打开修复面板失败，请稍后重试')
    return
  }
  repairIssue.value = issue
  repairBody.value = chapter.chapter?.body || ''
  qualityCleanPreview.value = ''
  qualityCleanConfirmation.value = ''
  repairCanUndo.value = Boolean(chapter.chapter?.bodyRaw && chapter.chapter.bodyRaw !== chapter.chapter.body)
  repairUrl.value = book.book?.chapters.find((item) => item.id === issue.chapterId)?.url || ''
  repairOpen.value = true
}

async function previewQualityClean(confirm = false) {
  const bookId = qualityReport.value?.bookId
  const issue = repairIssue.value
  if (!bookId || !issue || issue.kind !== 'suspectedAd' || repairBody.value.replace(/\s+/g, '').length < 500) return
  // 已在跑就别再进：连点「确认生成」会并发两次 AI 调用，白花额度。
  if (qualityCleanLoading.value) return
  qualityCleanLoading.value = true
  try {
    const result = await window.api.ai.clean(bookId, issue.chapterId, confirm)
    if (result.ok) {
      qualityCleanPreview.value = result.result.cleaned
      qualityCleanConfirmation.value = ''
    } else if ('confirmationRequired' in result && result.confirmationRequired) {
      qualityCleanConfirmation.value = `${result.message} 约 ${result.budget.estimatedTokens} tokens（估算）。`
    } else {
      message.error(result.message)
    }
  } catch {
    message.error('生成清理预览失败，请稍后重试')
  } finally { qualityCleanLoading.value = false }
}

async function applyQualityClean() {
  const bookId = qualityReport.value?.bookId
  const issue = repairIssue.value
  if (!bookId || !issue || !qualityCleanPreview.value.trim()) return
  repairSaving.value = true
  try {
    const result = await window.api.library.updateChapterBody(bookId, issue.chapterId, qualityCleanPreview.value)
    if (result?.ok === false) { message.error(result.message || '应用失败'); return }
    repairBody.value = qualityCleanPreview.value
    qualityCleanPreview.value = ''
    repairCanUndo.value = true
    await checkQuality(bookId, false)
    message.success('已应用清理结果；可恢复原始正文')
  } finally { repairSaving.value = false }
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
  try {
    const res = await window.api.library.delete(bookId)
    if (res && 'ok' in res && res.ok === false) {
      message.error(res.message || '删除失败')
      return
    }
    message.success('已移入回收站')
    await refresh()
  } catch {
    message.error('删除失败，请稍后重试')
  }
}

// 回收站
const trashOpen = ref(false)
const trashLoading = ref(false)
const trashItems = ref<TrashItem[]>([])
/** 导入进行中：按钮置灰 + 文案改成「导入中…」，避免重复提交。 */
const importing = ref(false)

async function openTrash() {
  trashOpen.value = true
  await reloadTrash()
}

// 阅读统计
const statsOpen = ref(false)
const statsLoading = ref(false)
const statsView = ref<ReadingStatsView | null>(null)

async function openStats() {
  statsOpen.value = true
  statsLoading.value = true
  try {
    const res = await window.api.library.getReadingStats(30)
    statsView.value = res.ok ? res.stats : null
    if (!res.ok) message.error(res.message || '读取阅读统计失败')
  } catch {
    statsView.value = null
    message.error('读取阅读统计失败，请稍后重试')
  } finally {
    statsLoading.value = false
  }
}

/** 秒 → 「X 小时 Y 分钟」/「Y 分钟」/「Z 秒」。 */
function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h} 小时 ${m} 分钟`
  if (m > 0) return `${m} 分钟`
  return `${total} 秒`
}

function fmtChars(chars: number): string {
  const n = Math.max(0, Math.round(chars))
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万字` : `${n} 字`
}

/** 最近 30 天里最大的一天时长：热力条按它取相对高度。 */
const statsMaxSeconds = computed(() => {
  const days = statsView.value?.days ?? []
  return Math.max(1, ...days.map((d) => d.seconds))
})

async function reloadTrash() {
  trashLoading.value = true
  try {
    const res = await window.api.library.listTrash()
    if (res.ok) trashItems.value = res.items
    else message.error(res.message || '读取回收站失败')
  } catch {
    message.error('读取回收站失败，请稍后重试')
  } finally {
    trashLoading.value = false
  }
}

function fmtTrashedAt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN')
}

/** 回收站占用：删掉的书还占着同一块盘，界面得让人看得见。 */
const trashTotalBytes = computed(() => trashItems.value.reduce((sum, item) => sum + (item.sizeBytes || 0), 0))

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function handleRestore(name: string) {
  try {
    const res = await window.api.library.restoreTrash(name)
    if (res.ok) {
      message.success('已还原到书库')
      await Promise.all([reloadTrash(), refresh()])
    } else {
      message.error(res.message || '还原失败')
    }
  } catch {
    message.error('还原失败，请稍后重试')
  }
}

async function handlePurge(name?: string) {
  try {
    const res = await window.api.library.purgeTrash(name)
    if (res.ok) {
      message.success(name ? '已彻底清除' : `已清空回收站（${res.purged} 项）`)
      await reloadTrash()
    } else {
      message.error(res.message || '清除失败')
    }
  } catch {
    message.error('清除失败，请稍后重试')
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

function startTask(
  ids: typeof retryingIds | typeof checkingIds | typeof exportingIds | typeof activeDownloadIds | typeof unblockingIds,
  bookId: string,
) {
  if (!ids.value.includes(bookId)) ids.value = [...ids.value, bookId]
}

function endTask(
  ids: typeof retryingIds | typeof checkingIds | typeof exportingIds | typeof activeDownloadIds | typeof unblockingIds,
  bookId: string,
) {
  ids.value = ids.value.filter((id) => id !== bookId)
}

function clearBlocked(bookId: string): void {
  if (!blockedByBook.value[bookId]) return
  const next = { ...blockedByBook.value }
  delete next[bookId]
  blockedByBook.value = next
}

/** 只把卡住的那一章打开给用户在浏览页里亲自处理：软件不代登录、不代付费、不代点验证。 */
async function handleOpenUnblock(bookId: string) {
  const blocked = blockedByBook.value[bookId]
  if (!blocked) return
  startTask(unblockingIds, bookId)
  try {
    const res = await window.api.download.openUnblock(bookId, blocked.chapterId)
    if (res.ok) emit('go-browse', res.url)
    else message.error(res.message)
  } finally {
    endTask(unblockingIds, bookId)
  }
}

async function handleResumeUnblock(bookId: string) {
  const res = await window.api.download.resumeUnblock(bookId)
  if (res.ok) message.success('已继续下载')
  else message.error(res.message || '无法继续下载')
}

/** 卡在墙上的任务以前只能等，现在可以直接收工（已下好的章不受影响）。 */
async function handleCancelDownload(bookId: string) {
  await window.api.download.cancel(bookId)
  message.success('已取消本次下载，已下好的章节保留')
}

async function handleRetry(bookId: string) {
  if (hasTask(retryingIds.value, bookId) || hasTask(activeDownloadIds.value, bookId)) return
  startTask(retryingIds, bookId)
  try {
    const res = await window.api.download.retryFailed(bookId)
    if (!res.ok) message.error(res.message || '重试失败')
  } catch {
    message.error('重试失败，请稍后再试')
  } finally {
    // IPC reject 也要收尾，否则 id 永久留在 retryingIds，卡片卡在「正在重试」且菜单永久禁用。
    endTask(retryingIds, bookId)
  }
}

async function handleCheckUpdate(bookId: string) {
  if (hasTask(checkingIds.value, bookId) || hasTask(activeDownloadIds.value, bookId)) return
  startTask(checkingIds, bookId)
  try {
    const res = await window.api.download.checkUpdate(bookId)
    endTask(checkingIds, bookId)
    if (res.ok && (res.added > 0 || (res.changed ?? 0) > 0)) {
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
  const { filePaths } = await window.api.dialog.openDirectory('选择导出目录')
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
  const key = tag.toLowerCase()
  return selectedTags.value.some((item) => item.toLowerCase() === key)
}

/** 多选标签：点一下加入、再点移除；多个标签按「含任一」取并集。 */
function toggleLibraryTag(tag: string) {
  const key = tag.toLowerCase()
  selectedTags.value = isSelectedLibraryTag(tag)
    ? selectedTags.value.filter((item) => item.toLowerCase() !== key)
    : [...selectedTags.value, tag]
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
    if (entry === 'edit') return { label: '编辑信息', key: entry }
    if (entry === 'recap') return { label: '前情提要', key: entry }
    if (entry === 'quality') return {
      label: `检查质量${qualityCounts.value[book.id] ? `（${qualityCounts.value[book.id]}）` : ''}`,
      key: entry,
      disabled: qualityLoading.value && qualityReport.value?.bookId === book.id,
    }
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
  if (action === 'edit') openEdit(book)
  else if (action === 'recap') void openRecap(book)
  else if (action === 'quality') void checkQuality(book.id)
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
    if (active) {
      void refresh()
      void refreshWebShelf()
    }
  },
)

/** 前情提要弹窗的取数序号：await 期间又开了另一本时，旧结果不能覆盖新弹窗。 */
let recapSeq = 0

async function openRecap(item: BookListItem) {
  recapBook.value = item
  recapOpen.value = true
  if (!item.progress?.chapterId) {
    recapText.value = '还没有阅读进度，打开阅读器读几章再来。'
    return
  }
  const seq = ++recapSeq
  try {
    const res = await window.api.ai.getSummaries(item.id)
    if (seq !== recapSeq) return
    recapText.value = res.ok ? (res.summaries.storySoFar?.text || '还没有前情提要。请先「生成本章摘要」，再点「刷新看到这里」。') : res.message
  } catch {
    if (seq !== recapSeq) return
    recapText.value = '读取前情提要失败，请稍后重试'
  }
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
  unsubShelf = window.api.shelf.onChanged(() => { void refreshWebShelf() })
  void refreshWebShelf()
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
    if (p.status === 'running' || p.status === 'awaitingHuman') {
      if (p.status === 'running' && p.bookId) clearBlocked(p.bookId)
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
        clearBlocked(p.bookId)
        endTask(retryingIds, p.bookId)
        endTask(checkingIds, p.bookId)
        endTask(activeDownloadIds, p.bookId)
        if (failedOpen.value && failedBookId.value === p.bookId) void reloadFailedRows(p.bookId)
      }
      void refresh()
      if (p.bookId && p.status !== 'cancelled') void checkQuality(p.bookId, false)
    }
  })
  unsubBlocked = window.api.download.onBlocked((payload) => {
    blockedByBook.value = { ...blockedByBook.value, [payload.bookId]: payload }
    message.warning(payload.message)
  })
  unsubCheckAll = window.api.download.onCheckAllProgress((p) => {
    checkAllStatus.value = `正在检查 ${p.current}/${p.total}：《${p.title}》`
  })
})

onUnmounted(() => {
  unsubOverview?.()
  unsubShelf?.()
  window.removeEventListener('keydown', onLibraryKeydown)
  unsubProgress?.()
  unsubBlocked?.()
  unsubCheckAll?.()
  unsubAiChunk?.()
  unsubAiDone?.()
})
</script>

<template>
  <div class="page library-page">
    <header class="library-header">
      <div>
        <h2 class="page-title">书架</h2>
        <p class="library-subtitle">最近在读放在最前，其余按书架排开。</p>
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
        <n-button class="shelf-action" @click="openStats">阅读统计</n-button>
        <n-button class="shelf-action" @click="openTrash">回收站</n-button>
        <n-button class="shelf-action" :loading="importing" :disabled="importing" @click="handleImport">
          {{ importing ? '导入中…' : '导入 txt / epub' }}
        </n-button>
      </div>
    </header>
    <div v-if="books.length" class="lib-toolbar">
      <n-input ref="searchInputRef" v-model:value="query" clearable placeholder="按书名、作者或标签筛选" style="max-width:240px" />
      <n-select v-model:value="statusFilter" :options="statusOptions" style="width:120px" />
      <n-select v-model:value="sortKey" :options="sortOptions" style="width:132px" />
      <div v-if="libraryTags.length" class="lib-tag-chips" :class="{ expanded: tagsExpanded }" role="list" aria-label="按标签筛选">
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
        <button type="button" class="lib-tag-toggle" @click="tagsExpanded = !tagsExpanded">
          {{ tagsExpanded ? '收起标签' : '更多标签' }}
        </button>
        <button
          v-if="selectedTags.length"
          type="button"
          class="lib-tag-toggle"
          @click="selectedTags = []"
        >取消标签筛选（{{ selectedTags.length }}）</button>
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

    <section v-else-if="!books.length && !webBooks.length && !hasActiveFilter" class="library-empty empty-state">
      <h3>还没有书</h3>
      <p>导入一本 txt 或 epub，或去浏览里下载。在内置浏览器里打开小说网页后，还能用阅读模式的「加书架」收藏网址。</p>
      <div class="empty-actions">
        <n-button type="primary" @click="emit('go-browse')">去浏览</n-button>
      </div>
    </section>

    <section v-else-if="!visibleBooks.length && !webBooks.length" class="library-empty empty-state">
      <h3>没有匹配的书</h3>
    </section>

    <template v-else>
      <p v-if="loadError" class="library-inline-error" role="alert">{{ loadError }}</p>
      <section v-if="continueBook && !hasActiveFilter" class="shelf-continue">
        <button class="shelf-continue-open" type="button" @click="continueReading">
          <div class="book-cover" :style="coverStyle(continueBook.id)" aria-hidden="true">
            <img v-if="continueBook.coverPath" class="book-cover-img" :src="coverImgSrc(continueBook) || undefined" alt="" />
            <span v-else>{{ libraryCoverText(continueBook.title) }}</span>
          </div>
          <div>
            <div class="shelf-kicker">最近在读</div>
            <div class="book-title" :title="continueBook.title">{{ continueBook.title }}</div>
            <div class="book-author">{{ continueBook.author || '未知作者' }}</div>
            <div class="book-progress">{{ fmtProgress(continueBook) }} · {{ fmtProgressTime(continueBook) }}</div>
          </div>
        </button>
      </section>
      <div v-if="visibleBooks.length" class="book-grid" :class="{ 'book-grid-large': virtualizeBooks }">
      <section v-for="(row, rowIndex) in shelfRows" :key="rowIndex" class="shelf-row">
      <n-card v-for="b in row" :key="b.id" hoverable class="book-card">
        <button class="book-open-area" type="button" :aria-label="`打开《${b.title}》`" @click="emit('open-book', b.id)">
          <div class="book-cover" :style="coverStyle(b.id)" aria-hidden="true">
            <img v-if="b.coverPath" class="book-cover-img" :src="coverImgSrc(b) || undefined" alt="" />
            <span v-else>{{ libraryCoverText(b.title) }}</span>
            <i v-if="shelfProgress(b)" class="cover-progress" :style="{ width: `${shelfProgress(b)}%` }" />
          </div>
          <div class="book-title" :title="b.title">{{ b.title }}</div>
          <div v-if="b.author" class="book-author" :title="b.author">{{ b.author }}</div>
          <div class="book-meta">
            <n-tag size="small" :type="statusType(b.status)">
              {{ statusLabel(b.status) }}
            </n-tag>
          </div>
          <div
            v-if="libraryUnlockedNote(b)"
            class="book-progress"
            :title="libraryUnlockedNote(b)"
          >
            {{ libraryUnlockedNote(b) }}
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
        <!-- 书库发起的下载（检查更新/重试失败章）以前在书库页没有取消入口，
             只能靠侧栏那个「取消全部」。这里按书给一个。卡在墙上时走下面的横幅，不重复。 -->
        <n-button
          v-if="hasTask(activeDownloadIds, b.id) && !blockedByBook[b.id]"
          size="tiny"
          quaternary
          type="error"
          class="book-cancel-download"
          @click="handleCancelDownload(b.id)"
        >取消下载</n-button>
        <div v-if="blockedByBook[b.id]" class="book-blocked" role="alert">
          <p class="book-blocked-reason">{{ blockedByBook[b.id].message }}</p>
          <p class="book-blocked-chapter">卡住的那一章：{{ blockedByBook[b.id].chapterTitle }}</p>
            <n-space size="small">
            <n-button size="tiny" :loading="hasTask(unblockingIds, b.id)" @click="handleOpenUnblock(b.id)">
              去浏览这一章
            </n-button>
            <n-button size="tiny" type="primary" @click="handleResumeUnblock(b.id)">我已处理好，继续下载</n-button>
            <n-button size="tiny" quaternary type="error" @click="handleCancelDownload(b.id)">取消这次下载</n-button>
          </n-space>
        </div>
        <div v-if="b.overview?.text || b.overview?.message" class="book-overview">
          <button
            v-if="b.overview?.text"
            class="book-overview-toggle"
            type="button"
            :aria-expanded="expandedOverviews.has(b.id)"
            @click="toggleOverview(b.id)"
          >{{ expandedOverviews.has(b.id) ? '收起全书概览' : '查看全书概览' }} <span>含剧透</span></button>
          <div v-else class="book-overview-heading">全书概览 <span>含剧透</span></div>
          <p
            v-if="b.overview?.text && expandedOverviews.has(b.id)"
            class="book-overview-text"
          >{{ b.overview.text }}</p>
          <p v-if="b.overview?.message" class="book-overview-status" role="status">{{ b.overview.message }}</p>
          <n-button v-if="b.overview?.status === 'failed'" size="tiny" @click="retryOverview(b.id)">重试概览</n-button>
        </div>
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
      </section>
      </div>
      <section v-if="webBooks.length" class="web-shelf">
        <div class="web-shelf-head">
          <h3>
            网页书架
            <span class="web-shelf-count">{{ webBooks.length }}</span>
          </h3>
          <div class="web-shelf-actions">
            <n-button size="small" :loading="webRefreshing" @click="refreshAllWebBooks">全部刷新目录</n-button>
            <n-button size="small" tertiary @click="emit('go-browse')">继续添加</n-button>
          </div>
        </div>
        <p class="web-shelf-hint">网页书不占本机空间，读的是站点上的正文；进度与目录存在本机，随时接着读。</p>
        <div class="web-shelf-grid">
          <div v-for="book in webBooks" :key="book.id" class="web-shelf-card">
            <button class="web-shelf-open" type="button" :title="`继续读《${book.title}》`" @click="continueWebBook(book)">
              <div class="book-cover" :style="coverStyle(book.id)" aria-hidden="true">
                <img v-if="book.coverUrl" class="book-cover-img" :src="book.coverUrl" alt="" />
                <span v-else>{{ libraryCoverText(book.title) }}</span>
                <i v-if="webProgress(book)" class="cover-progress" :style="{ width: `${webProgress(book)}%` }" />
                <em v-if="book.addedChapters > 0" class="web-update-badge">＋{{ book.addedChapters }} 章</em>
              </div>
              <div class="book-title" :title="book.title">{{ book.title }}</div>
              <div class="book-author" :title="book.host">{{ book.author || book.host }}</div>
              <div class="book-progress" :title="webProgressLabel(book)">{{ webProgressLabel(book) }}</div>
              <div class="book-progress-time">{{ webChapterCountLabel(book) }}</div>
            </button>
            <div class="web-shelf-tools">
              <n-button
                size="tiny"
                quaternary
                :loading="webBusyId === book.id"
                @click="refreshWebBook(book)"
              >
                刷新目录
              </n-button>
              <n-popconfirm @positive-click="removeWebBook(book)">
                <template #trigger>
                  <n-button size="tiny" quaternary type="error">移除</n-button>
                </template>
                把《{{ book.title }}》从网页书架移除？不会删除任何本地文件。
              </n-popconfirm>
            </div>
          </div>
        </div>
      </section>
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
        <template v-if="repairIssue?.kind === 'suspectedAd' && repairBody.replace(/\s+/g, '').length >= 500">
          <n-button :loading="qualityCleanLoading" @click="previewQualityClean(false)">AI 清正文预览</n-button>
          <p v-if="qualityCleanConfirmation">{{ qualityCleanConfirmation }} <n-button size="tiny" @click="previewQualityClean(true)">确认生成</n-button></p>
          <template v-if="qualityCleanPreview">
            <label>清理结果预览 · 请逐段对比原文，确认没有删掉剧情</label>
            <n-input :value="qualityCleanPreview" type="textarea" :rows="12" readonly />
            <n-button type="primary" :disabled="repairSaving" @click="applyQualityClean">应用预览结果</n-button>
          </template>
        </template>
        <p v-else-if="repairIssue && ['suspectedWall', 'unlockedBody', 'duplicateBody', 'duplicateUrl', 'truncated', 'short'].includes(repairIssue.kind)">此类问题请核对、重新提取或手动修复；AI 不补写缺失剧情。</p>
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
      <p v-if="failedGroups.length > 1" class="fail-summary">
        <span v-for="group in failedGroups" :key="group.code || 'none'">{{ group.label }} {{ group.count }} 章</span>
      </p>
      <div v-if="failedRows.length" class="fail-list">
        <div v-for="ch in failedRows" :key="ch.id" class="fail-row">
          <div>
            <div class="fail-title">{{ formatChapterOrdinal(ch.id, ch.index) }} {{ ch.title }}</div>
            <div class="fail-reason">{{ failLabel(ch) }}</div>
          </div>
          <n-button v-if="ch.url" size="tiny" @click="emit('go-browse', ch.url)">打开这一章</n-button>
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
            <div class="fail-reason">
              删除于 {{ fmtTrashedAt(t.trashedAt) }}<template v-if="t.sizeBytes"> · 占用 {{ fmtBytes(t.sizeBytes) }}</template>
            </div>
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
        <div class="trash-footer">
          <span v-if="trashItems.length" class="fail-reason">
            共占用 {{ fmtBytes(trashTotalBytes) }}；超过 30 天的条目会在下次启动时自动清理
          </span>
          <n-space justify="end">
            <n-popconfirm v-if="trashItems.length" @positive-click="handlePurge()">
              <template #trigger>
                <n-button size="small" type="error">清空回收站</n-button>
              </template>
              彻底删除回收站里的全部 {{ trashItems.length }} 本？此操作不可撤销。
            </n-popconfirm>
            <n-button size="small" @click="trashOpen = false">关闭</n-button>
          </n-space>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="statsOpen" preset="card" title="阅读统计" style="width:560px">
      <div v-if="statsLoading" class="stats-loading">正在统计…</div>
      <template v-else-if="statsView">
        <div class="stats-summary">
          <div class="stats-metric">
            <strong>{{ statsView.streak }}</strong>
            <span>连续阅读天数</span>
          </div>
          <div class="stats-metric">
            <strong>{{ fmtDuration(statsView.totalSeconds) }}</strong>
            <span>累计阅读时长</span>
          </div>
          <div class="stats-metric">
            <strong>{{ fmtChars(statsView.totalChars) }}</strong>
            <span>累计阅读字数</span>
          </div>
        </div>
        <n-empty v-if="!statsView.days.length" description="还没有阅读记录，去读几章吧" />
        <template v-else>
          <div class="stats-chart" role="img" aria-label="最近 30 天每日阅读时长">
            <div
              v-for="day in statsView.days"
              :key="day.date"
              class="stats-bar"
              :title="`${day.date}：${fmtDuration(day.seconds)}，${fmtChars(day.chars)}`"
            >
              <i :style="{ height: `${Math.round((day.seconds / statsMaxSeconds) * 100)}%` }" />
            </div>
          </div>
          <div class="stats-hint">最近 {{ statsView.days.length }} 天每日阅读时长（悬停看当天详情）</div>
        </template>
      </template>
      <n-empty v-else description="读取阅读统计失败" />
      <template #footer>
        <n-space justify="end">
          <n-button size="small" @click="statsOpen = false">关闭</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.library-page {
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
  overflow: auto;
  padding: var(--space-8) clamp(24px, 3vw, 48px) 48px;
  color: var(--text-primary);
  background: var(--app-bg);
}

.library-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-8);
}

.library-page :deep(.page-title) {
  margin: 0;
  color: var(--text-primary);
  font-size: 28px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: 0.01em;
}

.library-subtitle {
  margin: var(--space-2) 0 0;
  color: var(--text-secondary);
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
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.lib-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-8);
}

.lib-tag-chips {
  display: flex;
  flex-wrap: wrap;
  flex: 1 0 100%;
  gap: var(--space-2);
  max-height: 32px;
  overflow: hidden;
}

.lib-tag-chips.expanded { max-height: none; }

.lib-tag-toggle {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--focus);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.checkall-status {
  max-width: 280px;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 28px;
}

/* 书多时跳过屏外卡片的布局与绘制（不改变外观，只在滚到附近时才真正排版）。
   与 Reader.vue 大章同一套思路：内容高度会变（卡墙横幅/展开概览），不能用固定行高虚拟列表。 */
.book-grid-large .book-card {
  content-visibility: auto;
  contain-intrinsic-size: auto 320px;
}

/* 网页书架：和本地书同排，但角标与工具更轻，一眼能分清来源 */
.web-shelf {
  margin-bottom: 28px;
}

.web-shelf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}

.web-shelf-head h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 15px;
}

.web-shelf-count {
  min-width: 22px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
}

.web-shelf-actions {
  display: flex;
  gap: 8px;
}

.web-shelf-hint {
  margin: 0 0 14px;
  color: var(--text-muted);
  font-size: 12px;
}

.web-shelf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 18px;
}

.web-shelf-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.web-shelf-open {
  display: block;
  width: 100%;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-card, 12px);
  background: var(--surface-1);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, transform 140ms ease;
}

.web-shelf-open:hover {
  border-color: var(--hover-line);
  transform: translateY(-2px);
}

.web-shelf-open .book-cover {
  margin-inline: auto;
}

.web-shelf-open .book-progress {
  margin-top: 2px;
}

.web-update-badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--success, #18a058);
  color: #fff;
  font-size: 11px;
  font-style: normal;
}

.web-shelf-tools {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.shelf-continue {
  margin-bottom: 28px;
}

.shelf-continue-open {
  display: flex;
  align-items: center;
  gap: 18px;
  width: min(560px, 100%);
  border: 0;
  border-radius: 16px;
  padding: 14px;
  color: inherit;
  background: var(--surface-1);
  text-align: left;
  cursor: pointer;
  box-shadow: var(--shadow-card);
}

.shelf-kicker {
  margin-bottom: 4px;
  color: var(--text-secondary);
  font-size: 12px;
}

.shelf-row {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 18px 16px;
  padding: 8px 8px 22px;
  border-bottom: 10px solid color-mix(in srgb, var(--text-primary) 8%, var(--surface-1));
  border-radius: 0 0 8px 8px;
}

.cover-progress {
  position: absolute;
  z-index: 2;
  left: 0;
  bottom: 0;
  height: 3px;
  background: #c4554a;
}

.shelf-row .book-card {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

.shelf-row :deep(.book-card > .n-card__content) {
  padding: 8px 4px 4px;
}

.book-card {
  min-width: 0;
  border-color: var(--border);
  border-radius: var(--radius-card);
  background: var(--surface-1);
  box-shadow: var(--shadow-card);
  transition: transform var(--motion-duration) var(--motion-easing), box-shadow var(--motion-duration) var(--motion-easing), border-color var(--motion-duration) var(--motion-easing);
}

.book-card:hover {
  transform: translateY(-2px);
  border-color: var(--card-hover-border);
  box-shadow: var(--card-hover-shadow);
}

:deep(.book-card > .n-card__content) {
  position: relative;
  display: flex;
  height: 100%;
  flex-direction: column;
  padding: var(--space-6) var(--space-4) var(--space-4);
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
  outline: 2px solid var(--focus);
  outline-offset: 3px;
}

.book-cover {
  position: relative;
  width: 112px;
  height: 156px;
  flex: 0 0 156px;
  align-self: center;
  display: grid;
  place-items: center;
  overflow: hidden;
  margin-bottom: var(--space-6);
  border-radius: 3px 8px 8px 3px;
  color: #f7f3e8;
  background: linear-gradient(
    160deg,
    hsl(calc(var(--cover-hue) * 1deg) 28% 32%),
    hsl(calc(var(--cover-hue-secondary) * 1deg) 34% 24%)
  );
  box-shadow: var(--shadow-card);
  font-size: 24px;
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

:global(body[data-skin='light']) .book-cover {
  color: hsl(calc(var(--cover-hue) * 1deg) 22% 24%);
  background: linear-gradient(
    160deg,
    hsl(calc(var(--cover-hue) * 1deg) 24% 90%),
    hsl(calc(var(--cover-hue-secondary) * 1deg) 20% 78%)
  );
  text-shadow: none;
}

.shelf-row .book-title {
  min-height: 40px;
  font-size: 14px;
  text-align: center;
}

.shelf-row .book-author,
.shelf-row .book-progress,
.shelf-row .book-progress-time {
  text-align: center;
}

.book-title {
  min-height: 48px;
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-primary);
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
  color: var(--text-secondary);
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
  color: var(--text-secondary);
  font-size: 12px;
}

.book-progress-time {
  margin-top: var(--space-1);
}

.check-msg {
  margin-top: var(--space-2);
  color: var(--success);
  font-size: 12px;
  line-height: 1.4;
}

.check-msg.error {
  color: var(--error);
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
  border-radius: 999px;
  background: var(--surface-2);
}

.book-blocked {
  margin-top: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--warning);
  border-radius: var(--radius-control);
  background: var(--warning-surface);
}

.book-cancel-download {
  margin-top: var(--space-2);
}

.stats-loading {
  padding: var(--space-4) 0;
  color: var(--text-secondary);
  text-align: center;
}

.stats-summary {
  display: flex;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.stats-metric {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-control);
  text-align: center;
}

.stats-metric strong {
  font-size: 18px;
}

.stats-metric span {
  color: var(--text-secondary);
  font-size: 12px;
}

.stats-chart {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 120px;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-color);
}

.stats-bar {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
  min-width: 3px;
}

.stats-bar i {
  display: block;
  width: 100%;
  min-height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--primary-color, #2080f0);
}

.stats-hint {
  margin-top: var(--space-2);
  color: var(--text-secondary);
  font-size: 12px;
}

.book-blocked-reason {
  margin: 0;
  color: var(--warning);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}

.book-blocked-chapter {
  margin: var(--space-1) 0 var(--space-3);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.library-empty {
  min-height: 280px;
  display: grid;
  justify-items: center;
  align-content: center;
  gap: var(--space-3);
  padding: var(--space-8) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--surface-1);
  text-align: center;
}

.library-empty h3,
.library-empty p {
  margin: 0;
}

.library-empty h3 {
  color: var(--text-primary);
  font-size: 22px;
  font-weight: 700;
  line-height: 1.3;
}

.library-empty p {
  max-width: 36ch;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.6;
}

.library-error {
  border-color: var(--error);
}

.library-inline-error {
  margin: 0 0 var(--space-3);
  color: var(--error);
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
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--surface-1);
}

.library-page :deep(.skeleton-block) {
  background: var(--surface-3);
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

.fail-summary {
  margin: 0 0 var(--space-3);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
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
  border-bottom: 1px solid var(--border);
}

.fail-title {
  font-size: 13px;
}

.fail-reason {
  font-size: 12px;
  color: var(--error);
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
