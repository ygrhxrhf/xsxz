<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick, computed } from 'vue'
import { NButton, NDrawer, NDrawerContent, NList, NListItem, NSlider, NSwitch, NTag, NInput, NSpace, useMessage } from 'naive-ui'
import { FAIL_CODE_ZH } from '@shared/types'
import type { Book, ChapterMeta, AiChatMessage } from '@shared/types'
import { failAdvice, filterCatalogChapters, readerProgressLabel } from './readerHelpers'

const props = defineProps<{ bookId?: string }>()
const emit = defineEmits<{
  (e: 'back'): void
  (e: 'go-browse', url?: string): void
}>()
const message = useMessage()

const book = ref<Book | null>(null)
const chapters = ref<ChapterMeta[]>([])
const currentChapter = ref<ChapterMeta | null>(null)
const chapterBody = ref('')
const chapterError = ref('')
const hasBodyRaw = ref(false)
const chapterLoading = ref(false)
const contentRef = ref<HTMLElement | null>(null)
const showDrawer = ref(false)

// Reader prefs (from settings)
const fontSize = ref(18)
const lineHeight = ref(1.8)
const nightMode = ref(false)

// AI state
const aiLoading = ref(false)
const aiResult = ref('')
const aiResultTitle = ref('')
const showAiResult = ref(false)
const showChat = ref(false)
const chatMessages = ref<AiChatMessage[]>([])
const chatInput = ref('')
const chatLoading = ref(false)
const catalogQuery = ref('')
const scrollRatioView = ref(0)
const retryingChapter = ref(false)

const prefsReady = ref(false)

// Debounced scroll save
let scrollTimer: ReturnType<typeof setTimeout> | null = null
let unsubDownload: (() => void) | null = null

const nightClass = computed(() => (nightMode.value ? 'night' : ''))
const contentStyle = computed(() => ({
  fontSize: fontSize.value + 'px',
  lineHeight: lineHeight.value,
}))
const chapterReady = computed(() => Boolean(currentChapter.value && currentChapter.value.status === 'ready' && chapterBody.value))
const canRetryChapter = computed(() => {
  const ch = currentChapter.value
  if (!book.value || !ch) return false
  if (book.value.importType !== 'download') return false
  return ch.status === 'failed' || ch.status === 'empty' || ch.status === 'pending'
})
const filteredCatalog = computed(() => filterCatalogChapters(chapters.value, catalogQuery.value))
const progressSummary = computed(() =>
  readerProgressLabel(chapters.value, currentChapter.value?.id, scrollRatioView.value),
)
const chapterFailHint = computed(() => failAdvice(currentChapter.value?.failCode))

async function loadBook(bookId: string) {
  saveProgress()
  const res = await window.api.library.get(bookId)
  if (res.book) {
    book.value = res.book
    chapters.value = res.book.chapters
    currentChapter.value = null
    // Restore progress
    if (res.book.progress) {
      const ch = chapters.value.find((c) => c.id === res.book!.progress!.chapterId)
      if (ch) {
        await openChapter(ch, res.book.progress.scrollRatio)
        return
      }
    }
    // Default to first chapter
    if (chapters.value.length > 0) {
      await openChapter(chapters.value[0], 0)
    }
  }
}

async function openChapter(ch: ChapterMeta, scrollRatio = 0) {
  if (!book.value) return
  if (currentChapter.value && currentChapter.value.id !== ch.id) saveProgress()
  chapterLoading.value = true
  try {
    const res = await window.api.library.readChapter(book.value.id, ch.id)
    if (res.chapter) {
      currentChapter.value = { ...ch, status: res.chapter.status, failCode: res.chapter.failCode }
      chapterBody.value = res.chapter.body || ''
      hasBodyRaw.value = Boolean(res.chapter.bodyRaw) && res.chapter.bodyRaw !== res.chapter.body
      const failText = res.chapter.failCode ? FAIL_CODE_ZH[res.chapter.failCode] : ''
      if (res.chapter.status !== 'ready' || !res.chapter.body) {
        chapterError.value = failText || (res.chapter.status === 'pending' ? '这一章还没下载' : '这一章没有正文')
      } else {
        chapterError.value = ''
      }
      showDrawer.value = false
      scrollRatioView.value = scrollRatio
      await nextTick()
      scrollToRatio(scrollRatio)
    } else {
      currentChapter.value = ch
      chapterBody.value = ''
      hasBodyRaw.value = false
      chapterError.value = res.message || '无法打开这一章'
    }
  } finally {
    chapterLoading.value = false
  }
}

