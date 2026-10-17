import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/** 助手面板的实现搬去了 readerAssistant.ts：这些契约断言看的是「实现里有没有这条」，
 *  所以把 Reader.vue 与该模块拼起来看（模板与接线仍在 Reader.vue 里断言）。 */
async function readReaderSurface(): Promise<string> {
  const [reader, assistant] = await Promise.all([
    readFile(new URL('./Reader.vue', import.meta.url), 'utf-8'),
    readFile(new URL('./readerAssistant.ts', import.meta.url), 'utf-8'),
  ])
  return reader + assistant
}

describe('Reader evidence QA UI contract', () => {
  it('keeps v2 evidence metadata in memory when the matching job completes', async () => {
    const source = await readReaderSurface()
    expect(source).toContain('const chatMessages = ref<AiEvidenceChatMessage[]>([])')
    expect(source.match(/normalizeEvidenceChatHistory\([^)]*\.messages\)/g)).toHaveLength(2)
    expect(source).toContain('assistant.citations = event.citations')
    expect(source).toContain('assistant.uptoChapterId = event.uptoChapterId')
    expect(source).toContain('assistant.stopped = event.stopped === true')
    expect(source).toContain('if (!event.text && assistantIndex >= 0) chatMessages.value.splice(assistantIndex, 1)')
  })

  it('renders whitelisted citations as plain-text source buttons and distinguishes legacy answers', async () => {
    const source = await readReaderSurface()
    // v2 逐条结论各挂自己的引用；没有 claims 的旧回答保留一个「未逐条对应」的依据块
    expect(source).toContain('<strong>依据（旧版回答，未逐条对应）</strong>')
    expect(source).toContain('v-for="citation in msg.citations"')
    expect(source).toContain('@click="jumpToMemorySource(citation)"')
    expect(source).toContain('旧版回答，无来源')
    expect(source).toContain('已停止，以下为停止前生成的部分回答。')
    expect(source).not.toContain('v-html')
  })

  it('uses Ctrl+Enter, blocks reader shortcuts in the input, and confirms clearing history', async () => {
    const source = await readReaderSurface()
    expect(source).toContain('@keydown.stop @keyup.ctrl.enter="sendChat"')
    expect(source).not.toContain('@keyup.enter="sendChat"')
    expect(source).toContain('确定清空这本书的全部 AI 问答记录吗？此操作无法撤销。')
    expect(source).toContain('@positive-click="clearChat"')
  })
})
