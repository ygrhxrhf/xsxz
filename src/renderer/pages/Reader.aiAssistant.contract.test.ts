import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Reader unified AI assistant shell', () => {
  it('has one AI assistant drawer with the three fixed tabs', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source.match(/<n-drawer v-model:show="showAiAssistant"/g)).toHaveLength(1)
    expect(source).not.toContain('v-model:show="showChat"')
    expect(source).not.toContain('v-model:show="showRecap"')
    expect(source).toContain('<n-drawer-content title="AI 助手"')
    expect(source).toContain('<n-tab-pane name="recap" tab="前情">')
    expect(source).toContain('<n-tab-pane name="memory" tab="记忆">')
    expect(source).toContain('<n-tab-pane name="qa" tab="问答">')
    expect(source).toContain('已读截止：')
  })

  it('opens from local data only and maps legacy entry intent to a tab', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    const start = source.indexOf('async function openAiAssistant')
    const end = source.indexOf('async function startMemoryJob', start)
    const block = source.slice(start, end)
    expect(block).toContain('Promise.allSettled([')
    expect(block).toContain('loadStoredRecap()')
    expect(block).toContain('loadStoredMemory()')
    expect(block).toContain('window.api.ai.getChat(book.value.id)')
    expect(block).not.toContain('storySoFar(')
    expect(block).not.toContain('updateMemory(')
    expect(block).not.toContain('sendChat(')
    expect(source).toContain("openAiAssistant('recap')")
    expect(source).toContain("openAiAssistant('qa')")
    expect(source).toContain("aiAssistantTab.value = 'qa'")
    expect(source).toContain("recapLoading && aiAssistantTab === 'recap'")
    expect(source).not.toContain('function askSuggested(')
  })
})
