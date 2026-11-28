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
/** 一次真实发出去的问答：记下模式与 payload，好断言「附没附参考范围那行」。 */
type ChatCall = { mode: 'agent' | 'general' | 'evidence'; messages: AiEvidenceChatMessage[]; threadId?: string }
type ChatThreadCall = { created: string[]; deleted: string[]; getChat: (string | undefined)[] }
/** 一颗会话种子：id / 标题 / 消息是主进程 chats.json 里那条线程的摘要与历史。 */
type ThreadSeed = { id: string; title: string; messages: AiEvidenceChatMessage[]; updatedAt: string }

async function mountReader(options: {
  messages?: AiEvidenceChatMessage[]
  /** 给了就是一份两三条线程的 chats.json：不给则沿用「getChat 一律回 messages」的旧桩。 */
  threads?: ThreadSeed[]
  handlers?: Handlers
  replaceCalls?: ReplaceCall[]
  chatCalls?: ChatCall[]
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
  // 会话栏的假书库：listThreads / createThread / deleteThread 都改这份内存，
  // 断言就能落在「真的换了一条会话」上，而不是只看按钮有没有被点到。
  const threads = new Map<string, ThreadSeed>((options.threads ?? []).map((seed) => [seed.id, { ...seed }]))
  let activeThreadId = options.threads?.[0]?.id ?? ''
  let createdCount = 0
  const threadCalls: ChatThreadCall = { created: [], deleted: [], getChat: [] }
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
      onExternalSources: () => () => {}, onBudget: () => () => {},
      onDone: (fn: (event: AiDoneEvent) => void) => { handlers.done = fn; return () => { handlers.done = undefined } },
      agentChat: async (_bookId: string, _chapterId: string, messages: AiEvidenceChatMessage[], threadId?: string) => {
        starts.count += 1
        options.chatCalls?.push({ mode: 'agent', messages, threadId })
        return { ok: true, jobId: 'qa-1' }
      },
      generalChat: async (_bookId: string, messages: AiEvidenceChatMessage[], threadId?: string) => {
        starts.count += 1
        options.chatCalls?.push({ mode: 'general', messages, threadId })
        return { ok: true, jobId: 'qa-1' }
      },
      chatStream: async (_bookId: string, _chapterId: string, messages: AiEvidenceChatMessage[], threadId?: string) => {
        starts.count += 1
        options.chatCalls?.push({ mode: 'evidence', messages, threadId })
        return { ok: true, jobId: 'qa-1' }
      },
      getChat: async (_bookId: string, threadId?: string) => {
        threadCalls.getChat.push(threadId)
        if (!options.threads) return { ok: true, version: 2, messages: options.messages ?? [] }
        const id = threadId ?? activeThreadId
        const found = threads.get(id)
        if (!found) return { ok: false, message: `会话不存在，请刷新会话列表（${id}）` }
        return { ok: true, version: 2, messages: found.messages, threadId: id }
      },
      listThreads: async () => ({
        ok: true,
        activeThreadId,
        threads: [...threads.values()]
          .map((item) => ({ id: item.id, title: item.title, messageCount: item.messages.length, updatedAt: item.updatedAt }))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      }),
      createThread: async () => {
        createdCount += 1
        const id = `th_new_${createdCount}`
        threads.set(id, { id, title: '', messages: [], updatedAt: `2026-02-0${createdCount}T00:00:00.000Z` })
        activeThreadId = id
        threadCalls.created.push(id)
        return { ok: true, threadId: id }
      },
      deleteThread: async (_bookId: string, threadId: string) => {
        threadCalls.deleted.push(threadId)
        threads.delete(threadId)
        if (activeThreadId === threadId) {
          activeThreadId = [...threads.values()]
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? ''
        }
        return { ok: true }
      },
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
  await vi.waitFor(() => expect(document.querySelector('.chat-input-row textarea')).toBeTruthy())
  return { app, handlers, starts, threadCalls }
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

/** 输入框下面那排 chip：对话 / 证据 / 本章 / 记忆 / 批注 / 清空。 */
function composerChips(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.sider-composer-chips .chat-chip')]
}

function composerChip(label: string): HTMLButtonElement {
  const button = composerChips().find((item) => item.textContent?.trim() === label)
  if (!button) throw new Error(`输入框下面没有「${label}」chip`)
  return button
}

/** 打字再点「发送问题」：只有走界面才能验到模板里的开关接线。 */
async function typeAndSend(question: string): Promise<void> {
  const field = document.querySelector<HTMLTextAreaElement>('.chat-input-row textarea')!
  field.value = question
  field.dispatchEvent(new Event('input', { bubbles: true }))
  const send = [...document.querySelectorAll<HTMLButtonElement>('.chat-input-row button')]
    .find((item) => item.textContent?.includes('发送问题'))!
  await vi.waitFor(() => expect(send.disabled).toBe(false))
  send.click()
}

/** 会话栏里的按钮（「新会话」/「删除会话」）：按文案取，不靠位置。 */
function threadBarButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.chat-threads button')]
    .find((item) => item.textContent?.trim() === label)
  if (!button) throw new Error(`会话栏里没有「${label}」`)
  return button
}

function threadBarLabels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.chat-threads button')]
    .map((item) => item.textContent?.trim() ?? '')
}

