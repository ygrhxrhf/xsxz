import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_PREFS } from './types'
import { AI_PROMPT_LABELS, BUILTIN_AI_PROMPTS, resolveAiTaskInstruction } from './aiPrompts'

describe('AI task instruction resolution', () => {
  it('defines the six fixed prompt tasks and their built-in editable requirements', () => {
    expect(Object.keys(AI_PROMPT_LABELS)).toEqual([
      'clean', 'translate', 'chapterSummary', 'recap', 'memory', 'evidenceQa',
    ])
    expect(Object.keys(BUILTIN_AI_PROMPTS)).toEqual(Object.keys(AI_PROMPT_LABELS))
    expect(Object.values(BUILTIN_AI_PROMPTS).every((text) => text.trim().length > 0)).toBe(true)
  })

  it('uses the built-in requirement by default', () => {
    expect(resolveAiTaskInstruction(DEFAULT_AI_PREFS, 'clean')).toBe(BUILTIN_AI_PROMPTS.clean)
  })

  it('uses a nonblank custom copy only while custom mode is active', () => {
    const custom = {
      ...DEFAULT_AI_PREFS,
      promptMode: { ...DEFAULT_AI_PREFS.promptMode, translate: 'custom' as const },
      customPrompts: { translate: '  保留专有名词原文。  ' },
    }
    expect(resolveAiTaskInstruction(custom, 'translate')).toBe('保留专有名词原文。')
    expect(resolveAiTaskInstruction({ ...custom, promptMode: DEFAULT_AI_PREFS.promptMode }, 'translate'))
      .toBe(BUILTIN_AI_PROMPTS.translate)
  })

  it('falls back to built-in when a damaged custom prompt is blank', () => {
    const damaged = {
      ...DEFAULT_AI_PREFS,
      promptMode: { ...DEFAULT_AI_PREFS.promptMode, recap: 'custom' as const },
      customPrompts: { recap: '   ' },
    }
    expect(resolveAiTaskInstruction(damaged, 'recap')).toBe(BUILTIN_AI_PROMPTS.recap)
  })
})
