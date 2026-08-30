import { describe, expect, it } from 'vitest'
import { displayAiServiceOrigin } from './aiAssistantTransparency'

describe('AI service origin display', () => {
  it('shows only normalized HTTP(S) origins', () => {
    expect(displayAiServiceOrigin('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com')
    expect(displayAiServiceOrigin('http://localhost:8080/v1?token=hidden')).toBe('http://localhost:8080')
  })

  it('never echoes credentials or malformed sensitive strings', () => {
    expect(displayAiServiceOrigin('https://user:secret@example.com/v1')).toBe('无效地址')
    expect(displayAiServiceOrigin('not-a-url?api_key=SECRET')).toBe('无效地址')
    expect(displayAiServiceOrigin('file:///tmp/model')).toBe('无效地址')
  })
})
