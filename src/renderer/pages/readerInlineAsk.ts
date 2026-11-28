/**
 * 划词行内卡片：承载两种截然不同的 AI 询问方式：
 * 1. 「询问 AI」（mode = 'ask'）：与书籍联系在一起——锁住选中原文、书名、当前章节与前后段上下文，
 *    发给能查记忆与已读章节的书籍 agent，并支持「在侧边栏中继续」追问剧情。
 * 2. 「解释字词」（mode = 'word'）：单纯解释所选字或词本身的读音、本义与常见用法，
 *    与文章内容无关、不附带任何书籍或章节上下文，也不调用书籍 agent。
 */
import { ref, computed } from 'vue'
import { renderMarkdownHtml } from './readerMarkdown'

export type InlineAskStatus = 'idle' | 'loading' | 'ready' | 'error'
export type InlineAskMode = 'ask' | 'word'

export interface InlineAskTurn {
  question: string
  answer: string
}

export interface UseInlineAskDeps {
  /** 当前书与当前章：「询问 AI」需要关联书籍；「解释字词」不需要阅读进度。 */
  canAsk: () => boolean
  /** 选中文字与它所在的书籍/章节/段落上下文。 */
  excerpt: () => string
  context: () => string
  /** 「询问 AI」：走书籍 agent，与本书已读内容联系在一起。 */
  ask: (question: string) => Promise<{ ok: true; jobId: string } | { ok: false; message: string }>
  /** 「解释字词」：单纯解释字词本身的意思，不带书籍与文章上下文。 */
  explainWord?: (word: string) => Promise<{ ok: true; jobId: string } | { ok: false; message: string }>
  /** 把对话交给侧栏并关掉卡片。 */
  handOff: (turns: InlineAskTurn[]) => void
  message: { warning: (text: string) => void }
}

