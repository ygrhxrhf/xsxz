<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NConfigProvider, NMessageProvider, darkTheme, zhCN, dateZhCN } from 'naive-ui'
import BrowsePage from './pages/Browse.vue'
import LibraryPage from './pages/Library.vue'
import ReaderPage from './pages/Reader.vue'
import SettingsPage from './pages/Settings.vue'

type Tab = 'browse' | 'library' | 'reader' | 'settings'

const tab = ref<Tab>('browse')
const currentBookId = ref<string | undefined>(undefined)
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

function syncBrowseVisibility() {
  void window.api.browse.setVisible(tab.value === 'browse')
}

watch(tab, syncBrowseVisibility)

onMounted(async () => {
  syncBrowseVisibility()
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
            {{ item.label }}
          </button>
        </aside>
        <section class="main">
          <BrowsePage v-show="tab === 'browse'" @open-book="openBook" />
          <LibraryPage v-show="tab === 'library'" :active="libraryActive" @open-book="openBook" />
          <ReaderPage v-show="tab === 'reader'" :book-id="currentBookId" @back="backToLibrary" />
          <SettingsPage v-show="tab === 'settings'" :active="tab === 'settings'" />
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
