// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'

/**
 * 助手面板的挂载级安全网。`tsc` 不检查 .vue 模板，而助手抽屉是 v-if 子树——
 * 拆这块之前先钉住「打开助手能看到五个 tab 与入口卡」这条界面契约。
 */
class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

afterEach(() => { document.body.innerHTML = '' })

const NO_SUB = () => () => {}

function installReaderApi() {
  const chapters = [{ id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const }]
  const book = {
    id: 'book-1', title: '助手书', author: '', tags: [] as string[], importType: 'txt' as const,
    createdAt: '', updatedAt: '', status: 'ready' as const, chapters, progress: null,
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      library: {
        get: async () => ({ book }),
        readChapter: async () => ({ chapter: { title: '第一章', body: '第一段。\n\n第二段。', status: 'ready' } }),
        setProgress: async () => ({ ok: true }),
      },
      settings: {
        get: async () => ({
          reader: {
            fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
            paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll',
          },
          tts: { rate: 1, autoNextChapter: true }, baseUrl: '', apiKeyConfigured: true, model: 'test',
        }),
        set: async () => ({}),
      },
      annotations: { list: async () => ({ ok: true, items: [] }) },
      download: { onProgress: NO_SUB },
      ai: {
        onChunk: NO_SUB, onStage: NO_SUB, onBudget: NO_SUB, onDone: NO_SUB,
        getChat: async () => ({ ok: true, version: 2, messages: [] }),
        getSummaries: async () => ({ ok: true, summaries: { byChapter: {}, storySoFar: '' } }),
        getMemory: async () => ({ ok: true, memory: null }),
        chapterNotes: async () => ({ ok: true, notes: [] }),
        resumeCard: async () => ({ ok: true, view: null }),
        timeline: async () => ({ ok: true, timeline: { entries: [] } }),
        semanticIndexStatus: async () => ({ ok: true, status: { enabled: false, indexed: 0, total: 0, message: '' } }),
        getMaterialCoverage: async () => ({ ok: true, coverage: null }),
        getUsage: async () => ({ ok: true, usage: { calls: 0 } }),
        chapterFinished: async () => ({ ok: false, message: '测试桩：不追剧' }),
      },
    },
  })
}

async function mountReader() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
  app.mount(host)
  await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
  return app
}

/** 助手抽屉是两跳进去的：顶栏「AI 助手」工具按钮 → 工具面板里的「AI 助手」。 */
async function openAssistant(): Promise<void> {
  const toolbarButton = document.querySelector<HTMLElement>('[title="AI 助手"]')
  expect(toolbarButton, '顶栏应有 AI 工具入口').toBeTruthy()
  toolbarButton?.click()
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const entry = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => (button.textContent ?? '').trim() === 'AI 助手')
  expect(entry, '工具面板里应有「AI 助手」入口').toBeTruthy()
  entry?.click()
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

describe('Reader 助手面板（拆前安全网）', () => {
  it('打开助手能看到五类 tab 与四张入口卡', async () => {
    installReaderApi()
    const app = await mountReader()
    await openAssistant()

    const text = document.body.textContent ?? ''
    for (const tab of ['前情', '记忆', '问答', '笔记', '输出']) expect(text).toContain(tab)
    for (const entry of ['接着读', '找人物与伏笔', '带依据地问', '记住本章']) expect(text).toContain(entry)
    app.unmount()
  })

  it('切到「问答」能看到提问框', async () => {
    installReaderApi()
    const app = await mountReader()
    await openAssistant()

    const qaTab = [...document.querySelectorAll<HTMLElement>('.n-tabs-tab')].find((tab) => (tab.textContent ?? '').includes('问答'))
    expect(qaTab, '应有「问答」tab').toBeTruthy()
    qaTab?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector('textarea, input')).toBeTruthy()
    app.unmount()
  })
})
