import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Reader AI task status contract', () => {
  it('subscribes and unsubscribes stage events with fixed Chinese copy', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    const status = await readFile(new URL('./aiAssistantStatus.ts', import.meta.url), 'utf-8')
    expect(source).toContain('window.api.ai.onStage((event) =>')
    expect(source).toContain('unsubAiStage?.()')
    // 文案真源在纯函数模块里，界面只负责按 jobId 覆盖阶段与进度句。
    for (const text of [
      '正在准备已读材料…', '正在改写检索问题…', '正在检索本地已读内容…',
      '正在请求模型服务…', '正在保存到本地书库…', '已排队，等待前面的任务完成…',
    ]) expect(status).toContain(text)
    expect(status).toContain("indexing: '正在检索本地已读内容…'")
    expect(source).toContain('[event.jobId]: { stage: event.stage, ...(detail ? { detail } : {}) }')
    expect(source).toContain('describeAssistantStage(currentAssistantStage.value)')
    // 依据由本地检索先算出，必须在正文流完之前就写进气泡。
    expect(source).toContain('if (event.jobId === chatJobId.value && event.citations?.length && chatAssistantIndex.value >= 0)')
    expect(source).toContain('assistant.citations = event.citations')
  })

  it('captures usage, truncation, and save tokens only for assistant jobs', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain('assistantKindForJob(event.jobId, assistantJobIds.value)')
    expect(source).toContain('recap: recapJobId.value')
    expect(source).toContain('memory: memoryJobId.value')
    expect(source).toContain('qa: chatJobId.value')
    expect(source).toContain('lastAssistantUsage.value = event.ok ? event.usage ?? null : null')
    expect(source).toContain('lastAssistantTruncated.value = event.ok ? event.truncated === true : false')
    expect(source).toContain('updateAssistantSaveToken(assistantSaveState.value, assistantKind, event)')
    expect(source).toContain('removeAssistantStage(assistantStages.value, event.jobId)')
    expect(source).toContain('服务未返回 token 用量。')
    expect(source).toContain('回答可能因输出上限而截断。')
  })

  it('retries only the captured save token without restarting model work', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    const start = source.indexOf('async function retryAssistantSave')
    const end = source.indexOf('async function setRecapLength', start)
    const block = source.slice(start, end)
    expect(block).toContain('const token = assistantSaveState.value.token')
    // 补写只该等它自己那一类任务，别的 tab 在跑不该挡住这次重试。
    expect(block).toContain('assistantSaveBusy.value')
    expect(block).not.toContain('assistantBusyByKind.value')
    expect(block).toContain('window.api.ai.retrySave(token)')
    expect(block).toContain('runAiSaveRecovery(async () =>')
    expect(block).toContain('clearRetriedAssistantSaveToken(assistantSaveState.value, token)')
    expect(block).toContain("message.success('结果已保存')")
    expect(block).not.toContain('storySoFar(')
    expect(block).not.toContain('updateMemory(')
    expect(block).not.toContain('chatStream(')
  })

  it('blocks chat clearing, memory marking, and library recap writes during recovery', async () => {
    const reader = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    const library = await readFile(new URL('./Library.vue', import.meta.url), 'utf-8')
    expect(reader).toContain("item.accuracy !== 'normal' || assistantSaveRetrying.value")
    expect(reader).toContain('chatLoading.value || assistantSaveRetrying.value')
    expect(library).toContain('aiSaveRecoveryActive.value')
    expect(library).toContain('!recapBook?.progress?.chapterId || aiSaveRecoveryActive')
  })
})
