/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/atlas/hydrology.ts，Apache-2.0。已修改：类型改从 ./types 取、去掉 .ts 扩展名、接入 spbf。
 * 许可文本见 third_party/infinite-reader/LICENSE，地图数据署名见 src/renderer/public/atlas/README.md。
 */
import type { ErrorEvent as MapErrorEvent, ExpressionSpecification, LayerSpecification, Map as GlobeMap, SourceSpecification } from 'maplibre-gl'

export const WATER_COLOR = '#a9c4cc'
const WATER_DETAIL_ZOOM = 8
export const WATER_DETAIL_SOURCE = 'hydro-detail'
const RIVER_COLOR = '#568b9d'
const DETAIL_VISIBLE: ExpressionSpecification = ['case', ['boolean', ['global-state', 'waterDetailReady'], false], 1, 0]
// The bundled coast/lakes and rivers remain usable while detail loads or fails.
export const WATER_FALLBACK_OPACITY: ExpressionSpecification = ['step', ['zoom'], 1, WATER_DETAIL_ZOOM,
  ['case', ['boolean', ['global-state', 'waterDetailReady'], false], 0, 1]]

export function hydrologySources(origin: string): Record<string, SourceSpecification> {
  return {
    rivers: { type: 'geojson', data: `${origin}/atlas/rivers.json`, maxzoom: 10, tolerance: 0.3,
      attribution: '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a>' },
    [WATER_DETAIL_SOURCE]: { type: 'vector', url: 'https://tiles.openfreemap.org/planet',
      attribution: '<a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · <a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>' },
  }
}

export function waterName(chinese: boolean, detailed: boolean): ExpressionSpecification {
  const keys = detailed
    ? chinese ? ['name:zh-Hans', 'name:zh', 'name', 'name:en', 'name_en'] : ['name:en', 'name_en', 'name', 'name:zh']
    : chinese ? ['name_zh', 'name', 'name_en'] : ['name_en', 'name', 'name_zh']
  // Empty provider strings should not prevent a useful fallback name.
  return keys.reduceRight<ExpressionSpecification>((fallback, key) =>
    ['case', ['all', ['has', key], ['!=', ['get', key], ''], ['!=', ['get', key], null]],
      ['to-string', ['get', key]], fallback], ['literal', ''])
}

export function hydrologyLayers(chinese: boolean): LayerSpecification[] {
  const label = (detailed: boolean) => ({
    'text-field': waterName(chinese, detailed), 'text-font': ['sans-serif'],
    'text-size': 12, 'text-padding': 6, 'text-allow-overlap': false,
    'text-pitch-alignment': 'viewport' as const,
  })
  const labelPaint = { 'text-color': '#315e70', 'text-halo-color': '#eef0df', 'text-halo-width': 1.4 }
  const detail = { source: WATER_DETAIL_SOURCE, minzoom: WATER_DETAIL_ZOOM }
  const visibleWaterway: ExpressionSpecification = ['!=', ['get', 'brunnel'], 'tunnel']
  return [
    { id: 'rivers', type: 'line', source: 'rivers', minzoom: 2,
      filter: ['<=', ['get', 'min_zoom'], ['zoom']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': RIVER_COLOR, 'line-opacity': WATER_FALLBACK_OPACITY,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.55, 6, 1.2, 10, 2, 14, 2.5] } },
    { id: 'river-labels', type: 'symbol', source: 'rivers', minzoom: 3,
      filter: ['<=', ['get', 'min_label'], ['zoom']],
      layout: { ...label(false), 'symbol-placement': 'line', 'symbol-spacing': 350 },
      paint: { ...labelPaint, 'text-opacity': WATER_FALLBACK_OPACITY } },
    { id: 'water-detail', type: 'fill', ...detail, 'source-layer': 'water',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      paint: { 'fill-color': WATER_COLOR, 'fill-opacity': DETAIL_VISIBLE, 'fill-antialias': true } },
    { id: 'waterway-detail', type: 'line', ...detail, 'source-layer': 'waterway',
      filter: ['all', visibleWaterway, ['!=', ['get', 'intermittent'], 1]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': RIVER_COLOR, 'line-opacity': DETAIL_VISIBLE,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 11, 1.6, 14,
          ['match', ['get', 'class'], 'river', 3, 'canal', 2, 1.1]] } },
    { id: 'waterway-seasonal', type: 'line', ...detail, 'source-layer': 'waterway',
      filter: ['all', visibleWaterway, ['==', ['get', 'intermittent'], 1]],
      paint: { 'line-color': RIVER_COLOR, 'line-opacity': DETAIL_VISIBLE, 'line-width': 1.1, 'line-dasharray': [3, 2] } },
    { id: 'waterway-labels', type: 'symbol', ...detail, minzoom: 9, 'source-layer': 'waterway',
      filter: visibleWaterway,
      layout: { ...label(true), 'symbol-placement': 'line', 'symbol-spacing': 350 },
      paint: { ...labelPaint, 'text-opacity': DETAIL_VISIBLE } },
    { id: 'lake-labels', type: 'symbol', ...detail, minzoom: 9, 'source-layer': 'water_name',
      filter: ['all', ['==', ['geometry-type'], 'Point'], ['in', ['get', 'class'], ['literal', ['lake', 'river']]]],
      layout: { ...label(true), 'text-max-width': 8 },
      paint: { ...labelPaint, 'text-opacity': DETAIL_VISIBLE } },
  ]
}

/** One failed detail tile restores the complete bundled water mask for this map session. */
export function watchWaterDetail(map: GlobeMap, onUnavailable: (unavailable: boolean) => void): () => void {
  onUnavailable(false)
  let failed = false, ready = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => { clearTimeout(timer); timer = undefined }
  const check = () => {
    if (!map.getSource(WATER_DETAIL_SOURCE)) return
    if (failed || map.getZoom() < WATER_DETAIL_ZOOM) { clear(); return }
    if (map.isSourceLoaded(WATER_DETAIL_SOURCE)) {
      clear()
      if (!ready) { ready = true; map.setGlobalStateProperty('waterDetailReady', true) }
      onUnavailable(false)
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined; ready = false
        map.setGlobalStateProperty('waterDetailReady', false)
        onUnavailable(true)
      }, 15000)
    }
  }
  const data = (event: { sourceId?: string }) => { if (event.sourceId === WATER_DETAIL_SOURCE) check() }
  const error = (event: MapErrorEvent) => {
    if (!('sourceId' in event) || event.sourceId !== WATER_DETAIL_SOURCE) return
    failed = true; clear()
    map.setGlobalStateProperty('waterDetailReady', false)
    onUnavailable(true)
  }
  map.on('sourcedata', data); map.on('error', error); map.on('zoomend', check)
  check()
  return () => { clear(); map.off('sourcedata', data); map.off('error', error); map.off('zoomend', check) }
}
