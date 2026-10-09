import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/** `ai.chatStream` 之后紧接的就是连接测试通道，用它当块尾边界。 */
async function chatStreamBlock(): Promise<string> {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
  const start = source.indexOf("ipcMain.handle('ai.chatStream'")
  return source.slice(start, source.indexOf("ipcMain.handle(\n    'ai.test'", start))
}

describe('evidence QA IPC contract', () => {
  it('reads chapters through the sorted progress plan and does not use the legacy book prompt', async () => {
    const block = await chatStreamBlock()
    expect(block).toContain('planEvidenceChapterReads(book.chapters, progressChapterId)')
    expect(block).toContain('chapters: readPlan.ordered')
    expect(block).toContain('const local = await readChapter(args.bookId, chapterId)')
    expect(block).toContain('executeEvidenceQaPipeline({')
    expect(block).toContain('if (signal.aborted) return { citations: [], uptoChapterId: progressChapterId, topScore: 0 }')
    expect(block).toContain('return { citations, uptoChapterId, topScore }')
    expect(block).not.toContain('buildBookChatMessages(')
    // 打分器只由检索编排层调用，IPC 层不再自己读正文、自己拼章节。
    expect(block).not.toContain('selectLocalEvidence(')
  })

  it('drops the unsafe direct-book channel from both handler and preload surface', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const preload = await readFile(new URL('../preload/index.ts', import.meta.url), 'utf-8')
    expect(source).not.toContain("ipcMain.handle('ai.chat',")
    expect(preload).not.toContain("invoke('ai.chat',")
    expect(source).not.toContain('chatAboutBook(')
  })

  it('uses a detached retry snapshot and an empty stopped terminal during save', async () => {
    const block = await chatStreamBlock()
    expect(block).toContain('const retrySave = () => writeChat(args.bookId, completedMessages)')
    expect(block).toContain('citations: result.citations')
    expect(block).toContain('uptoChapterId: result.uptoChapterId')
    expect(block).toContain('{ version: existingChat.version }')
    expect(block).toContain('const persistedMessages: import')
    expect(block).toContain('[...existingChat.messages]')
    expect(block).not.toContain('args.messages.filter(')
    expect(block).toContain("role: 'assistant', content: result.text, citations: result.citations")
    expect(block).toContain('uptoChapterId: result.uptoChapterId, stopped: true')
    expect(block).toContain('stopped: true,')
    expect(block).toContain('saveStopped: () => writeChat(args.bookId, stoppedMessages)')
    expect(block).toContain('retrySave,')
    expect(block).toContain('() => writeChat(args.bookId, completedMessages, { signal })')
  })

  it('streams the answer field, pushes citations early, and keeps the partial on both stop paths', async () => {
    const block = await chatStreamBlock()
    expect(block).toContain("createJsonStringFieldSink('answer'")
    expect(block).toContain("task: 'evidenceQa', stream: true, signal, onDelta: sink")
    expect(block).toContain("mainWindow?.webContents.send('ai.chunk', { jobId, delta: chunk })")
    expect(block).toContain('sendAiEvidence(jobId, citations, uptoChapterId)')
    expect(block).toContain('const finishStopped = async')
    expect(block.match(/await finishStopped\(\)/g)).toHaveLength(2)
    // 两条停止路径都只能经 finishStopped；流开始前就写盘失败的分支仍可直接发空事件。
    expect(block).toMatch(/kind === 'stopped'\)\s*\{\s*await finishStopped\(\)/)
    expect(block).toMatch(/if \(signal\.aborted\)\s*\{\s*await finishStopped\(\)/)
    expect(block).toContain("role: 'assistant', content: partial, citations: candidateCitations")
    expect(block).toContain('uptoChapterId: upto, stopped: true,')
  })
})
