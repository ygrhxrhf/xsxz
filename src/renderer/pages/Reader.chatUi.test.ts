// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'
import type {
  AiCitation,
  AiDoneEvent,
  AiEvidenceChatMessage,
  AiStageEvent,
} from '../../shared/types'

/**
 * 侧栏问答的界面层：内联角标、依据折叠、逐条操作、思考链、角标跳原文时的段落闪烁。
 * 这些都在 Reader.vue 的模板里，`tsc` 看不到，只能挂载后按 DOM 断言。
 */

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

const CHAPTER_BODY = 'c1正文。'
/** 引用的 excerpt 必须真的能在正文里找到，否则跳转会走 fallback 分支而不闪段落。 */
const stampCitation: AiCitation = {
  id: 'qa-c1-p1', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 0, excerpt: CHAPTER_BODY,
}
const accountantCitation: AiCitation = {
  id: 'qa-c1-p2', chapterId: 'c1', chapterTitle: '第一章', paragraphIndex: 0, excerpt: CHAPTER_BODY,
}

const QUESTION = '玉印后来去了哪里？'

/** 一条 v2 证据回答：两句结论各自挂一个引用，句尾角标序号与依据列表能对上。 */
const answerWithClaims: AiEvidenceChatMessage = {
  role: 'assistant',
  content: '她把玉印交了出去。码头的账房先生接手。',
  citations: [stampCitation, accountantCitation],
  claims: [
    { text: '她把玉印交了出去。', citationIds: ['qa-c1-p1'] },
    { text: '码头的账房先生接手。', citationIds: ['qa-c1-p2'] },
  ],
  uptoChapterId: 'c1',
}

type Handlers = {
  stage?: (event: AiStageEvent) => void
  chunk?: (event: { jobId: string; delta: string }) => void
  done?: (event: AiDoneEvent) => void
}
type ReplaceCall = { bookId: string; messages: AiEvidenceChatMessage[] }

async function mountReader(options: {
  messages?: AiEvidenceChatMessage[]
  handlers?: Handlers
  replaceCalls?: ReplaceCall[]
} = {}) {
  const book = {
    id: 'book1', title: '问答书', author: '', tags: [], importType: 'txt', status: 'ready',
    createdAt: '', updatedAt: '',
    chapters: [{ id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const }],
    progress: { chapterId: 'c1', chapterIndex: 1, scrollRatio: 0.5, updatedAt: '' },
  }
  const handlers = options.handlers ?? {}
  // 只数「开了几次模型调用」：复制/编辑/删除都不该碰它，重问才该多一次。
  const starts = { count: 0 }
  Object.defineProperty(window, 'api', { configurable: true, value: {
    library: {
      get: async () => ({ book: JSON.parse(JSON.stringify(book)) }),
      readChapter: async (_bookId: string, id: string) => ({ chapter: { title: id, status: 'ready', body: CHAPTER_BODY } }),
      setProgress: async () => ({ ok: true }),
      updateChapterBody: async () => ({ ok: true }),
    },
    annotations: { list: async () => ({ ok: true, items: [] }), add: async () => ({ ok: true }), update: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    download: { onProgress: () => () => {}, cancel: async () => ({ ok: true }), retryFailed: async () => ({ ok: true }) },
    settings: {
      get: async () => ({
        reader: {
          fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
          paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll', bookView: 'classic',
        },
        tts: { rate: 1, autoNextChapter: false, source: 'system' }, baseUrl: '', libraryPath: '',
      }),
      set: async () => ({}),
    },
    ai: {
      onChunk: (fn: (event: { jobId: string; delta: string }) => void) => { handlers.chunk = fn; return () => { handlers.chunk = undefined } },
      onStage: (fn: (event: AiStageEvent) => void) => { handlers.stage = fn; return () => { handlers.stage = undefined } },
      onBudget: () => () => {},
      onDone: (fn: (event: AiDoneEvent) => void) => { handlers.done = fn; return () => { handlers.done = undefined } },
      agentChat: async () => { starts.count += 1; return { ok: true, jobId: 'qa-1' } },
      chatStream: async () => { starts.count += 1; return { ok: true, jobId: 'qa-1' } },
      getChat: async () => ({ ok: true, version: 2, messages: options.messages ?? [] }),
      replaceChat: async (bookId: string, messages: AiEvidenceChatMessage[]) => {
        options.replaceCalls?.push({ bookId, messages })
        return { ok: true }
      },
      clearChat: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      getMemory: async () => ({ ok: true, memory: null }),
      getSummaries: async () => ({ ok: true, summaries: {} }),
      chapterNotes: async () => ({ ok: true, notes: [] }),
      resumeCard: async () => ({ ok: true, view: null }),
      timeline: async () => ({ ok: true, timeline: { entries: [] } }),
      semanticIndexStatus: async () => ({ ok: true, status: { enabled: false, indexed: 0, total: 0, message: '' } }),
      getMaterialCoverage: async () => ({ ok: true, coverage: null }),
      getUsage: async () => ({ ok: true, usage: { calls: 0 } }),
      chapterFinished: async () => ({ ok: false, message: '测试桩：不追剧' }),
    },
  } })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book1' }) }) })
  app.mount(host)
  await vi.waitFor(() => expect(document.querySelector('.reader-content')?.textContent).toContain(CHAPTER_BODY))
  document.querySelector<HTMLButtonElement>('[aria-label="AI"]')?.click()
  await nextTick()
  const qaButton = [...document.querySelectorAll<HTMLButtonElement>('.tool-panel button')]
    .find((item) => item.textContent?.includes('聊书'))
  expect(qaButton, 'AI 面板里的「聊书」入口').toBeTruthy()
  qaButton?.click()
  await vi.waitFor(() => expect(document.querySelector('.chat-input-row textarea')).toBeTruthy())
  return { app, handlers, starts }
}

function assistantBubbles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.chat-msg.assistant .chat-bubble')]
}

