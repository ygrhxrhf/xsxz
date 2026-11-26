import { describe, expect, it } from 'vitest'
import { locateCity } from './atlasCities'

/**
 * 用真实的 `resources/atlas-cities.json` 而不是注入的假数据：这条测试保证
 * 打包资源存在、能被解析成 `[id, name, iso_a2, lng, lat, aliases]`，并且
 * 「国家 + 地名」唯一匹配真的能落出坐标。数据丢了或格式变了会立刻红。
 */
describe('Natural Earth 城座标库（真实资源）', () => {
  it('能在西欧图幅内定位伦敦，坐标来自数据文件', async () => {
    const city = await locateCity('London', 'GB', [[-12, 35], [16, 64]])
    expect(city).not.toBeNull()
    expect(city![0]).toMatch(/^\d+$/)
    expect(city![3]).toBeCloseTo(-0.118668, 4)
    expect(city![4]).toBeCloseTo(51.501941, 4)
  })

  it('国家不符与区域外的地点都不落点', async () => {
    expect(await locateCity('London', 'FR', [[-12, 35], [16, 64]])).toBeNull()
    expect(await locateCity('Tokyo', 'JP', [[-12, 35], [16, 64]])).toBeNull()
    expect(await locateCity('这个地方不存在', 'GB', null)).toBeNull()
  })

  it('跨日期变更线的图幅能把东经城市落进来', async () => {
    const city = await locateCity('Tokyo', 'JP', [[120, -50], [250, 65]])
    expect(city).not.toBeNull()
    expect(city![3]).toBeGreaterThan(100)
  })
})