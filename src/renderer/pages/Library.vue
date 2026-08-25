<script setup lang="ts">
import { NButton, NCard, NEmpty, NInput, NSelect, NSpace, NTag, NPopconfirm, NModal, NDropdown, useMessage } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { BookListItem, ChapterMeta, DownloadProgress, FailCode, TrashItem } from '@shared/types'
import { FAIL_CODE_ZH } from '@shared/types'
import {
  applyAddedChapterCount,
  checkUpdateMessage,
  checkUpdateNeedsBrowse,
  filterLibraryBooks,
  formatChapterOrdinal,
  formatLibraryProgress,
  hasFailedChapters,
  isDownloadBook,
  sortLibraryBooks,
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
const loading = ref(false)
const retryingId = ref<string | null>(null)
const checkingId = ref<string | null>(null)
const exportingId = ref<string | null>(null)
const checkMsg = ref<Record<string, string>>({})
const checkErr = ref<Record<string, boolean>>({})
const query = ref('')
const statusFilter = ref<LibraryStatusFilter>('all')
const sortKey = ref<LibrarySortKey>('updated')
const failedOpen = ref(false)
const failedTitle = ref('')
const failedBookId = ref('')
const failedRows = ref<ChapterMeta[]>([])
let unsubProgress: (() => void) | null = null
let unsubCheckAll: (() => void) | null = null
let lastErrorToast = ''

const visibleBooks = computed(() =>
  sortLibraryBooks(filterLibraryBooks(books.value, { q: query.value, status: statusFilter.value }), sortKey.value),
)

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
  loading.value = true
  try {
    const res = await window.api.library.list()
    books.value = res.books
  } finally {
    loading.value = false
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
    window.alert(res.message || '导入失败')
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

async function handleRetry(bookId: string) {
  retryingId.value = bookId
  const res = await window.api.download.retryFailed(bookId)
  if (!res.ok) {
    message.error(res.message || '重试失败')
    retryingId.value = null
  }
}

async function handleCheckUpdate(bookId: string) {
  checkingId.value = bookId
  try {
    const res = await window.api.download.checkUpdate(bookId)
    checkingId.value = null
    if (res.ok && res.added > 0) {
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
    checkingId.value = null
  }
}

async function handleExport(bookId: string, format: 'txt' | 'epub') {
  const { filePaths } = await window.api.dialog.openDirectory()
  const dest = filePaths?.[0]
  if (!dest) return
  exportingId.value = bookId
  try {
    const res = await window.api.library.export(bookId, format, dest)
    if (res.ok) message.success(`已导出到 ${res.path}`)
    else message.error(res.message || '导出失败')
  } finally {
    exportingId.value = null
  }
}

function statusLabel(status: BookListItem['status']): string {
  if (status === 'downloading') return '下载中'
  if (status === 'ready') return '完整'
  return '部分'
}

/** 按书 id 稳定映射一个色相，让每本书的封面渐变色不同 */
function coverHue(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return String(h)
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

onMounted(() => {
  refresh()
  unsubProgress = window.api.download.onProgress((p: DownloadProgress) => {
    if (p.status === 'running' && p.bookId) {
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
      retryingId.value = null
      checkingId.value = null
      void refresh()
    }
  })
  unsubCheckAll = window.api.download.onCheckAllProgress((p) => {
    checkAllStatus.value = `正在检查 ${p.current}/${p.total}：《${p.title}》`
  })
})

onUnmounted(() => {
  unsubProgress?.()
  unsubCheckAll?.()
})
</script>

<template>
  <div class="page">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px">
      <h2 style="margin:0">书库</h2>
      <n-space align="center">
        <span v-if="checkAllStatus" class="checkall-status">{{ checkAllStatus }}</span>
        <n-button v-if="checkAllLoading" size="small" @click="handleCancelCheckAll">停止</n-button>
        <n-button v-else :disabled="!books.length" @click="handleCheckAll">全部检查更新</n-button>
        <n-button @click="openTrash">回收站</n-button>
        <n-button type="primary" @click="handleImport">导入 txt / epub</n-button>
      </n-space>
    </div>
    <div v-if="books.length" class="lib-toolbar">
      <n-input v-model:value="query" clearable placeholder="按书名或作者筛选" style="max-width:240px" />
      <n-select v-model:value="statusFilter" :options="statusOptions" style="width:120px" />
      <n-select v-model:value="sortKey" :options="sortOptions" style="width:132px" />
    </div>
    <n-empty v-if="!books.length && !loading" description="还没有书，去浏览页下一本或导入文件" />
    <n-empty v-else-if="!visibleBooks.length && !loading" description="没有符合筛选的书" />
    <div v-else class="book-grid">
      <n-card
        v-for="b in visibleBooks"
        :key="b.id"
        hoverable
        class="book-card"
        @click="emit('open-book', b.id)"
      >
        <div class="book-cover" :style="{ '--hue': coverHue(b.id) }">📖</div>
        <div class="book-title">{{ b.title }}</div>
        <div class="book-meta">
          <span v-if="b.author">{{ b.author }}</span>
          <n-tag size="small" :type="statusType(b.status)">
            {{ statusLabel(b.status) }}
          </n-tag>
        </div>
        <div class="book-progress">{{ fmtProgress(b) }}</div>
        <div v-if="checkMsg[b.id]" class="check-msg" :class="{ error: checkErr[b.id] }">{{ checkMsg[b.id] }}</div>
        <n-space justify="end" style="margin-top:8px">
          <n-button
            v-if="isDownloadBook(b)"
            size="tiny"
            :loading="checkingId === b.id"
            @click.stop="handleCheckUpdate(b.id)"
          >
            检查更新
          </n-button>
          <n-button
            v-if="hasFailedChapters(b)"
            size="tiny"
            type="warning"
            :loading="retryingId === b.id"
            @click.stop="handleRetry(b.id)"
          >
            重试失败章
          </n-button>
          <n-button
            v-if="hasFailedChapters(b)"
            size="tiny"
            @click.stop="openFailedList(b.id, b.title)"
          >
            失败章
          </n-button>
          <n-dropdown
            trigger="click"
            :options="[{ label: '导出 txt', key: 'txt' }, { label: '导出 epub', key: 'epub' }]"
            @select="(key: string) => handleExport(b.id, key as 'txt' | 'epub')"
          >
            <n-button size="tiny" :loading="exportingId === b.id" @click.stop>导出</n-button>
          </n-dropdown>
          <n-popconfirm @positive-click="handleDelete(b.id)">
            <template #trigger>
              <n-button size="tiny" quaternary @click.stop>删除</n-button>
            </template>
            把《{{ b.title }}》移入回收站？之后可在回收站还原。
          </n-popconfirm>
        </n-space>
      </n-card>
    </div>
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
            :loading="retryingId === failedBookId"
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
.lib-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.checkall-status {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}

.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}

.book-card {
  cursor: pointer;
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}

.book-card:hover {
  transform: translateY(-4px);
  border-color: var(--card-hover-border);
  box-shadow: var(--card-hover-shadow);
}

.book-cover {
  height: 96px;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 42px;
  border-radius: 10px;
  background: var(--cover-background);
  box-shadow: var(--cover-ring);
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}

.book-title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.book-meta {
  font-size: 12px;
  color: var(--muted);
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.book-progress {
  font-size: 12px;
  color: var(--muted);
  opacity: 0.85;
  margin-top: 4px;
}

.check-msg {
  font-size: 12px;
  color: var(--success);
  margin-top: 6px;
  line-height: 1.4;
}

.check-msg.error {
  color: var(--danger);
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
