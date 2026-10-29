// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'
import { readerScrollBehavior, resolveReaderKey } from './readerHelpers'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
// 捕获 ResizeObserver 回调，用来手动模拟「阅读页隐藏 → 重新可见」。
function installResizeObserverCapture(): Array<(entries: Array<{ contentRect: { width: number; height: number } }>) => void> {
  const callbacks: Array<(entries: Array<{ contentRect: { width: number; height: number } }>) => void> = []
  class CaptureResizeObserver {
    constructor(cb: (entries: Array<{ contentRect: { width: number; height: number } }>) => void) { callbacks.push(cb) }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { value: CaptureResizeObserver, configurable: true })
  Object.defineProperty(globalThis, 'ResizeObserver', { value: CaptureResizeObserver, configurable: true })
  return callbacks
}
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }), configurable: true })
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

afterEach(() => { document.body.innerHTML = '' })

function installReaderApi() {
  const chapters = [
    { id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const },
  ]
  const book = { id: 'book-1', title: '验收书', author: '', tags: [] as string[], importType: 'txt' as const, createdAt: '', updatedAt: '', status: 'ready' as const, chapters, progress: null }
  Object.defineProperty(window, 'api', { configurable: true, value: {
    library: {
      get: async () => ({ book }),
      readChapter: async () => ({ chapter: { title: '第一章', body: '第一段。\n\n第二段。', status: 'ready' } }),
      setProgress: async () => ({ ok: true }),
    },
    settings: { get: async () => ({ reader: { fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll' }, tts: { rate: 1, autoNextChapter: true }, baseUrl: '' }), set: async () => ({}) },
    annotations: { list: async () => ({ ok: true, items: [] }) },
    download: { onProgress: () => () => {} },
    ai: { onChunk: () => () => {}, onStage: () => () => {}, onBudget: () => () => {}, onDone: () => () => {}, getMaterialCoverage: async () => ({ ok: true, coverage: null }), getUsage: async () => ({ ok: true, usage: { calls: 0 } }), chapterFinished: async () => ({ ok: false, message: '测试桩：不追剧' }) },
  } })
}

describe('Reader P2.1 accessibility behavior', () => {
  it('keeps ordinary paragraph clicks silent and exposes focusable, named controls', async () => {
    installReaderApi()
    const spoken: string[] = []
    class MockUtterance { rate = 1; lang = ''; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(readonly text: string) {} }
    const speechSynthesis = { cancel() {}, speak: (utterance: MockUtterance) => spoken.push(utterance.text), pause() {}, resume() {} }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: speechSynthesis })
    Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: speechSynthesis })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: MockUtterance })
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: MockUtterance })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
    app.mount(host)
    await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    const paragraphs = [...document.querySelectorAll('.reader-content [data-p]')]
    expect(paragraphs).toHaveLength(2)
    paragraphs[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    paragraphs[0].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(spoken).toEqual([])
    const start = paragraphs[1].querySelector<HTMLButtonElement>('.para-tts-start')
    expect(start?.tagName).toBe('BUTTON')
    expect(start?.type).toBe('button')
    expect(start?.getAttribute('aria-label')).toBe('从第 2 段开始朗读')
    start?.focus()
    expect(document.activeElement).toBe(start)
    start?.click()
    await nextTick()
    expect(spoken).toEqual(['第二段。'])
    const shortcuts = document.querySelector<HTMLButtonElement>('[aria-label="快捷键说明"]')
    shortcuts?.click()
    await nextTick()
    expect(document.querySelector('.tool-panel')?.textContent).toContain('Space / Shift+Space，J / K')
    expect(spoken).toEqual(['第二段。'])
    app.unmount()
  })

  it('maps J/K to the existing page actions', async () => {
    expect(resolveReaderKey({ key: 'j' })).toBe('page-down')
    expect(resolveReaderKey({ key: 'K' })).toBe('page-up')
  })
})

