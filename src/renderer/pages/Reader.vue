<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick, computed } from 'vue'
import { NButton, NDrawer, NDrawerContent, NList, NListItem, NSlider, NSwitch, NTag, NEmpty } from 'naive-ui'
import type { Book, ChapterFile, ChapterMeta, ReaderPrefs } from '@shared/types'

const props = defineProps<{ bookId?: string }>()
const emit = defineEmits<{ (e: 'back'): void }>()

const book = ref<Book | null>(null)
const chapters = ref<ChapterMeta[]>([])
const currentChapter = ref<ChapterMeta | null>(null)
const chapterBody = ref('')
const chapterLoading = ref(false)
const contentRef = ref<HTMLElement | null>(null)
const showDrawer = ref(false)

// Reader prefs (from settings)
const fontSize = ref(18)
const lineHeight = ref(1.8)
const nightMode = ref(false)

// Debounced scroll save
let scrollTimer: ReturnType<typeof setTimeout> | null = null

const nightClass = computed(() => (nightMode.value ? 'night' : ''))
const contentStyle = computed(() => ({
  fontSize: fontSize.value + 'px',
  lineHeight: lineHeight.value,
}))

async function loadBook(bookId: string) {
  const res = await window.api.library.get(bookId)
  if (res.book) {
    book.value = res.book
    chapters.value = res.book.chapters
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
  saveProgress()
  chapterLoading.value = true
  try {
    const res = await window.api.library.readChapter(book.value.id, ch.id)
    if (res.chapter) {
      currentChapter.value = ch
      chapterBody.value = res.chapter.body
      showDrawer.value = false
      await nextTick()
      scrollToRatio(scrollRatio)
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
  if (scrollTimer) clearTimeout(scrollTimer)
  scrollTimer = setTimeout(saveProgress, 1000)
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

watch([fontSize, lineHeight, nightMode], () => {
  void window.api.settings.set({
    reader: { fontSize: fontSize.value, lineHeight: lineHeight.value, nightMode: nightMode.value },
  })
})

watch(() => props.bookId, (id) => { if (id) loadBook(id) })

onMounted(() => {
  loadPrefs()
  if (props.bookId) loadBook(props.bookId)
})

onUnmounted(() => {
  if (scrollTimer) clearTimeout(scrollTimer)
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
        </div>

        <!-- Text area -->
        <div class="reader-content" :style="contentStyle" ref="contentRef" @scroll="onScroll">
          <div v-if="chapterLoading" class="loading-hint">加载中…</div>
          <template v-else>
            <h3 class="ch-title">{{ currentChapter?.title }}</h3>
            <p v-for="(para, i) in chapterBody.split(/\n{2,}/)" :key="i" class="para">{{ para }}</p>
          </template>
        </div>
      </div>

      <!-- Bottom nav -->
      <div class="reader-nav">
        <n-button :disabled="!currentChapter || chapters[0]?.id === currentChapter?.id" @click="prevChapter">
          上一章
        </n-button>
        <n-tag v-if="currentChapter">
          {{ chapters.findIndex(c => c.id === currentChapter?.id) + 1 }} / {{ chapters.length }}
        </n-tag>
        <n-button :disabled="!currentChapter || chapters[chapters.length-1]?.id === currentChapter?.id" @click="nextChapter">
          下一章
        </n-button>
      </div>

      <!-- Chapter drawer -->
      <n-drawer v-model:show="showDrawer" placement="left" :width="320">
        <n-drawer-content title="目录">
          <n-list hoverable clickable>
            <n-list-item
              v-for="ch in chapters"
              :key="ch.id"
              @click="goToChapterId(ch.id)"
            >
              <div :class="['ch-item', { active: ch.id === currentChapter?.id }]">
                <span>{{ ch.title }}</span>
                <n-tag v-if="ch.status === 'failed'" size="tiny" type="error">失败</n-tag>
              </div>
            </n-list-item>
          </n-list>
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
  --bg: #0e0e0e;
  --text: #d4d4d4;
  --line: #222;
  --ctrl-bg: #151515;
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
</style>
