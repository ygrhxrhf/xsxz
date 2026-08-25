<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NConfigProvider, NMessageProvider, darkTheme, zhCN, dateZhCN } from 'naive-ui'
import BrowsePage from './pages/Browse.vue'
import LibraryPage from './pages/Library.vue'
import ReaderPage from './pages/Reader.vue'
import SettingsPage from './pages/Settings.vue'
import type { DownloadProgress } from '@shared/types'

type Tab = 'browse' | 'library' | 'reader' | 'settings'

const tab = ref<Tab>('browse')
const currentBookId = ref<string | undefined>(undefined)
const ruleHostPrefill = ref('')
const ruleHostNonce = ref(0)
const browsePrefillUrl = ref('')
const browsePrefillNonce = ref(0)
const dlRunning = ref(false)
const dlHint = ref('')
let unsubProgress: (() => void) | null = null

const tabs: { id: Tab; label: string }[] = [
  { id: 'browse', label: '浏览' },
  { id: 'library', label: '书库' },
  { id: 'reader', label: '阅读' },
  { id: 'settings', label: '设置' },
]

const libraryActive = computed(() => tab.value === 'library')

function openBook(bookId: string) {
  currentBookId.value = bookId
  tab.value = 'reader'
}

function backToLibrary() {
  tab.value = 'library'
}

function goBrowse(url?: string) {
  if (url) {
    browsePrefillUrl.value = url
    browsePrefillNonce.value += 1
  }
  tab.value = 'browse'
}

function goSettingsWithHost(host: string) {
  if (host) {
    ruleHostPrefill.value = host
    ruleHostNonce.value += 1
  }
  tab.value = 'settings'
}

function onDownloadProgress(p: DownloadProgress) {
  if (p.status === 'running') {
    dlRunning.value = true
    dlHint.value = `${p.done}/${p.total}`
  } else {
    dlRunning.value = false
    dlHint.value = p.status === 'error' ? '有失败' : ''
  }
}

function tabLabel(item: { id: Tab; label: string }): string {
  if (item.id === 'library' && dlRunning.value && dlHint.value) return `${item.label} ${dlHint.value}`
  if (item.id === 'browse' && dlRunning.value) return `${item.label} · 下`
  return item.label
}

function syncBrowseVisibility() {
  void window.api.browse.setVisible(tab.value === 'browse')
}

watch(tab, syncBrowseVisibility)

onMounted(async () => {
  syncBrowseVisibility()
  unsubProgress = window.api.download.onProgress(onDownloadProgress)
  try {
    const { books } = await window.api.library.list()
    const withProgress = books.filter((b) => b.progress)
    if (withProgress.length === 0) return
    withProgress.sort((a, b) => (b.progress!.updatedAt || '').localeCompare(a.progress!.updatedAt || ''))
    currentBookId.value = withProgress[0].id
    tab.value = 'reader'
  } catch {
    /* first launch / empty library */
  }
})

onUnmounted(() => {
  unsubProgress?.()
  void window.api.browse.setVisible(false)
})
</script>

<template>
  <n-config-provider :theme="darkTheme" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand">小说浏览器</div>
          <button
            v-for="item in tabs"
            :key="item.id"
            class="nav-btn"
            :class="{ active: tab === item.id }"
            type="button"
            @click="tab = item.id"
          >
            {{ tabLabel(item) }}
          </button>
        </aside>
        <section class="main">
          <BrowsePage
            v-show="tab === 'browse'"
            :active="tab === 'browse'"
            :prefill-url="browsePrefillUrl"
            :prefill-nonce="browsePrefillNonce"
            @open-book="openBook"
            @edit-site-rule="goSettingsWithHost"
          />
          <LibraryPage
            v-show="tab === 'library'"
            :active="libraryActive"
            @open-book="openBook"
            @go-browse="goBrowse"
          />
          <ReaderPage
            v-show="tab === 'reader'"
            :book-id="currentBookId"
            @back="backToLibrary"
            @go-browse="goBrowse"
          />
          <SettingsPage
            v-show="tab === 'settings'"
            :active="tab === 'settings'"
            :prefill-host="ruleHostPrefill"
            :prefill-nonce="ruleHostNonce"
          />
        </section>
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<style>
.n-config-provider {
  height: 100%;
}
</style>
