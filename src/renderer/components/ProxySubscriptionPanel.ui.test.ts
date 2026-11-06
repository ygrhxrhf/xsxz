// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import type { ProxyAutoUpdatePrefs, ProxySpeedTestResult, ProxySubscriptionState } from '@shared/types'
import ProxySubscriptionPanel from './ProxySubscriptionPanel.vue'

/**
 * 订阅面板：定时重拉开关与间隔、立即重拉、多节点测速。
 *
 * 两处刻意的克制也在这里钉住：面板**不提供自动换节点**，测速**只报数不切节点**，
 * 所以面板里不应出现「自动选择最快节点」这类入口。
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const PREFS: ProxyAutoUpdatePrefs = {
  enabled: false,
  intervalMinutes: 60,
  lastUpdatedAt: '',
  lastError: '',
}

const SPEED: ProxySpeedTestResult = {
  nodes: [
    { index: 0, name: '慢节点', protocol: 'vless', latencyMs: 300, ok: true, message: '' },
    { index: 1, name: '快节点', protocol: 'hysteria2', latencyMs: 50, ok: true, message: '' },
    { index: 2, name: '坏节点', protocol: 'tuic', latencyMs: -1, ok: false, message: '连接超时' },
  ],
  succeeded: 2,
  total: 3,
  fastestIndex: 1,
}

const OVERVIEW: ProxySubscriptionState = {
  total: 3,
  skipped: 0,
  byProtocol: { vless: 1, hysteria2: 1, tuic: 1 },
  nodes: [
    { name: '慢节点', protocol: 'vless' },
    { name: '快节点', protocol: 'hysteria2' },
    { name: '坏节点', protocol: 'tuic' },
  ],
}

interface ApiOverrides {
  autoUpdateState?: ReturnType<typeof vi.fn>
  setAutoUpdate?: ReturnType<typeof vi.fn>
  refreshSubscription?: ReturnType<typeof vi.fn>
  speedTest?: ReturnType<typeof vi.fn>
}

function installApi(overrides: ApiOverrides = {}) {
  const api = {
    proxy: {
      autoUpdateState: overrides.autoUpdateState ?? vi.fn(async () => ({ ok: true, prefs: PREFS })),
      setAutoUpdate: overrides.setAutoUpdate ?? vi.fn(async (payload: { enabled?: boolean; intervalMinutes?: number }) => ({
        ok: true,
        prefs: { ...PREFS, ...payload } as ProxyAutoUpdatePrefs,
      })),
      refreshSubscription: overrides.refreshSubscription ?? vi.fn(async () => ({
        ok: true,
        overview: OVERVIEW,
        prefs: { ...PREFS, enabled: true, lastUpdatedAt: '2026-11-07T10:00:00.000Z' },
      })),
      speedTest: overrides.speedTest ?? vi.fn(async () => ({ ok: true, result: SPEED })),
    },
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

async function mountPanel() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const refreshed: ProxySubscriptionState[] = []
  const app = createApp({
    render: () => h(NMessageProvider, null, {
      default: () => h(ProxySubscriptionPanel, { onRefreshed: (overview: ProxySubscriptionState) => refreshed.push(overview) }),
    }),
  })
  app.mount(host)
  await nextTick(); await flush(); await nextTick()
  return { app, refreshed }
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ProxySubscriptionPanel（订阅自动更新与测速）', () => {
  it('挂载时读取自动更新状态，并显示从未成功重拉', async () => {
    installApi()
    const { app } = await mountPanel()

    expect(document.body.textContent).toContain('从未成功重拉')
    expect(document.body.textContent).toContain('分钟数，1–1440；非法值回退到 60')
    app.unmount()
  })

  it('打开定时重拉开关：把开关状态与间隔一起发给主进程', async () => {
    const api = installApi()
    const { app } = await mountPanel()

    const toggle = document.querySelector<HTMLElement>('.n-switch')
    expect(toggle).not.toBeNull()
    toggle!.click()
    await nextTick(); await flush(); await nextTick()

    expect(api.proxy.setAutoUpdate).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 60 })
    app.unmount()
  })

  it('保存失败时显示主进程给的失败原因', async () => {
    installApi({ setAutoUpdate: vi.fn(async () => ({ ok: false, message: '间隔必须是 1–1440 分钟' })) })
    const { app } = await mountPanel()

    document.querySelector<HTMLElement>('.n-switch')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(document.body.textContent).toContain('间隔必须是 1–1440 分钟')
    app.unmount()
  })

  it('立即重拉：成功后把新的节点概览抛给设置页', async () => {
    const api = installApi()
    const { app, refreshed } = await mountPanel()

    buttonByText('立即重拉')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(api.proxy.refreshSubscription).toHaveBeenCalled()
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]!.total).toBe(3)
    expect(document.body.textContent).toContain('已重拉订阅，共 3 个节点')
    app.unmount()
  })

  it('立即重拉失败时显示原因，不抛概览', async () => {
    installApi({ refreshSubscription: vi.fn(async () => ({ ok: false, message: '订阅地址返回 403' })) })
    const { app, refreshed } = await mountPanel()

    buttonByText('立即重拉')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(document.body.textContent).toContain('订阅地址返回 403')
    expect(refreshed).toHaveLength(0)
    app.unmount()
  })

  it('测速：结果按延迟升序排列，失败节点排在最后', async () => {
    installApi()
    const { app } = await mountPanel()

    buttonByText('开始测速')!.click()
    await nextTick(); await flush(); await nextTick()

    const rows = [...document.querySelectorAll('.speed-row')].map((row) => row.textContent ?? '')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('快节点')
    expect(rows[1]).toContain('慢节点')
    expect(rows[2]).toContain('坏节点')
    expect(rows[2]).toContain('连接超时')
    expect(document.querySelector('.speed-summary')?.textContent).toContain('成功 2 / 3 个节点')
    app.unmount()
  })

  it('全部节点测速失败时给出警告，仍列出每个节点的失败原因', async () => {
    installApi({
      speedTest: vi.fn(async () => ({
        ok: true,
        result: {
          nodes: [{ index: 0, name: '坏节点', protocol: 'tuic', latencyMs: -1, ok: false, message: '连接超时' }],
          succeeded: 0,
          total: 1,
          fastestIndex: -1,
        } as ProxySpeedTestResult,
      })),
    })
    const { app } = await mountPanel()

    buttonByText('开始测速')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(document.body.textContent).toContain('没有节点测速成功')
    expect(document.querySelector('.speed-summary')?.textContent).not.toContain('最快')
    app.unmount()
  })

  it('测速失败时显示主进程给的错误', async () => {
    installApi({ speedTest: vi.fn(async () => ({ ok: false, message: '没有可测速的节点' })) })
    const { app } = await mountPanel()

    buttonByText('开始测速')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(document.body.textContent).toContain('没有可测速的节点')
    expect(document.querySelector('.speed-list')).toBeNull()
    app.unmount()
  })

  it('面板不提供「自动换节点」入口：测速只报数', async () => {
    installApi()
    const { app } = await mountPanel()

    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
    expect(labels).toContain('开始测速')
    expect(labels.join(' ')).not.toContain('自动切换')
    expect(labels.join(' ')).not.toContain('切换到最快')
    app.unmount()
  })
})
