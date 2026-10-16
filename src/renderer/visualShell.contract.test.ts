import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/** 本机检出为 CRLF：断言里写的是 \n，读进来先归一，免得契约被行尾绊倒。 */
async function readRendererSource(name: 'App.vue' | 'styles.css'): Promise<string> {
  return (await readFile(new URL(`./${name}`, import.meta.url), 'utf-8')).replace(/\r\n/g, '\n')
}

describe('shared visual shell contract', () => {
  it('keeps the fixed spacing, radius, motion, and semantic skin tokens', async () => {
    const styles = await readRendererSource('styles.css')
    for (const declaration of [
      '--space-1: 4px',
      '--space-2: 8px',
      '--space-3: 12px',
      '--space-4: 16px',
      '--space-6: 24px',
      '--space-8: 32px',
      '--radius-control: 10px',
      '--radius-card: 16px',
      '--radius-overlay: 18px',
      '--motion-duration: 150ms',
    ]) expect(styles).toContain(declaration)

    expect(styles).toContain("body[data-skin='light']")
    expect(styles).toContain("body[data-skin='dark']")
    for (const token of [
      '--text-primary:', '--text-secondary:', '--text-muted:',
      '--surface-1:', '--surface-2:', '--surface-3:',
      '--border:', '--hover:', '--focus:', '--disabled:',
      '--success:', '--warning:', '--error:', '--info:',
      '--selection-bg:', '--scrollbar-thumb:',
    ]) expect(styles.split(token).length - 1).toBeGreaterThanOrEqual(2)
  })

  it('keeps focus, non-color status cues, and reduced-motion safeguards', async () => {
    const styles = await readRendererSource('styles.css')
    expect(styles).toContain(":where(button, [role='button'], a, input, textarea, select, [tabindex]):focus-visible")
    expect(styles).toContain('outline: 2px solid var(--focus)')
    expect(styles).toContain(".status-success::before { content: '✓'; }")
    expect(styles).toContain(".status-warning::before { content: '!'; }")
    expect(styles).toContain(".status-error::before { content: '×'; }")
    expect(styles).toContain(".status-info::before { content: 'i'; }")
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(styles).toContain('scroll-behavior: auto !important')
    expect(styles).toContain('animation: none !important')
    expect(styles).toContain('transform: none !important')
  })

  it('keeps the book brand and four visible inline SVG navigation items', async () => {
    const [app, styles, settings] = await Promise.all([
      readRendererSource('App.vue'),
      readRendererSource('styles.css'),
      readFile(new URL('./pages/Settings.vue', import.meta.url), 'utf-8').then((s) => s.replace(/\r\n/g, '\n')),
    ])
    for (const entry of [
      "id: 'browse',\n    label: '浏览'",
      "id: 'library',\n    label: '书库'",
      "id: 'reader',\n    label: '阅读'",
      "id: 'settings',\n    label: '设置'",
    ]) expect(app).toContain(entry)

    expect(app).toContain('<span class="brand-mark" aria-hidden="true">')
    expect(app).toContain('class="nav-icon"')
    expect(app).toContain('v-for="path in item.iconPaths"')
    expect(app).not.toContain('下载中')
    expect(app).toContain('class="sidebar-dl"')
    expect(app).toContain('已下 {{ dlRunning.done }} / {{ dlRunning.total }} 章')
    expect(app).toContain('>取消</button>')
    expect(app).toContain(':aria-current="tab === item.id ? \'page\' : undefined"')
    expect(app).not.toMatch(/[🧭📚📖⚙️📘🌸]/u)
    expect(settings).toContain('class="theme-toggle"')
    expect(styles).toContain('.nav-btn.active::after')
  })

  it('keeps shell lifecycle and Naive UI radii aligned with the design system', async () => {
    const app = await readRendererSource('App.vue')
    expect(app).toContain("const tab = ref<Tab>('browse')")
    expect(app).toContain("const withProgress = books.filter((b) => b.progress)")
    expect(app).toContain("tab.value = 'reader'")
    expect(app.match(/v-show="tab ===/g)).toHaveLength(4)
    expect(app).toContain('unsubProgress = window.api.download.onProgress(onDownloadProgress)')
    expect(app).toContain('unsubProgress?.()')
    expect(app).toContain("const lightOverrides: GlobalThemeOverrides")
    expect(app).toContain("const darkOverrides: GlobalThemeOverrides")
    expect(app).toContain("skin.value === 'dark' ? darkOverrides : lightOverrides")
    expect(app).toContain("normalizeCachedSkin(localStorage.getItem(SKIN_STORAGE_KEY))")
    expect(app).toContain("value === 'dark' || value === 'night' ? 'dark' : 'light'")
  })
})
