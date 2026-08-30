import { describe, expect, it } from 'vitest'
import {
  assistantKindForJob,
  clearRetriedAssistantSaveToken,
  currentAssistantStage,
  removeAssistantStage,
  updateAssistantSaveToken,
} from './aiAssistantStatus'

const jobs = { recap: 'r1', memory: 'm1', qa: 'q1' }

describe('assistant stage lifecycle', () => {
  it('retains an early stage until the matching job id is registered and isolates tabs', () => {
    const stages = { r1: 'requesting', m1: 'saving' } as const
    expect(currentAssistantStage(stages, 'recap', { ...jobs, recap: '' })).toBeUndefined()
    expect(currentAssistantStage(stages, 'recap', jobs)).toBe('requesting')
    expect(currentAssistantStage(stages, 'memory', jobs)).toBe('saving')
    expect(currentAssistantStage(stages, 'qa', jobs)).toBeUndefined()
  })

  it('filters unknown jobs and removes only the completed stage', () => {
    expect(assistantKindForJob('translate', jobs)).toBeNull()
    expect(assistantKindForJob('m1', jobs)).toBe('memory')
    expect(removeAssistantStage({ r1: 'requesting', m1: 'saving' }, 'r1'))
      .toEqual({ m1: 'saving' })
  })
})

describe('assistant save token lifecycle', () => {
  it('keeps a token across failed or different-kind completions', () => {
    const current = { token: 'save-old', kind: 'memory' as const }
    expect(updateAssistantSaveToken(current, 'memory', { ok: false })).toEqual(current)
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
