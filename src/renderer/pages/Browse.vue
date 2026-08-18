<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NDrawer, NDrawerContent, NProgress, NTag } from 'naive-ui'
import type { BrowseState, DownloadProgress } from '@shared/types'

const emit = defineEmits<{
  (e: 'open-book', bookId: string): void
}>()

const address = ref('')
const state = ref<BrowseState>({
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
})
const slot = ref<HTMLElement | null>(null)
let ro: ResizeObserver | null = null
const unsubs: Array<() => void> = []

// Download state
const downloading = ref(false)
const downloadProgress = ref<DownloadProgress | null>(null)
const showProgress = ref(false)

const canOpenDownloadedBook = computed(() => {
  const p = downloadProgress.value
  return Boolean(p?.bookId) && (p!.status === 'done' || p!.status === 'error')
})

function openThisBook() {
  const p = downloadProgress.value
  if (!p?.bookId || !canOpenDownloadedBook.value) return
  emit('open-book', p.bookId)
  showProgress.value = false
}

function reportBounds() {
  const el = slot.value
  if (!el) return
  const r = el.getBoundingClientRect()
  // v-show hide (display:none) yields 0×0; do not overwrite lastBounds with 1×1.
  if (r.width < 8 || r.height < 8) return
  void window.api.browse.setBounds({
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(1, Math.round(r.width)),
    height: Math.max(1, Math.round(r.height)),
  })
}

async function go() {
  const res = await window.api.browse.load(address.value)
  if (!res.ok) {
    window.alert(res.message)
  }
}

async function startDownload() {
  downloading.value = true
  downloadProgress.value = null
  showProgress.value = true
  const res = await window.api.download.start()
  if (!res.ok) {
    window.alert(res.message || '下载失败')
    downloading.value = false
    showProgress.value = false
    downloadProgress.value = null
    return
  }
}

async function cancelDownload() {
  await window.api.download.cancel()
}

function onSubmit(e: Event) {
  e.preventDefault()
  void go()
}

onMounted(async () => {
  await nextTick()
  reportBounds()
  ro = new ResizeObserver(() => reportBounds())
  if (slot.value) ro.observe(slot.value)
  window.addEventListener('resize', reportBounds)
  unsubs.push(window.api.browse.onState((s) => {
    state.value = s
    if (s.url && s.url !== 'about:blank') address.value = s.url
  }))
  unsubs.push(window.api.browse.onUrl(({ url }) => {
    if (url && url !== 'about:blank') address.value = url
  }))
  unsubs.push(window.api.download.onProgress((p) => {
    downloadProgress.value = p
    if (p.status === 'done' || p.status === 'cancelled' || p.status === 'error') {
      downloading.value = false
      // Closed mid-run must not cancel; surface the terminal tag + open button.
      showProgress.value = true
    }
  }))
})

onUnmounted(() => {
  ro?.disconnect()
  window.removeEventListener('resize', reportBounds)
  unsubs.forEach((u) => u())
})
</script>

<template>
  <div class="page browse-page">
    <form class="chrome" @submit="onSubmit">
      <button type="button" :disabled="!state.canGoBack" @click="window.api.browse.back()">后退</button>
      <button type="button" :disabled="!state.canGoForward" @click="window.api.browse.forward()">前进</button>
      <button type="button" @click="state.loading ? window.api.browse.stop() : window.api.browse.reload()">
        {{ state.loading ? '停止' : '刷新' }}
      </button>
      <input v-model="address" placeholder="粘贴或输入网址，回车打开" spellcheck="false" />
      <button type="submit">打开</button>
      <n-button
        type="primary"
        size="small"
        :disabled="downloading || !address"
        :loading="downloading"
        @click.prevent="startDownload"
      >
        下载本书
      </n-button>
    </form>
    <div ref="slot" class="browse-slot" />

    <!-- Download progress drawer -->
    <n-drawer v-model:show="showProgress" placement="bottom" :height="240">
      <n-drawer-content title="下载进度" closable>
        <div v-if="downloadProgress" class="dl-progress">
          <div class="dl-title">{{ downloadProgress.title }}</div>
          <n-progress
            type="line"
            :percentage="downloadProgress.total > 0 ? Math.round((downloadProgress.done + downloadProgress.failed) / downloadProgress.total * 100) : 0"
            :status="downloadProgress.status === 'error' ? 'error' : downloadProgress.status === 'done' ? 'success' : 'default'"
          />
          <div class="dl-stats">
            <span>已下 {{ downloadProgress.done }} / {{ downloadProgress.total }} 章</span>
            <n-tag v-if="downloadProgress.failed > 0" size="small" type="warning">
              {{ downloadProgress.failed }} 失败
            </n-tag>
            <n-tag v-if="downloadProgress.status === 'done'" size="small" type="success">完成</n-tag>
            <n-tag v-if="downloadProgress.status === 'error'" size="small" type="error">有失败</n-tag>
            <n-tag v-if="downloadProgress.status === 'cancelled'" size="small" type="warning">已取消</n-tag>
          </div>
          <div v-if="downloadProgress.currentTitle" class="dl-current">
            正在下载：{{ downloadProgress.currentTitle }}
          </div>
          <div v-if="downloadProgress.lastError" class="dl-error">
            错误：{{ downloadProgress.lastError }}
          </div>
          <div class="dl-actions">
            <n-button
              v-if="downloading"
              size="small"
              quaternary
              type="error"
              @click="cancelDownload"
            >
              取消下载
            </n-button>
            <n-button
              v-if="canOpenDownloadedBook"
              type="primary"
              size="small"
              @click="openThisBook"
            >
              打开这本书
            </n-button>
          </div>
        </div>
        <div v-else style="color:#888;text-align:center;padding:24px">等待下载开始…</div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.dl-progress {
  padding: 8px 0;
}

.dl-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
}

.dl-stats {
  font-size: 13px;
  color: #888;
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.dl-current {
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}

.dl-error {
  font-size: 12px;
  color: #e88080;
  margin-top: 4px;
}

.dl-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
</style>
