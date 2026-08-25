<script setup lang="ts">
import { NButton, NCard, NEmpty, NSpace, NTag, NPopconfirm, NDropdown, useMessage } from 'naive-ui'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { BookListItem, DownloadProgress } from '@shared/types'
import {
  applyAddedChapterCount,
  checkUpdateMessage,
  hasFailedChapters,
  isDownloadBook,
} from './libraryCard'

const props = defineProps<{ active?: boolean }>()

const emit = defineEmits<{
  (e: 'open-book', bookId: string): void
}>()

const message = useMessage()
const books = ref<BookListItem[]>([])
const loading = ref(false)
const retryingId = ref<string | null>(null)
const checkingId = ref<string | null>(null)
const exportingId = ref<string | null>(null)
const checkMsg = ref<Record<string, string>>({})
let unsubProgress: (() => void) | null = null

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
  await window.api.library.delete(bookId)
  await refresh()
}

async function handleRetry(bookId: string) {
  retryingId.value = bookId
  const res = await window.api.download.retryFailed(bookId)
  if (!res.ok) {
    window.alert(res.message || '重试失败')
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
    if (res.ok && res.added > 0) await refresh()
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    checkMsg.value = { ...checkMsg.value, [bookId]: message || '检查更新失败' }
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

function statusType(status: BookListItem['status']): 'info' | 'success' | 'warning' {
  if (status === 'downloading') return 'info'
  if (status === 'ready') return 'success'
  return 'warning'
}

function fmtProgress(b: BookListItem): string {
  if (!b.progress) return `${b.readyCount}/${b.chapterCount} 章`
  return `${b.progress.chapterId} · ${b.readyCount}/${b.chapterCount} 章`
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
    if (p.status === 'done' || p.status === 'cancelled' || p.status === 'error') {
      retryingId.value = null
      checkingId.value = null
      void refresh()
    }
  })
})

onUnmounted(() => {
  unsubProgress?.()
})
</script>

<template>
  <div class="page">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h2 style="margin:0">书库</h2>
      <n-button type="primary" @click="handleImport">导入 txt / epub</n-button>
    </div>
    <n-empty v-if="!books.length && !loading" description="还没有书，去浏览页下一本或导入文件" />
    <div v-else class="book-grid">
      <n-card
        v-for="b in books"
        :key="b.id"
        hoverable
        class="book-card"
        @click="emit('open-book', b.id)"
      >
        <div class="book-cover">📖</div>
        <div class="book-title">{{ b.title }}</div>
        <div class="book-meta">
          <span v-if="b.author">{{ b.author }}</span>
          <n-tag size="small" :type="statusType(b.status)">
            {{ statusLabel(b.status) }}
          </n-tag>
        </div>
        <div class="book-progress">{{ fmtProgress(b) }}</div>
        <div v-if="checkMsg[b.id]" class="check-msg">{{ checkMsg[b.id] }}</div>
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
            确认删除《{{ b.title }}》？本地文件将被清除。
          </n-popconfirm>
        </n-space>
      </n-card>
    </div>
  </div>
</template>

<style scoped>
.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}

.book-card {
  cursor: pointer;
}

.book-cover {
  font-size: 48px;
  text-align: center;
  padding: 24px 0 12px;
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
  color: #999;
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.book-progress {
  font-size: 12px;
  color: #888;
  margin-top: 4px;
}

.check-msg {
  font-size: 12px;
  color: #63e2b7;
  margin-top: 6px;
  line-height: 1.4;
}
</style>
