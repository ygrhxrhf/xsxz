import { normalizeAtlasVisionPrefs } from './settings'
import { DEFAULT_ATLAS_VISION_PREFS } from '../shared/types'
import { describe, expect, it } from 'vitest'

/**
 * 书中地图识别服务的设置归一：本机 magpie 是默认值，显式空串才是「回退聊天 AI」，
 * 非法地址也按回退处理，合法地址去掉尾部斜杠。
 */
describe('normalizeAtlasVisionPrefs', () => {
  it('从没写过这项配置时用本机 magpie', () => {
    expect(normalizeAtlasVisionPrefs(undefined)).toEqual(DEFAULT_ATLAS_VISION_PREFS)
    expect(normalizeAtlasVisionPrefs({})).toEqual(DEFAULT_ATLAS_VISION_PREFS)
    expect(DEFAULT_ATLAS_VISION_PREFS.baseUrl).toBe('http://127.0.0.1:3425/v1')
    expect(DEFAULT_ATLAS_VISION_PREFS.model).toBe('auto/glm-5.3-flash')
  })

  it('显式空串与非法地址都表示回退聊天 AI', () => {
    expect(normalizeAtlasVisionPrefs({ baseUrl: '' }).baseUrl).toBe('')
    expect(normalizeAtlasVisionPrefs({ baseUrl: 'not-a-url' }).baseUrl).toBe('')
    expect(normalizeAtlasVisionPrefs({ baseUrl: 'ftp://x.test/v1' }).baseUrl).toBe('')
    expect(normalizeAtlasVisionPrefs({ baseUrl: 'http://user:pw@x.test/v1' }).baseUrl).toBe('')
  })

  it('合法地址去掉尾部斜杠，模型名截到 100 字，空模型名回退默认', () => {
    const prefs = normalizeAtlasVisionPrefs({
      baseUrl: 'http://192.168.1.9:8080/v1///',
      model: 'x'.repeat(400),
    })
    expect(prefs.baseUrl).toBe('http://192.168.1.9:8080/v1')
    expect(prefs.model).toHaveLength(100)
    expect(normalizeAtlasVisionPrefs({ baseUrl: 'http://a.test/v1', model: '  ' }).model)
      .toBe(DEFAULT_ATLAS_VISION_PREFS.model)
  })
})