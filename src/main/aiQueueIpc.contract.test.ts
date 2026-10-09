import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/**
 * `src/main/index.ts` 在 vitest 下不可导入，队列与阶段接线只能按既有 IPC 契约测试的口径钉住源码，
 * 防止后来者把排队可见性又改回「忙就直接拒绝」。
 */
describe('AI 排队与索引进度的主进程接线', () => {
  it('提交即回报排队：invoke 结果带位次，同时补一个带文案的 queued 阶段', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const start = source.indexOf('function aiStart(')
    const block = source.slice(start, source.indexOf('/** 独占任务同样排队等待', start))
    expect(start).toBeGreaterThan(-1)
    expect(block).toContain("sendAiStage(started.jobId, 'queued', queueWaitingText(started.position))")
    expect(block).toContain('return { ok: true, jobId: started.jobId, queued: started.queued, position: started.position }')
    expect(block).toContain('onCancelled: sendAiQueueCancel')
    expect(block).not.toContain('请先停止当前生成')
  })

  it('问答在读第一章正文之前把剪枝计划推成 indexing 阶段', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const start = source.indexOf("ipcMain.handle('ai.chatStream'")
    const block = source.slice(start, source.indexOf("ipcMain.handle('ai.chat'", start))
    expect(block).toContain('retrieveLocalEvidence({')
    expect(block).toContain("onProgress: (reads) => sendAiStage(jobId, 'indexing', indexingText(reads))")
  })

  it('界面按 jobId 覆盖阶段状态，排队文案不会留到下一个阶段', async () => {
    const reader = await readFile(new URL('../renderer/pages/Reader.vue', import.meta.url), 'utf-8')
    const start = reader.indexOf('unsubAiStage = window.api.ai.onStage')
    const block = reader.slice(start, reader.indexOf('unsubAiBudget', start))
    expect(block).toContain('[event.jobId]: { stage: event.stage, ...(detail ? { detail } : {}) }')
    expect(reader).toContain('const assistantStageText = computed(() => describeAssistantStage(currentAssistantStage.value))')
  })
})
