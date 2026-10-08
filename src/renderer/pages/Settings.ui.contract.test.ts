import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Settings section framework contract', () => {
  it('keeps seven session-only keyboard-native sections in the fixed order', async () => {
    const source = await readFile(new URL('./Settings.vue', import.meta.url), 'utf-8')
    expect(source).toContain("type SettingsSection = 'appearance' | 'library' | 'tts' | 'ai' | 'siteRules' | 'backup' | 'about'")
    expect(source).toContain("const activeSection = ref<SettingsSection>('appearance')")
    expect(source).toContain("{ id: 'appearance', label: '外观' }")
    expect(source).toContain("{ id: 'library', label: '书库' }")
    expect(source).toContain("{ id: 'tts', label: '听书' }")
    expect(source).toContain("{ id: 'ai', label: 'AI' }")
    expect(source).toContain("{ id: 'siteRules', label: '站点规则' }")
    expect(source).toContain("{ id: 'backup', label: '备份与恢复' }")
    expect(source).toContain("{ id: 'about', label: '关于' }")
    expect(source).toContain('class="settings-nav-item"')
    expect(source).toContain('@click="activeSection = section.id"')
    expect(source).toContain(':aria-current="activeSection === section.id ? \'page\' : undefined"')
  })

  it('keeps each panel mounted and source prefill locates site rules', async () => {
    const source = await readFile(new URL('./Settings.vue', import.meta.url), 'utf-8')
    for (const id of ['appearance', 'library', 'tts', 'ai', 'siteRules', 'backup', 'about']) {
      expect(source).toContain(`v-show="activeSection === '${id}'"`)
    }
    expect(source).toContain("ruleHost.value = props.prefillHost ?? ''")
    expect(source).toContain("activeSection.value = 'siteRules'")
    expect(source).not.toContain('v-if="activeSection')
  })

  it('keeps the responsive shell and semantic first-load feedback', async () => {
    const source = await readFile(new URL('./Settings.vue', import.meta.url), 'utf-8')
    expect(source).toContain('max-width: 1120px')
    expect(source).toContain('grid-template-columns: 180px minmax(0, 1fr);\n  gap: var(--space-6)')
    expect(source).toContain('grid-template-columns: 160px minmax(0, 1fr);\n    gap: var(--space-4)')
    expect(source).toContain('overflow-x: hidden')
    expect(source).toContain('overflow-y: auto')
    expect(source).toContain('role="status" aria-label="正在加载设置"')
    expect(source).toContain('<n-spin size="medium" />')
    expect(source).toContain('color: var(--text-muted)')
    expect(source).toContain('字体、行距、主题和列宽请在阅读器的“外观”面板中调整。')
    expect(source).not.toContain('color:#888')
  })
})
