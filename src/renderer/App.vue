<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NConfigProvider, NMessageProvider, darkTheme, lightTheme, zhCN, dateZhCN } from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import type { Skin } from '@shared/types'
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
const browsePrefillReading = ref(false)
const dlRunning = ref<DownloadProgress | null>(null)
let unsubProgress: (() => void) | null = null

const tabs: { id: Tab; label: string; iconPaths: string[] }[] = [
  {
    id: 'browse',
    label: '浏览',
    iconPaths: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'm16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3 6.3-2.1Z'],
  },
  {
    id: 'library',
    label: '书库',
    iconPaths: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z', 'M8 7h8', 'M8 11h6'],
  },
  {
    id: 'reader',
    label: '阅读',
    iconPaths: ['M2.5 4.5A3.5 3.5 0 0 1 6 2h5v17H6a3.5 3.5 0 0 0-3.5 3V4.5Z', 'M21.5 4.5A3.5 3.5 0 0 0 18 2h-5v17h5a3.5 3.5 0 0 1 3.5 3V4.5Z'],
  },
  {
    id: 'settings',
    label: '设置',
    iconPaths: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56V20.3h-3v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.56-1.04H5.3v-3h.14A1.7 1.7 0 0 0 7 9.92a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.12-2.12.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.7 4.7v-.14h3v.14a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.04h.14v3h-.14A1.7 1.7 0 0 0 19.4 15Z'],
  },
]

// 微信读书式浅色界面：浅灰画布、白色纸面与克制的蓝色操作色。
const lightOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#4b93dd',
    primaryColorHover: '#65a5e7',
    primaryColorPressed: '#3278bf',
    primaryColorSuppl: '#4b93dd',
    infoColor: '#4b93dd',
    infoColorHover: '#65a5e7',
    infoColorPressed: '#3278bf',
    infoColorSuppl: '#4b93dd',
    successColor: '#3b9d77',
    warningColor: '#b48436',
    errorColor: '#d85a60',
    textColorBase: '#25272b',
    textColor1: '#25272b',
    textColor2: '#60656d',
    textColor3: '#898f97',
    placeholderColor: '#a0a6ae',
    borderColor: '#e5e8ec',
    dividerColor: '#eceef1',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    drawerColor: '#ffffff',
    inputColor: '#f7f8fa',
    actionColor: '#f7f8fa',
    hoverColor: 'rgba(37, 39, 43, 0.05)',
    borderRadius: '10px',
    borderRadiusSmall: '8px',
  },
  Card: {
    borderRadius: '16px',
    borderColor: '#e9ebee',
    color: '#ffffff',
  },
  Dialog: {
    borderRadius: '18px',
  },
  Tag: {
    borderRadius: '999px',
  },
}

const darkOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#79b5f2',
    primaryColorHover: '#9ac9f6',
    primaryColorPressed: '#5b9ddd',
    primaryColorSuppl: '#79b5f2',
    infoColor: '#79b5f2',
    successColor: '#79c8a4',
    warningColor: '#e3bb79',
    errorColor: '#ef9299',
    textColorBase: '#e8e9eb',
    textColor1: '#e8e9eb',
    textColor2: '#c0c2c7',
    textColor3: '#93969d',
    placeholderColor: '#82858d',
    borderColor: '#393b40',
    dividerColor: '#33353a',
    cardColor: '#282a2e',
    modalColor: '#282a2e',
    popoverColor: '#282a2e',
    drawerColor: '#282a2e',
    inputColor: '#303237',
    actionColor: '#303237',
    hoverColor: 'rgba(232, 233, 235, 0.07)',
    borderRadius: '10px',
    borderRadiusSmall: '8px',
  },
  Card: { borderRadius: '16px', borderColor: '#393b40' },
  Dialog: { borderRadius: '18px' },
  Tag: { borderRadius: '999px' },
}

// 本地快照决定首帧，settings.json 在加载后校正为权威值。
const SKIN_STORAGE_KEY = 'spbf.skin'

function normalizeCachedSkin(value: unknown): Skin {
  return value === 'dark' || value === 'night' ? 'dark' : 'light'
}

const skin = ref<Skin>(normalizeCachedSkin(localStorage.getItem(SKIN_STORAGE_KEY)))
document.body.dataset.skin = skin.value

const naiveTheme = computed(() => (skin.value === 'dark' ? darkTheme : lightTheme))
const themeOverrides = computed(() => (skin.value === 'dark' ? darkOverrides : lightOverrides))

function onChangeSkin(s: Skin) {
  skin.value = s
}

watch(skin, (s) => {
  document.body.dataset.skin = s
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, s)
  } catch {
    /* 隐私模式等写不进就只走 settings */
  }
  void window.api.settings.set({ appearance: { skin: s } })
})

