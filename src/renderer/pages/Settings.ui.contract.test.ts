import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Settings section framework contract', () => {
  it('keeps ten session-only keyboard-native sections in the fixed order', async () => {
    const source = (await readFile(new URL('./Settings.vue', import.meta.url), 'utf-8')).replace(/\r\n/g, '\n')
    expect(source).toContain("type SettingsSection = 'appearance' | 'library' | 'network' | 'tts' | 'map' | 'ai' | 'siteRules' | 'backup' | 'agentAudit' | 'about'")
    expect(source).toContain("const activeSection = ref<SettingsSection>('appearance')")
    expect(source).toContain("{ id: 'appearance', label: '外观' }")
    expect(source).toContain("{ id: 'library', label: '书库' }")
    expect(source).toContain("{ id: 'network', label: '网络代理' }")
    expect(source).toContain("{ id: 'tts', label: '听书' }")
    expect(source).toContain("{ id: 'map', label: '书中地图' }")
    expect(source).toContain("{ id: 'ai', label: 'AI' }")
    expect(source).toContain("{ id: 'siteRules', label: '站点规则' }")
    expect(source).toContain("{ id: 'backup', label: '备份与恢复' }")
    expect(source).toContain("{ id: 'agentAudit', label: 'Agent 调用记录' }")
    expect(source).toContain("{ id: 'about', label: '关于' }")
    expect(source).toContain('class="settings-nav-item"')
    expect(source).toContain('@click="activeSection = section.id"')
    expect(source).toContain(':aria-current="activeSection === section.id ? \'page\' : undefined"')
  })

  it('keeps each panel mounted and source prefill locates site rules', async () => {
    const source = (await readFile(new URL('./Settings.vue', import.meta.url), 'utf-8')).replace(/\r\n/g, '\n')
    for (const id of ['appearance', 'library', 'network', 'tts', 'map', 'ai', 'siteRules', 'backup', 'agentAudit', 'about']) {
      expect(source).toContain(`v-show="activeSection === '${id}'"`)
    }
    expect(source).toContain("ruleHost.value = props.prefillHost ?? ''")
    expect(source).toContain("activeSection.value = 'siteRules'")
    expect(source).not.toContain('v-if="activeSection')
  })

  it('mounts the rule-market, sync, and proxy-subscription panels', async () => {
    const source = (await readFile(new URL('./Settings.vue', import.meta.url), 'utf-8')).replace(/\r\n/g, '\n')
    expect(source).toContain("import RuleMarketPanel from '../components/RuleMarketPanel.vue'")
    expect(source).toContain("import SyncPanel from '../components/SyncPanel.vue'")
    expect(source).toContain("import ProxySubscriptionPanel from '../components/ProxySubscriptionPanel.vue'")
    expect(source).toContain('<RuleMarketPanel />')
    expect(source).toContain('<SyncPanel />')
    expect(source).toContain('<ProxySubscriptionPanel @refreshed="onSubscriptionRefreshed" />')
    // 面板重拉订阅后，节点列表要跟着更新（不能各说各话）。
    expect(source).toContain('function onSubscriptionRefreshed(overview: ProxySubscriptionState) {')
    expect(source).toContain('subscriptionOverview.value = overview')
    // 边界说明必须留在界面上：市场不含凭据、同步不含正文与 Key。
    expect(source).toContain('规则市场')
    expect(source).toContain('账号与云同步')
  })

  it('keeps the responsive shell and semantic first-load feedback', async () => {
    const source = (await readFile(new URL('./Settings.vue', import.meta.url), 'utf-8')).replace(/\r\n/g, '\n')
    expect(source).toContain('max-width: 1240px')
    expect(source).toContain('grid-template-columns: 200px minmax(0, 1fr);\n  gap: var(--space-8)')
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
