<script setup lang="ts">
import { NButton, NCard, NEmpty, NInput, NSelect, NSpace, NSpin, NTag, NPopconfirm, NModal, NDropdown, NDrawer, NDrawerContent, NForm, NFormItem, NDynamicTags, useMessage } from 'naive-ui'
import type { DropdownOption, InputInst } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { BookListItem, ChapterMeta, DownloadProgress, FailCode, TrashItem } from '@shared/types'
import { FAIL_CODE_ZH } from '@shared/types'
import { aiSaveRecoveryActive } from '../aiSaveRecoveryLock'
import {
  applyAddedChapterCount,
  checkUpdateMessage,
  checkUpdateNeedsBrowse,
  collectLibraryTags,
  createLibraryRefreshTracker,
  filterLibraryBooks,
  formatChapterOrdinal,
  formatLibraryProgress,
  isLibraryFindShortcut,
  libraryCoverHues,
  libraryCoverText,
  libraryFailureLabel,
  libraryMenuEntries,
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
const editBookId = ref('')
const editTitle = ref('')
const editAuthor = ref('')
const editTags = ref<string[]>([])
let unsubProgress: (() => void) | null = null
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
const initialLoading = computed(() => loading.value && books.value.length === 0)
const hasActiveFilter = computed(
  () => Boolean(query.value.trim()) || statusFilter.value !== 'all' || Boolean(selectedTag.value),
)
const deleteConfirmBook = computed(() => books.value.find((book) => book.id === deleteConfirmId.value) || null)

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
    if (refreshTracker.isLatest(requestId)) books.value = res.books
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
  return ch.failMessage || (ch.failCode ? FAIL_CODE_ZH[ch.failCode] : '失败')
}

async function openFailedList(bookId: string, title: string) {
  failedBookId.value = bookId
  failedTitle.value = title
  failedOpen.value = true
  const res = await window.api.library.get(bookId)
  failedRows.value = (res.book?.chapters || []).filter((c) => c.status === 'failed' || c.status === 'empty')
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
  if (editSaving.value) return
  editBookId.value = book.id
  editTitle.value = book.title
  editAuthor.value = book.author || ''
  editTags.value = normalizeEditTags(book.tags || [])
  editOpen.value = true
}

function closeEdit() {
  if (editSaving.value) return
  editOpen.value = false
  editBookId.value = ''
}

function onEditShow(show: boolean) {
  if (show) return
  if (editSaving.value) {
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

async function saveEdit() {
  if (editSaving.value || !editBookId.value) return
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

function isSelectedLibraryTag(tag: string): boolean {
  return Boolean(selectedTag.value) && selectedTag.value.toLowerCase() === tag.toLowerCase()
}

function toggleLibraryTag(tag: string) {
  selectedTag.value = isSelectedLibraryTag(tag) ? '' : tag
}

function clearFilters() {
  query.value = ''
  statusFilter.value = 'all'
  selectedTag.value = ''
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
      }
      void refresh()
    }
  })
  unsubCheckAll = window.api.download.onCheckAllProgress((p) => {
    checkAllStatus.value = `正在检查 ${p.current}/${p.total}：《${p.title}》`
  })
})