const libraryActive = computed(() => tab.value === 'library')

function openBook(bookId: string) {
  currentBookId.value = bookId
  tab.value = 'reader'
}

function backToLibrary() {
  tab.value = 'library'
}

function goBrowse(url?: string, options: { reading?: boolean } = {}) {
  browsePrefillReading.value = Boolean(options.reading)
  if (url) {
    browsePrefillUrl.value = url
    browsePrefillNonce.value += 1
  }
  tab.value = 'browse'
}

/** 网页书架续读：打开这一章的地址并直接进阅读模式。 */
function openWebBook(url: string) {
  goBrowse(url, { reading: true })
}

function goSettingsWithHost(host: string) {
  if (host) {
    ruleHostPrefill.value = host
    ruleHostNonce.value += 1
  }
  tab.value = 'settings'
}

function onDownloadProgress(p: DownloadProgress) {
  // awaitingHuman（卡在墙上等人处理）以前不进侧栏，用户没有全局的取消入口
  dlRunning.value = p.status === 'running' || p.status === 'awaitingHuman' ? p : null
}

function cancelSidebarDownload() {
  void window.api.download.cancel()
}

function syncBrowseVisibility() {
  void window.api.browse.setVisible(tab.value === 'browse')
}

watch(tab, syncBrowseVisibility)

onMounted(async () => {
  syncBrowseVisibility()
  unsubProgress = window.api.download.onProgress(onDownloadProgress)
  try {
    const s = await window.api.settings.get()
    if (s.appearance?.skin && s.appearance.skin !== skin.value) {
      skin.value = s.appearance.skin
    }
    localStorage.setItem(SKIN_STORAGE_KEY, skin.value)
  } catch {
    /* 设置读不到就沿用快照 */
  }
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
  <n-config-provider :theme="naiveTheme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <div :class="['app-shell', { 'app-shell-reader': tab === 'reader' && !!currentBookId }]">
        <header v-if="!(tab === 'reader' && currentBookId)" class="app-bar">
          <span class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M3 5.5A3.5 3.5 0 0 1 6.5 2H11v17H6.5A3.5 3.5 0 0 0 3 22V5.5Z" />
              <path d="M21 5.5A3.5 3.5 0 0 0 17.5 2H13v17h4.5A3.5 3.5 0 0 1 21 22V5.5Z" />
            </svg>
          </span>
          <span class="brand-title">小说浏览器</span>
          <nav class="app-nav" aria-label="主要功能">
            <button
              v-for="item in tabs"
              :key="item.id"
              class="nav-btn"
              :class="{ active: tab === item.id }"
              type="button"
              :aria-current="tab === item.id ? 'page' : undefined"
              @click="tab = item.id"
            >
              <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path v-for="path in item.iconPaths" :key="path" :d="path" />
              </svg>
              <span class="nav-label">{{ item.label }}</span>
            </button>
          </nav>
          <div class="app-bar-actions">
            <div v-if="dlRunning" class="sidebar-dl" role="status">
              <div class="sidebar-dl-title" :title="dlRunning.title">{{ dlRunning.title }}</div>
              <div class="sidebar-dl-row">
                <span v-if="dlRunning.status === 'awaitingHuman'">等你处理页面上的登录 / 验证</span>
                <span v-else>已下 {{ dlRunning.done }} / {{ dlRunning.total }} 章</span>
                <button class="sidebar-dl-cancel" type="button" @click="cancelSidebarDownload">取消</button>
              </div>
            </div>
          </div>
        </header>
        <section class="main">
          <BrowsePage
            v-show="tab === 'browse'"
            :active="tab === 'browse'"
            :prefill-url="browsePrefillUrl"
            :prefill-nonce="browsePrefillNonce"
            :prefill-reading="browsePrefillReading"
            @open-book="openBook"
            @edit-site-rule="goSettingsWithHost"
          />
          <LibraryPage
            v-show="tab === 'library'"
            :active="libraryActive"
            @open-book="openBook"
            @go-browse="goBrowse"
            @open-web-book="openWebBook"
          />
          <ReaderPage
            v-show="tab === 'reader'"
            :book-id="currentBookId"
            @back="backToLibrary"
            @go-browse="goBrowse"
            @open-shelf="backToLibrary"
            @go-settings="tab = 'settings'"
          />
          <SettingsPage
            v-show="tab === 'settings'"
            :active="tab === 'settings'"
            :prefill-host="ruleHostPrefill"
            :prefill-nonce="ruleHostNonce"
            :skin="skin"
            @change-skin="onChangeSkin"
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
