// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'

/**
 * 「经典模式 / 真实书籍」切换只改偏好，模板断言看不到 aria 状态与保存时序，
 * 所以这里真挂载一次：默认值、切换后的选中态、提示文案与 settings.set 落盘都要被钉住。
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

/** 够长的正文：分页要能排出第二页，翻页才有得可翻。 */
const LONG_BODY = Array.from({ length: 60 }, (_, i) => `第${i + 1}段。`).join('\n\n')

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

type BookView = 'classic' | 'sheet' | 'realbook'
type SheetColumns = 'single' | 'double'
type HandwritingFont = 'none' | 'kai' | 'xingshu'

function installReaderApi(initialBookView?: BookView, initialHandwritingFont: HandwritingFont = 'none', body?: string) {
  const settingsWrites: Array<{ reader?: { bookView?: BookView; sheetColumns?: SheetColumns; handwritingFont?: HandwritingFont } }> = []
  const chapters = [{ id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const }]
  const book = {
    id: 'book-1', title: '模式书', author: '', tags: [] as string[], importType: 'txt' as const,
    createdAt: '', updatedAt: '', status: 'ready' as const, chapters, progress: null,
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      library: {
        get: async () => ({ book }),
        readChapter: async () => ({ chapter: { title: '第一章', body: body ?? '第一段。\n\n第二段。', status: 'ready' } }),
        setProgress: async () => ({ ok: true }),
      },
      settings: {
        get: async () => ({
          reader: {
            fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
            paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll',
            // 不传就不再写 bookView：用来验证「设置文件缺字段」时的缺省阅读界面。
            ...(initialBookView ? { bookView: initialBookView } : {}), handwritingFont: initialHandwritingFont,
          },
          tts: { rate: 1, autoNextChapter: true }, baseUrl: '',
        }),
        set: async (patch: { reader?: { bookView?: BookView; sheetColumns?: SheetColumns; handwritingFont?: HandwritingFont } }) => {
          settingsWrites.push(patch)
          return {}
        },
      },
      annotations: {
        list: async () => ({ ok: true, items: [] }),
        add: async () => ({ ok: false, message: '测试桩：不新增' }),
        update: async () => ({ ok: false, message: '测试桩：不更新' }),
        remove: async () => ({ ok: true }),
      },
      download: { onProgress: () => () => {} },
      ai: {
        onChunk: () => () => {}, onStage: () => () => {}, onBudget: () => () => {}, onDone: () => () => {},
        getMaterialCoverage: async () => ({ ok: true, coverage: null }),
        getUsage: async () => ({ ok: true, usage: { calls: 0 } }),
        chapterFinished: async () => ({ ok: false, message: '测试桩：不追剧' }),
      },
    },
  })
  return { settingsWrites }
}

async function mountReader() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
  app.mount(host)
  await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
  return app
}

async function openFontPanel() {
  document.querySelector<HTMLElement>('.bottom-button[aria-label="字体"]')?.click()
  await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
}

function modeButtons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[aria-label="阅读界面"] button')]
}

function handwritingButtons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[aria-label="批注手写体"] button')]
}

function columnButtons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[aria-label="排版"] button')]
}

