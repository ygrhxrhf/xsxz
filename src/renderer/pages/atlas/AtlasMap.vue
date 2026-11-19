<script setup lang="ts">
/**
 * 3D 全球地形/水系地图（阶段 1）。
 *
 * 源自 Infinite Reader 的 web/src/ui/AtlasMap.tsx（Apache-2.0），已改成 Vue：
 * 保留地球/区域/三维地形三档、地点标记、标签避让、水系降级提示与重试；
 * 去掉 React 的 i18n / readingMap 细节，文案直接用中文。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { Map as GlobeMap } from 'maplibre-gl'
import workerSource from 'maplibre-gl/dist/maplibre-gl-worker.mjs?raw'
import 'maplibre-gl/dist/maplibre-gl.css'
import './atlas.css'
import type { BookMap } from './types'
import { atlasStyle } from './mapStyle'
import { WATER_DETAIL_SOURCE, watchWaterDetail } from './hydrology'
import { ATLAS_MAX_ZOOM, findTerrainFocus, TERRAIN_VIEW } from './terrainView'

const props = withDefaults(defineProps<{
  atlas: BookMap
  selected?: string | null
  compact?: boolean
  readingMap?: boolean
  focusPlace?: Pick<BookMap['places'][number], 'id' | 'coordinates'> | null
}>(), {
  selected: null,
  compact: false,
  readingMap: false,
  focusPlace: null,
})

const emit = defineEmits<{
  (event: 'select', id: string | null): void
}>()

const RECOGNIZED_PLACE_ZOOM = 9
const container = ref<HTMLDivElement | null>(null)
const ready = ref(false)
const fatal = ref(false)
const waterLimited = ref(false)
const limited = ref(false)
const terrain = ref(false)
const terrainLoading = ref(false)

let map: GlobeMap | null = null
let stopWaterDetail: (() => void) | undefined
let resizeObserver: ResizeObserver | null = null
let labelFrame = 0
let terrainTimer: ReturnType<typeof setTimeout> | null = null
let terrainFlight: 'overview' | 'refine' | 'detail' | null = null
let returnView: { center: [number, number]; zoom: number; pitch: number; bearing: number } | null = null
let workerUrl: string | null = null
const markerButtons = new Map<string, HTMLButtonElement>()

function motion(): boolean {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function atlasOrigin(): string {
  return typeof location !== 'undefined' && location.protocol === 'file:' ? 'spbf-atlas://a' : location.origin
}

function ensureWorker(): void {
  if (!workerUrl) {
    workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
  }
  maplibregl.setWorkerUrl(workerUrl)
}

function cancelTerrainFlight(): void {
  terrainFlight = null
  if (terrainTimer !== null) clearTimeout(terrainTimer)
  terrainTimer = null
  terrainLoading.value = false
}

function labels(): void {
  if (!map || !container.value) return
  if (labelFrame) return
  labelFrame = requestAnimationFrame(() => {
    labelFrame = 0
    const current = map
    const el = container.value
    if (!current || !el) return
    const visible = current.getZoom() >= 2.2
    el.dataset.labels = visible ? 'visible' : 'hidden'
    if (!visible) return
    const viewport = el.getBoundingClientRect()
    const candidates = [...markerButtons.values()].map((button) => ({
      button,
      box: button.querySelector('span')!.getBoundingClientRect(),
      priority: button.classList.contains('selected') || button.matches(':hover, :focus-visible'),
    })).sort((a, b) => Number(b.priority) - Number(a.priority))
    const occupied: DOMRect[] = []
    for (const { button, box, priority } of candidates) {
      const fits = box.left >= viewport.left + 4 && box.right <= viewport.right - 4
        && box.top >= viewport.top + 4 && box.bottom <= viewport.bottom - 4
      const overlaps = occupied.some((rect) => box.left < rect.right + 5 && box.right > rect.left - 5
        && box.top < rect.bottom + 4 && box.bottom > rect.top - 4)
      const show = priority || (fits && !overlaps)
      button.dataset.labelHidden = String(!show)
      if (show) occupied.push(box)
    }
  })
}

function destroy(): void {
  cleanupCurrent()
  cancelTerrainFlight()
  if (labelFrame) cancelAnimationFrame(labelFrame)
  labelFrame = 0
  resizeObserver?.disconnect()
  resizeObserver = null
  stopWaterDetail?.()
  stopWaterDetail = undefined
  markerButtons.clear()
  map?.remove()
  map = null
  ready.value = false
  fatal.value = false
  limited.value = false
  waterLimited.value = false
  terrain.value = false
  terrainLoading.value = false
}

function setup(): void {
  destroy()
  const el = container.value
  if (!el) return
  ensureWorker()
  try {
    const current = new maplibregl.Map({
      locale: {
        'Map.Title': '地图',
        'NavigationControl.ZoomIn': '放大',
        'NavigationControl.ZoomOut': '缩小',
        'NavigationControl.ResetBearing': '拖动旋转地图，点击回正北',
      },
      container: el,
      style: atlasStyle(atlasOrigin(), 'zh-CN'),
      center: [props.atlas.center[0] - 24, 20],
      zoom: 1.35,
      minZoom: 0.6,
      maxZoom: ATLAS_MAX_ZOOM,
      maxPitch: 75,
      renderWorldCopies: false,
      keyboard: !props.compact,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    })
    map = current
    current.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    current.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
    current.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left')
    stopWaterDetail = watchWaterDetail(current, (value) => { waterLimited.value = value })

    current.on('load', () => {
      ready.value = true
      const focus = props.focusPlace
      if (focus) current.flyTo({ center: focus.coordinates, zoom: RECOGNIZED_PLACE_ZOOM, duration: motion() ? 1200 : 0 })
      else current.fitBounds(props.atlas.bounds, { padding: 64, duration: motion() ? 1500 : 0, maxZoom: props.readingMap ? 10 : 5.7 })
    })
    current.on('error', (event) => {
      const sourceId = 'sourceId' in event ? (event as { sourceId?: string }).sourceId : undefined
      if (sourceId) {
        if (sourceId === WATER_DETAIL_SOURCE) return
        limited.value = true
        if (sourceId === 'terrain' && current.getTerrain()) {
          cancelTerrainFlight()
          current.stop().setTerrain(null)
          current.easeTo({ pitch: 0, duration: 0 })
          terrain.value = false
        }
        if (sourceId === 'water') {
          current.setLayoutProperty('elevation-color', 'visibility', 'none')
          current.setLayoutProperty('hillshade', 'visibility', 'none')
        }
      } else {
        fatal.value = true
      }
    })

    const finishTerrainFlight = (): void => {
      if (terrainFlight === 'overview' || terrainFlight === 'refine') {
        const refine = terrainFlight === 'refine'
        const fallback = props.atlas.places[0]?.coordinates ?? props.atlas.center
        const near = refine ? current.getCenter().toArray() as [number, number] : undefined
        const center = findTerrainFocus(
          props.atlas.bounds,
          (point) => current.queryTerrainElevation(point),
          near ?? fallback,
          near,
        )
        terrainFlight = refine ? 'detail' : 'refine'
        current.flyTo({
          center,
          zoom: refine ? TERRAIN_VIEW.zoom : 7.5,
          pitch: refine ? TERRAIN_VIEW.pitch : 0,
          bearing: 0,
          duration: motion() ? 1200 : 0,
        })
      } else if (terrainFlight === 'detail') {
        cancelTerrainFlight()
      }
    }
    const exitDistantTerrain = (): void => {
      if (current.getTerrain() && !terrainFlight && current.getZoom() < 6) {
        current.setTerrain(null)
        current.easeTo({ pitch: 0, duration: motion() ? 400 : 0 })
        terrain.value = false
      }
    }
    current.on('idle', finishTerrainFlight)
    current.on('moveend', exitDistantTerrain)
    el.addEventListener('pointerdown', cancelTerrainFlight)
    el.addEventListener('wheel', cancelTerrainFlight, { passive: true })
    el.addEventListener('keydown', cancelTerrainFlight)

    for (const place of props.atlas.places) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'atlas-marker'
      button.setAttribute('aria-label', `定位${place.name}`)
      const dot = document.createElement('i')
      const label = document.createElement('span')
      label.textContent = place.name
      button.append(dot, label)
      button.onclick = () => emit('select', place.id)
      markerButtons.set(place.id, button)
      new maplibregl.Marker({ element: button, anchor: 'center' }).setLngLat(place.coordinates).addTo(current)
    }

    current.on('move', labels)
    current.on('resize', labels)
    const labelEvents = ['pointerover', 'pointerout', 'focusin', 'focusout'] as const
    for (const eventName of labelEvents) el.addEventListener(eventName, labels)
    labels()

    resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => current.resize())
    resizeObserver?.observe(el)

    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || !['+', '=', '-', '_', '0'].includes(event.key)) return
      event.preventDefault()
      cancelTerrainFlight()
      if (event.key === '0') {
        current.setTerrain(null)
        terrain.value = false
        current.fitBounds(props.atlas.bounds, { bearing: 0, pitch: 0, padding: 64, duration: motion() ? 600 : 0 })
      } else {
        current.zoomTo(current.getZoom() + (event.key === '+' || event.key === '=' ? 0.5 : -0.5), { duration: 200 })
      }
    }
    const keyboardTarget: HTMLElement | Window = props.compact ? el : window
    keyboardTarget.addEventListener('keydown', onKey as EventListener)

    const cleanup = (): void => {
      current.off('idle', finishTerrainFlight)
      current.off('moveend', exitDistantTerrain)
      el.removeEventListener('pointerdown', cancelTerrainFlight)
      el.removeEventListener('wheel', cancelTerrainFlight)
      el.removeEventListener('keydown', cancelTerrainFlight)
      current.off('move', labels)
      current.off('resize', labels)
      for (const eventName of labelEvents) el.removeEventListener(eventName, labels)
      keyboardTarget.removeEventListener('keydown', onKey as EventListener)
    }
    el.dataset.atlasCleanup = '1'
    ;(el as HTMLElement & { __atlasCleanup?: () => void }).__atlasCleanup = cleanup
  } catch {
    fatal.value = true
    map?.remove()
    map = null
  }
}

function cleanupCurrent(): void {
  const el = container.value as (HTMLElement & { __atlasCleanup?: () => void }) | null
  el?.__atlasCleanup?.()
  if (el) delete el.__atlasCleanup
}

function retry(): void {
  fatal.value = false
  setup()
}

function exitTerrain(): void {
  cancelTerrainFlight()
  map?.stop().setTerrain(null)
  terrain.value = false
}

function region(): void {
  emit('select', null)
  exitTerrain()
  map?.fitBounds(props.atlas.bounds, { bearing: 0, pitch: 0, padding: 64, duration: motion() ? 800 : 0 })
}

function globe(): void {
  emit('select', null)
  exitTerrain()
  map?.easeTo({ center: props.atlas.center, zoom: 1.35, bearing: 0, pitch: 0, duration: motion() ? 1000 : 0 })
}

function toggleTerrain(): void {
  const current = map
  if (!current) return
  if (current.getTerrain()) {
    exitTerrain()
    current.flyTo({ ...(returnView ?? { pitch: 0 }), duration: motion() ? 1200 : 0 })
    return
  }
  current.stop()
  returnView = {
    center: current.getCenter().toArray() as [number, number],
    zoom: current.getZoom(),
    pitch: current.getPitch(),
    bearing: current.getBearing(),
  }
  const place = props.atlas.places.find((item) => item.id === props.selected)
  const local = current.getZoom() >= 7 || !!place
  terrainFlight = local ? 'detail' : 'overview'
  terrainLoading.value = true
  terrain.value = true
  current.setTerrain({ source: 'terrain', exaggeration: TERRAIN_VIEW.exaggeration })
  terrainTimer = setTimeout(() => {
    exitTerrain()
    limited.value = true
    current.easeTo({ pitch: 0, duration: 0 })
  }, 15000)
  if (local) {
    current.flyTo({
      center: current.getZoom() >= 7 ? current.getCenter() : place!.coordinates,
      zoom: Math.max(current.getZoom(), TERRAIN_VIEW.zoom),
      pitch: TERRAIN_VIEW.pitch,
      duration: motion() ? 1400 : 0,
    })
  } else {
    current.fitBounds(props.atlas.bounds, { bearing: 0, pitch: 0, padding: 64, maxZoom: 6, duration: motion() ? 500 : 0 })
  }
}

watch(
  () => `${props.atlas.id}|${props.atlas.places.map((place) => place.id).join(',')}`,
  () => setup(),
)
watch(() => props.selected, (selected) => {
  for (const [id, button] of markerButtons) {
    button.classList.toggle('selected', id === selected)
    button.setAttribute('aria-pressed', String(id === selected))
  }
  const current = map
  if (!current || !ready.value) return
  const place = props.atlas.places.find((item) => item.id === selected)
  if (!place) return
  cancelTerrainFlight()
  const minimumZoom = props.focusPlace?.id === place.id ? RECOGNIZED_PLACE_ZOOM : 5.3
  current.flyTo({
    center: place.coordinates,
    zoom: Math.max(current.getZoom(), current.getTerrain() ? TERRAIN_VIEW.zoom : minimumZoom),
    duration: motion() ? 1200 : 0,
  })
}, { immediate: true })

onMounted(setup)
onBeforeUnmount(() => {
  cleanupCurrent()
  destroy()
})
</script>

<template>
  <div class="atlas-viewport" :class="{ compact }">
    <div ref="container" class="atlas-map-canvas" />
    <div class="atlas-map-caption">
      <span>{{ terrain ? '3D 地形视图' : '地球视图' }}</span>
      <strong>{{ atlas.title }}</strong>
    </div>
    <div v-if="!ready || fatal" class="atlas-map-status" role="status">
      <span class="atlas-orbit" aria-hidden="true">◎</span>
      <p>{{ fatal ? '地球暂时未能加载，原图仍可查看。' : '正在展开地球…' }}</p>
      <button v-if="fatal" type="button" @click="retry">重新加载</button>
    </div>
    <div v-if="waterLimited && !limited && !fatal" class="atlas-map-notice" role="status">
      详细水系暂不可用，已保留主要河流。
    </div>
    <div v-if="limited && !fatal" class="atlas-map-notice" role="status">
      部分地形细节暂不可用，已保留基础地图。
    </div>
    <nav class="atlas-map-controls" aria-label="地图视角">
      <button type="button" :disabled="!ready || fatal" @click="region">↗ 区域全览</button>
      <button type="button" :disabled="!ready || fatal" @click="globe">◎ 全球</button>
      <button
        type="button"
        :disabled="!ready || fatal"
        :aria-pressed="terrain"
        :aria-busy="terrainLoading"
        @click="toggleTerrain"
      >△ 3D 地形</button>
    </nav>
    <div class="atlas-gesture-hint" role="status">
      {{ terrainLoading ? '正在加载三维地形…' : terrain ? '拖动探索 · 滚动缩放 · 右键拖动旋转' : '拖动探索 · 滚动缩放' }}
    </div>
  </div>
</template>
