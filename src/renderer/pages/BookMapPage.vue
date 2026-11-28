<script setup lang="ts">
/**
 * 书中地图页（M5 第一批落地）。
 *
 * 只负责三件事：按需取 Key、加载腾讯地图底图、把「为什么没有内容」说清楚。
 * 地名/事件标注与左侧「书中原图」都依赖用户提供的地图素材（方案 §9），
 * 未提供时给空态，不臆造坐标或图片。
 */
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AiPlace, AiPlaceCandidate, AiPlaceGeo, AiPlaceKind, MapManualPlaceInput } from '@shared/types'
import type { AtlasRecognition } from '@shared/atlas'
import { BOOK_MAPS, identifyBookMap } from './atlas/catalog'
import { textBookMap } from './atlas/mapPins'
import type { BookMap } from './atlas/types'
import {
  loadTencentMap,
  type TencentInfoWindow,
  type TencentMapApi,
  type TencentMapInstance,
  type TencentMarker,
} from './tencentMapLoader'

const props = withDefaults(defineProps<{
  bookId?: string
  bookTitle?: string
}>(), {
  bookId: '',
  bookTitle: '',
})

const emit = defineEmits<{
  (event: 'go-settings'): void
  (event: 'select-place', anchor: { paragraphIndex: number; paragraphOffset: number }): void
}>()

type MapStage = 'loading' | 'no-key' | 'ready' | 'error'

/** 地图视图：腾讯 2D 底图 / 3D 全球地形（MapLibre，按需加载）。 */
const AtlasMap = defineAsyncComponent(() => import('./atlas/AtlasMap.vue'))
const mapMode = ref<'2d' | '3d'>('2d')
const atlasId = ref(BOOK_MAPS[0]!.id)
const atlasSelected = ref<string | null>(null)
/** 书里已定位的地名汇总成一张「文字地点」地图；没有已定位地名时为 null。 */
const textMap = computed(() => textBookMap(places.value))
const atlasOptions = computed(() => {
  const recognized = atlasMatch.value.map
  // 自动识别出的图不在精选清单里：放进下拉，选中后 3D 区域才能指向它。
  const options = [...BOOK_MAPS, ...(recognized && !BOOK_MAPS.some((item) => item.id === recognized.id) ? [recognized] : [])]
  if (textMap.value) options.push(textMap.value)
  return options
})
const atlasMap = computed(() => atlasOptions.value.find((item) => item.id === atlasId.value)
  ?? textMap.value
  ?? BOOK_MAPS[0]!)
const atlasMatch = ref<{
  status: 'none' | 'checking' | 'matched' | 'unmatched' | 'unavailable' | 'recognizing' | 'failed'
  map: BookMap | null
}>({
  status: 'none',
  map: null,
})
/** 最近一次自动识别的说明与未匹配地名；只作提示，不参与落点。 */
const atlasRecognition = ref<{ message: string; model: string; cached: boolean; unresolved: string[] } | null>(null)
const atlasRecognizing = ref(false)
const atlasFocus = computed(() => {
  const place = atlasMap.value.places.find((item) => item.id === atlasSelected.value)
  return place ? { id: place.id, coordinates: place.coordinates } : null
})
let recognizeToken = 0

const stage = ref<MapStage>('loading')
const errorText = ref('')
const mapEl = ref<HTMLElement | null>(null)
let mapApi: TencentMapApi | null = null
let mapInstance: TencentMapInstance | null = null
const markers: TencentMarker[] = []
let infoWindow: TencentInfoWindow | null = null

// 「抽取已读地名」只做结构化输出；坐标只能来自腾讯地理编码，模型不产出。
const places = ref<AiPlaceGeo[]>([])
const extracting = ref(false)
const geocoding = ref(false)
const extractionMessage = ref('')
const geoMessage = ref('')
const budgetHint = ref('')
const needsConfirm = ref(false)
const mapImageUrl = ref('')
const imageBusy = ref(false)
const imageMessage = ref('')
/** 列表里当前被“居中查看”的地点；只影响高亮，不改变书里的锚点。 */
const centeredPlaceId = ref('')
/** 正在提交确认/忽略的地名 id，防止重复点击。 */
const confirmingId = ref('')
const candidatesFor = ref('')
const candidates = ref<AiPlaceCandidate[]>([])
const candidateBusy = ref('')
const candidateMessage = ref('')

/**
 * 手工标注（不消耗腾讯配额）：坐标由本人给定。
 *
 * 表单只在「手工标注」按钮点开后出现——地图页左栏本来就窄，常驻表单会把地名列表挤没。
 */
const manualFormOpen = ref(false)
const manualName = ref('')
const manualLatitude = ref('')
const manualLongitude = ref('')
const manualKind = ref<AiPlaceKind>('other')
const manualParagraphIndex = ref('')
const manualParagraphOffset = ref('')
const manualBusy = ref(false)
const manualMessage = ref('')

/** 手工标注的 id 前缀：主进程写盘时带上，渲染层据此认出「这是手工标的」。 */
const MANUAL_PLACE_ID_PREFIX = 'place-manual-'
const extractLabel = computed(() => {
  if (extracting.value) return '正在抽取…'
  return needsConfirm.value ? '确认继续抽取' : '抽取已读地名'
})

const PLACE_KIND_LABELS: Record<AiPlace['kind'], string> = {
  city: '城市',
  region: '地区',
  landmark: '地标',
  other: '其他',
}

function kindLabel(kind: AiPlace['kind']): string {
  return PLACE_KIND_LABELS[kind] ?? '其他'
}

