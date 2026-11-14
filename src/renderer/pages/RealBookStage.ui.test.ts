// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import RealBookStage from './RealBookStage.vue'
import { FLIP_DURATION_MS } from './realBookFlip'
import type { RealBookNote } from './realBookNotes'

/**
 * 真实书籍舞台的组件测试：双页摊开、翻页、缩放、锚点回报。
 *
 * jsdom 没有真实排版（每个段落量出来是一行），但分页规则本身由
 * `realBookPager.test.ts` 覆盖；这里只钉住「界面怎么表现、位置怎么上报」。
 */
class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  configurable: true,
})

afterEach(() => { document.body.innerHTML = '' })

const PARAGRAPHS = Array.from({ length: 30 }, (_, i) => `第${i + 1}段文字。`)

interface MountOptions {
  paragraphs?: string[]
  indexes?: number[]
  highlights?: Array<{ index: number; start: number; end: number; color?: string }>
  startAnchor?: { paragraph: number; offset: number } | null
  chapterTitle?: string
  /** 页眉页脚占高（px）：显式传入才能单独验证签名是否吃占高 */
  headHeight?: number
  footHeight?: number
  notes?: RealBookNote[]
  showNotes?: boolean
  handwritingFont?: 'none' | 'kai' | 'xingshu'
}

async function mountStage(options: MountOptions = {}) {
  const paragraphs = options.paragraphs ?? PARAGRAPHS
  const indexes = options.indexes ?? paragraphs.map((_, i) => i)
  const events: Array<{ type: string; payload: unknown }> = []
  const showNotes = ref(options.showNotes ?? true)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const stageRef = ref<InstanceType<typeof RealBookStage> | null>(null)
  const app = createApp({
    render: () => h(RealBookStage, {
      ref: stageRef,
      paragraphs,
      paragraphIndexes: indexes,
      totalChars: paragraphs.join('').length,
      highlights: options.highlights ?? [],
      startAnchor: options.startAnchor ?? null,
      chapterTitle: options.chapterTitle ?? '',
      headHeight: options.headHeight ?? 0,
      footHeight: options.footHeight ?? 0,
      notes: options.notes ?? [],
      showNotes: showNotes.value,
      handwritingFont: options.handwritingFont ?? 'none',
      'onUpdate:anchor': (anchor: unknown) => events.push({ type: 'anchor', payload: anchor }),
      'onUpdate:page': (page: number) => events.push({ type: 'page', payload: page }),
      'onUpdate:page-count': (count: number) => events.push({ type: 'page-count', payload: count }),
      'onUpdate:show-notes': (show: boolean) => {
        showNotes.value = show
        events.push({ type: 'show-notes', payload: show })
      },
      'onEditNote': (id: string) => events.push({ type: 'edit-note', payload: id }),
      onBack: () => events.push({ type: 'back', payload: null }),
    }),
  })
  app.mount(host)
  await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
  const stage = stageRef.value as unknown as {
    nextPage: () => void
    prevPage: () => void
    hasNextPage: boolean
  }
  return { app, events, stage, showNotes }
}

function note(partial: Partial<RealBookNote> = {}): RealBookNote {
  return {
    id: 'n1',
    paragraph: 2,
    offset: 3,
    text: '这是一条页内批注',
    source: 'user',
    createdAt: '2026-11-09T00:00:00.000Z',
    ...partial,
  }
}

