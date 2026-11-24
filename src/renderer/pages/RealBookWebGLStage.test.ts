// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import RealBookWebGLStage from './RealBookWebGLStage.vue'
import type { RealBookTexturePage } from './realBookTexture'

afterEach(() => { document.body.innerHTML = '' })

describe('RealBookWebGLStage', () => {
  it('没有 WebGL 时明确回退，而不是留下空白舞台', async () => {
    const events: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(RealBookWebGLStage, {
        leftPage: null,
        rightPage: null,
        flipFrontPage: null,
        flipBackPage: null,
        onUnsupported: () => events.push('unsupported'),
      }),
    })
    app.mount(host)
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
    expect(events).toContain('unsupported')
    expect(document.querySelector('.real-book-webgl-fallback')?.textContent).toContain('WebGL 不可用')
    app.unmount()
  })

  it('暴露 paperEl 给父组件的三分区翻页', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let stageRef: unknown = null
    const app = createApp({
      render: () => h(RealBookWebGLStage, {
        ref: (value: unknown) => { stageRef = value },
        leftPage: null,
        rightPage: null,
        flipFrontPage: null,
        flipBackPage: null,
      }),
    })
    app.mount(host)
    await nextTick()
    expect((stageRef as { paperEl?: HTMLElement | null } | null)?.paperEl).toBeInstanceOf(HTMLElement)
    app.unmount()
  })

  it('透明文本层按段落挂 data-p，供 WebGL 下选字换算坐标', async () => {
    const page: RealBookTexturePage = {
      pageNumber: 1,
      chapterTitle: '',
      items: [{
        kind: 'text',
        text: '测试段落',
        originalIndex: 3,
        start: 0,
        end: 4,
        continued: false,
        lines: [{ start: 0, end: 4 }],
        highlights: [],
        noteMarks: [],
      }],
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(RealBookWebGLStage, { leftPage: page, rightPage: null, flipFrontPage: null, flipBackPage: null }),
    })
    app.mount(host)
    await nextTick()
    const para = document.querySelector('.real-book-text-para[data-p="3"]')
    expect(para).not.toBeNull()
    expect(para?.querySelector('.real-book-text-line')?.textContent).toBe('测试段落')
    app.unmount()
  })

  it('页眉页脚也由 DOM 文本层显示：页眉在上、页码在下，字号小于正文', async () => {
    const page: RealBookTexturePage = {
      pageNumber: 12,
      chapterTitle: '第一章',
      header: '智人之后',
      items: [],
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(RealBookWebGLStage, { leftPage: page, rightPage: null, flipFrontPage: null, flipBackPage: null }),
    })
    app.mount(host)
    await nextTick()
    const chrome = [...document.querySelectorAll<HTMLElement>('.real-book-chrome-line')]
    expect(chrome.map((el) => el.textContent)).toEqual(['智人之后', '12'])
    const headerTop = Number.parseFloat(chrome[0]!.style.top)
    const footerTop = Number.parseFloat(chrome[1]!.style.top)
    expect(headerTop).toBeLessThan(footerTop)
    // 18px 正文的页眉页脚是 0.62 倍。
    expect(Number.parseFloat(chrome[0]!.style.fontSize)).toBeCloseTo(18 * 0.62)
    app.unmount()
  })

  it('页内批注贴出书口标签，点标签上报 edit-note', async () => {
    const page: RealBookTexturePage = {
      pageNumber: 2,
      chapterTitle: '第一章',
      items: [{
        kind: 'note',
        note: {
          id: 'n1',
          paragraph: 0,
          offset: 4,
          text: '这是一条批注',
          source: 'user',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        height: 80,
      }],
    }
    const clicked: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(RealBookWebGLStage, {
        leftPage: page,
        rightPage: null,
        flipFrontPage: null,
        flipBackPage: null,
        onEditNote: (id: string) => clicked.push(id),
      }),
    })
    app.mount(host)
    await nextTick()
    const tab = document.querySelector('.real-book-note-tab.is-left') as HTMLElement | null
    expect(tab?.textContent).toBe('注')
    expect(tab?.getAttribute('title')).toBe('这是一条批注')
    tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(clicked).toEqual(['n1'])
    app.unmount()
  })

  it('翻页时只藏被翻走那一页的正文，落位前把另一页也收掉', async () => {
    const page: RealBookTexturePage = {
      pageNumber: 1,
      chapterTitle: '',
      items: [{
        kind: 'text',
        text: '测试段落',
        originalIndex: 0,
        start: 0,
        end: 4,
        continued: false,
        lines: [{ start: 0, end: 4 }],
        highlights: [],
        noteMarks: [],
      }],
    }
    const mountWithFlip = async (direction: 1 | -1, progress: number) => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const app = createApp({
        render: () => h(RealBookWebGLStage, {
          leftPage: page,
          rightPage: page,
          flipFrontPage: null,
          flipBackPage: null,
          flips: [{ id: 1, front: page, back: page, direction, progress, follow: false }],
        }),
      })
      app.mount(host)
      await nextTick()
      const displays = [...document.querySelectorAll<HTMLElement>('.real-book-webgl-text-page')]
        .map((el) => el.style.display)
      app.unmount()
      host.remove()
      return displays
    }
    // 正向 30%：右页在翻走，左页的字要看得见。
    expect(await mountWithFlip(1, 0.3)).toEqual(['', 'none'])
    // 正向 80%：飞页快落到左页上了，左侧 DOM 正文收掉，交给飞页纸背。
    expect(await mountWithFlip(1, 0.8)).toEqual(['none', 'none'])
    // 反向：藏左页、右页可见。
    expect(await mountWithFlip(-1, 0.3)).toEqual(['none', ''])
  })

  it('页内注卡与图片走 DOM：卡片可点开批注、图片走协议、图注与标签贴在页面上', async () => {
    const page: RealBookTexturePage = {
      pageNumber: 2,
      chapterTitle: '第一章',
      items: [
        {
          kind: 'note',
          note: {
            id: 'n1',
            paragraph: 0,
            offset: 4,
            text: '这是一条批注',
            source: 'user',
            tags: ['人物'],
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          height: 80,
        },
        { kind: 'image', file: 'pic.png', width: 100, height: 50, caption: '插图一', displayHeight: 120 },
      ],
    }
    const clicked: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(RealBookWebGLStage, {
        leftPage: page,
        rightPage: null,
        flipFrontPage: null,
        flipBackPage: null,
        bookId: 'b1',
        onEditNote: (id: string) => clicked.push(id),
      }),
    })
    app.mount(host)
    await nextTick()
    const card = document.querySelector('.real-book-note-card') as HTMLElement | null
    expect(card?.getAttribute('title')).toBe('这是一条批注')
    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(clicked).toEqual(['n1'])
    const image = document.querySelector('.real-book-webgl-image img') as HTMLImageElement | null
    expect(image?.getAttribute('src')).toBe('spbf-image://i/b1/pic.png')
    const runs = [...document.querySelectorAll('.real-book-page-run')].map((el) => el.textContent)
    expect(runs).toContain('笔记')
    expect(runs).toContain('这是一条批注')
    expect(runs).toContain('#人物')
    expect(runs).toContain('插图一')
    app.unmount()
  })

  it('段内划线底色与「注」点也走 DOM：底色在正文下、注点在正文上', async () => {
    const page: RealBookTexturePage = {
      pageNumber: 3,
      chapterTitle: '',
      items: [{
        kind: 'text',
        text: '一二三四五六',
        originalIndex: 0,
        start: 0,
        end: 6,
        continued: false,
        lines: [{ start: 0, end: 6 }],
        highlights: [{ start: 1, end: 4, color: 'red' }],
        noteMarks: [5],
      }],
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(RealBookWebGLStage, { leftPage: page, rightPage: null, flipFrontPage: null, flipBackPage: null }),
    })
    app.mount(host)
    await nextTick()
    const mark = document.querySelector('.real-book-mark') as HTMLElement | null
    expect(mark).not.toBeNull()
    expect(mark?.style.background).toContain('206, 82, 82')
    const dot = document.querySelector('.real-book-note-dot') as HTMLElement | null
    expect(dot?.textContent).toBe('注')
    const pageEl = document.querySelector('.real-book-webgl-text-page') as HTMLElement
    const nodes = [...pageEl.children]
    const paragraphAt = nodes.findIndex((el) => el.classList.contains('real-book-text-para'))
    expect(nodes.indexOf(mark!)).toBeLessThan(paragraphAt)
    expect(nodes.indexOf(dot!)).toBeGreaterThan(paragraphAt)
    app.unmount()
  })

  it('向父层暴露 nextPage/prevPage（WebGL 翻页由 BookModel 接管）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let stageRef: unknown = null
    const app = createApp({
      render: () => h(RealBookWebGLStage, {
        ref: (value: unknown) => { stageRef = value },
        leftPage: null,
        rightPage: null,
        pageAt: () => null,
        turned: 0,
      }),
    })
    app.mount(host)
    await nextTick()
    const stage = stageRef as { nextPage?: unknown; prevPage?: unknown; paperEl?: unknown } | null
    expect(typeof stage?.nextPage).toBe('function')
    expect(typeof stage?.prevPage).toBe('function')
    expect(stage?.paperEl).toBeInstanceOf(HTMLElement)
    app.unmount()
  })

  it('开合交给 BookModel 落定回报；俯仰立即上报', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const opens: boolean[] = []
    const pitches: number[] = []
    let stageRef: unknown = null
    const app = createApp({
      render: () => h(RealBookWebGLStage, {
        ref: (value: unknown) => { stageRef = value },
        leftPage: null,
        rightPage: null,
        flipFrontPage: null,
        flipBackPage: null,
        'onUpdate:open': (value: boolean) => opens.push(value),
        'onUpdate:pitch': (value: number) => pitches.push(value),
      }),
    })
    app.mount(host)
    await nextTick()
    const stage = stageRef as { setOpen: (open: boolean) => void; setPitch: (value: number) => void }
    // jsdom 没有 WebGL 场景：setOpen 只把目标交给 BookModel，不提前回报；
    // 真正的 update:open 由 BookModel 的 onSettle 在开合弹簧落定后发出。
    expect(typeof stage.setOpen).toBe('function')
    stage.setOpen(false)
    stage.setOpen(true)
    expect(opens).toEqual([])
    stage.setPitch(-10)
    expect(pitches).toEqual([0])
    app.unmount()
  })

  it('选字命中交给行盒子，段落盒子不吃指针事件', () => {
    // 段落盒子按整页铺满，行是绝对定位的。段落盒子一旦自己吃指针事件，
    // 光标落在任何位置都先命中最后一个段落，落点被吸到那一行——上半页拖选就会选到下半页的字。
    const source = readFileSync(join(import.meta.dirname, 'RealBookWebGLStage.vue'), 'utf-8')

    const paraRule = /\.real-book-text-para \{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(paraRule).toContain('pointer-events: none')

    const lineRule = /\.real-book-text-line \{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(lineRule).toContain('pointer-events: auto')
  })
})
