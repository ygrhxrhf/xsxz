import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('evidence QA IPC contract', () => {
  it('reads chapters through the sorted progress plan and does not use the legacy book prompt', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const start = source.indexOf("ipcMain.handle('ai.chatStream'")
    const end = source.indexOf("ipcMain.handle('ai.chat'", start)
    const block = source.slice(start, end)
    expect(block).toContain('planEvidenceChapterReads(book.chapters, progressChapterId)')
    expect(block).toContain('index > readPlan.progressPosition')
    expect(block).toContain('const local = await readChapter(args.bookId, chapter.id)')
    expect(block).toContain('executeEvidenceQaPipeline({')
    expect(block).not.toContain('buildBookChatMessages(')
    expect(block).not.toContain('readSummaries(')
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
    expect(block).toContain("stoppedEvent: aiStoppedDoneEvent(jobId, '')")
    expect(block).toContain('retrySave,')
    expect(block).toContain('() => writeChat(args.bookId, completedMessages, { signal })')
  })
})
