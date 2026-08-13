<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import BrowsePage from './pages/Browse.vue'
import LibraryPage from './pages/Library.vue'
import ReaderPage from './pages/Reader.vue'
import SettingsPage from './pages/Settings.vue'

type Tab = 'browse' | 'library' | 'reader' | 'settings'

const tab = ref<Tab>('browse')
const tabs: { id: Tab; label: string }[] = [
  { id: 'browse', label: '浏览' },
  { id: 'library', label: '书库' },
  { id: 'reader', label: '阅读' },
  { id: 'settings', label: '设置' },
]

function syncBrowseVisibility() {
  void window.api.browse.setVisible(tab.value === 'browse')
}

watch(tab, syncBrowseVisibility)
onMounted(syncBrowseVisibility)
onUnmounted(() => {
  void window.api.browse.setVisible(false)
})
</script>

<template>
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
      <BrowsePage v-show="tab === 'browse'" />
      <LibraryPage v-show="tab === 'library'" />
      <ReaderPage v-show="tab === 'reader'" />
      <SettingsPage v-show="tab === 'settings'" />
    </section>
  </div>
</template>
