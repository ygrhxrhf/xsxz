// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import ReaderMindmap from './ReaderMindmap.vue'
import { buildMindmapTree, type MindmapAnchor } from '../pages/readerMindmap'

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
