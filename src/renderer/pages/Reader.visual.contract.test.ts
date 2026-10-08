import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Reader visual surface contract', () => {
  it('uses semantic reader surfaces for the toolbar, panels, progress, and interaction states', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    for (const token of ['--r-surface: var(--surface-2)', '--r-hover: var(--hover)', '--r-focus: var(--focus)']) {
      expect(source).toContain(token)
    }
    expect(source).toContain('background: color-mix(in srgb, var(--r-bar-bg) 94%, var(--r-surface))')
    expect(source).toContain('border-radius: var(--radius-card)')
    expect(source).toContain('border-radius: var(--radius-overlay)')
    expect(source).toContain('background: var(--r-surface)')
    expect(source).toContain('.tool-button:hover { background: var(--r-hover); }')
    expect(source).toContain('.chapter-hotzone:not(:disabled):hover, .chapter-hotzone:not(:disabled):focus-visible { opacity: 1; background: var(--r-hover); }')
    expect(source).not.toContain('.chapter-hotzone:not(:disabled):hover, .chapter-hotzone:not(:disabled):focus-visible { opacity: 1; background: var(--hover); }')
    expect(source).toContain('outline: 2px solid var(--r-focus)')
    expect(source).toContain('行焦点')
    expect(source).toContain('para-unfocused')
  })

  it('preserves the reader interaction structure and motion safety rails', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain('class="reader-toolbar"')
    expect(source).not.toContain(':class="[\'reader-toolbar\', { visible: toolsVisible }]"')
    expect(source).toContain('class="tool-panel"')
    expect(source).toContain('v-model:show="showDrawer" placement="left" :width="320"')
    expect(source).toContain('v-model:show="showAiResult" placement="right" :width="420"')
    expect(source).toContain('v-model:show="showAiAssistant" placement="right" :width="420"')
    expect(source).toContain('v-model:show="showMarks" placement="left" :width="340"')
    expect(source).toContain('v-model:show="showSearch" placement="right" :width="420"')
    expect(source).toContain('@media (prefers-reduced-motion: reduce)')
    expect(source).toContain('transition: none !important; animation: none !important; scroll-behavior: auto !important;')
    expect(source).toContain('.reader-toolbar .reader-book-title { min-width: 0; }')
    expect(source).toContain('readerScrollBehavior(window.matchMedia?.(\'(prefers-reduced-motion: reduce)\')?.matches === true)')
  })
})
