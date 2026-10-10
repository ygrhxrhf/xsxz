<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NProgress, NTag, useMessage } from 'naive-ui'
import { DEFAULT_READER_PREFS } from '@shared/types'
import type { BrowseState, BrowseReadingPage, BrowseFindResult, DownloadPreview, DownloadProgress, ReaderPrefs } from '@shared/types'

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
  zoom: 1,
})
const toolbarCollapsed = ref(false)
const readingPage = ref<BrowseReadingPage | null>(null)
const readingBusy = ref(false)
const readerPrefs = ref<ReaderPrefs>(DEFAULT_READER_PREFS)
const findOpen = ref(false)
const findQuery = ref('')
const findInput = ref<HTMLInputElement | null>(null)
const findResult = ref<BrowseFindResult>({ matches: 0, activeMatch: 0 })
const hidePicking = ref(false)
const hiddenCount = ref(0)
let resumeAttempted = false
let browseUrlForHide = ''
let hideCountTimer: ReturnType<typeof setInterval> | null = null
const themeColors = {
  paper: { bg: '#F7F3E8', text: '#2F2A24', outer: '#E9E3D7' },
  sepia: { bg: '#F3E2B8', text: '#3A2F22', outer: '#E6D2A4' },
  gray: { bg: '#E5E7E6', text: '#252A2D', outer: '#D6D9D8' },
  night: { bg: '#1B1D20', text: '#D8D2C7', outer: '#111316' },
}
const readingStyle = computed(() => {
  const p = readerPrefs.value
  const colors = themeColors[p.theme]
  return {
    '--web-paper': colors.bg,
    '--web-ink': colors.text,
    '--web-outer': colors.outer,
    '--web-font': p.fontFamily === 'serif' ? '"STSong", "Songti SC", "SimSun", serif' : p.fontFamily === 'mono' ? '"Cascadia Mono", "Consolas", monospace' : '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    '--web-width': p.contentWidth === 'narrow' ? '32em' : p.contentWidth === 'wide' ? '46em' : '38em',
    '--web-size': `${p.fontSize}px`,
    '--web-line': String(p.lineHeight),
    '--web-spacing': p.paragraphSpacing === 'compact' ? '0.2em' : p.paragraphSpacing === 'relaxed' ? '0.8em' : '0.45em',
    '--web-indent': p.paragraphIndent ? '2em' : '0',
  }
})
const readingParagraphs = computed(() => readingPage.value?.body.split(/\n\s*\n/).filter(Boolean) ?? [])
watch(findOpen, (open) => { if (open) void nextTick(() => findInput.value?.focus()) })
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
  if (active) {
    void refreshAdSetting(currentHost())
    void resumeBrowse()
  }
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
  if (readingPage.value) await exitReadingMode()
  const res = await window.api.browse.load(address.value)
  if (!res.ok) {
    message.error(res.message)
  }
}

async function resumeBrowse() {
  if (resumeAttempted || !props.active || props.prefillUrl) return
  resumeAttempted = true
  const res = await window.api.browse.resume()
  if (!res.ok) message.warning(res.message || '上次网页恢复失败')
}

async function setZoom(delta: number | 'reset') {
  const factor = delta === 'reset' ? 1 : state.value.zoom + delta
  const res = await window.api.browse.zoom(factor)
  if (!res.ok) message.warning(res.message || '缩放失败')
}

async function enterReadingMode() {
  if (readingBusy.value || readingPage.value) return
  readingBusy.value = true
  try {
    const res = await window.api.browse.readingPage()
    if (!res.ok) { message.warning(res.message); return }
    readerPrefs.value = (await window.api.settings.get()).reader
    readingPage.value = res.page
    await window.api.browse.setReadingMode(true)
  } catch { message.error('无法开启网页阅读模式') }
  finally { readingBusy.value = false }
}

async function exitReadingMode() {
  readingPage.value = null
  await window.api.browse.setReadingMode(false)
  await nextTick()
  reportBounds()
}

