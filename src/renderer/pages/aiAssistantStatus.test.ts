import { describe, expect, it } from 'vitest'
import {
  assistantKindForJob,
  clearRetriedAssistantSaveToken,
  currentAssistantStage,
  describeAssistantStage,
  removeAssistantStage,
  updateAssistantSaveToken,
} from './aiAssistantStatus'

const jobs = { recap: 'r1', memory: 'm1', qa: 'q1', notes: 'n1' }

describe('assistant stage lifecycle', () => {
  it('retains an early stage until the matching job id is registered and isolates tabs', () => {
    const stages = { r1: { stage: 'requesting' }, m1: { stage: 'saving', detail: '已排队，前面还有 2 个任务' } } as const
    expect(currentAssistantStage(stages, 'recap', { ...jobs, recap: '' })).toBeUndefined()
    expect(currentAssistantStage(stages, 'recap', jobs)).toEqual({ stage: 'requesting' })
    expect(currentAssistantStage(stages, 'memory', jobs)).toEqual({ stage: 'saving', detail: '已排队，前面还有 2 个任务' })
    expect(currentAssistantStage(stages, 'qa', jobs)).toBeUndefined()
    expect(currentAssistantStage(stages, 'notes', jobs)).toBeUndefined()
  })

  it('filters unknown jobs and removes only the completed stage', () => {
    expect(assistantKindForJob('translate', jobs)).toBeNull()
    expect(assistantKindForJob('m1', jobs)).toBe('memory')
    expect(assistantKindForJob('n1', jobs)).toBe('notes')
    expect(removeAssistantStage({ r1: { stage: 'requesting' }, m1: { stage: 'saving' } }, 'r1'))
      .toEqual({ m1: { stage: 'saving' } })
  })

  it('names every stage so a new one never renders an empty bubble', () => {
    expect(describeAssistantStage(undefined)).toBe('')
    expect(describeAssistantStage({ stage: 'preparing' })).toBe('正在准备已读材料…')
    expect(describeAssistantStage({ stage: 'queued' })).toBe('已排队，等待前面的任务完成…')
    expect(describeAssistantStage({ stage: 'indexing' })).toBe('正在检索本地已读内容…')
    expect(describeAssistantStage({ stage: 'saving' })).toBe('正在保存到本地书库…')
  })

  it('prefers the main-process progress sentence over the generic label', () => {
    expect(describeAssistantStage({ stage: 'queued', detail: '已排队，前面还有 4 个任务' }))
      .toBe('已排队，前面还有 4 个任务')
    expect(describeAssistantStage({ stage: 'indexing', detail: '检索索引已覆盖 800/800 章，本次只读 9 章' }))
      .toBe('检索索引已覆盖 800/800 章，本次只读 9 章')
    // 空白 detail 不能让界面变成一条空消息。
    expect(describeAssistantStage({ stage: 'searching', detail: '   ' })).toBe('正在检索本地已读内容…')
  })
})

describe('assistant save token lifecycle', () => {
  it('keeps a token across failed, stopped, or different-kind completions', () => {
    const current = { token: 'save-old', kind: 'memory' as const }
    expect(updateAssistantSaveToken(current, 'memory', { ok: false })).toEqual(current)
    expect(updateAssistantSaveToken(current, 'memory', { ok: true, stopped: true })).toEqual(current)
    expect(updateAssistantSaveToken(current, 'qa', { ok: true, stopped: true, saveToken: 'save-partial' }))
      .toEqual({ token: 'save-partial', kind: 'qa' })
    expect(updateAssistantSaveToken(current, 'recap', { ok: true })).toEqual(current)
  })

  it('replaces a token with a new failure snapshot and clears it on same-kind saved success', () => {
    expect(updateAssistantSaveToken({ token: '', kind: '' }, 'memory', { ok: true, saveToken: 'save-new' }))
      .toEqual({ token: 'save-new', kind: 'memory' })
    expect(updateAssistantSaveToken({ token: 'save-old', kind: 'memory' }, 'memory', { ok: true }))
      .toEqual({ token: '', kind: '' })
  })

  it('clears only the token that was actually retried', () => {
    expect(clearRetriedAssistantSaveToken({ token: 'save-new', kind: 'recap' }, 'save-old'))
      .toEqual({ token: 'save-new', kind: 'recap' })
    expect(clearRetriedAssistantSaveToken({ token: 'save-old', kind: 'memory' }, 'save-old'))
      .toEqual({ token: '', kind: '' })
  })
})