function actionButtons(): HTMLButtonElement[] {
  const row = document.querySelector<HTMLElement>('.chat-msg.assistant .chat-actions')
  if (!row) throw new Error('助手消息里没有操作条')
  return [...row.querySelectorAll<HTMLButtonElement>('button')]
}

function clickAction(label: string): void {
  const button = actionButtons().find((item) => item.textContent?.trim() === label)
  if (!button) throw new Error(`操作条里没有「${label}」`)
  button.click()
}

/** 让 naive-ui 的 popconfirm 浮层露出来（它挂在 body 上的 teleport 里）。 */
async function confirmPopover(): Promise<void> {
  const positive = await vi.waitFor(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.n-popconfirm button')]
      .find((item) => item.textContent?.trim() === '确定')
    expect(button, 'popconfirm 里应有「确定」').toBeTruthy()
    return button!
  })
  positive.click()
  await nextTick()
}

afterEach(() => { document.body.innerHTML = ''; localStorage.clear(); vi.unstubAllGlobals() })

describe('Reader 问答气泡：角标与依据', () => {
  it('有 claims 的回答按句渲染，句尾挂对应序号的角标，依据收进折叠块', async () => {
    const { app } = await mountReader({ messages: [{ role: 'user', content: QUESTION }, answerWithClaims] })
    try {
      await vi.waitFor(() => expect(assistantBubbles()).toHaveLength(1))
      const lines = [...document.querySelectorAll<HTMLElement>('.chat-msg.assistant .chat-claim')]
      expect(lines.map((line) => line.textContent?.trim())).toEqual([
        '她把玉印交了出去。[1]',
        '码头的账房先生接手。[2]',
      ])
      // 角标序号是引用在 citations 里的下标，读者能按序号数到依据列表
      expect(lines[0]!.querySelector('.chat-cite')?.textContent).toBe('[1]')
      expect(lines[1]!.querySelector('.chat-cite')?.textContent).toBe('[2]')

      const evidence = document.querySelector<HTMLDetailsElement>('.chat-msg.assistant .chat-evidence')
      expect(evidence, '有引用就该有依据块').toBeTruthy()
      // 依据默认收起：先读结论，核对时才展开
      expect(evidence!.tagName).toBe('DETAILS')
      expect(evidence!.open).toBe(false)
      expect(evidence!.querySelector('summary')?.textContent?.trim()).toBe('依据 · 2 条')
      expect(evidence!.querySelectorAll('.memory-source')).toHaveLength(2)
      expect(evidence!.textContent).toContain('第一章 · 第 1 段：c1正文。')
    } finally { app.unmount() }
  })

  it('没有 claims 的旧回答保留整段正文，不把正文拆成条目', async () => {
    const { app } = await mountReader({
      messages: [
        { role: 'user', content: QUESTION },
        { role: 'assistant', content: '她把玉印交了出去。', citations: [stampCitation], uptoChapterId: 'c1' },
      ],
    })
    try {
      await vi.waitFor(() => expect(assistantBubbles()).toHaveLength(1))
      expect(assistantBubbles()[0]!.textContent).toBe('她把玉印交了出去。')
      expect(document.querySelector('.chat-claim')).toBeNull()
      expect(document.querySelector('.chat-evidence')?.textContent).toContain('依据（旧版回答，未逐条对应）')
    } finally { app.unmount() }
  })

  it('点角标跳回原文后那一段闪一下，1.2 秒后自己退掉', async () => {
    const { app } = await mountReader({ messages: [{ role: 'user', content: QUESTION }, answerWithClaims] })
    try {
      await vi.waitFor(() => expect(assistantBubbles()).toHaveLength(1))
      document.querySelector<HTMLButtonElement>('.chat-msg.assistant .chat-cite')!.click()
      await vi.waitFor(() => {
        expect(document.querySelector('[data-p="0"]')?.classList.contains('para-flash'), '目标段落应亮一下').toBe(true)
      })
      await vi.waitFor(() => {
        expect(document.querySelector('[data-p="0"]')?.classList.contains('para-flash'), '闪完要退掉，别一直亮着').toBe(false)
      }, { timeout: 3000 })
    } finally { app.unmount() }
  })
})