/** 是否手工标注的条目。 */
function isManualPlace(place: AiPlaceGeo): boolean {
  return place.id.startsWith(MANUAL_PLACE_ID_PREFIX)
}

/**
 * 是否带正文锚点：自动抽取的地名一定属于某章；手工标注看 id——
 * `place-manual-anchor-<段号>-<偏移>` 才是挂了正文的，
 * `place-manual-free-<序号>` 只作地图标记，跳不回原文。
 *
 * 判据必须用 id 而不是 chapterId：手工标注不隶属任何一章，chapterId 恒为空。
 */
function hasAnchor(place: AiPlaceGeo): boolean {
  if (!isManualPlace(place)) return true
  return /^place-manual-anchor-\d+-\d+$/.test(place.id)
}

/**
 * 坐标输入：空串按非法处理（Number('') 是 0，会把没填的经度当成赤道）。
 *
 * 注意：Vue 对 `type="number"` 的输入框自动做数字转换，v-model 拿到的是 number，
 * 所以这里不能直接用字符串方法——两种类型都得接得住。
 */
function parseCoordinate(raw: string | number): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : Number.NaN
  const text = String(raw ?? '').trim()
  if (!text) return Number.NaN
  return Number(text)
}

/** 段号 / 段内偏移：空串表示不给这个锚点。 */
function parseAnchor(raw: string | number): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const text = String(raw ?? '').trim()
  if (!text) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

async function submitManualPlace(): Promise<void> {
  if (!props.bookId || manualBusy.value) return
  manualBusy.value = true
  manualMessage.value = ''
  try {
    const payload: MapManualPlaceInput = {
      bookId: props.bookId,
      name: manualName.value.trim(),
      latitude: parseCoordinate(manualLatitude.value),
      longitude: parseCoordinate(manualLongitude.value),
      kind: manualKind.value,
    }
    const paragraphIndex = parseAnchor(manualParagraphIndex.value)
    if (paragraphIndex !== null) {
      payload.paragraphIndex = paragraphIndex
      const offset = parseAnchor(manualParagraphOffset.value)
      payload.paragraphOffset = offset ?? 0
    }
    const res = await window.api.map.addManualPlace(payload)
    if (!res.ok) {
      manualMessage.value = res.message || '手工标注失败'
      return
    }
    places.value = res.places
    syncMarkers()
    manualMessage.value = `已手工标注「${payload.name}」`
    manualName.value = ''
    manualLatitude.value = ''
    manualLongitude.value = ''
    manualParagraphIndex.value = ''
    manualParagraphOffset.value = ''
    // 标完把地图挪到这个点：刚标的位置就是要看的位置。
    // 认领时按「手工项 + 同名 + 同坐标」找，避免撞上坐标相同的既有地名。
    const created = res.places.find((place) => isManualPlace(place)
      && place.name === payload.name
      && place.location
      && place.location.latitude === payload.latitude
      && place.location.longitude === payload.longitude)
    if (created) {
      centeredPlaceId.value = created.id
      const api = mapApi
      const map = mapInstance
      if (api && map && created.location) {
        map.setCenter?.(new api.maps.LatLng(created.location.latitude, created.location.longitude))
        map.setZoom?.(12)
      }
    }
  } catch (error) {
    manualMessage.value = error instanceof Error ? error.message : '手工标注失败'
  } finally {
    manualBusy.value = false
  }
}

async function extractPlaces(confirmOverBudget = false): Promise<void> {
  if (!props.bookId || extracting.value) return
  extracting.value = true
  extractionMessage.value = ''
  try {
    const res = await window.api.ai.extractPlaces(props.bookId, confirmOverBudget)
    if (!res.ok) {
      if (res.confirmationRequired) {
        needsConfirm.value = true
        budgetHint.value = res.message
      } else {
        extractionMessage.value = res.message || '地名抽取失败'
      }
      return
    }
    needsConfirm.value = false
    budgetHint.value = ''
    // 抽取结果已按书落盘；从缓存读回来才能拿到同名地点此前解析过的坐标。
    await loadPlaces()
    geoMessage.value = ''
    extractionMessage.value = res.view.message
      || (res.view.places.length ? `已从 ${res.view.chapterCount} 章中抽取 ${res.view.places.length} 个地点${res.view.truncated ? '（已读正文超出本次上限，结果不是全量）' : ''}` : '没有识别出地点')
  } catch (error) {
    extractionMessage.value = error instanceof Error ? error.message : '地名抽取失败'
  } finally {
    extracting.value = false
  }
}

async function init(): Promise<void> {
  stage.value = 'loading'
  errorText.value = ''
  mapInstance = null
  try {
    const key = await window.api.map.getKey()
    if (!key.trim()) {
      stage.value = 'no-key'
      return
    }
    const api = await loadTencentMap(key)
    await nextTick()
    const container = mapEl.value
    if (!container) {
      stage.value = 'error'
      errorText.value = '地图容器未就绪，请重试'
      return
    }
    // 先把底图落在全国视野；地名解析出坐标后再 fitBounds 或居中到第一个点。
    const center = new api.maps.LatLng(34.0, 108.0)
    mapApi = api
    mapInstance = new api.maps.Map(container, { center, zoom: 4, zoomControl: true })
    stage.value = 'ready'
    syncMarkers()
  } catch (error) {
    stage.value = 'error'
    errorText.value = error instanceof Error ? error.message : '腾讯地图加载失败'
  }
}

