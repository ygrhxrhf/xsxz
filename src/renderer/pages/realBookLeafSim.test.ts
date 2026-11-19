/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/leafSim.test.ts，Apache-2.0。已修改：改用 vitest 的 test。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { LeafSim, type SimEnv } from './realBookLeafSim'

const W = 6.4
const H = 9.2
const dt = 1 / 240

function heldLeaf(side: 1 | -1, height: number, grab: number) {
  const sim = new LeafSim(W, H)
  const env: SimEnv = {
    gravity: 85,
    rootZ: 0,
    surface: (x) => 0.11 + height - 0.62 * Math.max(0, height - 0.01) * Math.exp(-Math.abs(x) / 0.95),
  }
  sim.rest(side, env, 0.006)
  env.rootZ = sim.z[0]
  sim.pin = {
    u: 0.96, v: grab, sigma: 0.62, x: 0, z: 0, strength: 0.8,
    shape: { phi: side === 1 ? 0 : Math.PI, fromSide: side, flex: 0 },
  }
  return { sim, env }
}

test('a stationary grab keeps the curved resting surface instead of expanding its width', () => {
  for (const side of [1, -1] as const) for (const height of [0.02, 0.14, 0.425, 1.15]) {
    for (const grab of [0.08, 0.5, 0.92]) {
      const { sim, env } = heldLeaf(side, height, grab)
      const x = sim.x.slice(), z = sim.z.slice()
      for (let frame = 0; frame < 240; frame++) {
        sim.step(dt, env, env.rootZ)
        for (let k = 0; k < x.length; k++) {
          // Well below one screen pixel, including a full second of holding still.
          assert.ok(Math.abs(sim.x[k]! - x[k]!) < 0.0005, `horizontal jump: ${side}, ${height}, ${grab}, ${frame}, ${k}`)
          assert.ok(Math.abs(sim.z[k]! - z[k]!) < 0.0005, `vertical jump: ${side}, ${height}, ${grab}, ${frame}, ${k}`)
        }
      }
    }
  }
})

test('lift-off is continuous and mirrors between left and right pages', () => {
  const right = heldLeaf(1, 1.15, 0.08)
  const left = heldLeaf(-1, 1.15, 0.08)
  const initial = right.sim.x.slice()
  for (const q of [0, 0.00001, 0.0001, 0.001, 0.05, 0.2, 0.35, 0.6, Math.PI / 2]) {
    right.sim.pin!.shape!.phi = q
    left.sim.pin!.shape!.phi = Math.PI - q
    for (let frame = 0; frame < 12; frame++) {
      right.sim.step(dt, right.env, right.env.rootZ)
      left.sim.step(dt, left.env, left.env.rootZ)
    }
    for (let k = 0; k < initial.length; k++) {
      assert.ok(Math.abs(right.sim.x[k]! + left.sim.x[k]!) < 0.00001, `asymmetric x at ${q}, ${k}`)
      assert.ok(Math.abs(right.sim.z[k]! - left.sim.z[k]!) < 0.00001, `asymmetric z at ${q}, ${k}`)
      if (q <= 0.001) assert.ok(Math.abs(right.sim.x[k]! - initial[k]!) < 0.002, `lift-off jump at ${q}, ${k}`)
    }
  }
})