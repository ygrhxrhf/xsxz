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

// 纸白 + 近黑墨色 + 单一橄榄绿：结构上的发丝线，克制的强调色。
const lightOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#5f7f14',
    primaryColorHover: '#6f9418',
    primaryColorPressed: '#4d6a10',
    primaryColorSuppl: '#5f7f14',
    infoColor: '#5f7f14',
    infoColorHover: '#6f9418',
    infoColorPressed: '#4d6a10',
    infoColorSuppl: '#5f7f14',
    successColor: '#3b7f4a',
    warningColor: '#8a6a1d',
    errorColor: '#b4483d',
    textColorBase: '#0d0f0c',
    textColor1: '#0d0f0c',
    textColor2: '#4f574b',
    textColor3: '#828a7c',
    placeholderColor: '#a3a99b',
    borderColor: '#dedfd5',
    dividerColor: '#e6e7de',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    drawerColor: '#ffffff',
    inputColor: '#f3f3ee',
    actionColor: '#f3f3ee',
    hoverColor: 'rgba(13, 15, 12, 0.05)',
    borderRadius: '10px',
    borderRadiusSmall: '8px',
  },
  Card: {
    borderRadius: '14px',
    borderColor: '#dedfd5',
    color: '#ffffff',
  },
  Dialog: {
    borderRadius: '14px',
  },
  Tag: {
    borderRadius: '4px',
  },
}

// 深色对应参考站点的技术黑：近黑底、绿灰文字、单一荧光绿强调。
const darkOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#a8e64f',
    primaryColorHover: '#b9f06a',
    primaryColorPressed: '#93cf3d',
    primaryColorSuppl: '#a8e64f',
    infoColor: '#a8e64f',
    successColor: '#a7e88c',
    warningColor: '#e2c26b',
    errorColor: '#f0917f',
    textColorBase: '#fafafa',
    textColor1: '#fafafa',
    textColor2: '#b6c4b0',
    textColor3: '#7d8a78',
    placeholderColor: '#6f7a6a',
    borderColor: '#2a312a',
    dividerColor: '#242b24',
    cardColor: '#131713',
    modalColor: '#12160f',
    popoverColor: '#12160f',
    drawerColor: '#12160f',
    inputColor: '#171d17',
    actionColor: '#171d17',
    hoverColor: 'rgba(250, 250, 250, 0.06)',
    borderRadius: '10px',
    borderRadiusSmall: '8px',
  },
  Card: { borderRadius: '14px', borderColor: '#2a312a' },
  Dialog: { borderRadius: '14px' },
  Tag: { borderRadius: '4px' },
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
  // 外观偏好落盘失败不该打断使用：吞掉 rejection，避免 unhandled rejection。
  void window.api.settings.set({ appearance: { skin: s } }).catch(() => {})
})

const libraryActive = computed(() => tab.value === 'library')

function openBook(bookId: string) {
  currentBookId.value = bookId
  tab.value = 'reader'
}

/**
 * 「阅读」入口等于「继续读」：没选书时按最近读过（没进度则按最近加入）挑一本，
 * 而不是让这个页签只会说一句「从书库打开一本书后在这里阅读」。
 */
async function resolveResumeBookId(): Promise<string | undefined> {
  try {
    const { books } = await window.api.library.list()
    const withProgress = books.filter((b) => b.progress)
    if (withProgress.length) {
      withProgress.sort((a, b) => (b.progress!.updatedAt || '').localeCompare(a.progress!.updatedAt || ''))
      return withProgress[0].id
    }
    const newest = [...books].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    return newest[0]?.id
  } catch {
    return undefined
  }
}

async function goTab(next: Tab) {
  if (next === 'reader' && !currentBookId.value) {
    const resumeId = await resolveResumeBookId()
    if (resumeId) currentBookId.value = resumeId
  }
  tab.value = next
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
  void window.api.download.cancel().catch(() => {})
}

onMounted(async () => {
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
  void window.api.browse.setVisible(false).catch(() => {})
})
</script>

<template>
  <n-config-provider :theme="naiveTheme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <div :class="['app-shell', { 'app-shell-reader': tab === 'reader' && !!currentBookId }]">
        <aside v-if="!(tab === 'reader' && currentBookId)" class="app-rail" aria-label="主导航">
          <span class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M3 5.5A3.5 3.5 0 0 1 6.5 2H11v17H6.5A3.5 3.5 0 0 0 3 22V5.5Z" />
              <path d="M21 5.5A3.5 3.5 0 0 0 17.5 2H13v17h4.5A3.5 3.5 0 0 1 21 22V5.5Z" />
            </svg>
          </span>
          <nav class="app-nav" aria-label="主要功能">
            <button
              v-for="item in tabs"
              :key="item.id"
              class="nav-btn"
              :class="{ active: tab === item.id }"
              type="button"
              :title="item.label"
              :aria-current="tab === item.id ? 'page' : undefined"
              @click="goTab(item.id)"
            >
              <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path v-for="path in item.iconPaths" :key="path" :d="path" />
              </svg>
              <span class="nav-label">{{ item.label }}</span>
            </button>
          </nav>
          <div class="app-rail-foot">
            <div v-if="dlRunning" class="sidebar-dl" role="status">
              <div class="sidebar-dl-title" :title="dlRunning.title">{{ dlRunning.title }}</div>
              <div class="sidebar-dl-row">
                <span v-if="dlRunning.status === 'awaitingHuman'">等你处理页面上的登录 / 验证</span>
                <span v-else>已下 {{ dlRunning.done }} / {{ dlRunning.total }} 章</span>
                <button class="sidebar-dl-cancel" type="button" @click="cancelSidebarDownload">取消</button>
              </div>
            </div>
          </div>
        </aside>
        <section class="main">
          <BrowsePage
            v-show="tab === 'browse'"
            :active="tab === 'browse'"
            :prefill-url="browsePrefillUrl"
            :prefill-nonce="browsePrefillNonce"
            :prefill-reading="browsePrefillReading"
            @open-book="openBook"
            @edit-site-rule="goSettingsWithHost"
            @open-web-book="openWebBook"
          />
          <LibraryPage
            v-show="tab === 'library'"
            :active="libraryActive"
            @open-book="openBook"
            @go-browse="goBrowse"
            @open-web-book="openWebBook"
            @go-settings="tab = 'settings'"
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