/** 下拉框当前显示的那一行文案（naive-ui 在收起态把选中项的 label 画在框里）。 */
function selectedThreadLabel(): string {
  return document.querySelector('.chat-threads-select')?.textContent?.trim() ?? ''
}

/**
 * 切会话：直接调下拉框绑定的 update:value。
 *
 * 为什么不用点击：naive-ui 的选项列表是虚拟列表，jsdom 里量不到高度、一条选项都不渲染，
 * 点得开却点不到选项。这里走的是模板上同一个 handler，验的仍是 Reader 切会话的行为。
 */
function selectChatThread(id: string): void {
  const host = document.querySelector('.chat-threads-select') as unknown as {
    __vueParentComponent?: { vnode: { props?: Record<string, (value: string) => void> } }
  }
  const update = host?.__vueParentComponent?.vnode.props?.['onUpdate:value']
  if (!update) throw new Error('下拉框没有绑定 update:value')
  update(id)
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

/** 徽标文案是后端算的，界面只负责照猫画虎：不许在这里把 partial/not_run 说成「已核验」。 */
describe('Reader 问答可信度徽标', () => {
  async function mountWithVerification(message: AiEvidenceChatMessage) {
    const mounted = await mountReader({ messages: [{ role: 'user', content: QUESTION }, message] })
    await vi.waitFor(() => expect(assistantBubbles()).toHaveLength(1))
    return mounted
  }

  it('verified 说清几条结论都有原文支持', async () => {
    const { app } = await mountWithVerification({ ...answerWithClaims, verification: 'verified' })
    try {
      const badge = await vi.waitFor(() => {
        const node = document.querySelector<HTMLElement>('.chat-verify')
        expect(node, '已核验就该挂徽标').toBeTruthy()
        return node!
      })
      expect(badge.className).toContain('is-verified')
      expect(badge.textContent).toContain('已核验')
      // 条数取幸存结论数：读者能拿它和下面的逐条结论对得上
      expect(badge.textContent).toContain('条结论均有原文支持')
      expect(badge.textContent).toContain('2')
    } finally { app.unmount() }
  })

  it('partial 删过结论时说清删了几条', async () => {
    const { app } = await mountWithVerification({ ...answerWithClaims, verification: 'partial', droppedClaims: 2 })
    try {
      const badge = await vi.waitFor(() => {
        const node = document.querySelector<HTMLElement>('.chat-verify')
        expect(node).toBeTruthy()
        return node!
      })
      expect(badge.className).toContain('is-partial')
      expect(badge.textContent).toContain('删除了 2 条无原文支持的结论')
    } finally { app.unmount() }
  })

  it('partial 但一条没删时说明有结论没给逐字原文', async () => {
    const { app } = await mountWithVerification({ ...answerWithClaims, verification: 'partial', droppedClaims: 0 })
    try {
      const badge = await vi.waitFor(() => {
        const node = document.querySelector<HTMLElement>('.chat-verify')
        expect(node).toBeTruthy()
        return node!
      })
      // dropped 为 0 不是「全都核过了」：只是有结论没给引文，judge 没得判
      expect(badge.textContent).toContain('未给出逐字原文')
      expect(badge.textContent).not.toContain('删除了')
    } finally { app.unmount() }
  })

  it('not_run 必须直接写「未运行校验」，不能让读者以为校验过了', async () => {
    const { app } = await mountWithVerification({ ...answerWithClaims, verification: 'not_run' })
    try {
      const badge = await vi.waitFor(() => {
        const node = document.querySelector<HTMLElement>('.chat-verify')
        expect(node, '校验没跑成也得说一句').toBeTruthy()
        return node!
      })
      expect(badge.className).toContain('is-not_run')
      expect(badge.textContent).toContain('未运行校验')
      expect(badge.textContent).not.toContain('已核验')
    } finally { app.unmount() }
  })

  /**
   * disabled 是「读者自己关掉核验」：文案必须说成已关闭，不能说成未运行/失败——
   * 否则读者会以为核验坏了，把开关重新打开后反复重试。
   */
  it('disabled 写「已关闭原文核验」，不能说成校验失败或去跑过核验', async () => {
    const { app } = await mountWithVerification({ ...answerWithClaims, verification: 'disabled' })
    try {
      const badge = await vi.waitFor(() => {
        const node = document.querySelector<HTMLElement>('.chat-verify')
        expect(node, '读者关掉核验也得说明一下').toBeTruthy()
        return node!
      })
      expect(badge.className).toContain('is-disabled')
      expect(badge.textContent).toContain('已关闭原文核验')
      // 不能跟故障性的 not_run 用同一套说法
      expect(badge.textContent).not.toContain('未运行校验')
      expect(badge.textContent).not.toContain('已核验')
    } finally { app.unmount() }
  })

  it('旧记录没有 verification 时一个徽标都不渲染', async () => {
    const { app } = await mountWithVerification(answerWithClaims)
    try {
      // 缺省就是不知道：不默认说它被核过，也不编一个「未校验」出来
      expect(document.querySelector('.chat-verify')).toBeNull()
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

  it('重问直接删掉旧的一轮再问一次', async () => {
    const replaceCalls: ReplaceCall[] = []
    const { app, starts } = await mountReader({
      messages: [{ role: 'user', content: QUESTION }, answerWithClaims],
      replaceCalls,
    })
    try {
      await vi.waitFor(() => expect(assistantBubbles()).toHaveLength(1))
      clickAction('重问')
      // 重问免二次确认：历史先清空（覆盖写），再按截断后的历史重发同一句
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

/**
 * 参考范围开关：读者告诉模型先看什么。指令只附在对话模式的问题末尾；
 * 证据模式只吃检索结果，拼上去会让读者误以为能改变检索范围，所以连开关一起禁用。
 */
describe('Reader 问答模式切换（精简输入栏）', () => {
  it('输入框下方提供「对话 / 字词 / 百科 / 证据」三档胶囊，去掉本章/记忆/批注/清空冗余开关与灰字提示', async () => {
    const { app } = await mountReader()
    try {
      expect(composerChips().map((item) => item.textContent?.trim()))
        .toEqual(['对话', '字词 / 百科', '证据'])
      expect(composerChip('对话').classList.contains('chat-chip-on')).toBe(true)
      expect(composerChip('字词 / 百科').classList.contains('chat-chip-on')).toBe(false)
      expect(composerChip('证据').classList.contains('chat-chip-on')).toBe(false)
      expect(document.querySelector('.sider-composer-hint')).toBeNull()
    } finally { app.unmount() }
  })

  it('切到「字词 / 百科」走 general 通道并渲染通用徽标，切到「证据」走 evidence 通道', async () => {
    const chatCalls: ChatCall[] = []
    const handlers: Handlers = {}
    const { app } = await mountReader({ chatCalls, handlers })
    try {
      composerChip('字词 / 百科').click()
      await nextTick()
      expect(composerChip('字词 / 百科').classList.contains('chat-chip-on')).toBe(true)

      await typeAndSend('踟蹰是什么意思？')
      await vi.waitFor(() => expect(chatCalls).toHaveLength(1))
      expect(chatCalls[0]!.mode).toBe('general')
      expect(chatCalls[0]!.messages.at(-1)!.content).toBe('踟蹰是什么意思？')
      expect(document.querySelector('.chat-scope-tag')?.textContent?.trim()).toBe('字词 / 百科')
      expect(document.querySelector('.chat-legacy')).toBeNull()
      handlers.done?.({ jobId: 'qa-1', ok: true, text: '踟蹰：徘徊不前。', citations: [], scope: 'general' })
      await nextTick()
      expect(document.querySelector('.chat-scope-tag')?.textContent?.trim()).toBe('字词 / 百科')

      composerChip('证据').click()
      await nextTick()
      expect(composerChip('证据').classList.contains('chat-chip-on')).toBe(true)

      await typeAndSend(QUESTION)
      await vi.waitFor(() => expect(chatCalls).toHaveLength(2))
      expect(chatCalls[1]!.mode).toBe('evidence')
      expect(chatCalls[1]!.messages.at(-1)!.content).toBe(QUESTION)
    } finally { app.unmount() }
  })
})

/**
 * 会话栏：一本书可以有多条互不污染的问答会话。
 *
 * 这层守的是「删了当前会话会不会回退」「切会话会不会把消息写到错线程」在界面上的那一半：
 * 下拉框显示的是哪条、切过去之后消息区是不是真的换成了另一条的历史。
 */
describe('Reader 问答会话栏', () => {
  const seedA: ThreadSeed = {
    id: 'th_a',
    title: '默认会话',
    updatedAt: '2026-01-02T00:00:00.000Z',
    messages: [
      { role: 'user', content: 'A 会话的问题' },
      { role: 'assistant', content: 'A 会话的回答' },
    ],
  }
  const seedB: ThreadSeed = {
    id: 'th_b',
    title: '人物线',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [
      { role: 'user', content: 'B 会话的问题' },
      { role: 'assistant', content: 'B 会话的回答' },
    ],
  }

  function bubbles(): string[] {
    return [...document.querySelectorAll<HTMLElement>('.chat-msg .chat-bubble')]
      .map((item) => item.textContent?.trim() ?? '')
  }

  it('下拉框显示「标题 · N 条」，只剩一条会话时不露删除', async () => {
    const { app } = await mountReader({ threads: [seedA] })
    try {
      await vi.waitFor(() => expect(selectedThreadLabel()).toContain('默认会话 · 2 条'))
      // 删完就没会话了，只是把读者送回欢迎态，没必要给这个口
      expect(threadBarLabels()).toEqual(['新会话'])
    } finally { app.unmount() }
  })

  it('两条会话时露删除按钮', async () => {
    const { app } = await mountReader({ threads: [seedA, seedB] })
    try {
      await vi.waitFor(() => expect(selectedThreadLabel()).toContain('默认会话 · 2 条'))
      expect(threadBarLabels()).toEqual(['新会话', '删除会话'])
    } finally { app.unmount() }
  })

  it('点「新会话」先建会话再按新 id 拉历史，旧会话的消息被换掉', async () => {
    const { app, threadCalls } = await mountReader({ threads: [seedA, seedB] })
    try {
      await vi.waitFor(() => expect(bubbles()).toContain('A 会话的问题'))
      threadBarButton('新会话').click()

      await vi.waitFor(() => expect(threadCalls.created).toHaveLength(1))
      const created = threadCalls.created[0]!
      // 拉历史必须带新会话的 id：不带就会读到主进程的 active，显示的还是上一条
      await vi.waitFor(() => expect(threadCalls.getChat.at(-1)).toBe(created))
      await vi.waitFor(() => expect(document.querySelectorAll('.chat-msg')).toHaveLength(0))
      expect(bubbles()).toEqual([])
      // 下拉框里已经有这一条，并且选中态落在它上面
      await vi.waitFor(() => expect(selectedThreadLabel()).toContain('新会话 · 0 条'))
      // 旧会话的历史一个字都不该留在界面上
      expect(document.body.textContent).not.toContain('A 会话的问题')
    } finally { app.unmount() }
  })

  it('切会话后消息区显示的是另一条会话的历史', async () => {
    const { app, threadCalls } = await mountReader({ threads: [seedA, seedB] })
    try {
      await vi.waitFor(() => expect(bubbles()).toContain('A 会话的问题'))
      selectChatThread('th_b')

      await vi.waitFor(() => expect(bubbles()).toEqual(['B 会话的问题', 'B 会话的回答']))
      expect(threadCalls.getChat.at(-1)).toBe('th_b')
      await vi.waitFor(() => expect(selectedThreadLabel()).toContain('人物线 · 2 条'))
      expect(document.body.textContent).not.toContain('A 会话的问题')
    } finally { app.unmount() }
  })

  it('生成中下拉框与新会话按钮变灰，点删除也不删会话', async () => {
    const { app, threadCalls } = await mountReader({ threads: [seedA, seedB] })
    try {
      await vi.waitFor(() => expect(bubbles()).toContain('A 会话的问题'))
      await typeAndSend(QUESTION)
      // 流式回答还在往当前会话追加：这一栏整栏禁用，切走会把后面的句子写进另一条
      await vi.waitFor(() => {
        expect(document.querySelector('.chat-threads-select .n-base-selection')?.className)
          .toContain('n-base-selection--disabled')
      })
      expect(threadBarButton('新会话').disabled).toBe(true)
      expect(threadBarButton('删除会话').disabled).toBe(true)

      threadBarButton('删除会话').click()
      await nextTick()
      // 就算确认框被点出来了，handler 也会因为还在生成中直接返回
      const confirm = [...document.querySelectorAll<HTMLButtonElement>('.n-popconfirm button')]
        .find((item) => item.textContent?.trim() === '确定')
      confirm?.click()
      await nextTick()
      expect(threadCalls.deleted).toEqual([])
    } finally { app.unmount() }
  })
})