describe('Reader 阅读界面切换（经典模式 / 书页模式 / 真实书籍）', () => {
  it('默认经典模式：经典按钮选中、真实书籍未选中，且不显示占位提示', async () => {
    installReaderApi('classic')
    const app = await mountReader()
    await openFontPanel()

    const buttons = modeButtons()
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['经典模式', '书页模式', '真实书籍'])
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('false')
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('false')
    // 单/双栏只在书页模式下有意义，经典模式不出现这组选项。
    expect(columnButtons()).toEqual([])
    expect(document.querySelector('[role="status"]')).toBeNull()
    app.unmount()
  })

  it('切到真实书籍：选中态翻转、书台渲染出来，并按 bookView 落盘偏好', async () => {
    const { settingsWrites } = installReaderApi('classic')
    const app = await mountReader()
    await openFontPanel()

    modeButtons()[2]?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    const buttons = modeButtons()
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('false')
    // 真实书籍已接入渲染层：经典正文容器让位给双页书台。
    expect(document.querySelector('.real-book-stage')).not.toBeNull()
    expect(document.querySelector('.reader-content')).toBeNull()

    // 偏好保存走 300ms 防抖，等它落一次再断言
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(settingsWrites.some((patch) => patch.reader?.bookView === 'realbook')).toBe(true)
    app.unmount()
  })

  it('手写体选择器默认跟随正文字体，切换行书后写入 handwritingFont 偏好', async () => {
    const { settingsWrites } = installReaderApi('classic', 'none')
    const app = await mountReader()
    await openFontPanel()

    const buttons = handwritingButtons()
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['跟随正文字体', '楷体', '行书'])
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('false')
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('false')

    buttons[2]?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(settingsWrites.some((patch) => patch.reader?.handwritingFont === 'xingshu')).toBe(true)
    app.unmount()
  })

  it('已保存楷体偏好时重开面板恢复选中态', async () => {
    installReaderApi('classic', 'kai')
    const app = await mountReader()
    await openFontPanel()

    const buttons = handwritingButtons()
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('false')
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('false')
    app.unmount()
  })

  it('设置里已是真实书籍时，打开面板即显示该模式并渲染书台', async () => {
    installReaderApi('realbook')
    const app = await mountReader()
    await openFontPanel()

    const buttons = modeButtons()
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('.real-book-stage')).not.toBeNull()
    app.unmount()
  })

  it('设置文件缺 bookView 时默认经典模式，连续滚动渲染正文', async () => {
    installReaderApi(undefined)
    const app = await mountReader()
    await openFontPanel()

    const buttons = modeButtons()
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['经典模式', '书页模式', '真实书籍'])
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('false')
    // 默认不再分页：正文直接进滚动容器，不做书页舞台
    expect(document.querySelector('.real-book-stage')).toBeNull()
    expect(document.querySelector('.reader-content')).not.toBeNull()
    app.unmount()
  })

  it('书页模式：一张纸的书页舞台，默认双栏，可切单栏并落盘 sheetColumns', async () => {
    const { settingsWrites } = installReaderApi('classic')
    const app = await mountReader()
    await openFontPanel()

    modeButtons()[1]?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))

    expect(modeButtons()[1]?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.reader-content')).toBeNull()
    const stage = document.querySelector<HTMLElement>('.real-book-stage')
    expect(stage).not.toBeNull()
    expect(stage?.classList.contains('is-sheet')).toBe(true)
    // 缺省双栏：舞台按两栏下发栏数
    expect(stage?.getAttribute('style')).toContain('--rb-columns: 2')
    // 正文确实落在书页里（段落仍在 DOM 上，划线与选区照旧可用）
    expect(document.querySelector('.rb-sheet [data-p="0"]')).not.toBeNull()
    expect(document.querySelectorAll('.rb-sheet .rb-sheet-column').length).toBe(2)

    const columns = columnButtons()
    expect(columns.map((button) => button.textContent?.trim())).toEqual(['单栏', '双栏'])
    expect(columns[1]?.getAttribute('aria-pressed')).toBe('true')

    columns[0]?.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    expect(columnButtons()[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(stage?.getAttribute('style')).toContain('--rb-columns: 1')

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(settingsWrites.some((patch) => patch.reader?.sheetColumns === 'single')).toBe(true)
    expect(settingsWrites.some((patch) => patch.reader?.bookView === 'sheet')).toBe(true)
    app.unmount()
  })

  it('书页模式：点纸面显隐顶栏与工具条，再点一次收起', async () => {
    installReaderApi('sheet')
    const app = await mountReader()
    await openFontPanel()
    const toolbar = () => document.querySelector('.reader-toolbar')
    // 打开过面板，工具此刻是显式的
    expect(toolbar()?.getAttribute('aria-hidden')).toBe('false')

    const host = document.querySelector<HTMLElement>('.real-book-host')!
    expect(host).not.toBeNull()

    host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    await nextTick()
    expect(toolbar()?.getAttribute('aria-hidden')).toBe('true')
    expect(toolbar()?.classList.contains('reader-tools-hidden')).toBe(true)

    host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    await nextTick()
    expect(toolbar()?.getAttribute('aria-hidden')).toBe('false')
    app.unmount()
  })

  it('书页模式：点纸面左右两侧翻页，点中间显隐工具条', async () => {
    installReaderApi('sheet', 'none', LONG_BODY)
    const app = await mountReader()

    // 书页版式的纸面是那张纸本身（不是整个舞台）。
    const paper = document.querySelector<HTMLElement>('.rb-sheet')!
    expect(paper).not.toBeNull()
    Object.defineProperty(paper, 'clientWidth', { configurable: true, value: 600 })
    paper.getBoundingClientRect = () => ({ left: 0, width: 600 } as DOMRect)

    const label = () => document.querySelector('.rb-sheet-page-label')?.textContent ?? ''
    // 只看当前页号：页表惰性排版，总页数会往下长。
    const pageNo = () => Number(label().match(/第 (\d+)/)?.[1] ?? '0')
    const before = pageNo()
    expect(before).toBe(1)

    // 右侧三分之一：翻下一页。
    paper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 500 }))
    await nextTick()
    expect(pageNo()).toBe(before + 1)

    // 左侧三分之一：回上一页。
    paper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 100 }))
    await nextTick()
    expect(pageNo()).toBe(before)

    // 中间三分之一：只显隐工具条，不翻页。
    const afterPage = pageNo()
    const toolbar = () => document.querySelector('.reader-toolbar')
    const hiddenBefore = toolbar()?.getAttribute('aria-hidden')
    paper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 300 }))
    await nextTick()
    expect(toolbar()?.getAttribute('aria-hidden')).not.toBe(hiddenBefore)
    expect(pageNo()).toBe(afterPage)
    app.unmount()
  })

  it('书页模式：在纸面拖选文字后松手不翻页', async () => {
    installReaderApi('sheet', 'none', LONG_BODY)
    const app = await mountReader()

    const paper = document.querySelector<HTMLElement>('.rb-sheet')!
    Object.defineProperty(paper, 'clientWidth', { configurable: true, value: 600 })
    paper.getBoundingClientRect = () => ({ left: 0, width: 600 } as DOMRect)

    const label = () => document.querySelector('.rb-sheet-page-label')?.textContent ?? ''
    const pageNo = () => Number(label().match(/第 (\d+)/)?.[1] ?? '0')
    const before = pageNo()

    // 拖选：选区在松手那一刻已确定且非折叠。
    const para = document.querySelector<HTMLElement>('.rb-sheet .real-book-para')!
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
    // 选区工具条是在 setTimeout(0) 里读的选区，等它落地。
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()

    expect(pageNo()).toBe(before)
    // 选区工具条照常出现：这一下仍然是「选字」，不是「翻页」。
    expect(document.querySelector('.sel-popup')).not.toBeNull()
    app.unmount()
  })
})

