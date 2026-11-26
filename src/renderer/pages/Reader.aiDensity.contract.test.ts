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
  it('模型端点、已读截止、用量收在默认收起的运行信息面板里', async () => {
    const source = await readerSource()
    // 常驻只留一行状态条；这些核对信息必须还在，但只在面板展开时出现。
    expect(source).toContain('class="ai-status-bar"')
    const panelStart = source.indexOf('<div v-show="aiRuntimeOpen" class="ai-runtime-panel">')
    expect(panelStart, '缺少运行信息面板').toBeGreaterThan(0)
    // 面板一直包到「本次发送范围 / 用量」之后，下一条注释是它的收口边界。
    const panelEnd = source.indexOf('<!-- 只在真需要告知时浮出来', panelStart)
    const runtimeBlock = source.slice(panelStart, panelEnd)

    expect(runtimeBlock).toContain('模型服务：{{ aiServiceOrigin')
    expect(runtimeBlock).toContain('已读截止：')
    expect(runtimeBlock).toContain('仅包含当前阅读进度以内的内容，不发送未读章节。')
    expect(runtimeBlock).toContain('本书累计')
    expect(runtimeBlock).toContain('材料覆盖到')
    expect(runtimeBlock).toContain('读完一章后整理')

    // 默认收起：面板由 aiRuntimeOpen 控制，初值 false。
    expect(source).toContain('const aiRuntimeOpen = ref(false)')

    // 面板之外不应再有第二份同样的常驻说明或底部重复折叠栏。
    const outside = source.slice(0, panelStart) + source.slice(panelEnd)
    expect(outside).not.toContain('仅包含当前阅读进度以内的内容，不发送未读章节。')
    expect(outside).not.toContain('class="ai-follow-panel"')
  })

  it('问答 tab 只有一处空状态提示，不再叠一层 .chat-empty', async () => {
    const source = await readerSource()
    const qaStart = source.indexOf('data-ai-pane="qa"')
    const qaEnd = source.indexOf('data-ai-pane="notes"')
    const qaBlock = source.slice(qaStart, qaEnd)
    expect(qaBlock).toContain('sider-welcome')
    expect(qaBlock).not.toContain('class="chat-empty"')
  })

  it('前情 tab 去掉字数单选与材料覆盖冗余提示，直接聚焦前情内容', async () => {
    const source = await readerSource()
    const recapStart = source.indexOf('data-ai-pane="recap"')
    const recapEnd = source.indexOf('data-ai-pane="memory"')
    const recapBlock = source.slice(recapStart, recapEnd)
    expect(recapBlock).toContain('刷新前情')
    expect(recapBlock).not.toContain('materialCoverage')
    expect(recapBlock).not.toContain('recapLength')
  })

  it('对话区独立滚动，右侧工具栏固定不出滚动条，且去掉底部脚标条', async () => {
    const source = await readerSource()
    expect(source).not.toContain('sider-footer-strip')
    expect(source).not.toContain('sider-promo-pill')
    expect(source).toContain('.chat-messages {\n  flex: 1 1 0%;\n  min-height: 0;\n  overflow-y: auto;')
    expect(source).toContain('.ai-top-bar.sider-rail { flex-shrink: 0; height: 100%; overflow: hidden; }')
    expect(source).toContain('--sider-bg: #f5f6f8;')
    expect(source).toContain('--sider-card-bg: #ffffff;')
  })
})