/** 全局：有坐标时收拢所有标记；没有坐标时回到全国视野。 */
function fitAll(): void {
  const api = mapApi
  const map = mapInstance
  if (!api || !map) {
    geoMessage.value = '地图尚未就绪，暂时无法调整视野'
    return
  }
  const located = places.value.filter((place) => place.location)
  if (!located.length) {
    centeredPlaceId.value = ''
    map.setCenter?.(new api.maps.LatLng(34.0, 108.0))
    map.setZoom?.(4)
    return
  }
  if (api.maps.LatLngBounds && map.fitBounds) {
    try {
      const bounds = new api.maps.LatLngBounds()
      for (const place of located) bounds.extend(new api.maps.LatLng(place.location!.latitude, place.location!.longitude))
      map.fitBounds(bounds)
      return
    } catch { /* 退回第一个点 */ }
  }
  const first = located[0]!.location!
  map.setCenter?.(new api.maps.LatLng(first.latitude, first.longitude))
  map.setZoom?.(10)
}

/** 区域：放大到当前选中的地点；没有选中就取第一个有坐标的地点。 */
function focusRegion(): void {
  const target = places.value.find((place) => place.id === centeredPlaceId.value && place.location)
    ?? places.value.find((place) => place.location)
  if (!target?.location) {
    geoMessage.value = '还没有可定位的地点'
    return
  }
  centeredPlaceId.value = target.id
  const api = mapApi
  const map = mapInstance
  if (!api || !map) {
    geoMessage.value = '地图尚未就绪，暂时无法调整视野'
    return
  }
  map.setCenter?.(new api.maps.LatLng(target.location.latitude, target.location.longitude))
  map.setZoom?.(10)
}

/** 点地名：把地图居中到该点（列表高亮），不离开地图；跳原文由单独的「原文」按钮负责。 */
function centerOnPlace(place: AiPlaceGeo): void {
  if (!place.location) {
    geoMessage.value = '这个地点还没有坐标，请先点「定位到地图」'
    return
  }
  centeredPlaceId.value = place.id
  const api = mapApi
  const map = mapInstance
  if (!api || !map) {
    geoMessage.value = '地图尚未就绪，暂时无法居中'
    return
  }
  map.setCenter?.(new api.maps.LatLng(place.location.latitude, place.location.longitude))
  map.setZoom?.(12)
}

/**
 * 点标记先弹信息窗（名称、章节、段落、引文），再让读者决定是否跳原文。
 * 信息窗由腾讯地图接管 DOM，样式只能用内联，scoped 样式进不去。
 */
function openPlaceInfo(place: AiPlaceGeo, api: TencentMapApi, map: TencentMapInstance, position: unknown): void {
  const content = document.createElement('div')
  content.style.cssText = 'max-width:260px;padding:8px 10px;font-size:12px;line-height:1.6;color:#2f2a24;'
  const title = document.createElement('strong')
  title.textContent = place.name
  title.style.cssText = 'display:block;font-size:13px;margin-bottom:4px;'
  const meta = document.createElement('div')
  // 手工标注不隶属某章：没有正文锚点就别报「第 N 段」——那会把人引向一个跳不动的位置。
  meta.textContent = isManualPlace(place)
    ? (hasAnchor(place) ? `手工标注 · 第 ${place.paragraphIndex + 1} 段` : '手工标注')
    : `${place.chapterTitle} · 第 ${place.paragraphIndex + 1} 段`
  meta.style.cssText = 'color:#6b6257;margin-bottom:4px;'
  const excerpt = document.createElement('p')
  excerpt.textContent = place.excerpt
  excerpt.style.cssText = 'margin:0 0 6px;'
  const jump = document.createElement('button')
  jump.type = 'button'
  jump.textContent = '跳到原文'
  jump.style.cssText = 'border:1px solid #4b93dd;border-radius:4px;padding:2px 8px;background:#fff;color:#2f6fae;cursor:pointer;font-size:12px;'
  jump.onclick = () => emit('select-place', { paragraphIndex: place.paragraphIndex, paragraphOffset: place.paragraphOffset })
  content.append(title, meta, excerpt)
  // 没有正文锚点的地名（手工标注且没填段号）跳不回原文，别给一个跳不动的按钮。
  if (hasAnchor(place)) content.append(jump)

  if (!api.maps.InfoWindow) {
    emit('select-place', { paragraphIndex: place.paragraphIndex, paragraphOffset: place.paragraphOffset })
    return
  }
  infoWindow?.close?.()
  infoWindow = new api.maps.InfoWindow({ content, position, map })
  infoWindow.open?.(map, position)
}

/** 已解析坐标的条目落成标记；点标记弹出原文信息窗。 */
function syncMarkers(): void {
  const api = mapApi
  const map = mapInstance
  if (!api || !map) return
  infoWindow?.close?.()
  infoWindow = null
  for (const marker of markers) marker.setMap?.(null)
  markers.length = 0
  const located = places.value.filter((place) => place.location)
  if (!located.length) return
  const Marker = api.maps.Marker
  if (!Marker) {
    geoMessage.value = '当前地图脚本不支持标记，已保留地名列表'
    return
  }
  for (const place of located) {
    try {
      const position = new api.maps.LatLng(place.location!.latitude, place.location!.longitude)
      const marker = new Marker({
        position,
        map,
        title: place.name,
      })
      api.maps.event?.addListener?.(marker, 'click', () => openPlaceInfo(place, api, map, position))
      markers.push(marker)
    } catch { /* 单个标记失败不挡住其它地点 */ }
  }
  if (api.maps.LatLngBounds && map.fitBounds) {
    try {
      const bounds = new api.maps.LatLngBounds()
      for (const place of located) bounds.extend(new api.maps.LatLng(place.location!.latitude, place.location!.longitude))
      map.fitBounds(bounds)
      return
    } catch { /* 退回居中到第一个点 */ }
  }
  map.setCenter?.(new api.maps.LatLng(located[0]!.location!.latitude, located[0]!.location!.longitude))
}

