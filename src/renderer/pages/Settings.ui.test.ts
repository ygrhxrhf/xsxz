// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
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

function settingsHarness(active = ref(true)) {
  return defineComponent({
    setup: () => () => h(NMessageProvider, null, {
      default: () => h(SettingsPage, { active: active.value }),
    }),
  })
}

function textarea(): HTMLTextAreaElement {
  const match = document.querySelector('textarea')
  if (!match) throw new Error('textarea not found')
  return match
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

  it('copies a built-in prompt for editing and persists only the editable task requirement', async () => {
    let current: Settings = {
      libraryPath: '/tmp/library',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      apiKeyConfigured: true,
      reader: DEFAULT_READER_PREFS,
      tts: DEFAULT_TTS_PREFS,
      appearance: DEFAULT_APPEARANCE_PREFS,
      ai: { ...DEFAULT_AI_PREFS },
      downloadPace: 'standard',
    }
    const set = vi.fn(async (update: { ai?: Partial<NonNullable<Settings['ai']>> }) => {
      if (update.ai) current = { ...current, ai: { ...current.ai!, ...update.ai } }
      return current
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        settings: { get: vi.fn(async () => current), set },
        siteRules: { list: vi.fn(async () => ({ rules: [] })) },
        ai: { test: vi.fn() },
      },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(settingsHarness())
    app.mount(host)
    unmount = () => app.unmount()
    await flushUi()

    expect(document.body.textContent).toContain('防剧透、已读范围、来源坐标和结构化输出规则由应用固定维护')
    expect(textarea().readOnly).toBe(true)
    button('复制为自定义').click()
    await flushUi()
    expect(textarea().readOnly).toBe(false)
    textarea().value = '保留段落，并删除站点广告。'
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    button('保存提示词').click()
    await flushUi()

    expect(set).toHaveBeenCalledWith({
      ai: expect.objectContaining({
        promptMode: expect.objectContaining({ clean: 'custom' }),
        customPrompts: expect.objectContaining({ clean: '保留段落，并删除站点广告。' }),
      }),
    })
  })

  it('restores immediately and supports one in-memory undo for the same prompt', async () => {
    const original = '仅删除广告，保留分隔线。'
    let current: Settings = {
      libraryPath: '/tmp/library',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      apiKeyConfigured: true,
      reader: DEFAULT_READER_PREFS,
      tts: DEFAULT_TTS_PREFS,
      appearance: DEFAULT_APPEARANCE_PREFS,
      ai: {
        ...DEFAULT_AI_PREFS,
        promptMode: { ...DEFAULT_AI_PREFS.promptMode, clean: 'custom' },
        customPrompts: { clean: original },
      },
      downloadPace: 'standard',
    }
    const set = vi.fn(async (update: { ai?: Partial<NonNullable<Settings['ai']>> }) => {
      if (update.ai) {
        const promptMode = { ...current.ai!.promptMode, ...update.ai.promptMode }
        const customPrompts = { ...current.ai!.customPrompts, ...update.ai.customPrompts }
        for (const [kind, value] of Object.entries(customPrompts)) {
          if (typeof value !== 'string' || !value.trim()) delete customPrompts[kind as keyof typeof customPrompts]
        }
        if (!customPrompts.clean && promptMode.clean === 'custom') promptMode.clean = 'builtin'
        current = { ...current, ai: { ...current.ai!, ...update.ai, promptMode, customPrompts } }
      }
      return current
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        settings: { get: vi.fn(async () => current), set },
        siteRules: { list: vi.fn(async () => ({ rules: [] })) },
        ai: { test: vi.fn() },
      },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const active = ref(true)
    const app = createApp(settingsHarness(active))
    app.mount(host)
    unmount = () => app.unmount()
    await flushUi()

    expect(textarea().value).toBe(original)
    button('恢复默认').click()
    await flushUi()
    expect(document.body.textContent).toContain('已恢复默认提示词')
    expect(set).toHaveBeenLastCalledWith({
      ai: expect.objectContaining({
        promptMode: expect.objectContaining({ clean: 'builtin' }),
        customPrompts: expect.objectContaining({ clean: '' }),
      }),
    })
    expect(button('撤销')).toBeTruthy()

    button('撤销').click()
    await flushUi()
    expect(textarea().value).toBe(original)
    expect(set).toHaveBeenLastCalledWith({
      ai: expect.objectContaining({
        promptMode: expect.objectContaining({ clean: 'custom' }),
        customPrompts: expect.objectContaining({ clean: original }),
      }),
    })
    expect([...document.querySelectorAll('button')].some((item) => item.textContent?.trim() === '撤销')).toBe(false)

    button('恢复默认').click()
    await flushUi()
    expect(button('撤销')).toBeTruthy()
    active.value = false
    await flushUi()
    expect([...document.querySelectorAll('button')].some((item) => item.textContent?.trim() === '撤销')).toBe(false)
  })

  it('migrates a legacy DeepSeek model only after the user clicks the explicit action', async () => {
    let current: Settings = {
      libraryPath: '/tmp/library',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKeyConfigured: true,
      reader: DEFAULT_READER_PREFS,
      tts: DEFAULT_TTS_PREFS,
      appearance: DEFAULT_APPEARANCE_PREFS,
      ai: { ...DEFAULT_AI_PREFS },
      downloadPace: 'standard',
    }
    const set = vi.fn(async (update: Record<string, unknown>) => {
      current = {
        ...current,
        ...(typeof update.baseUrl === 'string' ? { baseUrl: update.baseUrl } : {}),
        ...(typeof update.model === 'string' ? { model: update.model } : {}),
      }
      return current
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        settings: { get: vi.fn(async () => current), set },
        siteRules: { list: vi.fn(async () => ({ rules: [] })) },
        ai: { test: vi.fn() },
      },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(settingsHarness())
    app.mount(host)
    unmount = () => app.unmount()
    await flushUi()

    expect(document.body.textContent).toContain('当前模型名 deepseek-chat 可能已停用')
    expect(set).not.toHaveBeenCalled()
    button('改用 deepseek-v4-flash').click()
    await flushUi()

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      ai: expect.objectContaining({ provider: 'deepseek' }),
    }))
    expect(document.body.textContent).toContain('模型已改为 deepseek-v4-flash')
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
      downloadPace: 'standard',
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
    const app = createApp(settingsHarness())
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

describe('Settings section content visibility', () => {
  let unmount: (() => void) | undefined

  afterEach(() => {
    unmount?.()
    unmount = undefined
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('keeps all established operations reachable in their fixed sections', async () => {
    const current: Settings = {
      libraryPath: '/tmp/library',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      apiKeyConfigured: true,
      reader: DEFAULT_READER_PREFS,
      tts: DEFAULT_TTS_PREFS,
      appearance: DEFAULT_APPEARANCE_PREFS,
      ai: { ...DEFAULT_AI_PREFS },
      downloadPace: 'standard',
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        settings: { get: vi.fn(async () => current), set: vi.fn(async () => current) },
        siteRules: { list: vi.fn(async () => ({ rules: [] })) },
        ai: { test: vi.fn() },
      },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(settingsHarness())
    app.mount(host)
    unmount = () => app.unmount()
    await flushUi()

    const navLabels = [...document.querySelectorAll('.settings-nav-item')].map((item) => item.textContent?.trim())
    expect(navLabels).toEqual(['外观', '书库', 'AI', '站点规则', '备份与恢复', '关于'])
    const visibleCard = (text: string) => {
      const card = [...document.querySelectorAll('.settings-card')]
        .find((item) => item.textContent?.includes(text)) as HTMLElement | undefined
      expect(card).toBeTruthy()
      expect(getComputedStyle(card!).display).not.toBe('none')
      return card!
    }
    const select = async (label: string) => {
      const nav = [...document.querySelectorAll('.settings-nav-item')]
        .find((item) => item.textContent?.trim() === label) as HTMLButtonElement
      nav.click()
      await flushUi()
      return nav
    }
    expect(visibleCard('阅读偏好').textContent).toContain('字体、行距、主题和列宽请在阅读器的“外观”面板中调整。')
    expect((await select('书库')).getAttribute('aria-current')).toBe('page')
    expect(visibleCard('书库路径').textContent).toContain('保存路径')
    await select('AI')
    expect(visibleCard('AI 配置').textContent).toContain('测试连接')
    expect(visibleCard('AI 配置').textContent).toContain('AI 提示词')
    await select('站点规则')
    expect(visibleCard('站点规则').textContent).toContain('书名选择器')
    expect(visibleCard('站点规则').textContent).toContain('还没有站点规则')
    await select('备份与恢复')
    expect(visibleCard('备份与恢复').textContent).toContain('备份书库…')
    expect(visibleCard('备份与恢复').textContent).toContain('从备份恢复…')
    await select('关于')
    expect(visibleCard('技术栈：Electron + Vue 3 + Naive UI').textContent).toContain('技术栈：Electron + Vue 3 + Naive UI')
  })
})
