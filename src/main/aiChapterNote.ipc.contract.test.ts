import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/**
 * src/main/index.ts 在 vitest 下不可 import（它一加载就要求 Electron），
 * 因此这里沿仓内既有做法把手柄源码当文本读出来，锁住「顺序」与「形状」。
 */
async function handlerSlice(startChannel: string, endChannel: string): Promise<string> {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
  const start = source.indexOf(`ipcMain.handle('${startChannel}'`)
  const end = source.indexOf(`ipcMain.handle('${endChannel}'`, start + 1)
  expect(start, startChannel).toBeGreaterThanOrEqual(0)
  expect(end, endChannel).toBeGreaterThan(start)
  return source.slice(start, end)
}

function noteStart(): Promise<string> {
  return handlerSlice('ai.chapterNote', 'ai.chapterNotes')
}

function notesListStart(): Promise<string> {
  return handlerSlice('ai.chapterNotes', 'ai.saveChapterNote')
}

function noteSaveStart(): Promise<string> {
  return handlerSlice('ai.saveChapterNote', 'ai.clean')
}

describe('ai.chapterNote 接线契约', () => {
  it('只取当前章正文与当前章的划线，不带坐标也不牵动别的章', async () => {
    const block = await noteStart()
    expect(block.indexOf('章节不存在')).toBeLessThan(block.indexOf('readChapter('))
    expect(block.match(/readChapter\(/g), '本次请求只读这一章').toHaveLength(1)
    expect(block).toContain('readChapter(args.bookId, args.chapterId)')
    expect(block).toContain("item.chapterId === args.chapterId && item.kind === 'highlight' && item.excerpt.trim()")
    expect(block).toContain('excerpt: item.excerpt')
    expect(block).not.toContain('item.start')
    expect(block).not.toContain('item.end')
    expect(block).not.toContain('readSummaries')
    expect(block).not.toContain('readAiMemory')
  })

  it('先拦下手改覆盖与超预算，再读 Key、再建任务', async () => {
    const block = await noteStart()
    expect(block).toContain('existing?.userEdited && args.overwriteUserNote !== true')
    expect(block).toContain('userNoteConfirmedRequired: true')
    expect(block.indexOf('planChapterNoteRequest')).toBeLessThan(block.indexOf('confirmationRequired: true'))
    expect(block).toContain('plan.requiresConfirmation || budgetWarning')
    expect(block).toContain('args.confirmOverBudget !== true')
    expect(block.indexOf('userNoteConfirmedRequired')).toBeLessThan(block.indexOf('getApiKey()'))
    expect(block.indexOf('confirmationRequired: true')).toBeLessThan(block.indexOf('getApiKey()'))
    expect(block.indexOf('getApiKey()')).toBeLessThan(block.indexOf('aiStart('))
    expect(block.indexOf('请先在设置中配置 API Key')).toBeLessThan(block.indexOf('aiStart('))
  })

  it('笔记任务走交互车道，写入与记忆串行，重复点击复用同一任务', async () => {
    const block = await noteStart()
    expect(block).toContain("lane: 'interactive'")
    expect(block).toContain("cls: 'chapterNote'")
    expect(block).toContain('resource: `${args.bookId}:write`')
    expect(block).toContain('dedupeKey: `note:${args.bookId}:${args.chapterId}`')
    expect(block).toContain("{ task: 'chapterNote', advisor }")
    expect(block).toContain("sendAiBudget(jobId, 'chapterNote', plan.budget)")
    expect(block.indexOf('sendAiBudget')).toBeLessThan(block.indexOf('sendAiStage(jobId, \'preparing\')'))
  })

  it('边生成边推增量，停止也要把已生成的部分带回界面', async () => {
    const block = await noteStart()
    expect(block).toContain('streamAiTaskCompletion(')
    expect(block.indexOf('partial += delta')).toBeLessThan(block.indexOf("send('ai.chunk'"))
    expect(block).toContain("send('ai.chunk', { jobId, delta })")
    expect(block).toContain('stoppedEvent: aiStoppedDoneEvent(jobId, partial)')
    expect(block).toContain('if (signal.aborted)')
    expect(block.match(/aiStoppedDoneEvent\(jobId, partial\)/g), '正常停止与异常中止都带回部分回答')
      .toHaveLength(2)
  })

  it('hash 与发送正文同源，落盘在保存回调里且尊重取消信号', async () => {
    const block = await noteStart()
    expect(block).toContain('const bodyHash = chapterBodyHash(chapter.body)')
    expect(block.indexOf('chapterBodyHash')).toBeLessThan(block.indexOf('aiStart('))
    expect(block.indexOf('saveAiDone')).toBeLessThan(block.indexOf('writeChapterNote('))
    expect(block).toContain('text: result.text')
    expect(block).toContain('}, { signal })')
    expect(block.indexOf('persistAiUsage')).toBeLessThan(block.indexOf('saveAiDone'))
  })
})

describe('ai.chapterNotes 与 ai.saveChapterNote 接线契约', () => {
  it('列表按目录章序返回，只为读者正看着的那一章算过期', async () => {
    const block = await notesListStart()
    expect(block).toContain('filter((note) => order.has(note.chapterId))')
    expect(block).toContain('order.get(left.chapterId)')
    expect(block.match(/readChapter\(/g), '别章不读正文，也就无法谎报新鲜度').toHaveLength(1)
    expect(block.indexOf('if (currentNote)')).toBeLessThan(block.indexOf('readChapter('))
    expect(block).toContain('readChapter(args.bookId, currentNote.chapterId)')
    expect(block).toContain('isChapterNoteStale(currentNote, chapterBodyHash(chapter.body))')
    expect(block).toContain('return { ok: true, notes, current }')
  })

  it('读笔记不需要 API Key，也不写盘', async () => {
    const block = await notesListStart()
    expect(block).not.toContain('getApiKey()')
    expect(block).not.toContain('writeChapterNote(')
    expect(block).not.toContain('aiStart(')
  })

  it('手动保存一定标 userEdited，空正文在读取章节之前就被拒', async () => {
    const block = await noteSaveStart()
    expect(block.indexOf('章节不存在')).toBeLessThan(block.indexOf('readChapter('))
    expect(block.indexOf('笔记不能为空')).toBeLessThan(block.indexOf('readChapter('))
    expect(block).toContain('const text = args.text.trim()')
    expect(block).toContain('userEdited: true')
    expect(block).toContain('return { ok: true, note }')
    expect(block).not.toContain('aiStart(')
  })
})

describe('本章笔记的类型与 preload 表面', () => {
  it('三个频道都只暴露必要参数，返回值用共享类型', async () => {
    const preload = await readFile(new URL('../preload/index.ts', import.meta.url), 'utf-8')
    expect(preload).toContain("ipcRenderer.invoke('ai.chapterNote'")
    expect(preload).toContain("ipcRenderer.invoke('ai.chapterNotes'")
    expect(preload).toContain("ipcRenderer.invoke('ai.saveChapterNote'")
    expect(preload).toContain('chapterNotes: (bookId: string, chapterId?: string)')
    expect(preload).toContain('Promise<AiChapterNotesResult>')
  })

  it('过期判定只出现在 current 上，列表条目不带 stale', async () => {
    const types = await readFile(new URL('../shared/types.ts', import.meta.url), 'utf-8')
    const start = types.indexOf('export type AiChapterNotesResult')
    expect(start).toBeGreaterThanOrEqual(0)
    const block = types.slice(start, types.indexOf('\nexport ', start + 1))
    expect(block).toContain('notes: AiChapterNote[]')
    expect(block).toContain('current: (AiChapterNote & { stale: boolean }) | null')
    expect(block).toContain('{ ok: false; message: string }')
    expect(block.match(/stale/g)).toHaveLength(1)
  })
})
