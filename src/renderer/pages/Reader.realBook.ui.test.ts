// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'
import { DEFAULT_PITCH_DEG } from './realBookPitch'
import { FLIP_DURATION_MS } from './realBookFlip'
import type { Annotation } from '@shared/types'

/**
 * 真实书籍模式在 Reader 层的接线：位置真源（段落锚点）、进度写盘、划线落位、
 * 两种模式互转。这些都是 `tsc` 看不出来的（模板与脚本的连线），所以真挂载一次。
 */
class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })
// jsdom 的 Range 没有几何信息，选区工具条定位需要 getBoundingClientRect
Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
  value: () => ({ top: 120, left: 40, bottom: 140, right: 200, width: 160, height: 20, x: 40, y: 120 }),
  configurable: true,
})

afterEach(() => {
  // 选区是全局的：残留的选区会让后续用例的「点纸面翻页」全部失灵（选字时本就不该翻页）。
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

/** 段落里最长的那个文本节点：段落可能被 <mark> 拆成多段，不能拿 firstChild。 */
function longestTextNode(el: HTMLElement): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let best: Text | null = null
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (!best || node.textContent!.length > best.textContent!.length) best = node
  }
  return best!
}

/** 够长的正文：分页要能排出第二页，翻页才有得可翻。 */
const LONG_BODY = Array.from({ length: 60 }, (_, i) => `第${i + 1}段。`).join('\n\n')

type BookView = 'classic' | 'sheet' | 'realbook'

type SettingsWrite = { reader?: Record<string, unknown> }

interface ProgressWrite {
  chapterId: string
  scrollRatio: number
  paragraphIndex?: number
  paragraphOffset?: number
}

function installReaderApi(options: {
  settingsWrites?: SettingsWrite[]
  bookView?: BookView
  body?: string
  annotations?: Annotation[]
  progress?: ProgressWrite | null
  showInlineNotes?: boolean
} = {}) {
  const progressWrites: ProgressWrite[] = []
  const settingsWrites = options.settingsWrites ?? []
  const annotationUpdates: Array<{ id: string; patch: Partial<Annotation> }> = []
  const annotationRemoves: string[] = []
  const items = [...(options.annotations ?? [])]
  const chapters = [{ id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const }]
  const bookStats = [{ chapterId: 'c1', chars: (options.body ?? '第一段。\n\n第二段。').length }]
  const book = {
    id: 'book-1', title: '真实书', author: '', tags: [] as string[], importType: 'txt' as const,
    createdAt: '', updatedAt: '', status: 'ready' as const, chapters,
    progress: options.progress ?? null,
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      library: {
        get: async () => ({ book }),
        readBookStats: async () => ({ stats: bookStats }),
        readChapter: async () => ({
          chapter: { title: '第一章', body: options.body ?? '第一段。\n\n第二段。', status: 'ready' },
        }),
        setProgress: async (_bookId: string, progress: ProgressWrite) => {
          progressWrites.push(progress)
          return { ok: true }
        },
        markReadFrontier: async () => ({ ok: true }),
      },
      settings: {
        get: async () => ({
          reader: {
            fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
            paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll',
            bookView: options.bookView ?? 'classic', handwritingFont: 'none',
            showInlineNotes: options.showInlineNotes ?? true,
          },
          tts: { rate: 1, autoNextChapter: true }, baseUrl: '',
        }),
        set: async (patch: SettingsWrite) => { settingsWrites.push(patch); return {} },
      },
      annotations: {
        list: async () => ({ ok: true, items }),
        add: async (draft: Partial<Annotation>) => {
          const item: Annotation = {
            id: `new-${items.length + 1}`, bookId: 'book-1', chapterId: 'c1', kind: 'highlight',
            start: 0, end: 0, excerpt: '', createdAt: '2026-11-09T00:00:00.000Z', ...draft,
          }
          items.push(item)
          return { ok: true, item }
        },
        update: async (_bookId: string, id: string, patch: Partial<Annotation>) => {
          annotationUpdates.push({ id, patch })
          const base = items.find((item) => item.id === id) ?? items[0]!
          const item = { ...base, ...patch, noteSource: 'user' as const }
          const index = items.findIndex((entry) => entry.id === id)
          if (index >= 0) items[index] = item
          return { ok: true, item }
        },
        remove: async (_bookId: string, id: string) => {
          annotationRemoves.push(id)
          const index = items.findIndex((item) => item.id === id)
          if (index >= 0) items.splice(index, 1)
          return { ok: true }
        },
      },
      download: { onProgress: () => () => {} },
      ai: {
        onChunk: () => () => {}, onStage: () => () => {}, onExternalSources: () => () => {}, onBudget: () => () => {}, onDone: () => () => {},
        getMaterialCoverage: async () => ({ ok: true, coverage: null }),
        getUsage: async () => ({ ok: true, usage: { calls: 0 } }),
        chapterFinished: async () => ({ ok: false, message: '测试桩：不追剧' }),
      },
    },
  })
  return { progressWrites, settingsWrites, annotationUpdates, annotationRemoves }
}

