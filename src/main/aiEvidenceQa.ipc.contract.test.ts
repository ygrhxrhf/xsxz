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

  it('uses a detached retry snapshot and an empty stopped terminal during save', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const start = source.indexOf("ipcMain.handle('ai.chatStream'")
    const end = source.indexOf("ipcMain.handle('ai.chat'", start)
    const block = source.slice(start, end)
    expect(block).toContain('const retrySave = () => writeChat(args.bookId, completedMessages)')
    expect(block).toContain("stoppedEvent: aiStoppedDoneEvent(jobId, '')")
    expect(block).toContain('retrySave,')
    expect(block).toContain('() => writeChat(args.bookId, completedMessages, { signal })')
  })
})