function scrollToRatio(ratio: number) {
  const el = contentRef.value
  if (!el) return
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight * Math.max(0, Math.min(1, ratio))
  })
}

function saveProgress() {
  if (!book.value || !currentChapter.value || !contentRef.value) return
  const el = contentRef.value
  const scrollRatio = el.scrollHeight > 0 ? el.scrollTop / el.scrollHeight : 0
  void window.api.library.setProgress(book.value.id, {
    chapterId: currentChapter.value.id,
    scrollRatio,
    updatedAt: new Date().toISOString(),
  })
}

function onScroll() {
  const el = contentRef.value
  if (el && el.scrollHeight > 0) scrollRatioView.value = el.scrollTop / el.scrollHeight
  if (scrollTimer) clearTimeout(scrollTimer)
  scrollTimer = setTimeout(saveProgress, 1000)
}

function goBrowseForChapter() {
  const url = currentChapter.value?.url || book.value?.sourceUrl
  emit('go-browse', url)
}

async function retryThisChapter() {
  if (!book.value) return
  retryingChapter.value = true
  try {
    const res = await window.api.download.retryFailed(book.value.id)
    if (!res.ok) {
      message.error(res.message || '重试失败')
      return
    }
    message.info('已开始重试失败章')
  } finally {
    retryingChapter.value = false
  }
}

function prevChapter() {
  if (!currentChapter.value) return
  const i = chapters.value.findIndex((c) => c.id === currentChapter.value!.id)
  if (i > 0) openChapter(chapters.value[i - 1], 1)
}

function nextChapter() {
  if (!currentChapter.value) return
  const i = chapters.value.findIndex((c) => c.id === currentChapter.value!.id)
  if (i < chapters.value.length - 1) openChapter(chapters.value[i + 1], 0)
}

function goToChapterId(chId: string) {
  const ch = chapters.value.find((c) => c.id === chId)
  if (ch) openChapter(ch, 0)
}

async function loadPrefs() {
  const s = await window.api.settings.get()
  fontSize.value = s.reader.fontSize
  lineHeight.value = s.reader.lineHeight
  nightMode.value = s.reader.nightMode
}

// AI actions
async function aiCleanBody() {
  if (!book.value || !currentChapter.value) return
  aiLoading.value = true
  aiResultTitle.value = '清正文'
  try {
    const res = await window.api.ai.clean(book.value.id, currentChapter.value.id)
    if (res.ok && res.result) {
      aiResult.value = res.result.cleaned
      showAiResult.value = true
    } else {
      message.error(res.message || '清正文失败')
    }
  } finally {
    aiLoading.value = false
  }
}

async function applyCleanedBody() {
  if (!book.value || !currentChapter.value || !aiResult.value) return
  await window.api.library.updateChapterBody(book.value.id, currentChapter.value.id, aiResult.value)
  chapterBody.value = aiResult.value
  hasBodyRaw.value = true
  showAiResult.value = false
  message.success('已应用到正文')
}

async function restoreCleanedBody() {
  if (!book.value || !currentChapter.value) return
  const res = await window.api.library.updateChapterBody(book.value.id, currentChapter.value.id, '', true)
  if (res && 'ok' in res && res.ok === false) {
    message.error((res as { message?: string }).message || '撤销失败')
    return
  }
  const ch = await window.api.library.readChapter(book.value.id, currentChapter.value.id)
  if (ch.chapter) {
    chapterBody.value = ch.chapter.body
    hasBodyRaw.value = false
  }
}