describe('Reader 问答操作条', () => {
  it('一轮问答下面有复制/重问/编辑/删除，生成中一起变灰', async () => {
    const { app } = await mountReader({ messages: [{ role: 'user', content: QUESTION }, answerWithClaims] })
    try {
      await vi.waitFor(() => expect(assistantBubbles()).toHaveLength(1))
      expect(actionButtons().map((button) => button.textContent?.trim())).toEqual(['复制', '重问', '编辑', '删除'])
      expect(actionButtons().every((button) => button.disabled)).toBe(false)
    } finally { app.unmount() }
  })

  it('编辑把上一句放回输入框，并从历史里删掉这一轮（覆盖写回书库）', async () => {
    const replaceCalls: ReplaceCall[] = []
    const { app } = await mountReader({
      messages: [{ role: 'user', content: QUESTION }, answerWithClaims],
      replaceCalls,
    })
    try {
      await vi.waitFor(() => expect(assistantBubbles()).toHaveLength(1))
      clickAction('编辑')
      // 只在界面上删是不够的：下次回答是追加写，不覆盖就会把删掉的那轮带回来
      await vi.waitFor(() => expect(replaceCalls).toHaveLength(1))
      expect(replaceCalls[0]!.bookId).toBe('book1')
      expect(replaceCalls[0]!.messages).toEqual([])
      await vi.waitFor(() => expect(document.querySelectorAll('.chat-msg')).toHaveLength(0))
      expect(document.querySelector<HTMLTextAreaElement>('.chat-input-row textarea')?.value).toBe(QUESTION)
    } finally { app.unmount() }
  })

  it('删除要先确认，确认后这一轮消失且不调用模型', async () => {
    const replaceCalls: ReplaceCall[] = []
    const { app, starts } = await mountReader({
      messages: [{ role: 'user', content: QUESTION }, answerWithClaims],
      replaceCalls,
    })
    try {
      await vi.waitFor(() => expect(assistantBubbles()).toHaveLength(1))
      clickAction('删除')
      expect(replaceCalls, '确认之前什么都不做').toHaveLength(0)
      // 浮层是 teleport + 过渡出来的，露出来才算数
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain('删除这一轮问答，不会调用模型。')
      })
      await confirmPopover()
      await vi.waitFor(() => expect(replaceCalls).toHaveLength(1))
      expect(replaceCalls[0]!.messages).toEqual([])
      await vi.waitFor(() => expect(document.querySelectorAll('.chat-msg')).toHaveLength(0))
      // 删除只是改本地记录：模型通道一次都没被叫过
      expect(starts.count, '删除不该开新任务').toBe(0)
    } finally { app.unmount() }
  })

  it('重问确认后删掉旧的一轮再问一次', async () => {
    const replaceCalls: ReplaceCall[] = []
    const { app, starts } = await mountReader({
      messages: [{ role: 'user', content: QUESTION }, answerWithClaims],
      replaceCalls,
    })
    try {
      await vi.waitFor(() => expect(assistantBubbles()).toHaveLength(1))
      clickAction('重问')
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain('会删掉这条回答并重新生成')
      })
      await confirmPopover()
      // 历史先清空（覆盖写），再按截断后的历史重发同一句
      await vi.waitFor(() => expect(replaceCalls).toHaveLength(1))
      expect(replaceCalls[0]!.messages).toEqual([])
      await vi.waitFor(() => expect(document.querySelectorAll('.chat-msg')).toHaveLength(2))
      expect(document.querySelectorAll('.chat-msg.user')).toHaveLength(1)
      expect(starts.count, '重问只重发这一句').toBe(1)
    } finally { app.unmount() }
  })
})

