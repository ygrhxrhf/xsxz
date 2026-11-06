// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import type { SyncAccountState, SyncResult } from '@shared/types'
import SyncPanel from './SyncPanel.vue'

/**
 * 账号与云同步面板：登录状态、登录/退出、同步结果摘要。
 * 同步内容边界（只同步设置与站点规则）由主进程 `syncCloud.test.ts` 把关，
 * 这里只钉界面行为与错误呈现。
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const SIGNED_OUT: SyncAccountState = { signedIn: false, account: '', endpoint: '' }
const SIGNED_IN: SyncAccountState = { signedIn: true, account: 'me@example.com', endpoint: 'https://sync.example.com' }

interface ApiOverrides {
  status?: ReturnType<typeof vi.fn>
  signIn?: ReturnType<typeof vi.fn>
  signOut?: ReturnType<typeof vi.fn>
  run?: ReturnType<typeof vi.fn>
}

function installApi(overrides: ApiOverrides = {}) {
  const api = {
    sync: {
      status: overrides.status ?? vi.fn(async () => ({ ok: true, state: SIGNED_OUT })),
      signIn: overrides.signIn ?? vi.fn(async () => ({ ok: true, state: SIGNED_IN })),
      signOut: overrides.signOut ?? vi.fn(async () => ({ ok: true, state: SIGNED_OUT })),
      run: overrides.run ?? vi.fn(async () => ({
        ok: true,
        result: { ok: true, updatedAt: '2026-11-07 10:00:00', pushed: 3, pulled: 5, message: '' } as SyncResult,
      })),
    },
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  return api
}

async function mountPanel() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(NMessageProvider, null, { default: () => h(SyncPanel) }),
  })
  app.mount(host)
  await nextTick(); await flush(); await nextTick()
  return app
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
}

function inputs(): HTMLInputElement[] {
  return [...document.querySelectorAll('input')]
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SyncPanel（账号与云同步）', () => {
  it('未登录时显示未登录标记与登录表单', async () => {
    installApi()
    const app = await mountPanel()

    expect(document.querySelector('.sync-status')?.textContent).toContain('未登录')
    expect(buttonByText('登录')).toBeTruthy()
    expect(buttonByText('立即同步')).toBeFalsy()
    app.unmount()
  })

  it('已登录时显示账号与同步/退出按钮', async () => {
    installApi({ status: vi.fn(async () => ({ ok: true, state: SIGNED_IN })) })
    const app = await mountPanel()

    const status = document.querySelector('.sync-status')?.textContent ?? ''
    expect(status).toContain('已登录')
    expect(status).toContain('me@example.com')
    expect(buttonByText('立即同步')).toBeTruthy()
    expect(buttonByText('退出登录')).toBeTruthy()
    app.unmount()
  })

  it('令牌为空时不发登录请求', async () => {
    const api = installApi()
    const app = await mountPanel()

    buttonByText('登录')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(api.sync.signIn).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('请填写访问令牌')
    app.unmount()
  })

  it('登录成功：状态切到已登录，令牌输入框清空', async () => {
    const api = installApi()
    const app = await mountPanel()

    const [token, account, endpoint] = inputs()
    token!.value = 'tok-1'
    token!.dispatchEvent(new Event('input', { bubbles: true }))
    account!.value = 'me@example.com'
    account!.dispatchEvent(new Event('input', { bubbles: true }))
    endpoint!.value = 'https://sync.example.com'
    endpoint!.dispatchEvent(new Event('input', { bubbles: true }))

    buttonByText('登录')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(api.sync.signIn).toHaveBeenCalledWith({
      token: 'tok-1',
      endpoint: 'https://sync.example.com',
      account: 'me@example.com',
    })
    expect(document.querySelector('.sync-status')?.textContent).toContain('已登录')
    // 登录成功后登录表单整体收起，令牌输入框不再留在页面上。
    expect(inputs()).toHaveLength(0)
    expect(buttonByText('立即同步')).toBeTruthy()
    app.unmount()
  })

  it('登录失败时提示原因，仍留在未登录状态', async () => {
    installApi({ signIn: vi.fn(async () => ({ ok: false, message: '令牌无效' })) })
    const app = await mountPanel()

    const token = inputs()[0]!
    token.value = 'bad'
    token.dispatchEvent(new Event('input', { bubbles: true }))
    buttonByText('登录')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(document.body.textContent).toContain('令牌无效')
    expect(document.querySelector('.sync-status')?.textContent).toContain('未登录')
    app.unmount()
  })

  it('同步成功后显示上传/拉回条数', async () => {
    installApi({ status: vi.fn(async () => ({ ok: true, state: SIGNED_IN })) })
    const app = await mountPanel()

    buttonByText('立即同步')!.click()
    await nextTick(); await flush(); await nextTick()

    const result = document.querySelector('.sync-result')?.textContent ?? ''
    expect(result).toContain('上传 3 条')
    expect(result).toContain('拉回 5 条')
    app.unmount()
  })

  it('同步失败时提示原因且不显示结果摘要', async () => {
    installApi({
      status: vi.fn(async () => ({ ok: true, state: SIGNED_IN })),
      run: vi.fn(async () => ({ ok: false, message: '云端不可达' })),
    })
    const app = await mountPanel()

    buttonByText('立即同步')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(document.body.textContent).toContain('云端不可达')
    expect(document.querySelector('.sync-result')).toBeNull()
    app.unmount()
  })

  it('退出登录后回到未登录状态', async () => {
    const api = installApi({ status: vi.fn(async () => ({ ok: true, state: SIGNED_IN })) })
    const app = await mountPanel()

    buttonByText('退出登录')!.click()
    await nextTick(); await flush(); await nextTick()

    expect(api.sync.signOut).toHaveBeenCalled()
    expect(document.querySelector('.sync-status')?.textContent).toContain('未登录')
    app.unmount()
  })

  it('读取登录状态失败时显示错误', async () => {
    installApi({ status: vi.fn(async () => { throw new Error('读取登录状态失败：磁盘不可读') }) })
    const app = await mountPanel()

    expect(document.body.textContent).toContain('读取登录状态失败：磁盘不可读')
    app.unmount()
  })
})