describe('Reader P2.4 accessibility wrap-up', () => {
  it('names core toolbar and chapter controls in Chinese', async () => {
    installReaderApi()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
    app.mount(host)
    await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    const labels = [
      '返回书库',
      '目录',
      '搜索',
      '标记',
      '朗读',
      '背景',
      '字体',
      '快捷键说明',
      '沉浸模式',
      '上一章',
      '下一章',
    ]
    for (const label of labels) {
      expect(document.querySelector(`[aria-label="${label}"]`)).not.toBeNull()
    }
    app.unmount()
  })

  it('lets the shortcut help button take keyboard focus', async () => {
    installReaderApi()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
    app.mount(host)
    await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    const shortcuts = document.querySelector<HTMLButtonElement>('[aria-label="快捷键说明"]')
    expect(shortcuts?.tagName).toBe('BUTTON')
    shortcuts?.focus()
    expect(document.activeElement).toBe(shortcuts)
    app.unmount()
  })

  it('keeps focus-visible outlines, reduced-motion rails, and toolbar title shrink in source', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain(':focus-visible')
    expect(source).toContain('outline: 2px solid var(--r-focus)')
    expect(source).toContain('@media (prefers-reduced-motion: reduce)')
    expect(source).toContain('transition: none !important; animation: none !important; scroll-behavior: auto !important;')
    expect(source).toContain('.reader-toolbar .reader-book-title { min-width: 0; }')
    expect(source).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)')")
  })

  it('maps reader keys and does not steal them from text fields', () => {
    expect(resolveReaderKey({ key: 'ArrowLeft' })).toBe('prev-chapter')
    expect(resolveReaderKey({ key: 'ArrowRight' })).toBe('next-chapter')
    expect(resolveReaderKey({ key: ' ' })).toBe('page-down')
    expect(resolveReaderKey({ key: ' ', shift: true })).toBe('page-up')
    expect(resolveReaderKey({ key: 'j' })).toBe('page-down')
    expect(resolveReaderKey({ key: 'K' })).toBe('page-up')
    expect(resolveReaderKey({ key: 't' })).toBe('open-catalog')
    expect(resolveReaderKey({ key: 'a' })).toBe('open-appearance')
    expect(resolveReaderKey({ key: 'r' })).toBe('toggle-tts')
    expect(resolveReaderKey({ key: 'Escape' })).toBe('close-drawer')
    expect(resolveReaderKey({ key: ' ', targetTag: 'input' })).toBeNull()
    expect(resolveReaderKey({ key: 'ArrowRight', targetTag: 'textarea' })).toBeNull()
    expect(resolveReaderKey({ key: 't', targetTag: 'input' })).toBeNull()
  })

  it('maps reduced-motion preference to auto scroll', () => {
    expect(readerScrollBehavior(true)).toBe('auto')
    expect(readerScrollBehavior(false)).toBe('smooth')
  })

  it('locks focus-mode copy, dim class, and viewport anchor in source', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain('行焦点')
    expect(source).toContain('1 段')
    expect(source).toContain('3 段')
    expect(source).toContain('5 段')
    expect(source).toContain('para-unfocused')
    expect(source).toContain('opacity: 0.4')
    expect(source).toContain('updateViewportFocusAnchor')
    expect(source).toContain('paragraphIndexAtViewportCenter')
    expect(source).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('locks reading-mode copy and wheel paging in source', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain('阅读方式')
    expect(source).toContain('连续滚动')
    expect(source).toContain('屏幕翻页')
    expect(source).not.toContain('onContentWheel')
    expect(source).not.toContain('@wheel="onContentWheel"')
    expect(source).not.toContain('wheelPageDirection')
    expect(source).toContain('el.clientHeight * 0.9')
    // U1.3：屏幕翻页走段落对齐，连续滚动仍按 0.9 屏推进、不吸附。
    expect(source).toContain('scrollTopForParagraphPage')
    expect(source).toContain('collectParagraphSpans')
    expect(source).toContain('snapScrollTopToParagraph')
    expect(source).toContain('readerScrollBehavior')
    expect(source).toContain('const toolsVisible = ref(false)')
    expect(source).toContain('onContentZoneMouseup')
    expect(source).not.toContain('@mousemove="onReaderPointerMove"')
  })

  it('locks the eye-care dim overlay and its z-order in source', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain('屏幕压暗')
    expect(source).toContain('class="reader-dim"')
    expect(source).toContain(':style="{ opacity: dim / 100 }"')
    // 遮罩只压暗正文：z-index 必须高于正文(0)、低于翻章热区(18)与页码(26)，且不吞点击。
    expect(source).toContain('.reader-dim {')
    expect(source).toContain('z-index: 15;')
    expect(source).toContain('pointer-events: none;')
  })

  it('makes resuming to the last position visible in source', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain('已回到上次读到')
    expect(source).toContain('resumeRatio > 0.02')
    // 关键回归护栏：openChapter 内部会自增 navEpoch，若用外层 `epoch !== navEpoch` 判断早退，
    // 续读提示会在弹出的前一行永远 return 掉。必须改判「仍落在续读这一章」，不能拿 epoch 拦。
    expect(source).toContain('if (currentChapter.value?.id !== ch.id) return')
  })
})