describe('Reader 思考链', () => {
  it('工具进度折在气泡上方，跑完翻成完成、失败翻成 error', async () => {
    const handlers: Handlers = {}
    const { app } = await mountReader({ handlers })
    try {
      const field = document.querySelector<HTMLTextAreaElement>('.chat-input-row textarea')!
      field.value = QUESTION
      field.dispatchEvent(new Event('input', { bubbles: true }))
      const send = [...document.querySelectorAll<HTMLButtonElement>('.chat-input-row button')]
        .find((item) => item.textContent?.includes('发送问题'))!
      await vi.waitFor(() => expect(send.disabled).toBe(false))
      send.click()
      await vi.waitFor(() => expect(assistantBubbles()).toHaveLength(1))

      handlers.stage?.({ jobId: 'qa-1', stage: 'requesting', detail: '检索原文' })
      await vi.waitFor(() => {
        expect(document.querySelector('.chat-steps li.is-running')?.textContent?.trim()).toBe('检索原文')
      })
      // 生成中默认展开，读者能看见它在翻哪一章
      expect(document.querySelector<HTMLDetailsElement>('.chat-steps')!.open).toBe(true)

      handlers.stage?.({ jobId: 'qa-1', stage: 'requesting', detail: '读第二章' })
      await vi.waitFor(() => {
        expect([...document.querySelectorAll<HTMLElement>('.chat-steps li')]
          .map((item) => item.className)).toEqual(['is-done', 'is-running'])
      })

      handlers.done?.({
        jobId: 'qa-1', ok: true, text: '她把玉印交了出去。',
        citations: [stampCitation], uptoChapterId: 'c1', stopped: false,
      })
      await nextTick()
      // 成功收尾：还在跑的那步标成 done，链留着（收在折叠里）给读者回看
      expect([...document.querySelectorAll<HTMLElement>('.chat-steps li')]
        .map((item) => item.className)).toEqual(['is-done', 'is-done'])
      expect(document.querySelector<HTMLDetailsElement>('.chat-steps')!.open).toBe(false)
    } finally { app.unmount() }
  })

  it('模型失败时最后一步标成 error，不假装跑完了', async () => {
    const handlers: Handlers = {}
    const { app } = await mountReader({ handlers })
    try {
      const field = document.querySelector<HTMLTextAreaElement>('.chat-input-row textarea')!
      field.value = QUESTION
      field.dispatchEvent(new Event('input', { bubbles: true }))
      const send = [...document.querySelectorAll<HTMLButtonElement>('.chat-input-row button')]
        .find((item) => item.textContent?.includes('发送问题'))!
      await vi.waitFor(() => expect(send.disabled).toBe(false))
      send.click()
      await vi.waitFor(() => expect(assistantBubbles()).toHaveLength(1))

      handlers.stage?.({ jobId: 'qa-1', stage: 'requesting', detail: '检索原文' })
      await vi.waitFor(() => expect(document.querySelector('.chat-steps li.is-running')).toBeTruthy())
      handlers.done?.({ jobId: 'qa-1', ok: false, message: 'API Key 无效或无权限，请到设置页核对' })
      await vi.waitFor(() => {
        expect([...document.querySelectorAll<HTMLElement>('.chat-steps li')]
          .map((item) => item.className)).toEqual(['is-error'])
      })
      expect(assistantBubbles()[0]!.textContent).toBe('错误：API Key 无效或无权限，请到设置页核对')
    } finally { app.unmount() }
  })
})
