import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_PREFS } from '../shared/types'
import {
  customOriginNeedsConfirmation,
  inferAiProvider,
  isLegacyDeepSeekModelName,
  normalizeAiServiceOrigin,
  trustCustomOrigin,
} from './aiSettings'

describe('AI settings origin safety', () => {
  it('normalizes by protocol, host and effective port while ignoring paths', () => {
    expect(normalizeAiServiceOrigin('https://Example.COM/v1/chat')).toBe('https://example.com')
    expect(normalizeAiServiceOrigin('https://example.com:443/other')).toBe('https://example.com')
    expect(normalizeAiServiceOrigin('http://example.com:8080/v1')).toBe('http://example.com:8080')
    expect(normalizeAiServiceOrigin('ftp://example.com')).toBeNull()
    expect(normalizeAiServiceOrigin('https://user:secret@example.com')).toBeNull()
  })

  it('reuses path changes but requires protocol or port changes to be confirmed', () => {
    const trusted = ['https://example.com']
    expect(customOriginNeedsConfirmation('custom', 'https://example.com/v2', trusted)).toBeNull()
    expect(customOriginNeedsConfirmation('custom', 'http://example.com/v2', trusted)).toBe('http://example.com')
    expect(customOriginNeedsConfirmation('custom', 'https://example.com:8443/v2', trusted)).toBe('https://example.com:8443')
  })

  it('treats legacy custom URLs as custom even when old prefs defaulted to deepseek', () => {
    expect(inferAiProvider('https://api.deepseek.com/v1', 'deepseek')).toBe('deepseek')
    expect(inferAiProvider('https://legacy.example/v1', 'deepseek')).toBe('custom')
    expect(inferAiProvider('http://api.deepseek.com/v1', 'deepseek')).toBe('custom')
    expect(inferAiProvider('https://api.deepseek.com:8443/v1', 'deepseek')).toBe('custom')
    expect(inferAiProvider('https://api.deepseek.com/v1', 'custom')).toBe('custom')
  })

  it('adds a trusted origin once without mutating other AI preferences', () => {
    const first = trustCustomOrigin(DEFAULT_AI_PREFS, 'https://example.com')
    const second = trustCustomOrigin(first, 'https://example.com')
    expect(second.trustedCustomOrigins).toEqual(['https://example.com'])
    expect(second.promptMode).toEqual(DEFAULT_AI_PREFS.promptMode)
  })

  it('recognizes only the two legacy DeepSeek model names', () => {
    expect(isLegacyDeepSeekModelName(' DeepSeek-Chat ')).toBe(true)
    expect(isLegacyDeepSeekModelName('deepseek-reasoner')).toBe(true)
    expect(isLegacyDeepSeekModelName('deepseek-v4-flash')).toBe(false)
  })
})