async function aiSummarize() {
  if (!book.value || !currentChapter.value) return
  aiLoading.value = true
  aiResultTitle.value = '前情摘要'
  try {
    const res = await window.api.ai.summarize(book.value.id, currentChapter.value.id)
    if (res.ok) {
      aiResult.value = res.text
      showAiResult.value = true
    } else {
      message.error(res.message || '摘要失败')
    }
  } finally {
    aiLoading.value = false
  }
}

function getSelectedText(): string {
  const sel = window.getSelection()
  return sel ? sel.toString().trim() : ''
}

async function aiTranslate() {
  const text = getSelectedText()
  if (!text) {
    message.warning('请先在正文中选中要翻译的文字')
    return
  }
  aiLoading.value = true
  aiResultTitle.value = '翻译'
  try {
    const res = await window.api.ai.translate(text)
    if (res.ok) {
      aiResult.value = res.text
      showAiResult.value = true
    } else {
      message.error(res.message || '翻译失败')
    }
  } finally {
    aiLoading.value = false
  }
}

async function sendChat() {
  if (!book.value || !currentChapter.value || !chatInput.value.trim()) return
  const userMsg = chatInput.value.trim()
  chatMessages.value.push({ role: 'user', content: userMsg })
  chatInput.value = ''
  chatLoading.value = true
  try {
    const res = await window.api.ai.chat(book.value.id, currentChapter.value.id, chatMessages.value)
    if (res.ok) {
      chatMessages.value.push({ role: 'assistant', content: res.text })
    } else {
      chatMessages.value.push({ role: 'assistant', content: `错误：${res.message}` })
    }
  } finally {
    chatLoading.value = false
  }
}

watch([fontSize, lineHeight, nightMode], () => {
  if (!prefsReady.value) return
  void window.api.settings.set({
    reader: { fontSize: fontSize.value, lineHeight: lineHeight.value, nightMode: nightMode.value },
  })
})

watch(() => props.bookId, (id) => { if (id) loadBook(id) })

onMounted(async () => {
  await loadPrefs()
  prefsReady.value = true
  if (props.bookId) await loadBook(props.bookId)
  unsubDownload = window.api.download.onProgress((p) => {
    if (!book.value || p.bookId !== book.value.id) return
    if (p.status === 'done' || p.status === 'error' || p.status === 'cancelled') {
      const stay = currentChapter.value?.id
      void loadBook(book.value.id).then(() => {
        if (stay) {
          const ch = chapters.value.find((c) => c.id === stay)
          if (ch) void openChapter(ch, scrollRatioView.value)
        }
      })
    }
  })
})

onUnmounted(() => {
  if (scrollTimer) clearTimeout(scrollTimer)
  unsubDownload?.()
  saveProgress()
})
</script>