async function confirmMapPlace(place: AiPlaceGeo, accepted: boolean): Promise<void> {
  if (!props.bookId || confirmingId.value) return
  confirmingId.value = place.id
  try {
    const res = await window.api.map.confirmPlace(props.bookId, place.id, accepted)
    if (!res.ok) { geoMessage.value = res.message || '地名确认失败'; return }
    places.value = res.places
    geoMessage.value = accepted ? `已确认「${place.name}」的位置` : `已忽略「${place.name}」`
    if (!accepted && centeredPlaceId.value === place.id) centeredPlaceId.value = ''
    syncMarkers()
  } catch (error) {
    geoMessage.value = error instanceof Error ? error.message : '地名确认失败'
  } finally {
    confirmingId.value = ''
  }
}

async function searchCandidates(place: AiPlaceGeo): Promise<void> {
  if (!props.bookId || candidateBusy.value) return
  if (candidatesFor.value === place.id) {
    candidatesFor.value = ''
    candidates.value = []
    candidateMessage.value = ''
    return
  }
  candidateBusy.value = place.id
  candidateMessage.value = ''
  try {
    const res = await window.api.map.searchPlaceCandidates(props.bookId, place.id)
    candidatesFor.value = place.id
    if (!res.ok) {
      candidates.value = []
      candidateMessage.value = res.message || '候选搜索失败'
      return
    }
    candidates.value = res.view.candidates
    candidateMessage.value = res.view.message
      || (res.view.candidates.length ? `在 ${res.view.boundary} 内找到 ${res.view.candidates.length} 个候选` : '')
  } catch (error) {
    candidatesFor.value = place.id
    candidates.value = []
    candidateMessage.value = error instanceof Error ? error.message : '候选搜索失败'
  } finally {
    candidateBusy.value = ''
  }
}

async function chooseCandidate(place: AiPlaceGeo, candidate: AiPlaceCandidate): Promise<void> {
  if (!props.bookId) return
  candidateBusy.value = place.id
  try {
    const res = await window.api.map.choosePlaceCandidate(props.bookId, place.id, {
      latitude: candidate.latitude,
      longitude: candidate.longitude,
    })
    if (!res.ok) { candidateMessage.value = res.message || '候选写入失败'; return }
    places.value = res.places
    candidatesFor.value = ''
    candidates.value = []
    candidateMessage.value = `已选用「${candidate.title}」`
    centeredPlaceId.value = place.id
    syncMarkers()
    const api = mapApi
    const map = mapInstance
    if (api && map) {
      map.setCenter?.(new api.maps.LatLng(candidate.latitude, candidate.longitude))
      map.setZoom?.(15)
    }
  } catch (error) {
    candidateMessage.value = error instanceof Error ? error.message : '候选写入失败'
  } finally {
    candidateBusy.value = ''
  }
}

async function loadMapImage(): Promise<void> {
  if (!props.bookId) return
  try {
    const res = await window.api.map.getImage(props.bookId)
    if (res.ok) mapImageUrl.value = res.url ?? ''
    void recognizeOriginalMap()
  } catch { /* 原图缺失不挡住其它内容 */ }
}

/**
 * 原图识别（两段）：先按图片字节的 SHA-256 与精选地图精确比对（不花钱、不联网），
 * 不命中时读上次保存的模型结论；都没有就停在「未收录」，由用户点「识别地图」
 * 显式发起一次识别——打开地图页、翻页、换图都不会自动花钱。
 *
 * 生产构建是 file://，`fetch(file://)` 会被拦；主进程的 `spbf-map://m/<bookId>`
 * 从书目录读原图。图片只在字节完全一致时才算识别，不做文件名/页号猜测。
 */
async function recognizeOriginalMap(): Promise<void> {
  const token = ++recognizeToken
  atlasRecognition.value = null
  if (!props.bookId || !mapImageUrl.value) {
    atlasMatch.value = { status: 'none', map: null }
    return
  }
  atlasMatch.value = { status: 'checking', map: null }
  try {
    const response = await fetch(`spbf-map://m/${encodeURIComponent(props.bookId)}`)
    if (token !== recognizeToken) return
    if (response.ok) {
      const matched = await identifyBookMap(await response.blob())
      if (token !== recognizeToken) return
      if (matched) {
        atlasMatch.value = { status: 'matched', map: matched }
        atlasId.value = matched.id
        return
      }
    }
    // 精选清单没有命中（或本机读不到字节）：看上次有没有保存的模型结论（只读，不调用模型）。
    if (await applySavedRecognition(token)) return
    atlasMatch.value = { status: response.ok ? 'unmatched' : 'unavailable', map: null }
  } catch {
    if (token !== recognizeToken) return
    if (await applySavedRecognition(token)) return
    if (token === recognizeToken) atlasMatch.value = { status: 'unavailable', map: null }
  }
}

/** 读上次保存的识别结论；返回是否真的找到了一个可用的结论。 */
async function applySavedRecognition(token: number): Promise<boolean> {
  if (!props.bookId) return false
  try {
    const res = await window.api.map.getRecognition(props.bookId)
    if (token !== recognizeToken) return false
    if (!res.ok || !res.recognition) return false
    applyRecognition(token, res.recognition)
    return true
  } catch {
    return false
  }
}

