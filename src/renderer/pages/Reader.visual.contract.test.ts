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
    // 左右侧翻章热区已去掉：切章只走章末卡片与快捷键，避免误点边缘跳章。
    expect(source).not.toContain('chapter-hotzone')
    expect(source).toContain('outline: 2px solid var(--r-focus)')
    expect(source).toContain('行焦点')
    expect(source).toContain('para-unfocused')
  })

  it('keeps popover and toolbar foregrounds on the app chrome palette, not the paper theme', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    // 底栏是深色半透明条，字色是奶油白；面板与顶栏刷的是浅色应用浮层底，
    // 不显式归位就会白底白字（背景面板、真实书籍顶栏的字号/平放按钮都踩过）。
    expect(source).toContain('color: var(--text);\n  animation: bottom-panel-in')
    expect(source).toContain('.bottom-panel .control-label { color: var(--text-secondary); }')
    expect(source).toContain('.reader-toolbar .bottom-button { color: inherit; }')
    // 顶栏与拖拽浮标的底是应用外壳色，夜间主题下不能用纸面字色。
    expect(source).toContain('.reader-toolbar .reader-book-title { flex: 0 1 auto; text-align: left; padding: 0 12px 0 0; font-size: 15px; color: var(--text); }')
    expect(source).toMatch(/\.reader-progress-scrub-hint \{[\s\S]*?color: var\(--text\);/)
    // 面板选项要有可见的浅底，白浮层上不再是透明按钮。
    expect(source).toContain('background: var(--r-surface);\n  color: inherit;')
  })

  it('keeps real-book chrome immersive: no app toolbar, tools in the dock, dark drawer', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    // 真实书籍不摆应用顶栏：工具栏容器只剩一个零高度锚点，入口收进底栏「更多」。
    expect(source).toContain("'reader-toolbar-realbook': isRealBook")
    expect(source).toContain('.reader-toolbar.reader-toolbar-realbook {')
    expect(source).toContain('aria-label="更多"')
    expect(source).toContain("activeBottomPanel === 'more'")
    // 目录 / 标记抽屉跟随参考站刷成暗色。
    expect(source).toContain(':theme="realBookDrawerTheme"')
    expect(source).toContain("'reader-drawer-realbook': isRealBook")
    expect(source).toContain('.reader-drawer-realbook .drawer-tab.active')
  })

  it('keeps the real-book appearance overlay on the dark dock palette', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    // 真实书籍底栏是深色图标带：外观/字体浮层必须跟着刷暗，不能被经典模式的
    // 浅色面板规则盖回白底（白底 + 继承来的奶油白字色 = 整块不可读）。
    expect(source).toContain('.reader-bottombar.is-realbook .bottom-panel {\n  border-color: rgba(233, 220, 188, 0.16);\n  background: rgba(24, 28, 25, 0.96);')
    expect(source).toContain('.reader-bottombar.is-realbook .bottom-panel .control-label { color: rgba(244, 235, 211, 0.58); }')
    expect(source).toContain('.reader-bottombar.is-realbook .bottom-panel .option-grid button {')
    expect(source).toContain('.reader-bottombar.is-realbook .bottom-panel .option-grid button.active {')
  })

  it('preserves the reader interaction structure and motion safety rails', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain('class="reader-toolbar"')
    expect(source).not.toContain(':class="[\'reader-toolbar\', { visible: toolsVisible }]"')
    expect(source).toContain('class="tool-panel"')
    expect(source).toContain('v-model:show="showDrawer"')
    expect(source).toContain('placement="left"')
    expect(source).toContain(':width="drawerTab === \'mindmap\' ? 560 : 320"')
    expect(source).not.toContain('v-model:show="showAiResult"')
    expect(source).toContain('v-model:show="showAiAssistant" placement="right" :width="420"')
    expect(source).toContain('v-model:show="showMarks"')
    expect(source).toContain(':width="340"')
    expect(source).toContain('v-model:show="showSearch" placement="right" :width="420"')
    expect(source).toContain('@media (prefers-reduced-motion: reduce)')
    expect(source).toContain('transition: none !important; animation: none !important; scroll-behavior: auto !important;')
    expect(source).toContain('.reader-toolbar .reader-book-title { min-width: 0; }')
    expect(source).toContain('readerScrollBehavior(window.matchMedia?.(\'(prefers-reduced-motion: reduce)\')?.matches === true)')
  })

  it('takes reading paper colours from the shared theme source', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain("import { READER_THEME_COLORS } from '@shared/readerTheme'")
    expect(source).toContain("READER_THEME_COLORS[theme.value].paper")
    expect(source).toContain("READER_THEME_COLORS[theme.value].text")
    // 本地不再抄一份色表：抄一份就会和网页阅读模式在同一主题下渲出两种纸色
    expect(source).not.toMatch(/const themeTokens\s*:\s*Record<ReaderTheme/)
    expect(source).not.toContain("paper: { paper: '#FFFFFF'")
  })
})
