<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NProgress, NTag, useMessage } from 'naive-ui'
import type { BrowseState, DownloadPreview, DownloadProgress } from '@shared/types'

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
const retryingFailed = ref(false)
const downloadProgress = ref<DownloadProgress | null>(null)
const showProgress = ref(false)
const showPreview = ref(false)
const previewing = ref(false)
const downloadPreview = ref<DownloadPreview | null>(null)
const adFilterEnabled = ref(true)
const adFilterBusy = ref(false)
let lastAdHost = ''

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
    const u = new URL(state.value.url)
    return u.hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

async function refreshAdSetting(host: string): Promise<void> {
  if (!host) {
    adFilterEnabled.value = true
    return
  }
  try {
    const { rules } = await window.api.siteRules.list()
    if (currentHost() !== host) return
    adFilterEnabled.value = rules.find((rule) => rule.host === host)?.adFilterEnabled !== false
  } catch {
    adFilterEnabled.value = true
  }
}

async function toggleAdFilter(): Promise<void> {
  const host = currentHost()
  if (!host || adFilterBusy.value) return
  adFilterBusy.value = true
  try {
    const { rules } = await window.api.siteRules.list()
    const existing = rules.find((rule) => rule.host === host)
    const enabled = !(existing?.adFilterEnabled !== false)
    const result = await window.api.siteRules.upsert({ ...existing, host, adFilterEnabled: enabled })
    if (!result.ok) {
      message.error(result.message || '去广告设置保存失败')
      return
    }
    if (currentHost() === host) {
      adFilterEnabled.value = enabled
      try {
        await window.api.browse.reload()
      } catch {
        message.warning('去广告设置已保存，请手动刷新网页')
      }
    }
  } catch (e: unknown) {
    message.error(e instanceof Error ? e.message : '去广告设置保存失败')
  } finally {
    adFilterBusy.value = false
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

function reportBounds() {
  const el = slot.value
  if (!el) return
  const r = el.getBoundingClientRect()
  // v-show hide (display:none) yields 0×0; do not overwrite lastBounds with 1×1.
  if (r.width < 8 || r.height < 8) return
  const slotHeight = Math.round(r.height)
  // Native persist:novel view sits above Vue; inset by the 240px drawer so
  // 打开这本书 / 取消下载 receive the real pointer. ResizeObserver will not fire.
  const inset = showPreview.value ? 430 : showProgress.value ? 240 : 0
  const height = Math.max(1, slotHeight - inset)
  void window.api.browse.setBounds({
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(1, Math.round(r.width)),
    height,
  })
}

watch(showProgress, reportBounds)
watch(showPreview, reportBounds)
watch(() => props.active, (active) => {
  if (active) void refreshAdSetting(currentHost())
})

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
  if (previewing.value || downloading.value) return
  previewing.value = true
  try {
    const res = await window.api.download.preview()
    if (!res.ok) { message.error(res.message); return }
    downloadPreview.value = res.preview
    showPreview.value = true
  } catch (error) {
    message.error(error instanceof Error ? error.message : '预览失败')
  } finally { previewing.value = false }
}

async function confirmDownload() {
  const token = downloadPreview.value?.token
  if (!token) return
  downloading.value = true
  downloadProgress.value = null
  const res = await window.api.download.confirm(token)
  if (!res.ok) {
    downloading.value = false
    message.error(res.message || '下载失败，请重新预览')
    showPreview.value = false
    downloadPreview.value = null
    return
  }
  showPreview.value = false
  downloadPreview.value = null
  showProgress.value = true
}

async function cancelDownload() {
  await window.api.download.cancel()
}

async function retryFailedChapters() {
  const bookId = downloadProgress.value?.bookId
  if (!bookId || retryingFailed.value || downloading.value) return
  retryingFailed.value = true
  downloading.value = true
  try {
    const res = await window.api.download.retryFailed(bookId)
    if (!res.ok) {
      message.error(res.message || '重试失败')
      retryingFailed.value = false
      downloading.value = false
    }
  } catch (e: unknown) {
    message.error(e instanceof Error ? e.message : '重试失败')
    retryingFailed.value = false
    downloading.value = false
  }
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
    const host = currentHost()
    if (host !== lastAdHost) {
      lastAdHost = host
      void refreshAdSetting(host)
    }
  }))
  unsubs.push(window.api.browse.onUrl(({ url }) => {
    if (url && url !== 'about:blank') address.value = url
  }))
  unsubs.push(window.api.download.onProgress((p) => {
    downloadProgress.value = p
    if (p.status === 'done' || p.status === 'cancelled' || p.status === 'error') {
      downloading.value = false
      retryingFailed.value = false
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
            :loading="previewing || downloading"
            @click.prevent="startDownload"
          >
            下载本书
          </n-button>
          <n-button size="small" secondary :disabled="!currentHost()" @click.prevent="editCurrentSiteRule">
            配置本站规则
          </n-button>
          <n-button size="small" secondary :disabled="!currentHost()" :loading="adFilterBusy" @click.prevent="toggleAdFilter">
            {{ adFilterEnabled ? '关闭去广告' : '开启去广告' }}
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

    <n-drawer v-model:show="showPreview" placement="bottom" :height="430">
      <n-drawer-content title="下载前预览" closable>
        <div v-if="downloadPreview" class="dl-progress">
          <strong>{{ downloadPreview.bookTitle || '未识别书名' }}</strong>
          <div>作者：{{ downloadPreview.author || '未识别' }} · 目录 {{ downloadPreview.chapterCount }} 章</div>
          <div>前几章：{{ downloadPreview.chapterTitles.join('、') }}</div>
          <strong>样本：{{ downloadPreview.sampleTitle }}</strong>
          <p v-if="downloadPreview.sampleError" role="alert">样本提取失败：{{ downloadPreview.sampleError }}</p>
          <div v-else class="download-preview-sample">{{ downloadPreview.sampleBody || '没有可预览的正文' }}</div>
          <n-button type="primary" :loading="downloading" @click="confirmDownload">确认下载这本书</n-button>
        </div>
      </n-drawer-content>
    </n-drawer>

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
          <div v-if="progressEnded && downloadProgress.qualityIssueCount" class="dl-error">
            质量检查发现 {{ downloadProgress.qualityIssueCount }} 项疑似问题，可到书库核对。
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
              <n-button
                size="small"
                secondary
                :loading="retryingFailed"
                :disabled="downloading || !downloadProgress?.bookId"
                @click="retryFailedChapters"
              >
                只补失败章
              </n-button>
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
.browse-page {
  --browse-paper: #f7f3e8;
  --browse-ink: #2f2a24;
  --browse-ink-soft: #6d6458;
  --browse-line: rgba(47, 42, 36, 0.14);
  --browse-focus: #8a5a32;
  color: var(--browse-ink);
  background: var(--browse-paper);
  font-family: "Source Han Serif SC", "Noto Serif SC", "Songti SC", "SimSun", "Microsoft YaHei UI", serif;
}

.browse-toolbar {
  position: relative;
  z-index: 2;
  height: auto;
  display: block;
  padding: 0;
  border-bottom: 1px solid rgba(47, 42, 36, 0.14);
  background: #f7f3e8;
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
  border-top: 1px solid rgba(47, 42, 36, 0.14);
  background: #fffdf8;
}

.browser-nav-row input {
  min-width: 120px;
  height: 36px;
  flex: 1;
  border: 1px solid #e3d9c6;
  border-radius: var(--radius-control);
  padding: 0 var(--space-3);
  color: var(--browse-ink);
  background: #fffdf8;
  font: inherit;
  font-size: 14px;
  transition: border-color var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing), box-shadow var(--motion-duration) var(--motion-easing);
}

.browser-nav-row input::placeholder {
  color: var(--browse-ink-soft);
}

.browser-nav-row input:hover {
  border-color: #c9b89a;
  background: #fffdf8;
}

.browser-nav-row input:focus {
  border-color: var(--browse-focus);
  background: #fffdf8;
  box-shadow: 0 0 0 3px rgba(138, 90, 50, 0.16);
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
  border: 1px solid #e3d9c6;
  border-radius: var(--radius-control);
  color: var(--browse-ink);
  background: #fffdf8;
  cursor: pointer;
  transition: border-color var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing), color var(--motion-duration) var(--motion-easing);
}

.browser-icon-button:hover:not(:disabled) {
  border-color: #c9b89a;
  background: #f3ecdf;
}

.browser-icon-button:active:not(:disabled) {
  border-color: var(--browse-focus);
  background: #efe6d4;
}

.browser-icon-button:focus-visible,
.browser-open-button:focus-visible {
  outline: 2px solid var(--browse-focus);
  outline-offset: 2px;
}

.browser-icon-button:disabled {
  color: #a89884;
  border-color: #eadfce;
  background: #fffdf8;
  opacity: 1;
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
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  padding: 0 var(--space-3);
  color: #fffaf3;
  background: var(--browse-focus);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
  transition: background var(--motion-duration) var(--motion-easing);
}

.browser-open-button:hover:not(:disabled) {
  background: #744b29;
}

.browser-open-button:active:not(:disabled) {
  background: #633f22;
}

.browser-open-button:disabled {
  color: rgba(255, 250, 243, 0.72);
  background: #c9b89a;
  cursor: default;
}

.site-status {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--browse-ink-soft);
  font-size: 12px;
}

.site-status.inactive {
  color: #a89884;
}

.browse-page :deep(.n-button) {
  --n-color: #fffdf8;
  --n-color-hover: #f3ecdf;
  --n-color-pressed: #efe6d4;
  --n-color-focus: #fffdf8;
  --n-text-color: var(--browse-ink);
  --n-text-color-hover: var(--browse-ink);
  --n-text-color-pressed: var(--browse-ink);
  --n-text-color-focus: var(--browse-ink);
  --n-text-color-disabled: #a89884;
  --n-border: 1px solid #e3d9c6;
  --n-border-hover: 1px solid #c9b89a;
  --n-border-pressed: 1px solid var(--browse-focus);
  --n-border-focus: 1px solid var(--browse-focus);
  --n-border-disabled: 1px solid #eadfce;
  --n-ripple-color: var(--browse-focus);
  min-height: 32px;
  border-radius: var(--radius-control);
}

.browse-page :deep(.n-button.n-button--primary-type) {
  --n-color: var(--browse-focus);
  --n-color-hover: #744b29;
  --n-color-pressed: #633f22;
  --n-color-focus: var(--browse-focus);
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

.browse-page :deep(.n-button.n-button--error-type) {
  --n-color: transparent;
  --n-color-hover: rgba(156, 59, 50, 0.08);
  --n-color-pressed: rgba(156, 59, 50, 0.14);
  --n-text-color: #9c3b32;
  --n-text-color-hover: #9c3b32;
  --n-text-color-pressed: #9c3b32;
  --n-border: 1px solid transparent;
}

.browse-page :deep(.n-button:not(.n-button--disabled):focus-visible) {
  outline: 2px solid var(--browse-focus);
  outline-offset: 2px;
}

.browse-page :deep(.n-drawer-content),
.browse-page :deep(.n-drawer-body-content-wrapper) {
  color: var(--browse-ink);
  background: var(--browse-paper);
}

.browse-page :deep(.n-drawer-header) {
  border-bottom: 1px solid var(--browse-line);
}

.browse-page :deep(.n-drawer-header__main) {
  color: var(--browse-ink);
  font-weight: 600;
}

.browse-page :deep(.n-progress-graph-line-fill) {
  background: var(--browse-focus) !important;
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
  color: var(--browse-ink);
}

.dl-waiting {
  color: var(--browse-ink-soft);
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
  color: var(--browse-ink-soft);
  margin-top: var(--space-2);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.dl-current {
  font-size: 12px;
  color: var(--browse-ink-soft);
  margin-top: var(--space-1);
}

.dl-error {
  font-size: 12px;
  color: #9c3b32;
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
  color: var(--browse-ink);
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
  color: #a89884;
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
  color: var(--browse-ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-failed-empty {
  color: #a89884;
}
.download-preview-sample {
  white-space: pre-wrap;
  max-height: 120px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--line);
}

.dl-retry-sample {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  color: #a89884;
}

@media (prefers-reduced-motion: reduce) {
  .browser-icon-button,
  .browser-open-button,
  .browser-nav-row input,
  .browse-page :deep(.n-button) {
    transition: none;
  }
}
</style>