/** 把一次识别结论映到页面状态：成功就选中它的地图，失败保留原图与说明。 */
function applyRecognition(token: number, result: AtlasRecognition | null): void {
  if (token !== recognizeToken || !result) return
  atlasRecognition.value = {
    message: result.message,
    model: result.model,
    cached: result.cached,
    unresolved: result.map?.recognition?.unresolved ?? [],
  }
  if (result.status === 'recognized' && result.map?.places.length) {
    atlasMatch.value = { status: 'matched', map: result.map }
    atlasId.value = result.map.id
    return
  }
  atlasMatch.value = { status: result.status === 'not_map' ? 'unmatched' : 'failed', map: null }
}

/**
 * 用户显式发起识别（可能产生模型账单）。refresh 为 true 时绕过缓存重新识别。
 * 只把这张原图与书名发给模型；原图换了以后旧结论由主进程按指纹作废。
 */
async function recognizeByModel(refresh = false): Promise<void> {
  if (!props.bookId || atlasRecognizing.value || !mapImageUrl.value) return
  const token = ++recognizeToken
  atlasRecognizing.value = true
  atlasMatch.value = { status: 'recognizing', map: null }
  atlasRecognition.value = null
  try {
    const res = await window.api.map.recognize(props.bookId, refresh)
    if (token !== recognizeToken) return
    if (!res.ok) {
      atlasMatch.value = { status: 'failed', map: null }
      atlasRecognition.value = { message: res.message, model: '', cached: false, unresolved: [] }
      return
    }
    applyRecognition(token, res.recognition)
  } catch (error) {
    if (token !== recognizeToken) return
    atlasMatch.value = { status: 'failed', map: null }
    atlasRecognition.value = {
      message: error instanceof Error ? error.message : '地图识别失败',
      model: '',
      cached: false,
      unresolved: [],
    }
  } finally {
    if (token === recognizeToken) atlasRecognizing.value = false
  }
}

function openAtlasPlace(id: string): void {
  const matched = atlasMatch.value.map
  if (!matched) return
  atlasId.value = matched.id
  atlasSelected.value = id
  mapMode.value = '3d'
}

function openAtlas(): void {
  const matched = atlasMatch.value.map
  if (!matched) return
  atlasId.value = matched.id
  atlasSelected.value = null
  mapMode.value = '3d'
}

/** 左侧「书中地名」里已定位的地点：切到文字地点地图并选中。 */
function openTextPlace(placeId: string): void {
  if (!textMap.value) return
  atlasId.value = textMap.value.id
  atlasSelected.value = placeId
  mapMode.value = '3d'
}

async function chooseMapImage(): Promise<void> {
  if (!props.bookId || imageBusy.value) return
  imageBusy.value = true
  imageMessage.value = ''
  try {
    const picked = await window.api.dialog.openFile()
    const sourcePath = picked.filePaths?.[0]
    if (!sourcePath) return
    const res = await window.api.map.setImage({ bookId: props.bookId, sourcePath })
    if (!res.ok) { imageMessage.value = res.message; return }
    mapImageUrl.value = res.url
    void recognizeOriginalMap()
  } catch (error) {
    imageMessage.value = error instanceof Error ? error.message : '地图图片保存失败'
  } finally {
    imageBusy.value = false
  }
}

async function loadPlaces(): Promise<void> {
  if (!props.bookId) return
  try {
    const res = await window.api.map.getPlaces(props.bookId)
    if (res.ok) {
      places.value = res.places
      syncMarkers()
    }
  } catch { /* 缓存读取失败不挡住底图 */ }
}

const notFoundCount = computed(() => places.value.filter((place) => place.geocodeStatus === 'not-found').length)

async function geocode(retryNotFound = false): Promise<void> {
  if (!props.bookId || geocoding.value || !places.value.length) return
  geocoding.value = true
  geoMessage.value = ''
  try {
    const res = await window.api.map.geocodePlaces(props.bookId, retryNotFound)
    if (!res.ok) {
      geoMessage.value = res.message || '地名定位失败'
      return
    }
    places.value = res.view.places
    geoMessage.value = res.view.message
    syncMarkers()
  } catch (error) {
    geoMessage.value = error instanceof Error ? error.message : '地名定位失败'
  } finally {
    geocoding.value = false
  }
}

onMounted(() => {
  void init()
  void loadPlaces()
  void loadMapImage()
})
onBeforeUnmount(() => {
  infoWindow?.close?.()
  infoWindow = null
  for (const marker of markers) marker.setMap?.(null)
  markers.length = 0
  mapApi = null
  mapInstance = null
})
</script>

