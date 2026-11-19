/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/atlas/mapStyle.ts，Apache-2.0。已修改：类型改从 ./types 取、去掉 .ts 扩展名、接入 spbf。
 * 许可文本见 third_party/infinite-reader/LICENSE，地图数据署名见 src/renderer/public/atlas/README.md。
 */
import type { StyleSpecification } from 'maplibre-gl'
import { WATER_COLOR, WATER_FALLBACK_OPACITY, hydrologyLayers, hydrologySources } from './hydrology'
import { TERRAIN_DETAIL_ZOOM } from './terrainView'

const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const TERRAIN_CREDIT = '<a href="https://www.mapzen.com/rights/" target="_blank" rel="noopener noreferrer">Mapzen terrain</a>'
const EARTH_CREDIT = '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a>'
const WATER = WATER_COLOR

export function atlasStyle(origin: string, locale = 'zh-CN'): StyleSpecification {
  return {
    version: 8, state: { waterDetailReady: { default: false } }, projection: { type: 'globe' },
    sky: { 'sky-color': '#dce7e5', 'horizon-color': '#edf0e4', 'fog-color': '#eef0e5', 'atmosphere-blend': 0.65 },
    sources: {
      ...hydrologySources(origin),
      relief: { type: 'raster', tiles: [`${origin}/atlas/relief/{z}/{x}/{y}.webp`], tileSize: 256, minzoom: 0, maxzoom: 3, attribution: `${EARTH_CREDIT} · ${TERRAIN_CREDIT}` },
      elevation: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: TERRAIN_DETAIL_ZOOM, encoding: 'terrarium', attribution: TERRAIN_CREDIT },
      shading: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: TERRAIN_DETAIL_ZOOM, encoding: 'terrarium', attribution: TERRAIN_CREDIT },
      terrain: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: TERRAIN_DETAIL_ZOOM, encoding: 'terrarium', attribution: TERRAIN_CREDIT },
      water: { type: 'geojson', data: `${origin}/atlas/water.json`, maxzoom: 10, tolerance: 0.5, attribution: EARTH_CREDIT },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': WATER } },
      // Keep the bundled relief beneath live detail so failed DEM tiles still have a base map.
      { id: 'relief', type: 'raster', source: 'relief', paint: { 'raster-fade-duration': 0, 'raster-opacity': 1, 'raster-saturation': -0.12 } },
      { id: 'elevation-color', type: 'color-relief', source: 'elevation', paint: {
        // One elevation palette at every scale. Zoom adds DEM detail, not a different base map.
        'color-relief-opacity': 1,
        // Elevation is not snow cover: keep ordinary mountain heights in earthy midtones.
        // Negative land elevation is not ocean; the independent water mask owns coastlines.
        'color-relief-color': ['interpolate', ['linear'], ['elevation'],
          -11000, '#91aa7e', 0, '#91aa7e', 300, '#acb985', 900, '#c4b786',
          1800, '#bd9c6b', 2800, '#b0926b', 4000, '#b59e7d', 5500, '#c0ae90',
          7000, '#d1c4aa', 9000, '#dfd8c6'],
      } },
      { id: 'hillshade', type: 'hillshade', source: 'shading', paint: {
        // Shadow-only relief preserves the land color instead of bleaching sun-facing slopes.
        'hillshade-method': 'igor', 'hillshade-exaggeration': 0.8,
        'hillshade-illumination-anchor': 'map', 'hillshade-illumination-direction': 315,
        'hillshade-shadow-color': 'rgba(38, 48, 39, 0.8)', 'hillshade-highlight-color': 'transparent',
      } },
      // An independent vector mask prevents coastal DEM zeros/noise from becoming false land.
      // Draw above hillshade as well, keeping the water calm at every zoom and terrain pitch.
      { id: 'water', type: 'fill', source: 'water', paint: { 'fill-color': WATER, 'fill-opacity': WATER_FALLBACK_OPACITY, 'fill-antialias': true } },
      ...hydrologyLayers(locale === 'zh-CN'),
    ],
  }
}
