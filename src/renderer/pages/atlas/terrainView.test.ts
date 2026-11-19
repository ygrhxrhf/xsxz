/**
 * 源自 Infinite Reader 的 web/src/atlas/terrainView.test.ts，Apache-2.0。
 * 已修改：改用 vitest 的 test，去掉 .ts 扩展名。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { findTerrainFocus } from './terrainView'

test('ocean-centered regional maps focus on actual nearby mountain relief', () => {
  const point = findTerrainFocus([[-15, 30], [20, 60]], ([x, y]) => {
    if (x < -5) return -4000
    return 4200 * Math.exp(-((x - 7) ** 2 + (y - 46) ** 2) / 2)
  }, [-10, 45])
  assert.ok(Math.hypot(point[0] - 7, point[1] - 46) < 1, `expected mountain focus, got ${point}`)
})

test('flat or unavailable elevations keep the geographic fallback without inventing relief', () => {
  for (const value of [null, 0, 20, -4000, NaN]) {
    assert.deepEqual(findTerrainFocus([[-10, 40], [15, 55]], () => value, [2, 49]), [2, 49])
  }
})

test('terrain search respects map bounds and crosses the date line locally', () => {
  const point = findTerrainFocus([[170, -20], [-170, 0]], ([x, y]) => {
    assert.ok((x >= 170 || x <= -170) && y >= -20 && y <= 0)
    const dx = ((x + 179 + 180) % 360 + 360) % 360 - 180
    return 2500 * Math.exp(-(dx ** 2 + (y + 10) ** 2))
  }, [178, -12])
  assert.ok(Math.abs(point[0] + 179) < 1 && Math.abs(point[1] + 10) < 1)
})

test('regional refinement uses local DEMs without jumping to a distant taller mountain', () => {
  const point = findTerrainFocus([[-12, 35.5], [16, 64]], ([x, y]) => {
    return 3000 * Math.exp(-((x - 1) ** 2 + (y - 42.5) ** 2) * 6) + 4500 * Math.exp(-((x - 7) ** 2 + (y - 46) ** 2) * 6)
  }, [1, 43], [1, 43])
  assert.ok(Math.hypot(point[0] - 1, point[1] - 42.5) < 0.3, `expected local ridge, got ${point}`)
})