<template>
  <div :class="['reader-wrap', nightClass]">
    <!-- No book selected -->
    <div v-if="!book" class="page placeholder">
      <h2>阅读</h2>
      <p>从书库点开一本书后在这里阅读。</p>
    </div>

    <!-- Reader -->
    <template v-else>
      <!-- Top bar -->
      <div class="reader-bar">
        <n-button quaternary size="small" @click="emit('back')">← 返回书库</n-button>
        <span class="reader-book-title">{{ book.title }}</span>
        <span class="reader-progress-label">{{ progressSummary }}</span>
        <n-button quaternary size="small" @click="showDrawer = true">目录</n-button>
      </div>

      <!-- Main content area -->
      <div class="reader-body">
        <!-- Sidebar controls -->
        <div class="reader-controls">
          <div class="control-label">字号 {{ fontSize }}</div>
          <n-slider v-model:value="fontSize" :min="12" :max="36" :step="1" />
          <div class="control-label">行距 {{ lineHeight.toFixed(1) }}</div>
          <n-slider v-model:value="lineHeight" :min="1.2" :max="3.0" :step="0.1" />
          <div class="control-label" style="margin-top:8px">
            <n-switch v-model:value="nightMode" /> 夜间
          </div>
          <div style="border-top:1px solid var(--line);margin-top:8px;padding-top:8px">
            <div class="control-label" style="margin-bottom:6px;font-weight:600">AI 助手</div>
            <n-space vertical :size="6">
              <n-button size="tiny" block :disabled="!chapterReady" :loading="aiLoading" @click="aiCleanBody">清正文</n-button>
              <n-button v-if="hasBodyRaw" size="tiny" block @click="restoreCleanedBody">撤销清正文</n-button>
              <n-button size="tiny" block :disabled="!chapterReady" :loading="aiLoading" @click="aiSummarize">前情摘要</n-button>
              <n-button size="tiny" block :disabled="!chapterReady" :loading="aiLoading" @click="aiTranslate">翻译选中</n-button>
              <n-button size="tiny" block :disabled="!chapterReady" @click="showChat = true">聊书</n-button>
            </n-space>
          </div>
        </div>

        <!-- Text area -->
        <div class="reader-content reader-pane" :style="contentStyle" ref="contentRef" @scroll="onScroll">
          <div v-if="chapterLoading" class="loading-hint">加载中…</div>
          <template v-else>
            <h3 class="ch-title">{{ currentChapter?.title }}</h3>
            <p v-if="chapterError" class="chapter-error">{{ chapterError }}</p>
            <p v-if="chapterFailHint" class="chapter-hint">{{ chapterFailHint }}</p>
            <n-space v-if="canRetryChapter || chapterError" justify="center" style="margin-bottom:16px">
              <n-button v-if="canRetryChapter" size="small" type="warning" :loading="retryingChapter" @click="retryThisChapter">
                重试失败章
              </n-button>
              <n-button v-if="currentChapter?.url || book.sourceUrl" size="small" @click="goBrowseForChapter">
                去浏览页
              </n-button>
            </n-space>
            <p v-for="(para, i) in chapterBody.split(/\n{2,}/).filter(Boolean)" :key="i" class="para">{{ para }}</p>
          </template>
        </div>
      </div>

      <!-- Bottom nav -->
      <div class="reader-nav">
        <n-button :disabled="!currentChapter || chapters[0]?.id === currentChapter?.id" @click="prevChapter">
          上一章
        </n-button>
        <n-tag v-if="currentChapter">
          {{ progressSummary }}
        </n-tag>
        <n-button :disabled="!currentChapter || chapters[chapters.length-1]?.id === currentChapter?.id" @click="nextChapter">
          下一章
        </n-button>
      </div>

      <!-- Chapter drawer -->
      <n-drawer v-model:show="showDrawer" placement="left" :width="320">
        <n-drawer-content title="目录">
          <n-input v-model:value="catalogQuery" clearable placeholder="过滤目录" style="margin-bottom:12px" />
          <n-list hoverable clickable>
            <n-list-item
              v-for="ch in filteredCatalog"
              :key="ch.id"
              @click="goToChapterId(ch.id)"
            >
              <div :class="['ch-item', { active: ch.id === currentChapter?.id }]">
                <span>{{ ch.title }}</span>
                <n-tag v-if="ch.status === 'failed'" size="tiny" type="error">{{ ch.failCode ? FAIL_CODE_ZH[ch.failCode] : '失败' }}</n-tag>
                <n-tag v-else-if="ch.status === 'pending'" size="tiny">未下</n-tag>
                <n-tag v-else-if="ch.status === 'empty'" size="tiny" type="warning">空</n-tag>
              </div>
            </n-list-item>
          </n-list>
        </n-drawer-content>
      </n-drawer>

      <!-- AI result drawer -->
      <n-drawer v-model:show="showAiResult" placement="right" :width="420">
        <n-drawer-content :title="aiResultTitle" closable>
          <div class="ai-result">{{ aiResult }}</div>
          <template #footer>
            <n-space v-if="aiResultTitle === '清正文'">
              <n-button type="primary" size="small" @click="applyCleanedBody">应用到正文</n-button>
              <n-button size="small" @click="showAiResult = false">取消</n-button>
            </n-space>
          </template>
        </n-drawer-content>
      </n-drawer>

      <!-- Chat drawer -->
      <n-drawer v-model:show="showChat" placement="right" :width="420">
        <n-drawer-content title="聊书" closable>
          <div class="chat-messages">
            <div v-for="(msg, i) in chatMessages" :key="i" :class="['chat-msg', msg.role]">
              <div class="chat-bubble">{{ msg.content }}</div>
            </div>
            <div v-if="chatLoading" class="chat-msg assistant">
              <div class="chat-bubble">思考中…</div>
            </div>
            <div v-if="chatMessages.length === 0 && !chatLoading" class="chat-empty">
              问点什么吧，比如「这章讲了什么」「主角是谁」「推荐类似小说」
            </div>
          </div>
          <template #footer>
            <div class="chat-input-row">
              <n-input
                v-model:value="chatInput"
                placeholder="输入问题…"
                :disabled="chatLoading"
                @keyup.enter="sendChat"
              />
              <n-button type="primary" :loading="chatLoading" :disabled="!chatInput.trim()" @click="sendChat">
                发送
              </n-button>
            </div>
          </template>
        </n-drawer-content>
      </n-drawer>
    </template>
  </div>
