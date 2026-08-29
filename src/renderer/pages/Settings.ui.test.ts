// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_PREFS, DEFAULT_APPEARANCE_PREFS, DEFAULT_READER_PREFS, DEFAULT_TTS_PREFS, type Settings } from '../../shared/types'
import SettingsPage from './Settings.vue'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  configurable: true,
})

async function flushUi(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function button(text: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')]
    .find((item) => item.textContent?.trim() === text)
  if (!match) throw new Error(`button not found: ${text}`)
  return match as HTMLButtonElement
}

describe('Settings AI custom-origin confirmation', () => {
  let unmount: (() => void) | undefined

  afterEach(() => {
    unmount?.()
    unmount = undefined
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('cancels without trust or API call, then confirms once before the first real call', async () => {
    let current: Settings = {
      libraryPath: '/tmp/library',
      baseUrl: 'https://custom.example/v1',
      model: 'custom-model',
      apiKeyConfigured: true,
      reader: DEFAULT_READER_PREFS,
      tts: DEFAULT_TTS_PREFS,
      appearance: DEFAULT_APPEARANCE_PREFS,
      // Simulate an old custom URL whose newly-added provider field defaulted to deepseek.
      ai: { ...DEFAULT_AI_PREFS, provider: 'deepseek', trustedCustomOrigins: [] },
    }
    const set = vi.fn(async (update: { ai?: Partial<NonNullable<Settings['ai']>> }) => {
      if (update.ai) current = { ...current, ai: { ...current.ai!, ...update.ai } }
      return current
    })
    const test = vi.fn(async () => ({ ok: true as const, text: 'ok' }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        settings: { get: vi.fn(async () => current), set },
        siteRules: { list: vi.fn(async () => ({ rules: [] })) },
        ai: { test },
      },
    })

    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(SettingsPage, { active: true })
    app.mount(host)
    unmount = () => app.unmount()
    await flushUi()

    expect(document.body.textContent).toContain('自定义兼容服务')
    expect(document.body.textContent).toContain('API Key 和你主动选择的正文内容将发送到此接口地址')

    button('测试连接').click()
    await flushUi()
    expect(document.body.textContent).toContain('本次请求会把 API Key 和所示正文内容发送到 https://custom.example')
    expect(test).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()

    button('取消').click()
    await flushUi()
    expect(test).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()

    button('测试连接').click()
    await flushUi()
    button('信任并继续').click()
    await flushUi()

    expect(set).toHaveBeenCalledWith({ ai: { trustedCustomOrigins: ['https://custom.example'] } })
    expect(test).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://custom.example/v1',
      model: 'custom-model',
      provider: 'custom',
    }))
  })
})