describe('RealBookStage（真实书籍舞台）', () => {
  it('行高以 px 长度下发：CSS 不能把它当成字号倍数', async () => {
    const { app } = await mountStage()
    const style = document.querySelector<HTMLElement>('.real-book-stage')?.getAttribute('style') ?? ''
    const value = /--rb-line-height:\s*([^;]+);/.exec(style)?.[1]?.trim() ?? ''
    // 分页器用的是数值像素；CSS 拿去当 line-height 时，裸数字会被解释成「字号的倍数」
    // （32.4 × 18px = 583px），整页就只剩一行。这个单位必须钉在测试里。
    expect(value).toMatch(/^\d+(\.\d+)?px$/)
    expect(Number.parseFloat(value)).toBeCloseTo(18 * 1.8, 6)
    app.unmount()
  })

  it('量断行容器与正文段落同缩进：漏掉 2em 会少算一行、末行被栏底裁掉', async () => {
    const { app } = await mountStage()
    const measure = document.querySelector<HTMLElement>('.real-book-measure')
    expect(measure).not.toBeNull()
    // 正文段落是 `.real-book-para { text-indent: 2em }`，量测容器必须一致
    expect(measure?.style.textIndent).toBe('2em')
    app.unmount()
  })

  it('摊开两页：左页右页各一块，页码状态可见', async () => {
    const { app } = await mountStage()
    expect(document.querySelectorAll('.real-book-page')).toHaveLength(2)
    expect(document.querySelector('.real-book-left')).not.toBeNull()
    expect(document.querySelector('.real-book-right')).not.toBeNull()
    expect(document.querySelector('.real-book-page-label')?.textContent).toContain('页')
    app.unmount()
  })

  it('开本接近方形：单页宽高比 1:1（参考图的宽书）', async () => {
    const { app } = await mountStage()
    const style = document.querySelector<HTMLElement>('.real-book-stage')?.getAttribute('style') ?? ''
    const width = Number(/--rb-page-width:\s*(\d+(?:\.\d+)?)px/.exec(style)?.[1] ?? NaN)
    const height = Number(/--rb-page-height:\s*(\d+(?:\.\d+)?)px/.exec(style)?.[1] ?? NaN)
    expect(Number.isFinite(width)).toBe(true)
    expect(Number.isFinite(height)).toBe(true)
    expect(width).toBeCloseTo(height, 5)
    app.unmount()
  })

  it('左上角有圆形返回键：点按发出 back 事件', async () => {
    const { app, events } = await mountStage()
    const back = document.querySelector<HTMLElement>('.real-book-back')
    expect(back).not.toBeNull()
    expect(back?.getAttribute('aria-label')).toBe('返回书库')
    back?.click()
    expect(events.some((event) => event.type === 'back')).toBe(true)
    app.unmount()
  })

  it('书台有硬壳封面与上下纸页切口，不再只是两张平纸', async () => {
    const { app } = await mountStage()
    expect(document.querySelectorAll('.real-book-board')).toHaveLength(2)
    expect(document.querySelector('.real-book-block-right .real-book-block-top')).not.toBeNull()
    app.unmount()
  })

  it('正文落在页面上，段落带原始下标 data-p', async () => {
    const { app } = await mountStage()
    const paras = [...document.querySelectorAll<HTMLElement>('.real-book-para')]
    expect(paras.length).toBeGreaterThan(0)
    expect(paras[0]?.dataset.p).toBe('0')
    expect(document.querySelector('.real-book-right')?.textContent).toContain('第1段文字。')
    app.unmount()
  })

  it('翻到下一页：页码状态推进，并上报新的锚点', async () => {
    const { app, events, stage } = await mountStage()
    const before = Number(document.querySelector('.real-book-page-label')?.textContent?.match(/第 (\d+)/)?.[1] ?? '1')
    stage.nextPage()
    // 翻页有整段动效，落定后才换页内容。
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 200))
    await nextTick()
    const after = Number(document.querySelector('.real-book-page-label')?.textContent?.match(/第 (\d+)/)?.[1] ?? '1')
    // 书台是双页摊开：翻一张纸会同时换掉左右两页，一次前进 2 页。
    // 只前进 1 页会把「翻一张纸」读成「挪一个窗口」。
    expect(after).toBe(before + 2)
    expect(events.some((e) => e.type === 'anchor')).toBe(true)
    app.unmount()
  })

  it('翻页中态：正面是旧右页，纸背是落定后的左页', async () => {
    const { app, stage } = await mountStage({ chapterTitle: '第一章 测试' })
    // 首屏左页是空的（章首），右页是第 1 页。
    stage.nextPage()
    await nextTick()

    const front = document.querySelector('.real-book-flip-front')
    expect(front?.querySelector('.real-book-page-head')?.textContent).toBe('第一章 测试')
    // 书心不再留槽，翻动页与两页共用中心线，避免书脊出现贯穿页高的空白竖带。
    expect(document.querySelector<HTMLElement>('.real-book-flip')?.style.left).toBe('calc(50% + 0px)')
    // 翻动的是第 1 页（原来的右页）。
    expect(front?.querySelector('.real-book-page-foot')?.textContent?.trim()).toBe('1')
    // 纸背就是这张纸的另一面：落地后它成为左页。空白纸背会读成一块硬纸板。
    // 纸背只在竖带转过 90° 后才挂载（v-if），所以先等它出现再断言。
    for (let i = 0; i < 60 && !document.querySelector('.real-book-flip-back'); i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    const back = document.querySelector('.real-book-flip-back')
    expect(back).not.toBeNull()
    expect(back?.querySelector('.real-book-page-head')?.textContent).toBe('第一章 测试')
    expect(back?.querySelector('.real-book-page-foot')?.textContent?.trim()).toBe('2')
    expect(back?.textContent).toContain('第12段文字。')
    expect(back?.querySelector<HTMLElement>('.real-book-flip-content')?.style.transform).toContain('scaleX(-1)')
    // 纸抬起来的这一侧立刻露出翻页后的新右页（前进 2 页）：否则纸底下压着一模一样的一页，
    // 看着像没翻动。
    expect(document.querySelector('.real-book-right .real-book-page-foot')?.textContent?.trim()).toBe('3')

    // 等落定定时器走完，别让它漏到下一个用例里。
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 200))
    app.unmount()
  })

  it('翻页中态：竖带转过 90° 后正面整层停画，不留下半透明的上一页', async () => {
    const { app, stage } = await mountStage()
    stage.nextPage()
    await nextTick()

    // 起手时最外那条带已经越过正对观者的位置；它的正面内容必须整层 opacity 0，
    // 否则侧过去的那半张仍按 opacity 叠在下方页面上，看起来像整页残影。
    let sawHiddenSide = false
    for (let i = 0; i < 60; i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      // 直接读几何下发的 --rb-flip-side：它决定正面整层是否停画，
      // 比 jsdom 对多层继承 opacity 的计算更接近真实约定。
      const sides = [...document.querySelectorAll<HTMLElement>('.real-book-flip-slice')]
        .map((node) => Number(node.style.getPropertyValue('--rb-flip-side')))
      if (sides.some((opacity) => opacity === 0)) {
        sawHiddenSide = true
        break
      }
    }
    expect(sawHiddenSide).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 200))
    app.unmount()
  })

  it('翻页中态：竖带始终铺满页高，不裁出露出底下页的横缝', async () => {
    const { app, stage } = await mountStage()
    stage.nextPage()
    await nextTick()

    // 上下缘内收的裁切会在纸上挖掉一条横带：下面静态页的新内容从缝里露出来，
    // 起手几帧看起来就像纸先被撕开、再开始翻转。竖带必须保持整页高度。
    for (let i = 0; i < 20; i += 1) {
      const slices = [...document.querySelectorAll<HTMLElement>('.real-book-flip-slice')]
      expect(slices.length).toBeGreaterThan(0)
      for (const slice of slices) expect(slice.style.clipPath).toBe('')
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }

    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 200))
    app.unmount()
  })

  it('书心不留贯穿页高的空白槽', async () => {
    const { app } = await mountStage()
    const gutter = document.querySelector<HTMLElement>('.real-book-gutter')
    expect(gutter).not.toBeNull()
    // 宽度为 0 的元素计算后是 0px；布局空间必须完全消失。
    expect(gutter!.getBoundingClientRect().width).toBeLessThan(0.5)
    app.unmount()
  })

  it('向前翻页时转轴落在书心中心线', async () => {
    const { app, stage } = await mountStage()
    // 先翻到第二屏，再往回翻，才能测到 direction=-1 的转轴。
    stage.nextPage()
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 200))
    stage.prevPage()
    await nextTick()

    expect(document.querySelector<HTMLElement>('.real-book-flip')?.style.left).toBe('calc(50% - 0px)')

    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 200))
    app.unmount()
  })

  it('没有翻页按钮：翻页改由点按纸面承担', async () => {
    const { app } = await mountStage()
    // 翻页按钮已移除：读者靠点纸面左右两侧翻页，页码只在页脚报位置。
    expect(document.querySelector('[aria-label="下一页"]')).toBeNull()
    expect(document.querySelector('[aria-label="上一页"]')).toBeNull()
    expect(document.querySelector('.real-book-page-label')?.textContent).toContain('页')
    app.unmount()
  })

  it('两页都有页眉，页脚分别标当前页与下一页', async () => {
    const { app } = await mountStage({ chapterTitle: '第一章 风起' })
    const heads = [...document.querySelectorAll('.real-book-page-head')]
    expect(heads).toHaveLength(2)
    expect(heads.map((node) => node.textContent)).toEqual(['第一章 风起', '第一章 风起'])
    const feet = [...document.querySelectorAll('.real-book-page-foot')]
    expect(feet).toHaveLength(2)
    // 左页是上一页（第一屏时为空），右页是第 1 页。
    expect(feet.map((node) => node.textContent)).toEqual(['', '1'])
    app.unmount()
  })

  it('页眉页脚占高进排版签名：同一字号下占高变大，页数随之变多', async () => {
    // 页表是惰性排的：拿全量页数得先跳到末段，让分页器把整章排完。
    const baseline = await mountStage({ headHeight: 20, footHeight: 20, startAnchor: { paragraph: 29, offset: 0 } })
    const basePages = Math.max(...baseline.events.filter((e) => e.type === 'page-count').map((e) => e.payload as number))
    baseline.app.unmount()
    document.body.innerHTML = ''

    const tall = await mountStage({ headHeight: 200, footHeight: 200, startAnchor: { paragraph: 29, offset: 0 } })
    const tallPages = Math.max(...tall.events.filter((e) => e.type === 'page-count').map((e) => e.payload as number))

    // 占高吃掉版心：同样的段落与字号，页眉页脚越高，页数越多。
    expect(tallPages).toBeGreaterThan(basePages)
    tall.app.unmount()
  })

  it('页眉不随标题长短变高：标题再长也只占一行', async () => {
    const short = await mountStage({ chapterTitle: '短标题', startAnchor: { paragraph: 29, offset: 0 } })
    const shortPages = Math.max(...short.events
      .filter((e) => e.type === 'page-count')
      .map((e) => e.payload as number))
    short.app.unmount()
    document.body.innerHTML = ''

    const long = await mountStage({ chapterTitle: '第'.repeat(80), startAnchor: { paragraph: 29, offset: 0 } })
    const longPages = Math.max(...long.events
      .filter((e) => e.type === 'page-count')
      .map((e) => e.payload as number))

    // 页眉高固定，长标题被省略号截断：不改变页数（否则页表会随标题长度抖动）。
    expect(longPages).toBe(shortPages)
    long.app.unmount()
  })

  it('书厚：第一屏左半无已读、右半显示该书基础厚度', async () => {
    const { app } = await mountStage()
    const left = document.querySelectorAll('.real-book-block-left i')
    const right = document.querySelectorAll('.real-book-block-right i')
    expect(left).toHaveLength(0)
    expect(right.length).toBeGreaterThanOrEqual(3)
    expect(right.length).toBeLessThanOrEqual(14)
    app.unmount()
  })

  it('翻到章末：书厚全部叠到左半（已读），右半为空', async () => {
    const { app } = await mountStage({ startAnchor: { paragraph: 29, offset: 0 } })
    const left = document.querySelectorAll('.real-book-block-left i')
    const right = document.querySelectorAll('.real-book-block-right i')
    expect(left.length).toBeGreaterThanOrEqual(3)
    expect(right).toHaveLength(0)
    app.unmount()
  })

  it('书厚层数带纵深偏移，且不超过最大显示层数', async () => {
    const { app } = await mountStage({ startAnchor: { paragraph: 15, offset: 0 } })
    const layers = [...document.querySelectorAll<HTMLElement>('.real-book-block i')]
    expect(layers.length).toBeGreaterThanOrEqual(3)
    expect(layers.length).toBeLessThanOrEqual(14)
    for (const layer of layers) {
      expect(layer.style.transform).toContain('translate3d')
    }
    app.unmount()
  })

  it('缩放有独立控件，改变缩放比例', async () => {
    const { app } = await mountStage()
    const value = () => document.querySelector('.real-book-zoom-value')?.textContent ?? ''
    expect(value()).toBe('100%')
    document.querySelector<HTMLElement>('[aria-label="放大"]')?.click()
    await nextTick()
    expect(value()).toBe('110%')
    document.querySelector<HTMLElement>('[aria-label="重置缩放"]')?.click()
    await nextTick()
    expect(value()).toBe('100%')
    app.unmount()
  })

  it('划线在页面上以高亮出现，颜色跟着走', async () => {
    const { app } = await mountStage({
      paragraphs: ['第一段文字。'],
      indexes: [0],
      highlights: [{ index: 0, start: 0, end: 3, color: 'green' }],
    })
    const hl = document.querySelector('.real-book-right mark.hl-mark')
    expect(hl?.textContent).toBe('第一段')
    expect(hl?.classList.contains('hl-green')).toBe(true)
    app.unmount()
  })

  it('给了起始锚点时，落在对应段所在页', async () => {
    const { app, events } = await mountStage({ startAnchor: { paragraph: 2, offset: 0 } })
    // 锚点被回报一次（说明舞台认了这个位置并给出了页首锚点）。
    const anchorEvents = events.filter((e) => e.type === 'anchor')
    expect(anchorEvents.length).toBeGreaterThan(0)
    const last = anchorEvents[anchorEvents.length - 1]!.payload as { paragraph: number; offset: number }
    expect(last.paragraph).toBeGreaterThanOrEqual(0)
    app.unmount()
  })

  it('正文是纯文本节点，不走 v-html', async () => {
    const { app } = await mountStage({ paragraphs: ['<b>不该是标签</b>'] })
    expect(document.querySelector('.real-book-right')?.innerHTML).not.toContain('<b>')
    expect(document.querySelector('.real-book-right')?.textContent).toContain('<b>不该是标签</b>')
    app.unmount()
  })

  it('批注卡紧跟锚定段落的最后一个片段，落在正文流里', async () => {
    const { app } = await mountStage({ notes: [note()] })
    const card = document.querySelector<HTMLElement>('.real-book-right .real-book-note[data-note-id="n1"]')
    expect(card).not.toBeNull()
    const anchored = document.querySelector<HTMLElement>('.real-book-right .real-book-para[data-p="2"]')
    expect(anchored).not.toBeNull()
    // 卡片必须排在被批注段落之后，而不是浮在页角。
    expect(anchored!.nextElementSibling).toBe(card)
    expect(card?.querySelector('.real-book-note-label')?.textContent).toContain('笔记')
    expect(card?.querySelector('.real-book-note-text')?.textContent).toBe('这是一条页内批注')
    app.unmount()
  })

  it('批注带 #tag，段末显示「注」标记且不污染原文文本', async () => {
    const { app } = await mountStage({ notes: [note({ tags: ['quote'] })] })
    const para = document.querySelector<HTMLElement>('.real-book-right .real-book-para[data-p="2"]')
    const marker = para?.querySelector<HTMLElement>('.real-book-note-anchor[data-note-anchor-id="n1"]')
    expect(marker).not.toBeNull()
    // 标记字由 CSS 伪元素提供，正文文本节点仍逐字对应原文。
    expect(para?.textContent).toBe('第3段文字。')
    expect(document.querySelector('.real-book-right .real-book-note-tag')?.textContent).toBe('#quote')
    app.unmount()
  })

  it('批注卡空间不足时整体移到下一页，不被拆开', async () => {
    // 两个长段先把第二段推到页尾，卡片剩余空间不够就只能从下一页开头出现。
    const long = '很长的段落。'.repeat(120)
    const { app, stage } = await mountStage({
      paragraphs: ['开头。', long, '第二段。', '第三段。'],
      indexes: [0, 1, 2, 3],
      notes: [note({ id: 'n-tail', paragraph: 1, offset: long.length })],
    })
    // 让分页器把卡片所在页显式排出来，再检查卡片没有跨页碎片。
    stage.nextPage()
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 200))
    await nextTick()
    const cards = [...document.querySelectorAll('.real-book-note[data-note-id="n-tail"]')]
    expect(cards).toHaveLength(1)
    // 卡片所在页必须有它锚定段落的文本（同一页或续页尾部），而不是孤零零悬空。
    const cardPage = cards[0]?.closest('.real-book-page, .real-book-flip-front, .real-book-flip-back')
    expect(cardPage?.textContent).toContain('很长的段落。')
    app.unmount()
  })

  it('批注卡支持 AI 标记与手写体，正文不需要手写体', async () => {
    const { app } = await mountStage({
      notes: [note({ id: 'n-ai', source: 'ai', text: 'AI 写的解释' })],
      handwritingFont: 'kai',
    })
    const card = document.querySelector<HTMLElement>('.real-book-right .real-book-note[data-note-id="n-ai"]')
    expect(card?.classList.contains('handwriting-kai')).toBe(true)
    expect(card?.classList.contains('is-ai')).toBe(true)
    expect(card?.querySelector('.real-book-note-source')?.textContent).toBe('AI')
    // 手写体只作用于批注，不污染正文段落。
    expect(document.querySelector('.real-book-para.handwriting-kai')).toBeNull()
    app.unmount()
  })

  it('批注文本按纯文本渲染，不解析 HTML', async () => {
    const { app } = await mountStage({
      notes: [note({ text: '<b>不该加粗</b>' })],
    })
    const page = document.querySelector('.real-book-right')
    expect(page?.querySelector('b')).toBeNull()
    expect(page?.querySelector('.real-book-note-text')?.innerHTML).toBe('&lt;b&gt;不该加粗&lt;/b&gt;')
    expect(page?.textContent).toContain('<b>不该加粗</b>')
    app.unmount()
  })

  it('批注开关带 aria-pressed，关闭后卡片隐藏但正文仍在', async () => {
    const { app } = await mountStage({ notes: [note()] })
    const toggle = document.querySelector<HTMLElement>('.real-book-note-toggle')!
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.real-book-right .real-book-note[data-note-id="n1"]')).not.toBeNull()

    toggle.click()
    await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('.real-book-right .real-book-note[data-note-id="n1"]')).toBeNull()
    expect(document.querySelector('.real-book-page .real-book-para')).not.toBeNull()
    app.unmount()
  })

  it('点击批注卡只发出编辑事件，不触发翻页', async () => {
    const { app, events } = await mountStage({ notes: [note()] })
    const card = document.querySelector<HTMLElement>('.real-book-right .real-book-note[data-note-id="n1"]')!
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: 500 }))
    card.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 500 }))
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 100))
    await nextTick()

    expect(events.some((event) => event.type === 'edit-note' && event.payload === 'n1')).toBe(true)
    expect(document.querySelector('.real-book-page-label')?.textContent).toContain('第 1')
    expect(document.querySelector<HTMLElement>('.real-book-note[data-note-id="n1"]')).not.toBeNull()
    app.unmount()
  })

  it('翻动页正面同样渲染批注卡', async () => {
    const { app, stage } = await mountStage({ notes: [note()] })
    stage.nextPage()
    await nextTick()
    expect(document.querySelector('.real-book-flip-front .real-book-note[data-note-id="n1"]')).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 200))
    app.unmount()
  })

  it('同一条带只挂一面：正反两面的字不会叠在同一张纸上', async () => {
    const { app, stage } = await mountStage()
    stage.nextPage()
    await nextTick()

    // 重影只有一种来源：同一条带同时画了正面与背面。显隐由 flipFaceVisible 互斥
    // 下发成模板上的两个 v-if；竖带转过 90° 的瞬间也只是换面，不是叠面。
    let sawBoth = false
    let sawBack = false
    for (let i = 0; i < 60; i += 1) {
      for (const slice of document.querySelectorAll('.real-book-flip-slice')) {
        const faces = slice.querySelectorAll(':scope > .real-book-flip-face').length
        expect(faces).toBeLessThanOrEqual(1)
        if (faces === 1) sawBoth = true
        if (slice.querySelector(':scope > .real-book-flip-back')) sawBack = true
      }
      if (sawBack) break
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    expect(sawBoth).toBe(true)
    // 正反两面都必须在整段翻页里各出现过一次，否则这个断言就只是在测一个空集合。
    expect(sawBack).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 200))
    app.unmount()
  })

  it('纸背正文按转角自己淡入，不被正面的停画变量带走', async () => {
    const { app, stage } = await mountStage()
    stage.nextPage()
    await nextTick()

    // 正面停画靠 `--rb-flip-side: 0`；纸背可见时这条带上的它正好是 0。
    // 纸背正文的 opacity 必须来自 flipBackContentOpacity 的内联值，不能被那个变量带走。
    // 但也不能指望它一露面就是亮的：刚转过 90° 时纸还侧着，投影不足半宽，
    // 那时正文本来就该收干净——纸背要转到快平了才露出正文。
    let sawBackSide = false
    let maxOpacity = 0
    let sawInline = false
    for (let i = 0; i < 120; i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      for (const back of document.querySelectorAll<HTMLElement>('.real-book-flip-back')) {
        const content = back.querySelector<HTMLElement>('.real-book-flip-content')
        if (!content) continue
        const slice = back.closest<HTMLElement>('.real-book-flip-slice')
        const side = Number(slice?.style.getPropertyValue('--rb-flip-side'))
        const opacity = Number(content.style.opacity)
        if (side !== 0) continue
        sawBackSide = true
        if (Number.isFinite(opacity)) {
          sawInline = true
          maxOpacity = Math.max(maxOpacity, opacity)
        }
      }
      if (maxOpacity >= 0.3) break
    }
    expect(sawBackSide).toBe(true)
    expect(sawInline).toBe(true)
    // 纸转平后必须印出正文，否则纸背就只是一张白纸。
    expect(maxOpacity).toBeGreaterThan(0.3)

    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS + 200))
    app.unmount()
  })

  it('纸面不透明、且停画兜底只落在正面', () => {
    // 跨竖带的重叠区靠**不透明纸面**遮挡：两条带的字落在不同 x 区间，
    // 纸面一旦半透明，下面那条带的字就会透上来，看起来就是重影。
    // 停画变量同理只能管正面——写成不限面的选择器会把纸背正文一起清零。
    const source = readFileSync(join(import.meta.dirname, 'RealBookStage.vue'), 'utf-8')

    const faceRule = /\.real-book-flip-face \{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(faceRule).toMatch(/background:\s*var\(--rb-paper-warm[^)]*\)\s*;/)
    // 不透明底色不能带上 alpha（rgba(...) / color-mix(...transparent) 都会漏出下层）。
    expect(faceRule).not.toMatch(/background:[^;]*transparent/)

    const frontRule = /\.real-book-flip-front \.real-book-flip-content \{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(frontRule).toContain('opacity: var(--rb-flip-side, 1)')
    // 不带面限定的规则行必须没有：它会在纸背可见时（--rb-flip-side 为 0）连纸背正文一起清零。
    const bareRule = /^\.real-book-flip-content \{([^}]*)\}/m.exec(source)?.[1]
    expect(bareRule ?? '').not.toContain('--rb-flip-side')
  })
})
