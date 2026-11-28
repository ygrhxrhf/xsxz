// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import ReaderMindmap from './ReaderMindmap.vue'
import { buildMindmapTree, type MindmapAnchor, type MindmapNode } from '../pages/readerMindmap'

class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
afterEach(() => { document.body.innerHTML = '' })

/**
 * 树：root → p0 → p0-s0 / p0-s1，root → p1 → p1-s0。
 * 默认全部展开时可见节点共 6 个；节点用 data-node-id 定位，避免靠文案模糊匹配。
 */
async function mountMindmap() {
  const root = buildMindmapTree('第一章', ['第一句。第二句！', '第三句？'])
  const selected: MindmapAnchor[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(ReaderMindmap, {
      root,
      'onSelect': (anchor: MindmapAnchor) => selected.push(anchor),
    }),
  })
  app.mount(host)
  await nextTick()
  return { app, selected }
}

function node(nodeId: string): SVGElement | undefined {
  return document.querySelector<SVGElement>(`[data-node-id="${nodeId}"]`) ?? undefined
}

function click(element: Element | undefined): void {
  element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('ReaderMindmap（SVG 思维导图）', () => {
  it('渲染 SVG、节点和可见节点数量', async () => {
    const { app } = await mountMindmap()
    expect(document.querySelector('svg[role="tree"]')).not.toBeNull()
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(6)
    expect(document.querySelector('.reader-mindmap-count')?.textContent).toContain('6')
    app.unmount()
  })

  it('节点之间画出连线', async () => {
    const { app } = await mountMindmap()
    // root→p0、root→p1、p0→两个句组、p1→一个句组，共 5 条。
    expect(document.querySelectorAll('.reader-mindmap-links path')).toHaveLength(5)
    app.unmount()
  })

  it('节点具备 aria-label、tabindex 和展开状态', async () => {
    const { app } = await mountMindmap()
    const root = node('root')
    expect(root?.getAttribute('tabindex')).toBe('0')
    expect(root?.getAttribute('aria-label')).toContain('第一章')
    expect(root?.getAttribute('aria-expanded')).toBe('true')
    expect(node('p0')?.getAttribute('aria-label')).toContain('已展开')
    app.unmount()
  })

  it('点击句组节点发出段落锚点', async () => {
    const { app, selected } = await mountMindmap()
    click(node('p0-s1'))
    await nextTick()
    expect(selected).toEqual([{ paragraphIndex: 0, paragraphOffset: 4 }])
    app.unmount()
  })

  it('点击有子节点的段落节点会折叠，不发跳转事件', async () => {
    const { app, selected } = await mountMindmap()
    click(node('p0'))
    await nextTick()
    expect(selected).toHaveLength(0)
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(4)
    expect(node('p0')?.getAttribute('aria-label')).toContain('已折叠')
    app.unmount()
  })

  it('全部折叠与全部展开控件生效', async () => {
    const { app } = await mountMindmap()
    document.querySelector<HTMLButtonElement>('[aria-label="全部折叠"]')?.click()
    await nextTick()
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(1)
    document.querySelector<HTMLButtonElement>('[aria-label="全部展开"]')?.click()
    await nextTick()
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(6)
    app.unmount()
  })

  it('Enter/Space 可键盘触发折叠', async () => {
    const { app } = await mountMindmap()
    node('p0')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(4)
    app.unmount()
  })

  it('缩放控件改变比例并受上下界限制', async () => {
    const { app } = await mountMindmap()
    const zoom = () => document.querySelector('.reader-mindmap-zoom')?.textContent?.trim()
    expect(zoom()).toBe('100%')
    document.querySelector<HTMLButtonElement>('[aria-label="放大"]')?.click()
    await nextTick()
    expect(zoom()).toBe('120%')
    document.querySelector<HTMLButtonElement>('[aria-label="缩小"]')?.click()
    await nextTick()
    expect(zoom()).toBe('100%')
    app.unmount()
  })

  it('主题切换写入存储并更新 data-map-theme', async () => {
    localStorage.removeItem('xsxz.mindmap.theme')
    const { app } = await mountMindmap()
    expect(document.querySelector('.reader-mindmap')?.getAttribute('data-map-theme')).toBe('porcelain')
    document.querySelector<HTMLButtonElement>('.reader-mindmap-theme-trigger')?.click()
    await nextTick()
    document.querySelector<HTMLButtonElement>('[data-mindmap-theme-option="midnight"]')?.click()
    await nextTick()
    expect(document.querySelector('.reader-mindmap')?.getAttribute('data-map-theme')).toBe('midnight')
    expect(localStorage.getItem('xsxz.mindmap.theme')).toBe('midnight')
    app.unmount()
    localStorage.removeItem('xsxz.mindmap.theme')
  })

  it('连线使用分支色变量', async () => {
    const { app } = await mountMindmap()
    const strokes = [...document.querySelectorAll('.reader-mindmap-links path')].map((path) => path.getAttribute('stroke'))
    expect(strokes.some((stroke) => stroke?.includes('--map-branch-0'))).toBe(true)
    expect(strokes.some((stroke) => stroke?.includes('--map-branch-1'))).toBe(true)
    app.unmount()
  })

  it('树晚于挂载到达时，滚轮仍能平移/缩放画布', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = ref<MindmapNode | null>(null)
    const app = createApp({ render: () => h(ReaderMindmap, { root: root.value }) })
    app.mount(host)
    await nextTick()
    expect(document.querySelector('.reader-mindmap-viewport')).toBeNull()

    root.value = buildMindmapTree('第一章', ['第一句。第二句！'])
    await nextTick()
    await nextTick()
    const viewport = document.querySelector<HTMLElement>('.reader-mindmap-viewport')
    expect(viewport).not.toBeNull()

    const zoom = () => document.querySelector('.reader-mindmap-zoom')?.textContent?.trim()
    const before = zoom()
    const event = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
    viewport!.dispatchEvent(event)
    await nextTick()
    expect(event.defaultPrevented).toBe(true)
    expect(zoom()).not.toBe(before)
    app.unmount()
  })

  it('全屏按钮把导图铺到 body 上，Esc 退出后回到原位并解锁滚动', async () => {
    const { app } = await mountMindmap()
    const section = () => document.querySelector<HTMLElement>('.reader-mindmap')
    const toggle = () => document.querySelector<HTMLButtonElement>('.reader-mindmap-fullscreen-toggle')

    expect(section()?.classList.contains('is-fullscreen')).toBe(false)
    toggle()?.click()
    await nextTick()
    expect(toggle()?.textContent?.trim()).toBe('退出全屏')
    expect(section()?.classList.contains('is-fullscreen')).toBe(true)
    // Teleport 到 body：不再挂在挂载用的 host 里
    expect(section()?.parentElement).toBe(document.body)
    expect(document.documentElement.style.overflow).toBe('hidden')

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(section()?.classList.contains('is-fullscreen')).toBe(false)
    expect(section()?.parentElement).not.toBe(document.body)
    expect(document.documentElement.style.overflow).toBe('')
    expect(document.querySelector('.reader-mindmap-fullscreen-toggle')?.getAttribute('aria-pressed')).toBe('false')
    app.unmount()
  })

  it('长标签在节点内折行，节点高度随行数增长', async () => {
    const root: MindmapNode = {
      id: 'root', label: '第一章：这一章讲的是王林从一个普通少年开始走上修仙之路的全过程与其中的种种代价和机缘', level: 0,
      children: [
        { id: 'a', label: '甲', level: 1, children: [], collapsed: false },
        { id: 'b', label: '乙', level: 1, children: [], collapsed: false },
      ],
      collapsed: false,
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(ReaderMindmap, { root }) })
    app.mount(host)
    await nextTick()

    const rootNode = document.querySelector<SVGGElement>('[data-node-id="root"]')
    const lines = [...(rootNode?.querySelectorAll('.reader-mindmap-label') ?? [])].map((line) => line.textContent ?? '')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.length).toBeLessThanOrEqual(3)
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(13)
    expect(lines.at(-1)?.endsWith('…')).toBe(true)
    // 三行文字 + 折叠提示：节点框必须够高，文字才不会溢出
    expect(Number(rootNode?.querySelector('rect')?.getAttribute('height'))).toBeGreaterThanOrEqual(70)
    app.unmount()
  })

  it('同一列的节点纵向不重叠（折行后高度不同的树）', async () => {
    const label = '这一句很长很长，长到需要折成两三行才放得下，用来验证布局不会互相压住'
    const root: MindmapNode = {
      id: 'root', label: '第一章', level: 0,
      children: [0, 1, 2].map((index) => ({
        id: `p${index}`, label, level: 1,
        children: [{ id: `p${index}-s0`, label: '短句。', level: 2, children: [], collapsed: false }],
        collapsed: false,
      })),
      collapsed: false,
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(ReaderMindmap, { root }) })
    app.mount(host)
    await nextTick()

    const spans = new Map<number, Array<{ top: number; bottom: number }>>()
    for (const group of document.querySelectorAll<SVGGElement>('[role="treeitem"]')) {
      const level = Number(/mindmap-node-level-(\d)/.exec(group.getAttribute('class') ?? '')?.[1] ?? 0)
      const [, , y] = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(group.getAttribute('transform') ?? '') ?? []
      const height = Number(group.querySelector('rect')?.getAttribute('height'))
      const list = spans.get(level) ?? []
      list.push({ top: Number(y), bottom: Number(y) + height })
      spans.set(level, list)
    }
    for (const list of spans.values()) {
      const sorted = [...list].sort((a, b) => a.top - b.top)
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index]!.top).toBeGreaterThanOrEqual(sorted[index - 1]!.bottom)
      }
    }
    app.unmount()
  })

  it('缩放下限放到 2%，可以一路缩小看全图', async () => {
    const { app } = await mountMindmap()
    const shrink = document.querySelector<HTMLButtonElement>('[aria-label="缩小"]')
    for (let index = 0; index < 40; index += 1) shrink?.click()
    await nextTick()
    expect(document.querySelector('.reader-mindmap-zoom')?.textContent?.trim()).toBe('2%')
    expect(shrink?.disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[aria-label="重置缩放"]')?.click()
    await nextTick()
    expect(document.querySelector('.reader-mindmap-zoom')?.textContent?.trim()).toBe('100%')
    app.unmount()
  })

  it('空树显示空态', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(ReaderMindmap, { root: null }) })
    app.mount(host)
    await nextTick()
    expect(document.querySelector('.reader-mindmap-empty')?.textContent).toContain('没有可生成')
    app.unmount()
  })
})
