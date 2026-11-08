// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import RealBookStage from './RealBookStage.vue'
import { FLIP_DURATION_MS } from './realBookFlip'

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
}

async function mountStage(options: MountOptions = {}) {
  const paragraphs = options.paragraphs ?? PARAGRAPHS
  const indexes = options.indexes ?? paragraphs.map((_, i) => i)
  const events: Array<{ type: string; payload: unknown }> = []
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
      'onUpdate:anchor': (anchor: unknown) => events.push({ type: 'anchor', payload: anchor }),
      'onUpdate:page': (page: number) => events.push({ type: 'page', payload: page }),
      'onUpdate:page-count': (count: number) => events.push({ type: 'page-count', payload: count }),
    }),
  })
  app.mount(host)
  await nextTick(); await nextTick(); await new Promise((resolve) => setTimeout(resolve, 0))
  const stage = stageRef.value as unknown as {
    nextPage: () => void
    prevPage: () => void
    hasNextPage: boolean
  }
  return { app, events, stage }
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
})