describe('Reader U1.1 re-entry', () => {
  it('collapses the tools when the reader page becomes visible again', async () => {
    installReaderApi()
    const callbacks = installResizeObserverCapture()
    try {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
      app.mount(host)
      await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
      expect(callbacks.length).toBeGreaterThan(0)
      const emitSize = (width: number, height: number) => callbacks[0]([{ contentRect: { width, height } }])
      const toolbar = () => document.querySelector('.reader-toolbar')
      // 首次观测只登记：在屏幕上不等于重入。
      emitSize(900, 600)
      await nextTick()
      expect(toolbar()?.getAttribute('aria-hidden')).toBe('true')
      // 展开工具（键盘焦点进入阅读区会唤回顶栏）。
      document.querySelector('.reader-wrap')?.dispatchEvent(new Event('focusin', { bubbles: true }))
      await nextTick()
      expect(toolbar()?.getAttribute('aria-hidden')).toBe('false')
      // 离开阅读页（v-show 切到 display:none，尺寸归零）。
      emitSize(0, 0)
      await nextTick()
      // 从书库点书卡回到阅读页：工具必须已收起，正文与书脊仍在。
      emitSize(900, 600)
      await nextTick()
      expect(toolbar()?.getAttribute('aria-hidden')).toBe('true')
      expect(toolbar()?.classList.contains('reader-tools-hidden')).toBe(true)
      expect(document.querySelector('.reader-bottombar')?.getAttribute('aria-hidden')).toBe('true')
      expect(document.querySelector('.reader-spine')).not.toBeNull()
      expect(document.querySelector('.reader-content')?.textContent).toContain('第一段。')
      app.unmount()
    } finally {
      Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
      Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
    }
  })

  it('resets the tools on every entry path in source', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain('ref="readerRootRef"')
    expect(source).toContain('collapseToolsForEntry')
    expect(source).toContain('shouldResetReaderToolsOnEntry')
    // 换书也算进入：loadBook 必须在新书上复位，不能沿用上一本展开着的工具层。
    expect(source).toContain('if (book.value?.id !== bookId) collapseToolsForEntry()')
    // 不得用定时器或强制重载冒充复位。
    expect(source).not.toContain('location.reload')
  })
})

describe('Reader U1.2 progress scrubbing', () => {
  it('shows the target chapter name while dragging, not after release', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    // 目标章名来自拖动中的 scrubRatio（pointermove 更新），不能只靠松手后的 currentChapter。
    expect(source).toContain('const scrubLabel = computed(')
    expect(source).toContain('progressScrubLabel(target.chapter, target.index)')
    expect(source).toContain('@pointermove="moveProgressScrub"')
    expect(source).toContain('v-if="scrubbing && scrubLabel"')
    expect(source).toContain('class="reader-progress-scrub-hint"')
    // 浮标是进度条的一部分，必须有 live 区域让读屏跟着念。
    expect(source).toContain('aria-live="polite"')
  })

  it('opens the target chapter at its start on release', async () => {
    const helpers = await readFile(join(process.cwd(), 'src/renderer/pages/readerHelpers.ts'), 'utf-8')
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(helpers).toContain('export function progressScrubTarget')
    expect(helpers).toContain('return { index, chapter, scrollRatio: 0 }')
    expect(source).toContain('if (target) void openChapter(target.chapter, 0)')
    // 拖动过程中不许换章：pointermove 只更新比例。
    const moveBlock = source.slice(source.indexOf('function moveProgressScrub'), source.indexOf('function endProgressScrub'))
    expect(moveBlock).not.toContain('openChapter')
  })

  it('keeps the track keyboard reachable and its old labels', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain('role="slider"')
    expect(source).toContain('tabindex="0"')
    expect(source).toContain(':aria-label="bookProgressDetail"')
    expect(source).toContain('@keydown="onProgressTrackKeydown"')
    expect(source).toContain('.reader-progress-track:focus-visible')
    // 失败章按既有分支渲染：拖过去也要留着重试与去浏览页入口。
    expect(source).toContain('v-if="canRetryChapter" size="small" type="warning"')
    expect(source).toContain('去浏览页')
  })
})