function buttonByText<T extends HTMLElement = HTMLElement>(root: ParentNode, text: string): T | null {
  return [...root.querySelectorAll<HTMLElement>('button')]
    .find((button) => (button.textContent ?? '').trim() === text) as T | null
}

async function mountReader() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
  app.mount(host)
  await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
  return app
}

describe('Reader 真实书籍模式接线', () => {
  it('偏好为真实书籍时不渲染经典滚动容器，改为双页书台', async () => {
    installReaderApi({ bookView: 'realbook' })
    const app = await mountReader()

    expect(document.querySelector('.real-book-stage')).not.toBeNull()
    expect(document.querySelectorAll('.real-book-page')).toHaveLength(2)
    expect(document.querySelector('.reader-content')).toBeNull()
    app.unmount()
  })

  it('经典模式仍渲染滚动容器，书台不出现', async () => {
    installReaderApi({ bookView: 'classic' })
    const app = await mountReader()

    expect(document.querySelector('.reader-content')).not.toBeNull()
    expect(document.querySelector('.real-book-stage')).toBeNull()
    app.unmount()
  })

  it('真实书籍下章节正文出现在书台上，带原始段落下标', async () => {
    installReaderApi({ bookView: 'realbook', body: '第一段。\n\n第二段。' })
    const app = await mountReader()

    const paras = [...document.querySelectorAll<HTMLElement>('.real-book-para')]
    expect(paras.length).toBeGreaterThan(0)
    expect(paras[0]?.dataset.p).toBe('0')
    expect(document.querySelector('.real-book-stage')?.textContent).toContain('第一段。')
    app.unmount()
  })

  it('真实书籍下写进度带段落锚点（位置真源不是页码）', async () => {
    const { progressWrites } = installReaderApi({ bookView: 'realbook' })
    const app = await mountReader()

    // 翻一页，触发进度排期；进度写入经 1s 防抖，等它落盘。
    // 翻页没有按钮了：键盘 → 翻页（分页渲染层里方向键翻页而不是换章）。
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 200))
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 1500))

    expect(progressWrites.length).toBeGreaterThan(0)
    const last = progressWrites[progressWrites.length - 1]!
    expect(last.chapterId).toBe('c1')
    expect(last.paragraphIndex).toBeGreaterThanOrEqual(0)
    expect(last.paragraphOffset).toBeGreaterThanOrEqual(0)
    app.unmount()
  })

  it('旧书只有比例没有锚点时，真实书籍按比例落位并写回锚点', async () => {
    const { progressWrites } = installReaderApi({
      bookView: 'realbook',
      progress: { chapterId: 'c1', scrollRatio: 0.5 },
    })
    const app = await mountReader()

    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(progressWrites.length).toBeGreaterThan(0)
    const last = progressWrites[progressWrites.length - 1]!
    // 比例回退后仍能写出锚点（段落下标），后续恢复就有精确位置。
    expect(last.paragraphIndex).toBeGreaterThanOrEqual(0)
    app.unmount()
  })

  it('划线在书台上以高亮出现', async () => {
    installReaderApi({
      bookView: 'realbook',
      body: '第一段。\n\n第二段。',
      annotations: [{
        id: 'a1', bookId: 'book-1', chapterId: 'c1', kind: 'highlight',
        start: 0, end: 3, excerpt: '第一段', createdAt: '2026-11-03T00:00:00.000Z',
      }],
    })
    const app = await mountReader()

    const hl = document.querySelector('.real-book-stage mark.hl-mark')
    expect(hl?.textContent).toBe('第一段')
    app.unmount()
  })

  it('从经典模式切到真实书籍：经典容器让位，书台接管', async () => {
    installReaderApi({ bookView: 'classic' })
    const app = await mountReader()
    expect(document.querySelector('.reader-content')).not.toBeNull()

    document.querySelector<HTMLElement>('.bottom-button[aria-label="字体"]')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLElement>('[aria-label="阅读界面"] button:nth-child(3)')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector('.real-book-stage')).not.toBeNull()
    expect(document.querySelector('.reader-content')).toBeNull()
    app.unmount()
  })

  it('俯仰角跨章节保持，且不写进阅读设置', async () => {
    const settingsWrites: SettingsWrite[] = []
    installReaderApi({ bookView: 'realbook', settingsWrites })
    const app = await mountReader()

    const stage = document.querySelector<HTMLElement>('.real-book-book')
    stage?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 100, pointerId: 1 }))
    stage?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientY: 200, pointerId: 1 }))
    stage?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientY: 200, pointerId: 1 }))
    await nextTick()

    // 拖 100px = 10°；初值是默认俯仰角，不是平放。
    expect(document.querySelector<HTMLElement>('.real-book-stage')?.getAttribute('style')).toContain(`--rb-pitch: ${DEFAULT_PITCH_DEG + 10}deg`)
    // 模拟换章：当前测试书只有一章，重新打开相同章节仍不得把会话角度重置。
    document.querySelector<HTMLElement>('.real-book-dock')?.click()
    await nextTick()
    document.querySelector<HTMLElement>('.reader-bottombar [aria-label="更多"]')?.click()
    await nextTick()
    buttonByText(document.querySelector('.bottom-panel')!, '字体 / 排版')?.click()
    await nextTick()
    expect(document.querySelector('.bottom-panel')?.textContent).toContain('阅读界面')
    expect(settingsWrites.every((write) => !('realBookPitch' in (write.reader ?? {})))).toBe(true)
    app.unmount()
  })

  it('经典/真实书籍切换保持俯仰角，且偏好快照不包含俯仰角', async () => {
    const settingsWrites: SettingsWrite[] = []
    installReaderApi({ bookView: 'classic', settingsWrites })
    const app = await mountReader()
    document.querySelector<HTMLElement>('.bottom-button[aria-label="字体"]')?.click()
    await nextTick()
    document.querySelector<HTMLElement>('[aria-label="阅读界面"] button:nth-child(3)')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    const stage = document.querySelector<HTMLElement>('.real-book-book')
    stage?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 100, pointerId: 2 }))
    stage?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientY: 150, pointerId: 2 }))
    stage?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientY: 150, pointerId: 2 }))
    await nextTick()
    const before = document.querySelector<HTMLElement>('.real-book-stage')?.getAttribute('style') ?? ''

    document.querySelector<HTMLElement>('[aria-label="阅读界面"] button:nth-child(1)')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLElement>('[aria-label="阅读界面"] button:nth-child(3)')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector<HTMLElement>('.real-book-stage')?.getAttribute('style')).toContain(`--rb-pitch: ${DEFAULT_PITCH_DEG + 5}deg`)
    expect(before).toContain(`--rb-pitch: ${DEFAULT_PITCH_DEG + 5}deg`)
    expect(settingsWrites.every((write) => !('realBookPitch' in (write.reader ?? {})))).toBe(true)
    app.unmount()
  })

  it('真实书籍下键盘 → 翻到下一页，而不是跳到下一章', async () => {
    installReaderApi({ bookView: 'realbook', body: LONG_BODY })
    const app = await mountReader()

    const label = () => document.querySelector('.real-book-page-label')?.textContent ?? ''
    const before = label()
    expect(before).toContain('第 1')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 250))
    await nextTick()

    // 翻页而不是换章：页码往前走，页眉仍印着本章章名（换章会把整章跳过去）。
    expect(label()).not.toBe(before)
    const heads = [...document.querySelectorAll('.real-book-page-head')].map((node) => node.textContent)
    expect(heads).toContain('第一章')
    // 参考站的页眉：左页印书名、右页印章节名。
    expect(heads).toContain('真实书')
    // 双页摊开一次翻 2 页，第 1 页翻过去后就不再显示；只确认正文仍在本章。
    expect(document.querySelectorAll('.real-book-para').length).toBeGreaterThan(0)
    app.unmount()
  })

  it('真实书籍下点纸面左右两侧翻页，点中间显隐工具条', async () => {
    installReaderApi({ bookView: 'realbook', body: LONG_BODY })
    const app = await mountReader()

    const paper = document.querySelector<HTMLElement>('.real-book-book')!
    expect(paper).not.toBeNull()
    // jsdom 没有真实布局：把纸面宽度与位置钉死，分区才可测。
    Object.defineProperty(paper, 'clientWidth', { configurable: true, value: 600 })
    paper.getBoundingClientRect = () => ({ left: 0, width: 600 } as DOMRect)

    const label = () => document.querySelector('.real-book-page-label')?.textContent ?? ''
    // 只看当前页号：页表是惰性排的，总页数会随排版往下长，拿整个标签比对会假红。
    const pageNo = () => Number(label().match(/第 (\d+)/)?.[1] ?? '0')
    const before = pageNo()

    // 右侧三分之一：翻下一页。
    paper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 500 }))
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 250))
    await nextTick()
    // 双页摊开，翻一张纸前进 2 页：右页滑到左页不是翻页，是挪窗口。
    expect(pageNo()).toBe(before + 2)

    // 左侧三分之一：回上一页。
    paper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 100 }))
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 250))
    await nextTick()
    expect(pageNo()).toBe(before)

    // 中间三分之一：只显隐底栏图标带，不翻页。真实书籍没有应用顶栏，
    // 用户看得见的「工具条」是底栏。
    const afterPage = pageNo()
    const dockBar = () => document.querySelector('.reader-bottombar')
    const hiddenBefore = dockBar()?.getAttribute('aria-hidden')
    paper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 300 }))
    await nextTick()
    expect(dockBar()?.getAttribute('aria-hidden')).not.toBe(hiddenBefore)
    expect(pageNo()).toBe(afterPage)
    app.unmount()
  })

  it('真实书籍底栏默认收进底部横条，点横条展开，再点书页中区收回', async () => {
    installReaderApi({ bookView: 'realbook', body: LONG_BODY })
    const app = await mountReader()

    const bar = () => document.querySelector<HTMLElement>('.reader-bottombar')
    // 不交互时整条图标带收起，只剩底边那根横条：工具栏不该在书桌照上常驻。
    expect(bar()?.getAttribute('aria-hidden')).toBe('true')
    expect(bar()?.classList.contains('reader-tools-hidden')).toBe(true)
    const dock = document.querySelector<HTMLElement>('.real-book-dock')
    expect(dock).not.toBeNull()
    expect(dock?.getAttribute('aria-label')).toBe('显示工具栏')

    // 点横条：图标带展开、横条让位。
    dock?.click()
    await nextTick()
    expect(bar()?.getAttribute('aria-hidden')).toBe('false')
    expect(bar()?.classList.contains('reader-tools-hidden')).toBe(false)
    expect(document.querySelector('.real-book-dock')).toBeNull()

    // 点书页中区：收回，横条回来（复用了顶栏/经典底栏的同一个显隐真源）。
    const paper = document.querySelector<HTMLElement>('.real-book-book')!
    Object.defineProperty(paper, 'clientWidth', { configurable: true, value: 600 })
    paper.getBoundingClientRect = () => ({ left: 0, width: 600 } as DOMRect)
    paper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 300 }))
    await nextTick()
    expect(bar()?.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('.real-book-dock')).not.toBeNull()
    app.unmount()
  })

  it('面板开着时点书页中区：面板先关，底栏再收进横条，不留下无主浮层', async () => {
    installReaderApi({ bookView: 'realbook', body: LONG_BODY })
    const app = await mountReader()

    document.querySelector<HTMLElement>('.real-book-dock')?.click()
    await nextTick()
    document.querySelector<HTMLElement>('.bottom-button[aria-label="背景"]')?.click()
    await nextTick()
    expect(document.querySelector('.bottom-panel')).not.toBeNull()

    const paper = document.querySelector<HTMLElement>('.real-book-book')!
    Object.defineProperty(paper, 'clientWidth', { configurable: true, value: 600 })
    paper.getBoundingClientRect = () => ({ left: 0, width: 600 } as DOMRect)
    paper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 300 }))
    await nextTick()

    // 面板挂在一个已收起的栏上会变成看不见却还活着的浮层：收起时一并关掉。
    expect(document.querySelector('.bottom-panel')).toBeNull()
    expect(document.querySelector('.reader-bottombar')?.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('.real-book-dock')).not.toBeNull()
    app.unmount()
  })

  it('真实书籍底栏有「适应屏幕」：0 键与按钮都把倍率拉回整书适配', async () => {
    installReaderApi({ bookView: 'realbook', body: LONG_BODY })
    const app = await mountReader()

    document.querySelector<HTMLElement>('.real-book-dock')?.click()
    await nextTick()
    const fit = document.querySelector<HTMLElement>('.rb-btn[aria-label="适应屏幕"]')
    expect(fit).not.toBeNull()
    const zoomLabel = () => document.querySelector('.rb-zoom')?.textContent ?? ''
    // CSS 3D 回退的 1 就是舞台原尺寸，也就是整书适配。
    expect(zoomLabel()).toBe('100%')

    // 推近之后：0 键回整书适配。复原回的是 90% 的默认构图，两者不是同一个动作。
    document.querySelector<HTMLElement>('.rb-btn[aria-label="放大"]')?.click()
    await nextTick()
    expect(zoomLabel()).toBe('110%')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }))
    await nextTick()
    expect(zoomLabel()).toBe('100%')

    // 底栏按钮走同一个暴露方法。
    document.querySelector<HTMLElement>('.rb-btn[aria-label="放大"]')?.click()
    await nextTick()
    fit?.click()
    await nextTick()
    expect(zoomLabel()).toBe('100%')
    app.unmount()
  })

  it('真实书籍不摆应用顶栏：工具入口收进底栏「更多」，页码仍在', async () => {
    installReaderApi({ bookView: 'realbook', body: LONG_BODY })
    const app = await mountReader()

    // 顶栏里不再有标题与任何应用入口，只剩一条隐藏的页码文本。
    expect(document.querySelector('.reader-toolbar .reader-book-title')).toBeNull()
    expect(document.querySelector('.reader-toolbar [aria-label="搜索"]')).toBeNull()
    expect(document.querySelector('.real-book-page-label')?.textContent).toContain('页')

    document.querySelector<HTMLElement>('.real-book-dock')?.click()
    await nextTick()
    document.querySelector<HTMLElement>('.reader-bottombar [aria-label="更多"]')?.click()
    await nextTick()
    const text = document.querySelector('.bottom-panel')?.textContent ?? ''
    for (const label of ['搜索', '标记', '书中地图', '朗读', 'AI', '字体 / 排版', '快捷键', '设置', '浏览', '书架']) {
      expect(text).toContain(label)
    }
    app.unmount()
  })

  it('真实书籍的目录抽屉刷成暗色面板', async () => {
    installReaderApi({ bookView: 'realbook', body: LONG_BODY })
    const app = await mountReader()

    document.querySelector<HTMLElement>('.real-book-dock')?.click()
    await nextTick()
    document.querySelector<HTMLElement>('.reader-bottombar [aria-label="目录"]')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    const content = document.querySelector('.reader-drawer-realbook')
    expect(content).not.toBeNull()
    expect(content?.textContent).toContain('目录')
    app.unmount()
  })

  it('手机单页固定 20px 档，不沿用桌面字号偏好', async () => {
    localStorage.setItem('spore:reader-realbook-phone:v1', '1')
    try {
      installReaderApi({ bookView: 'realbook', body: LONG_BODY })
      const app = await mountReader()
      await nextTick()
      // 桌面偏好 18 会按 22/18 换成 22px；手机单页按参考站固定 20px。
      expect(document.querySelector<HTMLElement>('.real-book-stage')?.getAttribute('style')).toContain('--rb-font-size: 20px')
      app.unmount()
    } finally {
      localStorage.removeItem('spore:reader-realbook-phone:v1')
    }
  })

  it('经典模式不出现底部横条：横条只属于真实书籍底栏', async () => {
    installReaderApi({ bookView: 'classic' })
    const app = await mountReader()
    expect(document.querySelector('.real-book-dock')).toBeNull()
    app.unmount()
  })

  it('真实书籍下点左侧回翻：章首停住，不跳到上一章', async () => {
    installReaderApi({ bookView: 'realbook', body: LONG_BODY })
    const app = await mountReader()

    const paper = document.querySelector<HTMLElement>('.real-book-book')!
    Object.defineProperty(paper, 'clientWidth', { configurable: true, value: 600 })
    paper.getBoundingClientRect = () => ({ left: 0, width: 600 } as DOMRect)

    const label = () => document.querySelector('.real-book-page-label')?.textContent ?? ''
    const pageNo = () => Number(label().match(/第 (\d+)/)?.[1] ?? '0')
    const before = pageNo()

    // 已经在第一页：点左侧翻不动，也不换章（章首没有上一章）。
    paper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 100 }))
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 250))
    await nextTick()
    expect(pageNo()).toBe(before)
    expect([...document.querySelectorAll('.real-book-page-head')].map((node) => node.textContent)).toContain('第一章')
    app.unmount()
  })

  it('真实书籍下点在按钮上的那一下不算翻页', async () => {
    installReaderApi({ bookView: 'realbook', body: LONG_BODY })
    const app = await mountReader()

    const paper = document.querySelector<HTMLElement>('.real-book-book')!
    Object.defineProperty(paper, 'clientWidth', { configurable: true, value: 600 })
    paper.getBoundingClientRect = () => ({ left: 0, width: 600 } as DOMRect)

    const label = () => document.querySelector('.real-book-page-label')?.textContent ?? ''
    const before = label()

    // 舞台工具条上的缩放按钮在纸面右区：点它不能顺手翻页。
    const zoom = document.querySelector<HTMLElement>('[aria-label="放大"]')!
    expect(zoom).not.toBeNull()
    zoom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 500 }))
    await nextTick()
    expect(label()).toBe(before)
    app.unmount()
  })

  it('真实书籍下在纸面拖选文字后松手不翻页', async () => {
    installReaderApi({ bookView: 'realbook', body: LONG_BODY })
    const app = await mountReader()

    const paper = document.querySelector<HTMLElement>('.real-book-book')!
    Object.defineProperty(paper, 'clientWidth', { configurable: true, value: 600 })
    paper.getBoundingClientRect = () => ({ left: 0, width: 600 } as DOMRect)

    const label = () => document.querySelector('.real-book-page-label')?.textContent ?? ''
    const pageNo = () => Number(label().match(/第 (\d+)/)?.[1] ?? '0')
    const before = pageNo()

    // 拖选：浏览器在拖动过程中就把选区建好，松手那一刻选区已确定且非折叠。
    const para = document.querySelector<HTMLElement>('.real-book-para')!
    const text = longestTextNode(para)
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, Math.min(3, text.textContent!.length))
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selection.isCollapsed).toBe(false)

    // 松手落在右区（会翻页的位置）：选字的那一下不能翻页。
    para.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 500 }))
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 250))
    await nextTick()

    expect(pageNo()).toBe(before)
    // 选区工具条照常出现：这一下仍然是「选字」，不是「翻页」。
    expect(document.querySelector('.sel-popup')).not.toBeNull()
    app.unmount()
  })

  it('真实书籍下拖俯仰角不会顺手翻页', async () => {
    installReaderApi({ bookView: 'realbook', body: LONG_BODY })
    const app = await mountReader()

    const paper = document.querySelector<HTMLElement>('.real-book-book')!
    Object.defineProperty(paper, 'clientWidth', { configurable: true, value: 600 })
    paper.getBoundingClientRect = () => ({ left: 0, width: 600 } as DOMRect)

    const label = () => document.querySelector('.real-book-page-label')?.textContent ?? ''
    const before = label()

    // 拖角：按下 → 移动 → 松手。松手那一下的 mouseup 不该被当成翻页点按。
    paper.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 100, pointerId: 1 }))
    paper.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 200, pointerId: 1 }))
    paper.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientY: 200, pointerId: 1 }))
    paper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 500 }))
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 250))
    await nextTick()

    expect(label()).toBe(before)
    app.unmount()
  })

  it('真实书籍下字体面板经底栏「更多」进入，且隐藏经典专属的「阅读方式」与自动滚屏', async () => {
    installReaderApi({ bookView: 'realbook' })
    const app = await mountReader()

    document.querySelector<HTMLElement>('.real-book-dock')?.click()
    await nextTick()
    document.querySelector<HTMLElement>('.reader-bottombar [aria-label="更多"]')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    buttonByText(document.querySelector('.bottom-panel')!, '字体 / 排版')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    const panel = document.querySelector('.bottom-panel')?.textContent ?? ''
    expect(panel).toContain('阅读界面')
    expect(panel).toContain('字号')
    expect(panel).not.toContain('连续滚动')
    expect(panel).not.toContain('开始自动滚屏')
    app.unmount()
  })

  it('真实书籍默认开启批注：已有批注显示在页面上', async () => {
    installReaderApi({
      bookView: 'realbook',
      body: '第一段。\n\n第二段。',
      annotations: [{
        id: 'a-note', bookId: 'book-1', chapterId: 'c1', kind: 'highlight',
        start: 0, end: 3, excerpt: '第一段', note: '默认可见的批注',
        createdAt: '2026-11-09T00:00:00.000Z',
      }],
    })
    const app = await mountReader()

    const card = document.querySelector<HTMLElement>('.real-book-note[data-note-id="a-note"]')
    expect(card?.textContent).toContain('默认可见的批注')
    expect(document.querySelector<HTMLElement>('.real-book-note-toggle')?.getAttribute('aria-pressed')).toBe('true')
    app.unmount()
  })

  it('关闭批注模式后卡片隐藏，划线底色保留', async () => {
    const { settingsWrites } = installReaderApi({
      bookView: 'realbook',
      body: '第一段。\n\n第二段。',
      annotations: [{
        id: 'a-note', bookId: 'book-1', chapterId: 'c1', kind: 'highlight',
        start: 0, end: 3, excerpt: '第一段', note: '可以隐藏的批注',
        createdAt: '2026-11-09T00:00:00.000Z',
      }],
    })
    const app = await mountReader()
    expect(document.querySelector('.real-book-note[data-note-id="a-note"]')).not.toBeNull()

    document.querySelector<HTMLElement>('.real-book-note-toggle')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector('.real-book-note[data-note-id="a-note"]')).toBeNull()
    expect(document.querySelector('.real-book-stage mark.hl-mark')?.textContent).toBe('第一段')
    expect(document.querySelector<HTMLElement>('.real-book-note-toggle')?.getAttribute('aria-pressed')).toBe('false')

    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(settingsWrites.some((write) => write.reader?.showInlineNotes === false)).toBe(true)
    app.unmount()
  })

  it('点击页内批注打开固定定位浮层，保存走 annotations.update', async () => {
    const { annotationUpdates } = installReaderApi({
      bookView: 'realbook',
      body: '第一段。\n\n第二段。',
      annotations: [{
        id: 'a-note', bookId: 'book-1', chapterId: 'c1', kind: 'highlight',
        start: 0, end: 3, excerpt: '第一段', note: '原来的批注',
        createdAt: '2026-11-09T00:00:00.000Z',
      }],
    })
    const app = await mountReader()

    document.querySelector<HTMLElement>('.real-book-note[data-note-id="a-note"]')?.click()
    await nextTick()
    const editor = document.querySelector<HTMLElement>('.inline-note-editor')
    expect(editor).not.toBeNull()
    expect(editor?.classList.contains('inline-note-editor')).toBe(true)
    expect(editor?.style.left).not.toBe('')
    expect(editor?.style.top).not.toBe('')
    expect(editor?.textContent).toContain('第一段')

    const textarea = editor!.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = '改写后的批注'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const tagInput = editor!.querySelector<HTMLInputElement>('input')!
    tagInput.value = '#quote'
    tagInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    buttonByText(editor!, '保存')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(annotationUpdates).toContainEqual({ id: 'a-note', patch: { note: '改写后的批注', tags: ['quote'] } })
    expect(document.querySelector('.inline-note-editor')).toBeNull()
    const card = document.querySelector('.real-book-note[data-note-id="a-note"]')
    expect(card?.textContent).toContain('改写后的批注')
    expect(card?.querySelector('.real-book-note-tag')?.textContent).toBe('#quote')
    app.unmount()
  })

  it('空批注不能保存，显式确认后才删除', async () => {
    const { annotationUpdates, annotationRemoves } = installReaderApi({
      bookView: 'realbook',
      body: '第一段。\n\n第二段。',
      annotations: [{
        id: 'a-note', bookId: 'book-1', chapterId: 'c1', kind: 'highlight',
        start: 0, end: 3, excerpt: '第一段', note: '待删除的批注',
        createdAt: '2026-11-09T00:00:00.000Z',
      }],
    })
    const app = await mountReader()

    document.querySelector<HTMLElement>('.real-book-note[data-note-id="a-note"]')?.click()
    await nextTick()
    const editor = document.querySelector<HTMLElement>('.inline-note-editor')!
    const textarea = editor.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = '   '
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    // 空内容时保存按钮禁用，批注不会因误清空而静默消失。
    expect(buttonByText(editor, '保存')?.hasAttribute('disabled')).toBe(true)
    expect(annotationUpdates).toHaveLength(0)

    buttonByText(editor, '删除')?.click()
    await nextTick()
    expect(buttonByText(editor, '确认删除')).not.toBeNull()
    expect(annotationRemoves).toHaveLength(0)
    buttonByText(editor, '确认删除')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(annotationRemoves).toEqual(['a-note'])
    expect(document.querySelector('.inline-note-editor')).toBeNull()
    expect(document.querySelector('.real-book-note[data-note-id="a-note"]')).toBeNull()
    app.unmount()
  })

  it.each([
    ['经典模式', 'classic'],
    ['书页模式', 'sheet'],
    ['真实书籍', 'realbook'],
  ] as const)('%s：已有批注显示在该段落下面且可开关', async (_label, bookView) => {
    const { settingsWrites } = installReaderApi({
      bookView,
      body: '第一段。\n\n第二段。',
      annotations: [{
        id: 'a-note', bookId: 'book-1', chapterId: 'c1', kind: 'highlight',
        start: 0, end: 3, excerpt: '第一段', note: '段落下方的批注', tags: ['quote'],
        createdAt: '2026-11-09T00:00:00.000Z',
      }],
    })
    const app = await mountReader()
    const card = document.querySelector<HTMLElement>('.real-book-note[data-note-id="a-note"]')
    expect(card?.textContent).toContain('段落下方的批注')
    expect(card?.querySelector('.real-book-note-tag')?.textContent).toBe('#quote')
    const paragraph = document.querySelector<HTMLElement>('[data-p="0"]')
    expect(paragraph?.nextElementSibling).toBe(card)
    // 「注」标记是伪元素，正文文本节点仍只有原文。
    expect(document.querySelector('[data-note-anchor-id="a-note"]')).not.toBeNull()
    expect(paragraph?.textContent).toContain('第一段。')
    expect(paragraph?.textContent).not.toContain('注')

    const toggle = document.querySelector<HTMLElement>('.real-book-note-toggle')!
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    toggle.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.querySelector('.real-book-note[data-note-id="a-note"]')).toBeNull()
    expect(document.querySelector('.reader-content .para, .rb-sheet-column .real-book-para, .real-book-page-body .real-book-para')).not.toBeNull()
    expect(document.querySelector<HTMLElement>('.real-book-note-toggle')?.getAttribute('aria-pressed')).toBe('false')
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(settingsWrites.some((write) => write.reader?.showInlineNotes === false)).toBe(true)
    app.unmount()
  })

  it.each([
    ['经典模式', 'classic'],
    ['书页模式', 'sheet'],
  ] as const)('%s：新写批注会开启批注模式并显示在段落下面', async (_label, bookView) => {
    installReaderApi({ bookView, body: LONG_BODY, showInlineNotes: false })
    const app = await mountReader()

    const para = document.querySelector<HTMLElement>('.para, .real-book-para')!
    const text = longestTextNode(para)
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, Math.min(3, text.textContent!.length))
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    para.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 300 }))
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    // 图标条先展开「⋯」菜单，批注在菜单里。
    document.querySelector<HTMLButtonElement>('.sel-popup [aria-label="更多操作"]')?.click()
    await nextTick()
    document.querySelector<HTMLButtonElement>('.sel-menu [data-action="note"]')?.click()
    await nextTick()
    const editor = document.querySelector<HTMLElement>('.direct-note-editor')!
    const textarea = editor.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = '刚写下的批注'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    buttonByText(editor, '保存批注')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector<HTMLElement>('.real-book-note-toggle')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.classic-inline-note .real-book-note-text, .rb-sheet-column .real-book-note-text')?.textContent)
      .toBe('刚写下的批注')
    app.unmount()
  })

  it('新写批注会自动开启批注模式并显示在页面上', async () => {
    installReaderApi({
      bookView: 'realbook',
      body: LONG_BODY,
      showInlineNotes: false,
    })
    const app = await mountReader()
    expect(document.querySelector<HTMLElement>('.real-book-note-toggle')?.getAttribute('aria-pressed')).toBe('false')

    const para = document.querySelector<HTMLElement>('.real-book-para')!
    const text = longestTextNode(para)
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, Math.min(3, text.textContent!.length))
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    para.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 300 }))
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    // 图标条先展开「⋯」菜单，批注在菜单里。
    document.querySelector<HTMLButtonElement>('.sel-popup [aria-label="更多操作"]')?.click()
    await nextTick()
    document.querySelector<HTMLButtonElement>('.sel-menu [data-action="note"]')?.click()
    await nextTick()
    const editor = document.querySelector<HTMLElement>('.direct-note-editor')!
    const textarea = editor.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = '刚写下的批注'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    buttonByText(editor, '保存批注')?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector<HTMLElement>('.real-book-note-toggle')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.real-book-note-text')?.textContent).toBe('刚写下的批注')
    app.unmount()
  })
})