async function changeChapter(direction: 'previous' | 'next') {
  if (readingPage.value) await exitReadingMode()
  const res = await window.api.browse.chapter(direction)
  if (!res.ok) message.warning(res.message || '章节打开失败')
}

function runFind(forward = true, findNext = false) {
  const query = findQuery.value.trim()
  if (query && !readingPage.value) void window.api.browse.find(query, forward, findNext)
}

function closeFind() {
  findOpen.value = false
  findQuery.value = ''
  findResult.value = { matches: 0, activeMatch: 0 }
  void window.api.browse.stopFind()
}

async function hideAction(action: 'start' | 'stop' | 'undo') {
  const result = await window.api.browse.hide(action)
  if (!result.ok) { message.warning(result.message || '操作失败'); return }
  hiddenCount.value = result.remaining ?? 0
  hidePicking.value = action === 'start' ? true : action === 'stop' ? false : hidePicking.value
}

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
  if (event.ctrlKey && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    if (!readingPage.value) findOpen.value = true
  } else if (event.altKey && event.key === 'ArrowUp') {
    event.preventDefault(); void changeChapter('previous')
  } else if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault(); void changeChapter('next')
  } else if (event.key === 'Escape') {
    if (findOpen.value) closeFind()
    else if (hidePicking.value) void hideAction('stop')
  }
}

async function back() {
  if (readingPage.value) await exitReadingMode()
  void window.api.browse.back()
}

async function forward() {
  if (readingPage.value) await exitReadingMode()
  void window.api.browse.forward()
}