export function useInlineAsk(deps: UseInlineAskDeps) {
  const open = ref(false)
  const mode = ref<InlineAskMode>('ask')
  const question = ref('')
  const answer = ref('')
  const status = ref<InlineAskStatus>('idle')
  const errorText = ref('')
  /** 卡片头部显示被问的那段文字，太长就截断。 */
  const subject = ref('')
  /** 打开卡片瞬间锁住的完整选中文字与书籍上下文，避免点输入框清掉浏览器选区后丢失。 */
  const rawExcerpt = ref('')
  const capturedContext = ref('')
  const activeQuestion = ref('')
  /** 这一问一答，供「在侧边栏继续」原样搬走。 */
  const turns = ref<InlineAskTurn[]>([])
  /** 正在跑的 jobId：ai.chunk/ai.done 按它判断是不是这张卡片的流。 */
  const jobId = ref('')

  const busy = computed(() => status.value === 'loading')
  const canSubmit = computed(() => Boolean(question.value.trim()) && !busy.value)
  /** 回答按 Markdown 渲染：模型回的 `**用法**`、列表、代码块都要真正显示成格式。 */
  const answerHtml = computed(() => renderMarkdownHtml(answer.value))

  /**
   * 钉住：钉住后卡片不随新的划词自动重定位，位置由读者自己拖到哪就是哪
   * （Sider 的卡片右上角也有这个图钉）。
   */
  const pinned = ref(false)
  /** 读者拖动后的落点；null 表示仍跟随选区。 */
  const manualOffset = ref<{ left: number; top: number } | null>(null)

  function togglePinned() {
    pinned.value = !pinned.value
    if (!pinned.value) manualOffset.value = null
  }

  /** 拖动结束：钉住时把当前位置记下来，后续新开卡片沿用它。 */
  function setManualOffset(offset: { left: number; top: number } | null) {
    manualOffset.value = offset
  }

  function show(prefillQuestion = '') {
    if (!deps.canAsk()) {
      deps.message.warning('还没有阅读进度，先读一章再问')
      return
    }
    const excerpt = deps.excerpt().trim()
    if (!excerpt) {
      deps.message.warning('请先选中要提问的文字')
      return
    }
    mode.value = 'ask'
    rawExcerpt.value = excerpt
    capturedContext.value = deps.context().trim()
    subject.value = excerpt.length > 120 ? `${excerpt.slice(0, 120)}…` : excerpt
    question.value = prefillQuestion
    activeQuestion.value = ''
    answer.value = ''
    errorText.value = ''
    turns.value = []
    jobId.value = ''
    status.value = 'idle'
    open.value = true
  }

  /**
   * 划词「解释字词」：只把选中的字或词本身送去解释，
   * 不采集章节标题与文章段落，不与书籍联系在一起。
   */
  async function explainWord() {
    const excerpt = deps.excerpt().trim()
    if (!excerpt) {
      deps.message.warning('请先选中要解释的字或词')
      return
    }
    if (excerpt.length > 800) {
      deps.message.warning('选中过长，请缩短后再问')
      return
    }
    mode.value = 'word'
    rawExcerpt.value = excerpt
    capturedContext.value = ''
    subject.value = excerpt.length > 120 ? `${excerpt.slice(0, 120)}…` : excerpt
    question.value = ''
    activeQuestion.value = `解释字词「${subject.value}」`
    answer.value = ''
    errorText.value = ''
    turns.value = []
    jobId.value = ''
    status.value = 'loading'
    open.value = true
    try {
      const runExplain = deps.explainWord ?? deps.ask
      const res = await runExplain(excerpt)
      if (!res.ok) {
        status.value = 'error'
        errorText.value = res.message
        return
      }
      jobId.value = res.jobId
    } catch (e: unknown) {
      status.value = 'error'
      errorText.value = e instanceof Error ? e.message : String(e)
    }
  }

  function close() {
    open.value = false
    mode.value = 'ask'
    question.value = ''
    activeQuestion.value = ''
    rawExcerpt.value = ''
    capturedContext.value = ''
    answer.value = ''
    errorText.value = ''
    turns.value = []
    jobId.value = ''
    status.value = 'idle'
  }

  async function submit() {
    if (status.value === 'loading') return
    if (mode.value === 'word') {
      const word = rawExcerpt.value || deps.excerpt().trim()
      if (!word) return
      const extra = question.value.trim()
      activeQuestion.value = extra || `解释字词「${subject.value}」`
      answer.value = ''
      errorText.value = ''
      status.value = 'loading'
      try {
        const runExplain = deps.explainWord ?? deps.ask
        const payload = extra ? `${word}\n\n追问：${extra}` : word
        const res = await runExplain(payload)
        if (!res.ok) {
          status.value = 'error'
          errorText.value = res.message
          return
        }
        jobId.value = res.jobId
      } catch (e: unknown) {
        status.value = 'error'
        errorText.value = e instanceof Error ? e.message : String(e)
      }
      return
    }

    const text = question.value.trim()
    if (!text) return
    if (!deps.canAsk()) {
      deps.message.warning('还没有阅读进度，先读一章再问')
      return
    }
    activeQuestion.value = text
    answer.value = ''
    errorText.value = ''
    status.value = 'loading'
    try {
      // 「询问 AI」需要与书籍联系在一起：把锁住的选中原文与章节/段落上下文一并交给书籍 agent。
      const excerpt = rawExcerpt.value || deps.excerpt().trim()
      const context = capturedContext.value || deps.context().trim()
      const prompt = [
        excerpt ? `选中原文：「${excerpt}」` : '',
        context,
        `问题：${text}`,
      ].filter(Boolean).join('\n\n')
      const res = await deps.ask(prompt)
      if (!res.ok) {
        status.value = 'error'
        errorText.value = res.message
        return
      }
      jobId.value = res.jobId
    } catch (e: unknown) {
      status.value = 'error'
      errorText.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 解释字词：重新生成时只重发选中的字词，不掺入任何追问或书籍上下文。 */
  async function regenerate() {
    if (mode.value === 'word' && !question.value.trim()) {
      await explainWord()
      return
    }
    await submit()
  }

  /** 流式增量：只有这张卡片自己那一轮才追加（jobId 由调用方传，双重校验）。 */
  function appendDelta(jobIdIn: string, delta: string) {
    if (!jobId.value || jobIdIn !== jobId.value || status.value !== 'loading') return
    answer.value += delta
  }

  /** 终态：成功则记下一问一答，供后续交棒。 */
  function finish(event: { jobId: string; ok: boolean; text?: string; message?: string; stopped?: boolean }) {
    if (event.jobId !== jobId.value) return
    jobId.value = ''
    if (!event.ok) {
      status.value = 'error'
      errorText.value = event.message ?? '生成失败'
      return
    }
    const text = (event.text ?? answer.value).trim()
    answer.value = text
    status.value = 'ready'
    const asked = question.value.trim() || activeQuestion.value
    if (text && asked) turns.value.push({ question: asked, answer: text })
  }

  /** 点「在侧边栏继续」：把已有对话整段交给侧栏，卡片收起。 */
  function continueInSidebar() {
    if (!turns.value.length) return
    deps.handOff([...turns.value])
    close()
  }

  return {
    open,
    mode,
    question,
    answer,
    status,
    busy,
    canSubmit,
    errorText,
    subject,
    rawExcerpt,
    capturedContext,
    turns,
    jobId,
    show,
    explainWord,
    regenerate,
    answerHtml,
    pinned,
    manualOffset,
    togglePinned,
    setManualOffset,
    close,
    submit,
    appendDelta,
    finish,
    continueInSidebar,
  }
}
