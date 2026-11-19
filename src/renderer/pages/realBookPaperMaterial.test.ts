import { describe, expect, it } from 'vitest'
import { SH_COLS, SH_ROWS, SH_SLOTS, shadowRig } from './realBookPaperMaterial'

describe('页间软影截面', () => {
  it('浮点纹理按「槽位 × 截面」留足行数', () => {
    const texture = shadowRig.uShTex.value
    expect(texture).not.toBeNull()
    expect(texture!.image.width).toBe(SH_COLS)
    expect(texture!.image.height).toBe(SH_SLOTS * SH_ROWS)
    expect((texture!.image.data as Float32Array).length).toBe(SH_COLS * SH_SLOTS * SH_ROWS * 4)
  })

  it('每张纸发布五条截面，覆盖页脚到页眉', () => {
    expect(SH_ROWS).toBe(5)
    expect(SH_SLOTS).toBe(2)
  })
})