async function reload() {
  if (readingPage.value) await exitReadingMode()
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
  window.addEventListener('keydown', onKeydown)
  void resumeBrowse()
  unsubs.push(window.api.browse.onState((s) => {
    state.value = s
    if (s.loading) { hidePicking.value = false; hiddenCount.value = 0 }
    if (readingPage.value && s.url !== readingPage.value.url) void exitReadingMode()
    if (s.url !== browseUrlForHide) {
      browseUrlForHide = s.url
      hidePicking.value = false
      hiddenCount.value = 0
      if (findOpen.value) closeFind()
    }
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
  unsubs.push(window.api.browse.onFindResult((result) => { findResult.value = result }))
  unsubs.push(window.api.browse.onShortcut((shortcut) => {
    if (shortcut.find && !readingPage.value) findOpen.value = true
    if (shortcut.direction) void changeChapter(shortcut.direction)
  }))
  hideCountTimer = setInterval(() => {
    if (!hidePicking.value) return
    void window.api.browse.hide('count').then((result) => { if (result.ok) hiddenCount.value = result.remaining ?? 0 })
  }, 500)
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
  window.removeEventListener('keydown', onKeydown)
  if (hideCountTimer) clearInterval(hideCountTimer)
  if (readingPage.value) void window.api.browse.setReadingMode(false)
  unsubs.forEach((u) => u())
})
</script>

<template>
  <div class="page browse-page">
    <form v-show="!toolbarCollapsed" class="browse-toolbar" @submit="onSubmit">
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
          <details class="browser-more">
            <summary>更多工具</summary>
            <div class="browser-more-content">
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
          </details>
        </div>
      </div>
    </form>
    <div class="web-reading-controls">
      <button type="button" @click="toolbarCollapsed = !toolbarCollapsed">{{ toolbarCollapsed ? '展开工具栏' : '收起工具栏' }}</button>
      <template v-if="toolbarCollapsed">
        <button type="button" :disabled="!state.canGoBack" @click="back">后退</button>
        <button type="button" :disabled="!state.canGoForward" @click="forward">前进</button>
        <button type="button" @click="state.loading ? stop() : reload()">{{ state.loading ? '停止' : '刷新' }}</button>
        <span class="web-current-site" :title="state.url">{{ currentHost() || '尚未打开网页' }}</span>
      </template>
      <button type="button" :disabled="!state.previousChapter" :title="state.previousChapter?.title || '未识别到上一章'" @click="changeChapter('previous')">上一章</button>
      <button type="button" :disabled="!state.nextChapter" :title="state.nextChapter?.title || '未识别到下一章'" @click="changeChapter('next')">下一章</button>
      <button type="button" :disabled="!state.url || readingBusy" @click="readingPage ? exitReadingMode() : enterReadingMode()">{{ readingPage ? '返回原网页' : '阅读模式' }}</button>
      <details v-if="!readingPage" class="web-more">
        <summary>网页工具</summary>
        <div class="web-more-content">
          <button type="button" aria-label="缩小网页" @click="setZoom(-0.1)">−</button>
          <button type="button" title="恢复默认缩放" @click="setZoom('reset')">{{ Math.round(state.zoom * 100) }}%</button>
          <button type="button" aria-label="放大网页" @click="setZoom(0.1)">＋</button>
          <button type="button" @click="findOpen ? closeFind() : findOpen = true">{{ findOpen ? '关闭查找' : '网页查找' }}</button>
          <button type="button" @click="hideAction(hidePicking ? 'stop' : 'start')">{{ hidePicking ? '退出点选' : '点选隐藏' }}</button>
          <button type="button" :disabled="hiddenCount === 0" @click="hideAction('undo')">撤销隐藏{{ hiddenCount ? `（${hiddenCount}）` : '' }}</button>
          <span class="web-shortcut-hint">Alt＋↑ / Alt＋↓ 翻章</span>
        </div>
      </details>
    </div>
    <div v-if="findOpen && !readingPage" class="web-find-row">
      <input ref="findInput" v-model="findQuery" aria-label="查找网页文字" placeholder="查找当前网页" @input="runFind()" @keydown.enter.prevent="runFind(true, true)" />
      <span>{{ findResult.matches ? `${findResult.activeMatch} / ${findResult.matches}` : '无匹配' }}</span>
      <button type="button" @click="runFind(false, true)">上一处</button>
      <button type="button" @click="runFind(true, true)">下一处</button>
      <button type="button" @click="closeFind">关闭</button>
    </div>
    <div ref="slot" v-show="!readingPage" class="browse-slot" />
    <div v-if="readingPage" class="web-reading-stage" :style="readingStyle">
      <article class="web-reading-article">
        <h1>{{ readingPage.title }}</h1>
        <p v-for="(paragraph, i) in readingParagraphs" :key="i">{{ paragraph }}</p>
      </article>
    </div>

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
  color: var(--text-primary);
  background: var(--app-bg);
}

.web-reading-controls, .web-find-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
  z-index: 2;
}

.web-reading-controls button, .web-find-row button {
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  padding: 6px 12px;
  cursor: pointer;
}

.web-reading-controls button:hover:not(:disabled), .web-find-row button:hover:not(:disabled) { background: var(--surface-2); color: var(--text-primary); }
.web-more { min-width: 0; margin-left: auto; }
.web-more[open] { flex: 1 0 100%; }
.web-more-content { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); padding-top: var(--space-2); }
.web-shortcut-hint { margin-left: var(--space-2); }
.web-more summary, .browser-more summary { list-style: none; border: 1px solid var(--border); border-radius: 999px; padding: 6px 12px; color: var(--text-secondary); background: var(--surface-1); font-size: 12px; cursor: pointer; }
.web-more summary::-webkit-details-marker, .browser-more summary::-webkit-details-marker { display: none; }
.web-more summary:hover, .browser-more summary:hover { border-color: var(--hover-line); color: var(--focus); }
.web-more summary:focus-visible, .browser-more summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.web-reading-controls button:disabled { opacity: 0.45; cursor: default; }
.web-shortcut-hint { color: var(--text-muted); font-size: 12px; }
.web-find-row input { min-width: 160px; flex: 1; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--input-bg); color: var(--text-primary); }
.web-find-row span { min-width: 70px; text-align: center; }
.web-reading-stage { flex: 1; min-height: 0; overflow: auto; background: var(--web-outer); color: var(--web-ink); }
.web-reading-article { box-sizing: border-box; width: min(100%, var(--web-width)); margin: 24px auto; min-height: calc(100% - 48px); padding: 56px clamp(30px, 6vw, 72px) 96px; border-radius: var(--radius-card); box-shadow: var(--shadow-card); background: var(--web-paper); color: var(--web-ink); font: var(--web-size)/var(--web-line) var(--web-font); white-space: pre-wrap; overflow-wrap: anywhere; }
.web-reading-article h1 { font-size: 1.25em; line-height: 1.5; text-align: center; margin: 0 0 2em; }
.web-reading-article p { margin: 0 0 var(--web-spacing); text-indent: var(--web-indent); }

