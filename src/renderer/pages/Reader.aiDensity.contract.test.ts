import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/**
 * 划词问答的界面接线：工具栏第一个按钮→行内卡片→「在侧边栏中继续」。
 * 这些断言看的是「Reader.vue 里有没有接上」，而不是渲染结果。
 */
async function readerSource(): Promise<string> {
  return readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
}

describe('划词问答的完整链路', () => {
  it('工具栏最左侧是询问 AI，默认钉住', async () => {
    const source = await readerSource()
    expect(source).toContain('v-for="action in pinnedBarActions"')
    expect(source).toContain("case 'ask': openInlineAsk(); return")
    // 行内卡片与工具条是两个独立层：卡片在 z-index 之上，工具条不跟着它重绘。
    expect(source).toContain('class="inline-ask"')
  })

  it('卡片里有输入、发送、流式回答与侧栏入口', async () => {
    const source = await readerSource()
    expect(source).toContain('inlineAsk.submit()')
    expect(source).toContain('inlineAsk.continueInSidebar()')
    expect(source).toContain('在侧边栏中继续')
    expect(source).toContain('inlineAsk.appendDelta(jobId, delta)')
    expect(source).toContain('inlineAsk.finish(event)')
  })

  it('在侧边栏继续会把对话原样搬进侧栏的问答页签', async () => {
    const assistant = await readFile(new URL('./readerAssistant.ts', import.meta.url), 'utf-8')
    const start = assistant.indexOf('const inlineAsk = useInlineAsk({')
    // 块尾：行内问答定义后面的「message,\n})」收口，不能按 `return {` 找——handOff 里也有它。
    const end = assistant.indexOf('  message,\n})', start)
    const block = assistant.slice(start, end)
    expect(block).toContain("aiAssistantTab.value = 'qa'")
    expect(block).toContain('showAiAssistant.value = true')
    expect(block).toContain('chatMessages.value = [...chatMessages.value, ...turns.flatMap')
    // 询问 AI 与侧栏用同一条书籍 agent 通道；解释字词走纯字词释义 explainText，不带书籍上下文。
    expect(block).toContain('window.api.ai.agentChat')
    expect(block).toContain('window.api.ai.explainText')
  })
})

describe('AI 侧栏的信息层级', () => {
  it('模型端点、已读截止、用量收在默认折叠的 <details> 里', async () => {
    const source = await readerSource()
    // 这些文案必须还在（它们是核对信息），但只能在折叠区里出现。
    const detailsStart = source.indexOf('<details class="ai-runtime-info">')
    expect(detailsStart, '缺少运行信息折叠区').toBeGreaterThan(0)
    const detailsEnd = source.indexOf('</details>', detailsStart)
    const runtimeBlock = source.slice(detailsStart, detailsEnd)

    expect(runtimeBlock).toContain('模型服务：{{ aiServiceOrigin')
    expect(runtimeBlock).toContain('已读截止：')
    expect(runtimeBlock).toContain('仅包含当前阅读进度以内的内容，不发送未读章节。')
    expect(runtimeBlock).toContain('本书累计')

    // 默认不收开：标签上不能带 open。
    expect(source).not.toContain('<details class="ai-runtime-info" open>')

    // 折叠区之外不应再有第二份同样的常驻说明。
    const outside = source.slice(0, detailsStart) + source.slice(detailsEnd)
    expect(outside).not.toContain('仅包含当前阅读进度以内的内容，不发送未读章节。')
  })

  it('问答 tab 只有一处空状态提示，不再叠一层 .chat-empty', async () => {
    const source = await readerSource()
    const qaStart = source.indexOf('<n-tab-pane name="qa" tab="问答">')
    const qaEnd = source.indexOf('<n-tab-pane name="notes" tab="笔记">')
    const qaBlock = source.slice(qaStart, qaEnd)
    // 欢迎态自己承担空状态，旧的 chat-empty 必须删掉。
    expect(qaBlock).toContain('sider-welcome')
    expect(qaBlock).not.toContain('class="chat-empty"')
  })

  it('前情 tab 的取材覆盖只有一行，不再是大面板', async () => {
    const source = await readerSource()
    const recapStart = source.indexOf('<n-tab-pane name="recap" tab="前情">')
    const recapEnd = source.indexOf('<n-tab-pane name="memory" tab="记忆">')
    const recapBlock = source.slice(recapStart, recapEnd)
    expect(recapBlock).toContain('缺摘要')
    // 覆盖信息用一行 subtle，不再套 ai-budget-status 卡片。
    expect(recapBlock).not.toMatch(/materialCoverage[^]*?class="ai-budget-status"/)
  })
})
