// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AiBudgetConfirm from './AiBudgetConfirm.vue'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  configurable: true,
})

afterEach(() => { document.body.innerHTML = '' })

describe('AI over-budget confirmation', () => {
  it('shows the reduced range and emits only the chosen action', async () => {
    const confirm = vi.fn()
    const cancel = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(AiBudgetConfirm, {
      show: true,
      budget: {
        originalCharacters: 45_000,
        sentCharacters: 32_000,
        estimatedTokens: 20_100,
        chapterCount: 1,
        paragraphCount: 8,
        batchCount: 3,
        range: '当前章节全文，按 3 批清理；每批仅携带目标前后各一段只读上下文。',
      },
      onConfirm: confirm,
      onCancel: cancel,
    })
    app.mount(host)
    await nextTick()

    expect(document.body.textContent).toContain('内容超过单次发送预算，已准备缩减后的发送范围。')
    expect(document.body.textContent).toContain('预计发送：1 章 / 8 段，约 32000 字 / 20100 tokens（估算）')
    expect(document.body.textContent).toContain('预计输入超过 30000 字。是否按上方缩减范围继续？')
    const buttons = [...document.querySelectorAll('button')]
    buttons.find((item) => item.textContent?.trim() === '取消')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(cancel).toHaveBeenCalledOnce()
    expect(confirm).not.toHaveBeenCalled()
    app.unmount()
  })

  it('emits confirmation only after the explicit continue action', async () => {
    const confirm = vi.fn()
    const cancel = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(AiBudgetConfirm, {
      show: true,
      budget: {
        originalCharacters: 40_000,
        sentCharacters: 8_500,
        estimatedTokens: 5_900,
        chapterCount: 1,
        paragraphCount: 4,
        batchCount: 1,
        range: '当前章节正文前 8000 字，用于生成本章摘要；其余正文本次不发送。',
      },
      onConfirm: confirm,
      onCancel: cancel,
    })
    app.mount(host)
    await nextTick()
    const continueButton = [...document.querySelectorAll('button')]
      .find((item) => item.textContent?.trim() === '继续')
    continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(confirm).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
    app.unmount()
  })
})
