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
const dlRunning = ref(false)
const dlHint = ref('')
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

// 夜樱主题：樱粉主色 + 紫罗兰辅色，统一 Naive UI 组件配色
const sakuraOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#ff8ec7',
    primaryColorHover: '#ffa6d4',
    primaryColorPressed: '#f077b5',
    primaryColorSuppl: '#b49bff',
    infoColor: '#9cb8ff',
    infoColorHover: '#b3c9ff',
    infoColorPressed: '#85a4f2',
    infoColorSuppl: '#9cb8ff',
    successColor: '#7ceac3',
    successColorHover: '#96f0d1',
    successColorPressed: '#63d8b0',
    successColorSuppl: '#7ceac3',
    warningColor: '#ffc978',
    warningColorHover: '#ffd694',
    warningColorPressed: '#f5b95e',
    warningColorSuppl: '#ffc978',
    errorColor: '#ff8ba3',
    errorColorHover: '#ffa4b8',
    errorColorPressed: '#f2748e',
    errorColorSuppl: '#ff8ba3',
    textColorBase: '#f3effc',
    textColor1: '#f3effc',
    textColor2: '#d9d2ec',
    textColor3: '#a89fc4',
    placeholderColor: '#6f6790',
    borderColor: 'rgba(203, 170, 247, 0.24)',
    dividerColor: 'rgba(203, 170, 247, 0.16)',
    cardColor: 'rgba(255, 255, 255, 0.045)',
    modalColor: '#211a35',
    popoverColor: '#261e3d',
    drawerColor: '#201a33',
    inputColor: 'rgba(11, 8, 19, 0.55)',
    actionColor: 'rgba(255, 255, 255, 0.04)',
    hoverColor: 'rgba(255, 142, 199, 0.10)',
    borderRadius: '8px',
    borderRadiusSmall: '8px',
  },
  Card: {
    borderRadius: '14px',
    borderColor: 'rgba(203, 170, 247, 0.18)',
  },
  Dialog: {
    borderRadius: '16px',
  },
  Tag: {
    borderRadius: '8px',
  },
}

// 简约主题：浅色中性、石板蓝点缀、小圆角无装饰
const minimalOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#5e6f9e',
    primaryColorHover: '#7080ae',
    primaryColorPressed: '#4d5d89',
    primaryColorSuppl: '#5e6f9e',
    infoColor: '#4c7dd4',
    infoColorHover: '#6b93dd',
    infoColorPressed: '#3f6cbd',
    infoColorSuppl: '#4c7dd4',
    successColor: '#2f9e6e',
    successColorHover: '#47b183',
    successColorPressed: '#278a5f',
    successColorSuppl: '#2f9e6e',
    warningColor: '#c78a2e',
    warningColorHover: '#d69c45',
    warningColorPressed: '#b57a26',
    warningColorSuppl: '#c78a2e',
    errorColor: '#d64550',
    errorColorHover: '#de606a',
    errorColorPressed: '#c23a45',
    errorColorSuppl: '#d64550',
    textColorBase: '#26262e',
    textColor1: '#26262e',
    textColor2: '#4a4a55',
    textColor3: '#767682',
    placeholderColor: '#a5a5b0',
    borderColor: '#d9dae2',
    dividerColor: '#e8e9ee',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    drawerColor: '#ffffff',
    inputColor: '#f4f5f8',
    actionColor: '#f4f5f8',
    hoverColor: 'rgba(94, 111, 158, 0.08)',
    borderRadius: '8px',
    borderRadiusSmall: '8px',
  },
  Card: {
    borderRadius: '14px',
    borderColor: '#e4e5ec',
    color: '#ffffff',
  },
  Dialog: {
    borderRadius: '16px',
  },
  Tag: {
    borderRadius: '8px',
  },
}

// 换肤：localStorage 快照让首帧即正确，settings.json 为权威值
const SKIN_STORAGE_KEY = 'spbf.skin'

function isSkin(v: unknown): v is Skin {
  return v === 'sakura' || v === 'minimal'
}

const skin = ref<Skin>(localStorage.getItem(SKIN_STORAGE_KEY) === 'minimal' ? 'minimal' : 'sakura')
document.body.dataset.skin = skin.value

const naiveTheme = computed(() => (skin.value === 'minimal' ? lightTheme : darkTheme))
const themeOverrides = computed(() => (skin.value === 'minimal' ? minimalOverrides : sakuraOverrides))

const skinMeta = computed(() =>
  skin.value === 'minimal'
    ? { sub: '简约阅读', toggleLabel: '夜樱模式' }
    : { sub: '❀ 樱色书房 ❀', toggleLabel: '简约模式' },
)

function toggleSkin() {
  skin.value = skin.value === 'sakura' ? 'minimal' : 'sakura'
}

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

function tabBadge(id: Tab): string {
  if (!dlRunning.value) return ''
  if (id === 'browse') return '下载中'
  if (id === 'library') return dlHint.value
  return ''
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
    if (isSkin(s.appearance?.skin) && s.appearance.skin !== skin.value) {
      skin.value = s.appearance.skin
    }
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
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M3 5.5A3.5 3.5 0 0 1 6.5 2H11v17H6.5A3.5 3.5 0 0 0 3 22V5.5Z" />
                <path d="M21 5.5A3.5 3.5 0 0 0 17.5 2H13v17h4.5A3.5 3.5 0 0 1 21 22V5.5Z" />
              </svg>
            </span>
            <div class="brand-copy">
              <div class="brand-title">小说浏览器</div>
              <div class="brand-sub">{{ skinMeta.sub }}</div>
            </div>
          </div>
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
            <span v-if="tabBadge(item.id)" class="nav-badge">{{ tabBadge(item.id) }}</span>
          </button>
          <div class="sidebar-bottom">
            <button class="skin-toggle" type="button" :title="skin === 'sakura' ? '切换到简约皮肤' : '切换到夜樱皮肤'" @click="toggleSkin">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path v-if="skin === 'sakura'" d="M12 3a9 9 0 1 0 9 9c0-.5-.04-1-.12-1.47A7 7 0 0 1 13.47 3.1C13 3.03 12.5 3 12 3Z" />
                <template v-else>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
                </template>
              </svg>
              <span>{{ skinMeta.toggleLabel }}</span>
            </button>
            <div v-if="skin === 'sakura'" class="sidebar-footer">✦ ♡ ✦</div>
          </div>
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