onUnmounted(() => {
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
        <n-button v-if="checkAllLoading" size="small" @click="handleCancelCheckAll">停止</n-button>
        <n-button v-else :disabled="!books.length" @click="handleCheckAll">全部检查更新</n-button>
        <n-button @click="openTrash">回收站</n-button>
        <n-button type="primary" @click="handleImport">导入 txt / epub</n-button>
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

    <section v-else-if="!books.length" class="library-empty empty-state">
      <h3>书库还是空的</h3>
      <p>从网页下载一本书，或导入本地 txt / epub。</p>
      <div class="empty-actions">
        <n-button type="primary" @click="emit('go-browse')">去浏览找书</n-button>
        <n-button secondary @click="handleImport">导入本地书</n-button>
      </div>
    </section>

    <section v-else-if="!visibleBooks.length" class="library-empty empty-state">
      <p>没有找到符合条件的书。</p>
      <n-button v-if="hasActiveFilter" @click="clearFilters">清除筛选</n-button>
    </section>

    <div v-else class="book-grid">
      <n-card v-for="b in visibleBooks" :key="b.id" hoverable class="book-card">
        <button class="book-open-area" type="button" :aria-label="`打开《${b.title}》`" @click="emit('open-book', b.id)">
          <div class="book-cover" :style="coverStyle(b.id)" aria-hidden="true">
            <span>{{ libraryCoverText(b.title) }}</span>
          </div>
          <div class="book-title" :title="b.title">{{ b.title }}</div>
          <div v-if="b.author" class="book-author" :title="b.author">{{ b.author }}</div>
          <div class="book-meta">
            <n-tag size="small" :type="statusType(b.status)">
              {{ statusLabel(b.status) }}
            </n-tag>
          </div>
          <div class="book-progress" :title="fmtProgress(b)">{{ fmtProgress(b) }}</div>
          <div
            v-if="cardTaskLabel(b)"
            class="check-msg"
            :class="{ error: checkErr[b.id] }"
            :title="cardTaskLabel(b)"
          >
            {{ cardTaskLabel(b) }}
          </div>
        </button>
        <n-button class="card-edit" size="small" @click="openEdit(b)">编辑信息</n-button>
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
    <n-modal
      :show="editOpen"
      preset="card"
      title="编辑信息"
      style="width:440px"
      :mask-closable="!editSaving"
      :closable="!editSaving"
      @update:show="onEditShow"
    >
      <n-form label-placement="top">
        <n-form-item label="书名">
          <n-input v-model:value="editTitle" :disabled="editSaving" />
        </n-form-item>
        <n-form-item label="作者">
          <n-input v-model:value="editAuthor" :disabled="editSaving" />
        </n-form-item>
        <n-form-item label="标签">
          <n-dynamic-tags
            :value="editTags"
            :disabled="editSaving"
            :input-props="{ onKeydown: onTagInputKeydown }"
            @update:value="onEditTagsUpdate"
          />
        </n-form-item>
        <n-form-item>
          <n-button disabled>选择封面</n-button>
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button :disabled="editSaving" @click="closeEdit">取消</n-button>
          <n-button type="primary" :loading="editSaving" @click="saveEdit">保存</n-button>
        </n-space>
      </template>
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
      <n-empty v-if="!failedRows.length" description="当前没有失败章" />
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
            重试失败章
          </n-button>
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
  overflow: auto;
}

.library-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.library-subtitle {
  margin: var(--space-1) 0 0;
  color: var(--text-muted);
  font-size: 13px;
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
  gap: var(--space-2);
  margin-bottom: var(--space-4);
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
  color: var(--text-muted);
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
  transition: transform var(--motion-duration), box-shadow var(--motion-duration), border-color var(--motion-duration);
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
  padding: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
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
  margin-bottom: var(--space-3);
  border-radius: var(--radius-control);
  color: #fff7fc;
  background: linear-gradient(
    135deg,
    hsl(calc(var(--cover-hue) * 1deg) 68% 34%),
    hsl(calc(var(--cover-hue-secondary) * 1deg) 72% 52%)
  );
  box-shadow: var(--cover-ring);
  font-size: 34px;
  font-weight: 800;
  letter-spacing: 1px;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
}

.book-cover::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 6px;
  border-right: 1px solid rgba(255, 255, 255, 0.24);
  background: rgba(0, 0, 0, 0.18);
}

.book-cover::after {
  content: '';
  position: absolute;
  inset: 5px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 5px;
  pointer-events: none;
}

:global(body[data-skin='minimal']) .book-cover {
  color: hsl(calc(var(--cover-hue) * 1deg) 34% 24%);
  background: linear-gradient(
    135deg,
    hsl(calc(var(--cover-hue) * 1deg) 30% 88%),
    hsl(calc(var(--cover-hue-secondary) * 1deg) 34% 76%)
  );
  text-shadow: none;
}

.book-title {
  min-height: 42px;
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.book-author,
.book-progress,
.check-msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-author {
  margin-top: var(--space-1);
  color: var(--text-muted);
  font-size: 12px;
}

.book-meta {
  min-height: 22px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.book-progress {
  margin-top: var(--space-2);
  color: var(--text-muted);
  font-size: 12px;
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

.card-edit {
  align-self: flex-start;
  margin-top: var(--space-3);
  min-height: 32px;
  border-radius: var(--radius-control);
}

.card-more {
  position: absolute;
  z-index: 2;
  top: var(--space-2);
  right: var(--space-2);
  min-height: 32px;
  border-radius: var(--radius-control);
  background: var(--surface-2);
}

.library-empty {
  min-height: 280px;
  align-content: center;
}

.library-empty h3,
.library-empty p {
  margin: 0;
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
  background: var(--surface-1);
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

.fail-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 360px;
  overflow: auto;
}

.fail-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}

.fail-title {
  font-size: 13px;
}

.fail-reason {
  font-size: 12px;
  color: var(--danger);
  margin-top: 4px;
}
</style>
