<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NProgress, NTag, useMessage } from 'naive-ui'
import type { BrowseState, DownloadProgress } from '@shared/types'

const props = defineProps<{
  active?: boolean
  prefillUrl?: string
  prefillNonce?: number
}>()

const emit = defineEmits<{
  (e: 'open-book', bookId: string): void
  (e: 'edit-site-rule', host: string): void
}>()
const message = useMessage()

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

const progressEnded = computed(() => {
  const status = downloadProgress.value?.status
  return status === 'done' || status === 'error' || status === 'cancelled'
})

const failedChapterRows = computed(() => downloadProgress.value?.failedChapters ?? [])

function currentHost(): string {
  try {
    const u = new URL(address.value || state.value.url)
    return u.hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

const siteLabel = computed(() => {
  const host = currentHost()
  return host ? `当前站点：${host}` : '尚未打开网页'
})

function editCurrentSiteRule() {
  const host = currentHost()
  if (!host) {
    message.warning('请先打开一个有效网址')
    return
  }
  emit('edit-site-rule', host)
}

function openThisBook() {
  const p = downloadProgress.value
  if (!p?.bookId || !canOpenDownloadedBook.value) return
  emit('open-book', p.bookId)
  showProgress.value = false
}

function restoreProgressDrawer() {
  if (downloadProgress.value) showProgress.value = true
}

function noteFailedRetrySample() {
  message.info('样例，尚未补章')
}

function reportBounds() {
  const el = slot.value
  if (!el) return
  const r = el.getBoundingClientRect()
  // v-show hide (display:none) yields 0×0; do not overwrite lastBounds with 1×1.
  if (r.width < 8 || r.height < 8) return
  const slotHeight = Math.round(r.height)
  // Native persist:novel view sits above Vue; inset by the 240px drawer so
  // 打开这本书 / 取消下载 receive the real pointer. ResizeObserver will not fire.
  const height = showProgress.value ? Math.max(1, slotHeight - 240) : Math.max(1, slotHeight)
  void window.api.browse.setBounds({
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(1, Math.round(r.width)),
    height,
  })
}

watch(showProgress, reportBounds)

watch(
  () => props.prefillNonce,
  () => {
    if (!props.prefillUrl) return
    address.value = props.prefillUrl
    void go()
  },
)

async function go() {
  const res = await window.api.browse.load(address.value)
  if (!res.ok) {
    message.error(res.message)
  }
}

function back() {
  void window.api.browse.back()
}

function forward() {
  void window.api.browse.forward()
}

function reload() {
  void window.api.browse.reload()
}

function stop() {
  void window.api.browse.stop()
}

async function startDownload() {
  downloading.value = true
  downloadProgress.value = null
  showProgress.value = true
  const res = await window.api.download.start()
  if (!res.ok) {
    message.error(res.message || '下载失败')
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
    <form class="browse-toolbar" @submit="onSubmit">
      <div class="browser-nav-row">
        <button class="browser-icon-button" type="button" title="后退" aria-label="后退" :disabled="!state.canGoBack" @click="back">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <button class="browser-icon-button" type="button" title="前进" aria-label="前进" :disabled="!state.canGoForward" @click="forward">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </button>
        <button
          class="browser-icon-button"
          type="button"
          :title="state.loading ? '停止加载' : '刷新'"
          :aria-label="state.loading ? '停止加载' : '刷新'"
          @click="state.loading ? stop() : reload()"
        >
          <svg v-if="state.loading" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v7h-7" /></svg>
        </button>
        <input v-model="address" aria-label="网页地址" placeholder="粘贴或输入网址，回车打开" spellcheck="false" />
        <button class="browser-open-button" type="submit">打开</button>
      </div>
      <div class="browser-action-row">
        <div class="site-status" :class="{ inactive: !currentHost() }" :title="siteLabel">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
          <span>{{ siteLabel }}</span>
        </div>
        <div class="browser-actions">
          <n-button
            type="primary"
            size="small"
            :disabled="downloading || !address"
            :loading="downloading"
            @click.prevent="startDownload"
          >
            下载本书
          </n-button>
          <n-button size="small" secondary :disabled="!currentHost()" @click.prevent="editCurrentSiteRule">
            配置本站规则
          </n-button>
          <n-button
            v-if="downloadProgress && !showProgress"
            size="small"
            tertiary
            @click.prevent="restoreProgressDrawer"
          >
            下载进度
          </n-button>
        </div>
      </div>
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
          <div v-if="progressEnded" class="dl-failed">
            <div class="dl-failed-title">失败章节</div>
            <ul v-if="failedChapterRows.length > 0" class="dl-failed-list">
              <li v-for="row in failedChapterRows" :key="row.chapterId">
                <span class="dl-failed-index">{{ row.index }}</span>
                <span class="dl-failed-name">{{ row.title }}</span>
                <span class="dl-failed-reason">{{ row.reason }}</span>
              </li>
            </ul>
            <div v-else class="dl-failed-empty">没有失败章节</div>
            <div v-if="failedChapterRows.length > 0" class="dl-retry-sample">
              <n-button size="small" secondary @click="noteFailedRetrySample">只补失败章</n-button>
              <span>样例，尚未补章</span>
            </div>
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
        <div v-else class="dl-waiting">等待下载开始…</div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.browse-toolbar {
  position: relative;
  z-index: 2;
  height: auto;
  display: block;
  padding: 0;
  border-bottom: 1px solid var(--border);
  background: var(--chrome-bg);
}

.browser-nav-row,
.browser-action-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.browser-nav-row {
  min-height: 52px;
}

.browser-action-row {
  min-height: 44px;
  justify-content: space-between;
  border-top: 1px solid var(--border);
  background: var(--surface-1);
}

.browser-nav-row input {
  min-width: 120px;
  height: 36px;
  flex: 1;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  padding: 0 var(--space-3);
  color: var(--text-primary);
  background: var(--input-bg);
  transition: border-color var(--motion-duration), box-shadow var(--motion-duration);
}

.browser-nav-row input:focus {
  border-color: var(--focus);
  box-shadow: var(--input-ring);
}

.browser-nav-row input:focus:not(:focus-visible) {
  outline: none;
}

.browser-icon-button {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  background: var(--chip-bg);
  cursor: pointer;
  transition: border-color var(--motion-duration), background var(--motion-duration), color var(--motion-duration);
}

.browser-icon-button:hover:not(:disabled),
.browser-open-button:hover:not(:disabled) {
  border-color: var(--hover-line);
  background: var(--chip-hover-bg);
}

.browser-icon-button:disabled {
  opacity: 0.45;
  cursor: default;
}

.browser-icon-button svg,
.site-status svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.browser-open-button {
  height: 36px;
  flex: 0 0 auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  padding: 0 var(--space-3);
  color: var(--text-primary);
  background: var(--chip-bg);
  cursor: pointer;
  transition: border-color var(--motion-duration), background var(--motion-duration), color var(--motion-duration);
}

.site-status {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: 12px;
}

.site-status.inactive {
  color: var(--text-muted);
}

.site-status span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.dl-progress {
  padding: var(--space-2) 0;
}

.dl-waiting {
  color: var(--muted);
  text-align: center;
  padding: var(--space-6);
}

.dl-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: var(--space-2);
}

.dl-stats {
  font-size: 13px;
  color: var(--muted);
  margin-top: var(--space-2);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.dl-current {
  font-size: 12px;
  color: var(--muted);
  margin-top: var(--space-1);
}

.dl-error {
  font-size: 12px;
  color: var(--danger);
  margin-top: var(--space-1);
}

.dl-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.dl-failed {
  margin-top: var(--space-2);
  color: var(--text-primary);
  font-size: 12px;
}

.dl-failed-title {
  font-weight: 600;
  margin-bottom: var(--space-1);
}

.dl-failed-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 72px;
  overflow: auto;
}

.dl-failed-list li {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  padding: 2px 0;
}

.dl-failed-index {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.dl-failed-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-failed-reason {
  flex: 0 1 auto;
  margin-left: auto;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-failed-empty {
  color: var(--text-muted);
}

.dl-retry-sample {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  color: var(--text-muted);
}
</style>
