<script setup lang="ts">
/**
 * 阅读器左下角的地图胶囊（阶段 4）。
 *
 * 源自 Infinite Reader 的 web/src/ui/AtlasDock.tsx（Apache-2.0），已改成 Vue：
 * 保留「图片地图」和「文字地点」两半胶囊、迷你 3D 面板、放大/收起、
 * 按 Esc 关闭、左右方向键交给阅读器翻页；去掉参考站的账号/云同步与原文锚点跳转，
 * 数据直接复用 spbf 的 `map.getImage` / `map.getPlaces`。
 */
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import type { AiPlaceGeo } from '@shared/types'
import { BOOK_MAPS, identifyBookMap } from './catalog'
import { textBookMap } from './mapPins'
import type { BookMap } from './types'
import './atlas.css'

const props = defineProps<{
  bookId: string
}>()

const emit = defineEmits<{
  (event: 'open-map-page'): void
}>()

const AtlasMap = defineAsyncComponent(() => import('./AtlasMap.vue'))

type DockView = 'closed' | 'list' | 'image' | 'text'

const places = ref<AiPlaceGeo[]>([])
const imageMap = ref<BookMap | null>(null)
const imageUrl = ref('')
const view = ref<DockView>('closed')
const selected = ref<string | null>(null)
const expanded = ref(false)
const imageId = ref('')

const textMap = computed(() => textBookMap(places.value))
const activeMap = computed<BookMap | null>(() => {
  if (view.value === 'text') return textMap.value
  if (view.value === 'image' && imageMap.value) return imageMap.value
  return null
})
const focusPlace = computed(() => {
  const place = activeMap.value?.places.find((item) => item.id === selected.value)
  return place ? { id: place.id, coordinates: place.coordinates } : null
})
const hasAny = computed(() => Boolean(textMap.value) || Boolean(imageMap.value))
const mini = computed(() => view.value === 'image' || view.value === 'text')

function toggle(target: 'image' | 'text'): void {
  if (target === 'text' && !textMap.value) return
  if (target === 'image' && !imageMap.value) return
  if (view.value === target) {
    close()
    return
  }
  view.value = target
  expanded.value = false
  selected.value = null
}

function openImageMap(): void {
  if (!imageMap.value) return
  imageId.value = imageMap.value.id
  view.value = 'image'
  expanded.value = false
  selected.value = null
}

function close(): void {
  view.value = 'closed'
  expanded.value = false
  selected.value = null
}

function onKeydown(event: KeyboardEvent): void {
  // 左右方向键属于阅读器翻页，不在面板里拦截。
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

let loadToken = 0

async function load(): Promise<void> {
  const token = ++loadToken
  if (!props.bookId) {
    places.value = []
    imageMap.value = null
    imageUrl.value = ''
    close()
    return
  }
  try {
    const res = await window.api.map.getPlaces(props.bookId)
    if (token === loadToken && res.ok) places.value = res.places
  } catch {
    // 读不到地名不影响图片地图那一半。
  }
  try {
    const res = await window.api.map.getImage(props.bookId)
    if (token !== loadToken) return
    if (res.ok && res.url) {
      imageUrl.value = res.url
      const response = await fetch(`spbf-map://m/${encodeURIComponent(props.bookId)}`)
      if (token !== loadToken) return
      if (response.ok) {
        const matched = await identifyBookMap(await response.blob())
        if (token === loadToken) imageMap.value = matched
      }
    } else {
      imageUrl.value = ''
      imageMap.value = null
    }
  } catch {
    imageUrl.value = ''
    imageMap.value = null
  } finally {
    // 识别失败只影响图片那一半；文字地点仍可用。
  }
}

watch(() => props.bookId, () => { void load() }, { immediate: true })

onBeforeUnmount(() => { loadToken += 1 })

const imageOptions = computed(() => (imageMap.value ? [imageMap.value] : []))
</script>

<template>
  <div
    v-if="hasAny"
    class="atlas-dock"
    data-atlas-dock
    :data-open="view !== 'closed'"
    @keydown="onKeydown"
  >
    <section
      v-if="view !== 'closed'"
      class="atlas-dock-panel"
      :class="{ 'atlas-dock-mini': mini, 'atlas-dock-expanded': expanded && mini }"
      tabindex="-1"
      aria-label="已识别的地图"
    >
      <header>
        <button v-if="view === 'image'" type="button" aria-label="返回地图列表" @click="view = 'list'; expanded = false">←</button>
        <strong>{{ view === 'text' ? '文字地点汇总' : activeMap?.title || '已识别的地图' }}</strong>
        <button
          v-if="mini"
          type="button"
          :aria-label="expanded ? '收起地图' : '放大地图'"
          @click="expanded = !expanded"
        >{{ expanded ? '⤡' : '⤢' }}</button>
        <button type="button" aria-label="关闭地图" @click="close">×</button>
      </header>
      <div v-if="view === 'list'" class="atlas-dock-body atlas-dock-list">
        <ul>
          <li v-if="textMap">
            <button type="button" class="atlas-dock-map-item" @click="toggle('text')">
              <span>◎</span>
              <span>
                <strong>文字地点汇总</strong>
                <small>{{ textMap.places.length }} 个地点</small>
              </span>
            </button>
          </li>
          <li v-for="map in imageOptions" :key="map.id">
            <button type="button" class="atlas-dock-map-item" @click="openImageMap">
              <span>▤</span>
              <span>
                <strong>{{ map.title }}</strong>
                <small>{{ map.period || '书中原图' }}</small>
              </span>
            </button>
          </li>
          <li v-if="!textMap && !imageOptions.length">
            <small>还没有可显示的地图。</small>
          </li>
        </ul>
        <button type="button" class="atlas-dock-more" @click="emit('open-map-page')">打开书中地图页</button>
      </div>
      <div v-else class="atlas-dock-body">
        <AtlasMap
          v-if="activeMap"
          :atlas="activeMap"
          :selected="selected"
          :focus-place="focusPlace"
          compact
          reading-map
          @select="selected = $event"
        />
      </div>
    </section>
    <div class="atlas-dock-launcher">
      <button
        type="button"
        class="atlas-dock-trigger"
        :disabled="!imageMap"
        :aria-expanded="view === 'image'"
        :aria-label="imageMap ? '书中图片地图' : '还没有识别的图片地图'"
        :title="imageMap ? '书中图片地图' : '还没有识别的图片地图'"
        @click="toggle('image')"
      >▤</button>
      <div class="atlas-dock-divider" aria-hidden="true"></div>
      <button
        type="button"
        class="atlas-dock-trigger"
        :disabled="!textMap"
        :aria-expanded="view === 'text'"
        :aria-label="textMap ? '书中文字地点' : '还没有定位的文字地名'"
        :title="textMap ? '书中文字地点' : '还没有定位的文字地名'"
        @click="toggle('text')"
      >◎</button>
    </div>
  </div>
</template>

<style scoped>
.atlas-dock-list {
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.atlas-dock-list ul {
  list-style: none;
  margin: 0;
  padding: 0 14px;
}
.atlas-dock-more {
  margin: 11px 14px 13px;
  padding: 5px 10px;
  font-size: 12px;
  text-decoration: underline;
}
</style>
