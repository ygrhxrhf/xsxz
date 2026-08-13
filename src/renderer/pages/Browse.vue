<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { BrowseState } from '@shared/types'

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

function reportBounds() {
  const el = slot.value
  if (!el) return
  const r = el.getBoundingClientRect()
  void window.api.browse.setBounds({
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(1, Math.round(r.width)),
    height: Math.max(1, Math.round(r.height)),
  })
}

async function go() {
  const res = await window.api.browse.load(address.value)
  if (!res.ok) {
    window.alert(res.message)
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
  }))
  unsubs.push(window.api.browse.onUrl(({ url }) => {
    if (url && url !== 'about:blank') address.value = url
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
    <form class="chrome" @submit="onSubmit">
      <button type="button" :disabled="!state.canGoBack" @click="window.api.browse.back()">后退</button>
      <button type="button" :disabled="!state.canGoForward" @click="window.api.browse.forward()">前进</button>
      <button type="button" @click="state.loading ? window.api.browse.stop() : window.api.browse.reload()">
        {{ state.loading ? '停止' : '刷新' }}
      </button>
      <input v-model="address" placeholder="粘贴或输入网址，回车打开" spellcheck="false" />
      <button type="submit">打开</button>
    </form>
    <div ref="slot" class="browse-slot" />
  </div>
</template>
