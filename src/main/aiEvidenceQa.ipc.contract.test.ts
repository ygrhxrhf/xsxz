import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function chatStreamBlock(): Promise<string> {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
  const start = source.indexOf("ipcMain.handle('ai.chatStream'")
  return source.slice(start, source.indexOf("ipcMain.handle('ai.chat'", start))
}

describe('evidence QA IPC contract', () => {
  it('reads chapters through the sorted progress plan and does not use the legacy book prompt', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const start = source.indexOf("ipcMain.handle('ai.chatStream'")
    const end = source.indexOf("ipcMain.handle('ai.chat'", start)
    const block = source.slice(start, end)
    expect(block).toContain('planEvidenceChapterReads(book.chapters, progressChapterId)')
    expect(block).toContain('chapters: readPlan.ordered')
    expect(block).toContain('const local = await readChapter(args.bookId, chapterId)')
    expect(block).toContain('executeEvidenceQaPipeline({')
    expect(block).toContain('if (signal.aborted) return { citations: [], uptoChapterId: progressChapterId }')
    expect(block).not.toContain('buildBookChatMessages(')
    // 打分器只由检索编排层调用，IPC 层不再自己读正文、自己拼章节。
    expect(block).not.toContain('selectLocalEvidence(')
  })

  it('keeps the legacy channel compatible but disables its unsafe direct-book path', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    expect(source).toContain("ipcMain.handle('ai.chat', async () => ({ ok: false, message: '请使用已读证据问答' }))")
    const start = source.indexOf("ipcMain.handle('ai.chat', async () =>")
    const end = source.indexOf("ipcMain.handle(\n    'ai.test'", start)
    const block = source.slice(start, end)
    expect(block).not.toContain('readChapter(')
    expect(block).not.toContain('chatAboutBook(')
    expect(block).not.toContain('runAiTaskCompletion(')
  })

  it('uses a detached retry snapshot and an empty stopped terminal during save', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const start = source.indexOf("ipcMain.handle('ai.chatStream'")
    const end = source.indexOf("ipcMain.handle('ai.chat'", start)
    const block = source.slice(start, end)
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