<template>
  <section class="book-map-page" :aria-label="`书中地图${props.bookTitle ? `：${props.bookTitle}` : ''}`">
    <aside class="book-map-original" aria-label="书中原图">
      <div class="book-map-original-head">
        <h3>书中原图</h3>
        <button
          type="button"
          class="book-map-button"
          :disabled="!props.bookId || imageBusy"
          @click="chooseMapImage"
        >{{ imageBusy ? '保存中…' : mapImageUrl ? '更换图片' : '选择图片' }}</button>
      </div>
      <div v-if="mapImageUrl" class="book-map-original-frame">
        <img :src="mapImageUrl" class="book-map-original-image" alt="书中原图">
        <button
          v-for="place in atlasMatch.map?.places ?? []"
          :key="place.id"
          type="button"
          class="book-map-atlas-pin"
          :class="{ selected: atlasSelected === place.id }"
          :style="{ left: `${(place.imagePoint?.[0] ?? 0) * 100}%`, top: `${(place.imagePoint?.[1] ?? 0) * 100}%` }"
          :title="place.name"
          :aria-label="`在 3D 地图查看${place.name}`"
          @click="openAtlasPlace(place.id)"
        />
      </div>
      <p v-else class="book-map-empty">尚未选择书中地图图片。支持 jpg、png、webp，最大 8MB。</p>
      <p v-if="imageMessage" class="book-map-budget" role="status">{{ imageMessage }}</p>
      <p v-if="atlasMatch.status === 'checking'" class="book-map-budget" role="status">正在比对书中地图…</p>
      <p v-else-if="atlasMatch.status === 'recognizing'" class="book-map-budget" role="status">正在读图并匹配地名…</p>
      <p v-else-if="atlasMatch.status === 'matched' && atlasMatch.map" class="book-map-recognized" role="status">
        已识别：{{ atlasMatch.map.title }}{{ atlasMatch.map.period ? ` · ${atlasMatch.map.period}` : '' }}
        <button type="button" class="book-map-button" @click="openAtlas">在 3D 地图查看</button>
        <button
          v-if="!atlasRecognizing"
          type="button"
          class="book-map-button"
          :disabled="!props.bookId"
          @click="recognizeByModel(true)"
        >重新识别</button>
      </p>
      <p v-else-if="atlasMatch.status === 'unmatched'" class="book-map-empty" role="status">
        这张地图未收录，也未保存过识别结果。可以按原图自动识别，或继续用文字地名与 2D 底图。
        <button
          type="button"
          class="book-map-button"
          :disabled="!props.bookId || atlasRecognizing"
          @click="recognizeByModel(false)"
        >{{ atlasRecognizing ? '识别中…' : '识别地图' }}</button>
      </p>
      <p v-else-if="atlasMatch.status === 'failed'" class="book-map-empty" role="status">
        {{ atlasRecognition?.message || '这次没有识别出可用的地图。' }}
        <button
          type="button"
          class="book-map-button"
          :disabled="!props.bookId || atlasRecognizing"
          @click="recognizeByModel(true)"
        >{{ atlasRecognizing ? '识别中…' : '重新识别' }}</button>
      </p>
      <p v-else-if="atlasMatch.status === 'unavailable'" class="book-map-empty" role="status">
        暂时读不到原图字节，无法按指纹比对。主进程仍可直接读这张图来识别，或重新选择图片后再试。
        <button
          type="button"
          class="book-map-button"
          :disabled="!props.bookId || atlasRecognizing"
          @click="recognizeByModel(false)"
        >{{ atlasRecognizing ? '识别中…' : '识别地图' }}</button>
      </p>
      <p v-if="atlasRecognition && atlasMatch.status === 'matched'" class="book-map-empty" role="status">
        {{ atlasRecognition.message }}地名坐标来自 Natural Earth 城市库；区域与图中标记为 AI 估计，请对照原图核对。
      </p>
      <p v-if="atlasRecognition?.unresolved.length" class="book-map-empty" role="status">
        暂未匹配：{{ atlasRecognition.unresolved.join('、') }}。这些地名尚未标到地球上。
      </p>
      <div
        v-if="atlasMatch.status === 'matched' && atlasMatch.map?.places.length"
        class="book-map-atlas-places"
        aria-label="已识别地点"
      >
        <button
          v-for="place in atlasMatch.map.places"
          :key="`atlas-${place.id}`"
          type="button"
          class="book-map-atlas-place"
          :class="{ selected: atlasSelected === place.id }"
          @click="openAtlasPlace(place.id)"
        >{{ place.name }}</button>
      </div>

      <div class="book-map-places-head">
        <h3>书中地名</h3>
        <div class="book-map-actions">
          <button
            type="button"
            class="book-map-button"
            :disabled="!props.bookId || extracting"
            @click="extractPlaces(needsConfirm)"
          >{{ extractLabel }}</button>
          <button
            type="button"
            class="book-map-button"
            :disabled="!props.bookId || !places.length || geocoding || extracting"
            @click="geocode(false)"
          >{{ geocoding ? '定位中…' : '定位到地图' }}</button>
          <button
            v-if="notFoundCount"
            type="button"
            class="book-map-button"
            :disabled="!props.bookId || geocoding || extracting"
            @click="geocode(true)"
          >重试未找到 {{ notFoundCount }}</button>
        </div>
        <button
          type="button"
          class="book-map-button"
          :disabled="!props.bookId"
          @click="manualFormOpen = !manualFormOpen"
        >{{ manualFormOpen ? '收起手工标注' : '手工标注' }}</button>
      </div>
      <p v-if="budgetHint" class="book-map-budget" role="status">{{ budgetHint }} 再点一次按钮继续。</p>
      <p v-if="extractionMessage" class="book-map-empty" role="status">{{ extractionMessage }}</p>
      <p v-if="geoMessage" class="book-map-budget" role="status">{{ geoMessage }}</p>
      <p v-if="textMap" class="book-map-recognized" role="status">
        已定位 {{ textMap.places.length }} 个书内地名
        <button type="button" class="book-map-button" @click="atlasId = textMap.id; atlasSelected = null; mapMode = '3d'">
          查看文字地点地图
        </button>
      </p>
      <div v-if="textMap" class="book-map-atlas-places" aria-label="书内已定位地名">
        <button
          v-for="place in textMap.places"
          :key="`text-${place.id}`"
          type="button"
          class="book-map-atlas-place"
          :class="{ selected: atlasSelected === place.id }"
          @click="openTextPlace(place.id)"
        >{{ place.name }}</button>
      </div>

      <form
        v-if="manualFormOpen"
        class="book-map-manual"
        aria-label="手工标注"
        @submit.prevent="submitManualPlace"
      >
        <p class="book-map-empty">手工标注不消耗腾讯地图配额，坐标由你自己给定。</p>
        <label class="book-map-manual-field">
          <span>地名</span>
          <input v-model="manualName" type="text" placeholder="长安" autocomplete="off">
        </label>
        <label class="book-map-manual-field">
          <span>纬度</span>
          <input v-model="manualLatitude" type="number" step="any" placeholder="34.2" autocomplete="off">
        </label>
        <label class="book-map-manual-field">
          <span>经度</span>
          <input v-model="manualLongitude" type="number" step="any" placeholder="108.9" autocomplete="off">
        </label>
        <label class="book-map-manual-field">
          <span>类型</span>
          <select v-model="manualKind">
            <option value="city">城市</option>
            <option value="region">地区</option>
            <option value="landmark">地标</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label class="book-map-manual-field">
          <span>正文段号（可选）</span>
          <input v-model="manualParagraphIndex" type="number" step="1" min="0" placeholder="0" autocomplete="off">
        </label>
        <label class="book-map-manual-field">
          <span>段内偏移（可选）</span>
          <input v-model="manualParagraphOffset" type="number" step="1" min="0" placeholder="0" autocomplete="off">
        </label>
        <p class="book-map-empty">给了段号与偏移，从地图点回正文就能跳到那一处。</p>
        <button type="submit" class="book-map-button primary" :disabled="!props.bookId || manualBusy">
          {{ manualBusy ? '保存中…' : '保存标注' }}
        </button>
        <p v-if="manualMessage" class="book-map-budget" role="status">{{ manualMessage }}</p>
      </form>
      <ol v-if="places.length" class="book-map-place-list" aria-label="已读地名">
        <li v-for="place in places" :key="place.id" class="book-map-place-item">
          <div
            class="book-map-place-row"
            :class="{ active: place.id === centeredPlaceId }"
          >
          <button
            type="button"
            class="book-map-place"
            :title="place.location ? '在地图上居中这个地点' : '还没有坐标'"
            @click="centerOnPlace(place)"
          >
            <span class="book-map-place-name">{{ place.name }}</span>
            <span class="book-map-place-meta">
              {{ kindLabel(place.kind) }} ·
              <template v-if="isManualPlace(place)">
                手工标注<template v-if="hasAnchor(place)"> · 第 {{ place.paragraphIndex + 1 }} 段</template>
              </template>
              <template v-else>{{ place.chapterTitle }} · 第 {{ place.paragraphIndex + 1 }} 段</template>
              <template v-if="place.geocodeStatus === 'resolved'"> · 已定位</template>
              <template v-else-if="place.geocodeStatus === 'ambiguous'"> · 待确认（可信度 {{ place.location?.reliability ?? '—' }}/10）</template>
              <template v-else-if="place.geocodeStatus === 'not-found'"> · 未找到</template>
              <template v-else-if="place.geocodeStatus === 'ignored'"> · 已忽略</template>
            </span>
            <span class="book-map-place-excerpt">{{ place.excerpt }}</span>
          </button>
          <div class="book-map-place-actions">
            <template v-if="place.geocodeStatus === 'ambiguous'">
              <button type="button" class="book-map-place-jump" :disabled="confirmingId === place.id" @click="confirmMapPlace(place, true)">确认</button>
              <button type="button" class="book-map-place-jump" :disabled="confirmingId === place.id" @click="confirmMapPlace(place, false)">忽略</button>
            </template>
            <button
              type="button"
              class="book-map-place-jump"
              :disabled="candidateBusy === place.id"
              title="从腾讯地点搜索里选一个候选"
              @click="searchCandidates(place)"
            >候选</button>
            <button
              v-if="hasAnchor(place)"
              type="button"
              class="book-map-place-jump"
              title="跳到原文"
              @click="emit('select-place', { paragraphIndex: place.paragraphIndex, paragraphOffset: place.paragraphOffset })"
            >原文</button>
          </div>
          </div>
          <div v-if="candidatesFor === place.id" class="book-map-candidates">
            <p v-if="candidateMessage" class="book-map-budget" role="status">{{ candidateMessage }}</p>
            <button
              v-for="candidate in candidates"
              :key="candidate.id"
              type="button"
              class="book-map-candidate"
              @click="chooseCandidate(place, candidate)"
            >
              <span class="book-map-candidate-title">{{ candidate.title }}</span>
              <span class="book-map-candidate-address">{{ candidate.address }}</span>
            </button>
          </div>
        </li>
      </ol>
    </aside>

    <div v-show="mapMode === '2d'" class="book-map-panel">
      <div class="book-map-toolbar">
        <strong>{{ props.bookTitle || '书中地图' }}</strong>
        <span class="book-map-hint">地名与事件标注待地图数据提供后显示</span>
        <div class="book-map-view-controls" aria-label="地图视野">
          <button type="button" class="book-map-button" data-map-view="all" @click="fitAll">全局</button>
          <button type="button" class="book-map-button" data-map-view="region" @click="focusRegion">区域</button>
        </div>
        <button type="button" class="book-map-button" @click="mapMode = '3d'">3D 全球地形</button>
        <button v-if="stage === 'error'" type="button" class="book-map-button" @click="init">重试</button>
      </div>

      <div ref="mapEl" class="book-map-canvas" aria-label="腾讯地图底图"></div>

      <div v-if="stage === 'no-key'" class="book-map-overlay" role="status">
        <p>未配置腾讯地图 Key，无法加载底图。</p>
        <button type="button" class="book-map-button primary" @click="emit('go-settings')">去设置填写 Key</button>
      </div>
      <div v-else-if="stage === 'loading'" class="book-map-overlay" role="status">正在加载腾讯地图…</div>
      <div v-else-if="stage === 'error'" class="book-map-overlay" role="alert">
        <p>{{ errorText }}</p>
        <p class="book-map-offline">地图依赖联网，离线或网络受限时会加载失败。</p>
      </div>
    </div>

    <div v-if="mapMode === '3d'" class="book-map-panel book-map-atlas-panel">
      <div class="book-map-toolbar">
        <strong>3D 全球地形</strong>
        <label class="book-map-atlas-select">
          <span>区域</span>
          <select v-model="atlasId">
            <option v-for="item in atlasOptions" :key="item.id" :value="item.id">
              {{ item.title }}{{ item.period ? ` · ${item.period}` : '' }}
            </option>
          </select>
        </label>
        <button type="button" class="book-map-button" @click="mapMode = '2d'">返回腾讯地图</button>
      </div>
      <AtlasMap :atlas="atlasMap" :selected="atlasSelected" :focus-place="atlasFocus" @select="atlasSelected = $event" />
    </div>
  </section>