describe('Reader U1.4 渲染层整段尾巴净化', () => {
  /** 正文：正文段 / 站点尾巴 / 叙述段「请收藏这封信」/ 纯网址尾巴。 */
  const TAIL_BODY = '第一段正文。\n\n请收藏本站，下次不迷路。\n\n请收藏这封信。\n\nwww.xsxz.example'

  function installTailApi() {
    installReaderApi()
    const api = (window as unknown as { api: Record<string, Record<string, unknown>> }).api
    api.library!.readChapter = async () => ({ chapter: { title: '第一章', body: TAIL_BODY, status: 'ready' } })
  }

  async function mountReader() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
    app.mount(host)
    await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    return app
  }

  it('默认开启净化：整段尾巴不渲染，叙述段仍显示，data-p 保持原始下标', async () => {
    installTailApi()
    const app = await mountReader()
    const paras = [...document.querySelectorAll<HTMLElement>('.reader-content [data-p]')]
    // 尾巴段（下标 1、3）整段不渲染；正文段与「请收藏这封信」还在。
    expect(paras.map((node) => node.dataset.p)).toEqual(['0', '2'])
    const text = document.querySelector('.reader-content')?.textContent ?? ''
    expect(text).toContain('第一段正文。')
    expect(text).toContain('请收藏这封信。')
    expect(text).not.toContain('请收藏本站')
    expect(text).not.toContain('www.xsxz.example')
    // 渲染层是纯文本节点，不许走 v-html。
    expect(document.querySelector('.reader-content')?.innerHTML).not.toContain('&lt;')
    app.unmount()
  })

  it('字体面板有「净化」与「本章显示原文」，原文开关只活在内存里', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/pages/Reader.vue'), 'utf-8')
    expect(source).toContain('<n-switch v-model:value="hideSiteTail" /> 净化')
    expect(source).toContain('<n-switch v-model:value="showRawThisChapter"')
    // 默认开启净化；原文开关是内存 ref，不进 currentReaderPrefs（不落盘）。
    expect(source).toContain('const hideSiteTail = ref(true)')
    expect(source).toContain('const showRawThisChapter = ref(false)')
    const prefs = source.slice(source.indexOf('function currentReaderPrefs'), source.indexOf('async function saveReaderPrefsSnapshot'))
    expect(prefs).not.toContain('showRawThisChapter')
    // 换章（每次 openChapter）都回到净化状态。
    const openChapter = source.slice(source.indexOf('async function openChapter'), source.indexOf('function paragraphTextNodes'))
    expect(openChapter).toContain('showRawThisChapter.value = false')
    // 净化只在渲染层过滤，绝不改写章节正文与坐标空间。
    expect(source).toContain('import { isSiteTailParagraph } from \'./readerTail\'')
    expect(source).not.toContain('v-html')
    expect(source).toContain('const normalizedBody = computed(() => paras.value.join(\'\\n\\n\'))')
    // 过滤结果只喂给渲染下标列表，不写回 chapterBody / normalizedBody。
    const purge = source.slice(source.indexOf('const tailHiddenFlags'), source.indexOf('const renderedCount'))
    expect(purge).not.toContain('chapterBody.value =')
  })
})
