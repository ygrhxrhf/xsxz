// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import type { RuleMarketEntry, RuleMarketListing } from '@shared/types'
import RuleMarketPanel from './RuleMarketPanel.vue'

/**
 * 规则市场面板只做三件事：列出条目、应用到本机、订阅/取消订阅清单地址。
 * 这里钉住「来源标签」「应用后的反馈」「订阅地址的增删」，
 * 真正的拉取与写盘由 `src/main/ruleMarket.test.ts` 覆盖。
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function entry(id: string, host: string, title: string): RuleMarketEntry {
  return {
    id,
    host,
    title,
    rule: { host },
    note: '',
    updatedAt: '',
    uses: 0,
  }
}

const LISTING: RuleMarketListing = {
  entries: [entry('a.test', 'a.test', '甲站'), entry('b.test', 'b.test', '乙站')],
  sources: { 'a.test': 'builtin', 'b.test': 'remote' },
}

interface ApiOverrides {
  list?: ReturnType<typeof vi.fn>
  apply?: ReturnType<typeof vi.fn>
  subscribe?: ReturnType<typeof vi.fn>
  unsubscribe?: ReturnType<typeof vi.fn>
}

function installApi(overrides: ApiOverrides = {}) {
  const api = {
    ruleMarket: {
      list: overrides.list ?? vi.fn(async () => LISTING),
      apply: overrides.apply ?? vi.fn(async () => ({ ok: true, rule: { host: 'a.test' } })),
      subscribe: overrides.subscribe ?? vi.fn(async () => ({ ok: true, entries: LISTING.entries })),
      unsubscribe: overrides.unsubscribe ?? vi.fn(async () => ({ ok: true })),
    },
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

async function mountPanel() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(NMessageProvider, null, { default: () => h(RuleMarketPanel) }),
  })
  app.mount(host)
  await nextTick(); await flush(); await nextTick()
  return app
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('RuleMarketPanel（规则市场）', () => {
  it('列出市场条目并标出来源', async () => {
    installApi()
    const app = await mountPanel()

    const rows = [...document.querySelectorAll('.market-row')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('甲站')
    expect(rows[0]!.textContent).toContain('a.test')
    expect(rows[0]!.textContent).toContain('内置')
    expect(rows[1]!.textContent).toContain('远端订阅')
    app.unmount()
  })

  it('列表为空时给出空态文案', async () => {
    installApi({ list: vi.fn(async () => ({ entries: [], sources: {} })) })
    const app = await mountPanel()

    expect(document.body.textContent).toContain('市场里还没有规则')
    app.unmount()
  })

  it('读取失败时显示错误而不是空列表', async () => {
    installApi({ list: vi.fn(async () => { throw new Error('读取市场失败：网络不通') }) })
    const app = await mountPanel()

    expect(document.body.textContent).toContain('读取市场失败：网络不通')
    app.unmount()
  })

  it('应用条目：带上条目 id，成功后提示落到本机站点', async () => {
    const api = installApi()
    const app = await mountPanel()

    buttonByText('应用到本机')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(api.ruleMarket.apply).toHaveBeenCalledWith({ id: 'a.test' })
    expect(document.body.textContent).toContain('已应用到本机：a.test')
    app.unmount()
  })

  it('应用失败时提示失败原因', async () => {
    installApi({ apply: vi.fn(async () => ({ ok: false, message: '该规则缺少正文选择器' })) })
    const app = await mountPanel()

    buttonByText('应用到本机')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(document.body.textContent).toContain('该规则缺少正文选择器')
    app.unmount()
  })

  it('订阅清单地址：成功订阅后出现该地址，可再取消', async () => {
    const api = installApi()
    const app = await mountPanel()

    const input = document.querySelector<HTMLInputElement>('.market-panel input, input')
    expect(input).not.toBeNull()
    typeInto(input!, 'https://example.com/rules.json')
    buttonByText('订阅')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(api.ruleMarket.subscribe).toHaveBeenCalledWith({ url: 'https://example.com/rules.json' })
    expect(document.querySelector('.market-subscription__url')?.textContent).toBe('https://example.com/rules.json')
    expect(document.body.textContent).toContain('拉到 2 条规则')

    buttonByText('取消订阅')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(api.ruleMarket.unsubscribe).toHaveBeenCalledWith({ url: 'https://example.com/rules.json' })
    expect(document.querySelector('.market-subscription__url')).toBeNull()
    app.unmount()
  })

  it('地址为空时不发请求，只提示填地址', async () => {
    const api = installApi()
    const app = await mountPanel()

    buttonByText('订阅')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(api.ruleMarket.subscribe).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('请填写清单地址')
    app.unmount()
  })

  it('订阅失败时提示失败原因，不把地址记进已订阅', async () => {
    installApi({ subscribe: vi.fn(async () => ({ ok: false, message: '清单地址不可达' })) })
    const app = await mountPanel()

    const input = document.querySelector<HTMLInputElement>('input')
    typeInto(input!, 'https://example.com/bad.json')
    buttonByText('订阅')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(document.body.textContent).toContain('清单地址不可达')
    expect(document.querySelector('.market-subscription__url')).toBeNull()
    app.unmount()
  })
})
