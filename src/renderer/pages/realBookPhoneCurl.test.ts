import { describe, expect, it } from 'vitest'
import { curlPoint, phoneCurl, phoneTurnCommits } from './realBookPhoneCurl'

/**
 * 窄屏卷页的纯函数测试。
 *
 * 钉住三条形状规则：没有手指位置时折线横过页心；手指在页的上/下部起拖时折线倾斜；
 * 卷到的部分抬离纸面、没卷到的部分保持平坦。
 */
const WIDTH = 360
const HEIGHT = 640

describe('手机卷页', () => {
  it('手指位置缺省（页心）时折线水平', () => {
    const fold = phoneCurl(WIDTH, HEIGHT, 0.5, 0.5, 0.5)
    expect(fold.nx).toBeCloseTo(1, 6)
    expect(fold.ny).toBeCloseTo(0, 6)
    expect(fold.crease).toBeCloseTo(WIDTH - (Math.PI * fold.radius) / 2 - WIDTH / 2, 5)
  })

  it('在页面上部起拖时折线向下倾斜，下部起拖时向上倾斜', () => {
    const upper = phoneCurl(WIDTH, HEIGHT, 0.5, 0.2, 0.2)
    const lower = phoneCurl(WIDTH, HEIGHT, 0.5, 0.8, 0.8)
    expect(upper.ny).toBeLessThan(0)
    expect(lower.ny).toBeGreaterThan(0)
    expect(Math.abs(upper.ny - lower.ny)).toBeGreaterThan(0.1)
  })

  it('拖动中手指沿页高移动会继续改变折线角度', () => {
    const held = phoneCurl(WIDTH, HEIGHT, 0.5, 0.2, 0.2)
    const moved = phoneCurl(WIDTH, HEIGHT, 0.5, 0.2, 0.8)
    expect(moved.ny).toBeGreaterThan(held.ny)
  })

  it('倾斜幅度有上限，不会把折线拧成竖直', () => {
    for (const grab of [0, 0.5, 1]) {
      const fold = phoneCurl(WIDTH, HEIGHT, 0.5, grab, 1 - grab)
      expect(Math.abs(fold.ny)).toBeLessThanOrEqual(0.25)
    }
  })

  it('卷过折线的部分抬离纸面，未卷到的部分保持平坦', () => {
    const fold = phoneCurl(WIDTH, HEIGHT, 0.65, 0.5, 0.5)
    const flat = curlPoint(0, 0, fold)
    const curled = curlPoint(WIDTH, 0, fold)
    expect(flat.z).toBe(0)
    expect(flat.x).toBe(0)
    expect(curled.z).toBeGreaterThan(0)
    expect(curled.x).toBeLessThan(WIDTH)
  })
})

describe('拖动落定阈值', () => {
  it('拖得够远或甩得够快才落定，明确回甩总是取消', () => {
    expect(phoneTurnCommits(0.3, 0)).toBe(true)
    expect(phoneTurnCommits(0.1, 0.6)).toBe(true)
    expect(phoneTurnCommits(0.1, 0)).toBe(false)
    expect(phoneTurnCommits(0.9, -0.5)).toBe(false)
  })
})