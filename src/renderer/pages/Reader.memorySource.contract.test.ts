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

describe('Reader memory source navigation contract', () => {
  it('reads local plain text, relocates, and opens the matching paragraph', async () => {
    const source = await readReaderSurface()
    const start = source.indexOf('async function jumpToMemorySource')
    const end = source.indexOf('async function markMemoryItem', start)
    const block = source.slice(start, end)
    expect(block).toContain('window.api.library.readChapter(book.value.id, source.chapterId)')
    expect(block).toContain('splitIntoParagraphs(result.chapter.body)')
    expect(block).toContain('locateMemorySourceParagraph(')
    expect(block).toContain('memorySourceJumping.value = true')
    expect(block).toContain('pendingScrollPara.set(location.paragraphIndex)')
    expect(block).toContain('await openChapter(chapter, 0)')
    expect(block).toContain('pendingScrollPara.set(-1)')
    expect(block).toContain('memorySourceJumping.value = false')
    expect(block).toContain('原段落已变化，已跳到该章开头。')
    expect(block).not.toContain('innerHTML')
    expect(block).not.toContain('v-html')
  })

  it('renders every source as a keyboard-accessible plain-text button', async () => {
    const source = await readReaderSurface()
    // 记忆看板里每个来源都要能跳回原文：人物、关系、伏笔、事件、时间线各一处
    expect(source.match(/<button v-for="source in item.sources"/g)).toHaveLength(5)
    expect(source.match(/@click="jumpToMemorySource\(source\)"/g)).toHaveLength(5)
    expect(source).toContain('· 查看原文</button>')
    expect(source).toContain('来源章节不存在')
    expect(source).toContain('来源章节正文不可用')
  })
})