</template>

<style scoped>
.reader-wrap {
  --bg: #161616;
  --text: #f2f2f2;
  --line: #2c2c2c;
  --ctrl-bg: #1e1e1e;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  color: var(--text);
  transition: background .2s, color .2s;
}

.reader-wrap.night {
  --bg: #050505;
  --text: #e6d5a2;
  --line: #1a1a1a;
  --ctrl-bg: #121212;
}

.reader-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  height: 44px;
  border-bottom: 1px solid var(--line);
  background: var(--ctrl-bg);
  flex-shrink: 0;
}

.reader-book-title {
  font-size: 14px;
  color: #999;
  flex: 1;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 12px;
}

.reader-progress-label {
  font-size: 12px;
  color: #888;
  margin-right: 8px;
  white-space: nowrap;
}

.chapter-hint {
  text-align: center;
  color: #c9a227;
  padding: 0 8px 12px;
  font-size: 13px;
}

.reader-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.reader-controls {
  width: 160px;
  padding: 16px;
  border-right: 1px solid var(--line);
  background: var(--ctrl-bg);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.control-label {
  font-size: 12px;
  color: #888;
}

.reader-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
  max-width: 800px;
  margin: 0 auto;
  background: #2c2c30;
  color: #f5f5f5;
}

.reader-wrap.night .reader-content {
  background: #000000;
  color: #e6d5a2;
}

.ch-title {
  font-size: 1.3em;
  font-weight: 600;
  margin-bottom: 1em;
  text-align: center;
}

.para {
  text-indent: 2em;
  margin: 0 0 0.5em;
}

.loading-hint {
  text-align: center;
  color: #888;
  padding: 40px;
}

.chapter-error {
  text-align: center;
  color: #e88080;
  padding: 16px 8px 24px;
}

.reader-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 8px 16px;
  border-top: 1px solid var(--line);
  background: var(--ctrl-bg);
  flex-shrink: 0;
}

.ch-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 14px;
}

.ch-item.active {
  color: #7c9cff;
  font-weight: 600;
}

.ai-result {
  white-space: pre-wrap;
  line-height: 1.8;
  font-size: 14px;
  padding: 0 4px;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chat-msg {
  display: flex;
  padding: 0 12px;
}

.chat-msg.user {
  justify-content: flex-end;
}

.chat-msg.assistant {
  justify-content: flex-start;
}

.chat-bubble {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.chat-msg.user .chat-bubble {
  background: #3a5ba0;
  color: #fff;
  border-bottom-right-radius: 4px;
}

.chat-msg.assistant .chat-bubble {
  background: #2a2a2a;
  color: #e0e0e0;
  border-bottom-left-radius: 4px;
}

.chat-empty {
  text-align: center;
  color: #666;
  padding: 40px 20px;
  font-size: 13px;
}

.chat-input-row {
  display: flex;
  gap: 8px;
}
</style>
