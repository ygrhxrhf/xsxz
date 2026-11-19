/**
 * 源自 Infinite Reader 的 web/src/atlas/catalog.test.ts，Apache-2.0。
 * 已修改：改用 vitest 的 test，去掉 .ts 扩展名。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { BOOK_MAPS, identifyBookMap, mapForDigest } from './catalog'
import type { BookMap } from './types'

test('exact bytes match an injected map catalog, wrong bytes do not', async () => {
  const bytes = new TextEncoder().encode('spbf atlas test image')
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  const fake: BookMap = {
    id: 'test-map',
    title: '测试地图',
    period: '',
    number: '',
    bounds: [[0, 0], [1, 1]],
    center: [0.5, 0.5],
    image: { sha256, bytes: bytes.length },
    places: [],
  }
  assert.equal(await identifyBookMap(new Blob([bytes]), [fake]), fake)
  assert.equal(await identifyBookMap(new Blob([new Uint8Array(bytes.length)]), [fake]), null)
})

test('only reviewed image fingerprints resolve to geographic data', () => {
  assert.equal(mapForDigest('92e47a663e34d2b18cd305f5819788b68a0a57b31dd57f94b6d4144869d00305')?.title, '西欧')
  assert.equal(mapForDigest('72d17d479651b1fec2f492e323e3df68660044565f1d9cc35e72050f5633ce51')?.title, '巴尔干地区')
  assert.equal(mapForDigest('images/00006.jpeg'), null)
  assert.equal(mapForDigest('0'.repeat(64)), null)
})

test('unrelated images cannot match by byte count or filename', async () => {
  for (const map of BOOK_MAPS) {
    const unrelated = new File([new Uint8Array(map.image.bytes)], '00006.jpeg', { type: 'image/jpeg' })
    assert.equal(await identifyBookMap(unrelated), null)
  }
  assert.equal(await identifyBookMap(new Blob(['地图 西欧 1940'])), null)
})

test('curated cities and original-image anchors stay inside the corresponding map', () => {
  const imageIds = new Set<string>()
  for (const map of BOOK_MAPS) {
    assert.ok(!imageIds.has(map.image.sha256))
    imageIds.add(map.image.sha256)
    const [[west, south], [east, north]] = map.bounds
    const places = new Set<string>()
    for (const place of map.places) {
      assert.ok(!places.has(place.id))
      places.add(place.id)
      const [lng, lat] = place.coordinates
      assert.ok(lng >= west && lng <= east && lat >= south && lat <= north, `${place.name} is outside ${map.title}`)
      assert.ok(place.imagePoint && place.imagePoint.every((v) => v >= 0 && v <= 1), `${place.name} is outside the original image`)
    }
  }
})