</template>

<style scoped>
.book-map-atlas-panel {
  min-height: 460px;
}
.book-map-atlas-panel :deep(.atlas-viewport) {
  min-height: 420px;
}
.book-map-atlas-select {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.book-map-page {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  gap: 14px;
  min-height: 460px;
  color: var(--text);
}

.book-map-original {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  background: var(--surface-2);
}

.book-map-original h3 {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  font-weight: 600;
}

.book-map-original-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.book-map-original-frame {
  position: relative;
  display: inline-block;
  max-width: 100%;
  align-self: center;
}
.book-map-original-image {
  display: block;
  max-width: 100%;
  max-height: 240px;
  object-fit: contain;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-2) 88%, transparent);
}
.book-map-atlas-pin {
  position: absolute;
  width: 12px;
  height: 12px;
  padding: 0;
  border: 2px solid #fcf5dc;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: #a3633f;
  box-shadow: 0 1px 4px #23392555;
  cursor: pointer;
}
.book-map-atlas-pin:hover,
.book-map-atlas-pin.selected {
  box-shadow: 0 0 0 4px #8e613d55;
}
.book-map-recognized {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  color: var(--text);
}
.book-map-atlas-places {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.book-map-atlas-place {
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.book-map-atlas-place:hover,
.book-map-atlas-place.selected {
  border-color: #a3633f;
  color: #a3633f;
}

.book-map-empty {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}

.book-map-places-head {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.book-map-places-head h3 { margin: 0; }

.book-map-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

/* 手工标注表单：默认收起，点「手工标注」才展开——左栏本来就窄。 */
.book-map-manual {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-2);
}

.book-map-manual-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.book-map-manual-field span {
  flex: 0 0 84px;
  color: var(--muted);
}

.book-map-manual-field input,
.book-map-manual-field select {
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 3px 6px;
  background: var(--surface);
  color: inherit;
  font: inherit;
  font-size: 12px;
}

.book-map-view-controls {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
}

.book-map-budget {
  margin: 0;
  color: var(--warning, #a86b00);
  font-size: 12px;
  line-height: 1.6;
}

.book-map-place-list {
  display: flex;
  max-height: 260px;
  margin: 0;
  padding: 0;
  overflow: auto;
  flex-direction: column;
  gap: 6px;
  list-style: none;
}

.book-map-place-item { list-style: none; }

.book-map-candidates {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 2px 0 6px;
}

.book-map-candidate {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 8px;
  background: var(--surface-2);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.book-map-candidate:hover { border-color: var(--focus); }
.book-map-candidate:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.book-map-candidate-title { font-size: 12px; font-weight: 600; }
.book-map-candidate-address { color: var(--muted); font-size: 11px; }

.book-map-place-row {
  display: flex;
  align-items: stretch;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: 6px;
}

.book-map-place-row.active {
  border-color: var(--focus);
  background: color-mix(in srgb, var(--focus) 10%, transparent);
}

.book-map-place {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  background: var(--surface-2);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.book-map-place:hover { border-color: var(--focus); }
.book-map-place:focus-visible, .book-map-place-jump:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.book-map-place-actions {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 3px;
}

.book-map-place-jump {
  flex: 0 0 auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0 8px;
  background: var(--surface-2);
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.book-map-place-jump:hover { border-color: var(--focus); color: var(--focus); }
.book-map-place-name { font-size: 13px; font-weight: 600; }
.book-map-place-meta { color: var(--muted); font-size: 11px; }
.book-map-place-excerpt {
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-map-panel {
  position: relative;
  display: flex;
  min-height: 420px;
  flex-direction: column;
  gap: 8px;
}

.book-map-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.book-map-hint {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.book-map-toolbar .book-map-button { margin-left: auto; }

.book-map-canvas {
  flex: 1 1 auto;
  min-height: 380px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-2) 92%, transparent);
}

.book-map-overlay {
  position: absolute;
  inset: 42px 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-2) 92%, transparent);
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}

.book-map-overlay p { margin: 0; }

.book-map-offline { font-size: 12px; }

.book-map-button {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 12px;
  background: var(--surface-2);
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.book-map-button.primary {
  border-color: var(--focus);
  color: var(--focus);
  font-weight: 600;
}

.book-map-button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

@media (max-width: 720px) {
  .book-map-page { grid-template-columns: minmax(0, 1fr); }
  .book-map-original { min-height: 120px; }
}
</style>