.browse-toolbar {
  position: relative;
  z-index: 2;
  height: auto;
  display: block;
  padding: 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
}

.browser-nav-row,
.browser-action-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.browser-nav-row {
  min-height: 60px;
}

.browser-action-row {
  min-height: 48px;
  justify-content: space-between;
  border-top: 1px solid var(--border);
  background: var(--surface-1);
}

.browser-nav-row input {
  min-width: 120px;
  height: 40px;
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 var(--space-3);
  color: var(--text-primary);
  background: var(--input-bg);
  font: inherit;
  font-size: 14px;
  transition: border-color var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing), box-shadow var(--motion-duration) var(--motion-easing);
}

.browser-nav-row input::placeholder {
  color: var(--text-muted);
}

.browser-nav-row input:hover {
  border-color: var(--hover-line);
  background: var(--input-bg);
}

.browser-nav-row input:focus {
  border-color: var(--focus);
  background: var(--input-bg);
  box-shadow: var(--input-ring);
}

.browser-nav-row input:focus:not(:focus-visible) {
  outline: none;
}

.browser-icon-button {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 999px;
  color: var(--text-primary);
  background: var(--chip-bg);
  cursor: pointer;
  transition: border-color var(--motion-duration) var(--motion-easing), background var(--motion-duration) var(--motion-easing), color var(--motion-duration) var(--motion-easing);
}

.browser-icon-button:hover:not(:disabled) {
  border-color: var(--hover-line);
  background: var(--chip-hover-bg);
}

.browser-icon-button:active:not(:disabled) {
  border-color: var(--focus);
  background: var(--surface-3);
}

.browser-icon-button:focus-visible,
.browser-open-button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.browser-icon-button:disabled {
  color: var(--disabled);
  border-color: var(--border);
  background: var(--chip-bg);
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
  height: 40px;
  flex: 0 0 auto;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0 var(--space-3);
  color: var(--on-accent);
  background: var(--focus);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
  transition: background var(--motion-duration) var(--motion-easing);
}

.browser-open-button:hover:not(:disabled) {
  filter: brightness(1.08);
}

.browser-open-button:active:not(:disabled) {
  filter: brightness(0.94);
}

.browser-open-button:disabled {
  color: var(--on-accent);
  background: var(--disabled);
  cursor: default;
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
  flex-wrap: wrap;
  justify-content: flex-end;
}

.browser-more { min-width: 0; }
.browser-more[open] { flex: 1 0 100%; }
.browser-more-content { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); padding-top: var(--space-2); }

.dl-progress {
  padding: var(--space-2) 0;
  color: var(--text-primary);
}

.dl-waiting {
  color: var(--text-secondary);
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
  color: var(--text-secondary);
  margin-top: var(--space-2);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.dl-current {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: var(--space-1);
}

.dl-error {
  font-size: 12px;
  color: var(--error);
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
  color: var(--text-muted);
}

@media (max-width: 900px) {
  .browser-action-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .browser-actions {
    justify-content: flex-start;
  }
}

@media (max-width: 560px) {
  .browser-nav-row,
  .browser-action-row {
    padding: var(--space-2);
  }

  .browser-nav-row {
    flex-wrap: wrap;
  }

  .browser-nav-row input {
    order: 1;
    flex-basis: calc(100% - 72px);
  }

  .browser-open-button {
    order: 2;
  }
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
