// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiCitation, AiMemoryFile } from '@shared/types'
import MemoryGraph from './MemoryGraph.vue'

afterEach(() => {
  document.body.innerHTML = ''
})

function citation(chapterTitle: string, paragraphIndex = 0): AiCitation {
  return {
    id: `${chapterTitle}-${paragraphIndex}`,
    chapterId: chapterTitle,
    chapterTitle,
    paragraphIndex,
    excerpt: `${chapterTitle} 的原文`,
  }
}

/**
 * 甲 —(同门)— 乙 —(师徒)— 丙，外加 甲 —(执念)— 甲 一条自环。
 * 四个人物卡里只有三张进了关系，第四个（「路人」）不该出现在图上。
 */
function memory(): AiMemoryFile {
  return {
    version: 1,
    characters: [
      { id: 'c1', name: '甲', aliases: ['阿甲'], role: '剑修', status: '主角', summary: '主角说明', sources: [citation('第1章')], accuracy: 'normal', updatedAt: '' },
      { id: 'c2', name: '乙', aliases: [], role: '符师', status: '配角', summary: '', sources: [citation('第1章')], accuracy: 'normal', updatedAt: '' },
      { id: 'c3', name: '丙', aliases: [], role: '散修', status: '龙套', summary: '', sources: [citation('第2章')], accuracy: 'uncertain', updatedAt: '' },
      { id: 'c4', name: '路人', aliases: [], role: '店主', status: '龙套', summary: '', sources: [], accuracy: 'normal', updatedAt: '' },
    ],
    relations: [
      {
        id: 'r1', from: '甲', to: '乙', relation: '同门', status: '稳定', summary: '',
        sources: [citation('第5章', 1), citation('第2章', 3)], accuracy: 'normal', updatedAt: '',
      },
      { id: 'r2', from: '乙', to: '丙', relation: '师徒', status: '稳定', summary: '', sources: [citation('第3章')], accuracy: 'normal', updatedAt: '' },
      { id: 'r3', from: '甲', to: '甲', relation: '执念', status: '存疑', summary: '', sources: [], accuracy: 'review', updatedAt: '' },
    ],
    foreshadows: [],
    events: [],
    updatedAt: '',
  }
}

type GraphProps = { chapters?: Array<{ id: string; index: number; title: string }>; uptoChapterIndex?: number }

async function mountGraph(payload: AiMemoryFile | null, props: GraphProps = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const jumps: AiCitation[] = []
  const app = createApp({
    render: () => h(MemoryGraph, {
      memory: payload,
      ...props,
      'onJump': (jump: AiCitation) => jumps.push(jump),
    }),
  })
  app.mount(host)
  await nextTick()
  return { app, jumps }
}

function node(id: string): SVGGElement | null {
  return document.querySelector<SVGGElement>(`[data-node-id="${id}"]`)
}

function click(element: Element | null | undefined): void {
  element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(text))
}

describe('MemoryGraph（人物关系图）', () => {
  it('只画有关系的人物，自环画成环而不是线段', async () => {
    const { app } = await mountGraph(memory())
    // 甲、乙、丙 三个人；路人没进关系，不出现。
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(3)
    expect(node('路人')).toBeNull()
    // 两条普通关系各一条线，自环单独一个环。
    expect(document.querySelectorAll('.memory-graph-edges line')).toHaveLength(2)
    expect(document.querySelectorAll('.memory-graph-selfloop')).toHaveLength(1)
    expect(document.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 340 260')
    app.unmount()
  })

  it('节点可键盘聚焦，存疑人物用虚线描边', async () => {
    const { app } = await mountGraph(memory())
    const first = node('甲')
    expect(first?.getAttribute('tabindex')).toBe('0')
    expect(first?.getAttribute('role')).toBe('button')
    expect(first?.getAttribute('aria-label')).toBe('人物：甲')
    // 丙 的 accuracy 是 uncertain，圆点要带虚线标记。
    expect(node('丙')?.querySelector('.memory-graph-dot')?.classList.contains('is-uncertain')).toBe(true)
    expect(node('甲')?.querySelector('.memory-graph-dot')?.classList.contains('is-uncertain')).toBe(false)
    app.unmount()
  })

  it('点击节点给出详情块：别名、身份、关系列表；再点一次收起', async () => {
    const { app } = await mountGraph(memory())
    expect(document.querySelector('.memory-graph-detail')).toBeNull()

    click(node('甲'))
    await nextTick()
    const detail = document.querySelector('.memory-graph-detail')
    expect(detail).not.toBeNull()
    expect(detail?.textContent).toContain('甲')
    expect(detail?.textContent).toContain('别名：阿甲')
    expect(detail?.textContent).toContain('身份：剑修')
    expect(detail?.textContent).toContain('状态：主角')
    // 甲 身上两条关系：与乙的同门、与自己的执念。
    expect(detail?.querySelectorAll('.memory-graph-relations li')).toHaveLength(2)

    click(node('甲'))
    await nextTick()
    expect(document.querySelector('.memory-graph-detail')).toBeNull()
    app.unmount()
  })

  it('详情块里的「最早出处」发出 jump 事件，取章节最靠前的那条来源', async () => {
    const { app, jumps } = await mountGraph(memory())
    click(node('甲'))
    await nextTick()

    click(buttonByText('最早出处'))
    await nextTick()
    expect(jumps).toHaveLength(1)
    // 关系 r1 的来源是第5章与第2章，最早出处必须是第2章那条。
    expect(jumps[0]).toMatchObject({ chapterTitle: '第2章', paragraphIndex: 3 })
    app.unmount()
  })

  it('没有关系时显示固定提示文案', async () => {
    for (const empty of [null, { ...memory(), relations: [] }]) {
      const { app } = await mountGraph(empty as AiMemoryFile | null)
      expect(document.querySelector('[data-node-id]')).toBeNull()
      expect(document.querySelector('.memory-graph-empty')?.textContent).toBe('还没有人物关系，先更新一次记忆')
      app.unmount()
      document.body.innerHTML = ''
    }
  })
})

/** 三章的书；图里的关系分别在第2章、第3章成立，自环那条没有来源（= 成立时间未知）。 */
const CHAPTERS = [
  { id: 'c1', index: 1, title: '第1章' },
  { id: 'c2', index: 2, title: '第2章' },
  { id: 'c3', index: 3, title: '第3章' },
]

/** 16 个人：人0 和其余每人一条关系，其余人之间不相连（degree 都是 1）。 */
function crowdMemory(): AiMemoryFile {
  const file = memory()
  return {
    ...file,
    characters: Array.from({ length: 16 }, (_, index) => ({
      id: `p${index}`, name: `人${index}`, aliases: [], role: '', status: '龙套', summary: '',
      sources: [citation('第1章')], accuracy: 'normal' as const, updatedAt: '',
    })),
    relations: Array.from({ length: 15 }, (_, index) => ({
      id: `cr${index}`, from: '人0', to: `人${index + 1}`, relation: '同门', status: '稳定', summary: '',
      sources: [citation('第1章')], accuracy: 'normal' as const, updatedAt: '',
    })),
  }
}

const CROWD_CHAPTERS = [{ id: 'c1', index: 1, title: '第1章' }]

describe('MemoryGraph（按阅读进度切片）', () => {
  it('传 uptoChapterIndex 后节点与边都变少，没来源的关系也不显示', async () => {
    const full = await mountGraph(memory())
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(3)
    expect(document.querySelectorAll('.memory-graph-edges line')).toHaveLength(2)
    full.app.unmount()
    document.body.innerHTML = ''

    // 读到第2章：只剩 甲—乙（第2章成立）。乙—丙 是第3章，自环没有来源，都不能出现。
    const { app } = await mountGraph(memory(), { chapters: CHAPTERS, uptoChapterIndex: 2 })
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(2)
    expect(node('丙')).toBeNull()
    expect(document.querySelectorAll('.memory-graph-edges line')).toHaveLength(1)
    expect(document.querySelectorAll('.memory-graph-selfloop')).toHaveLength(0)
    app.unmount()
  })

  it('切片后没有关系时提示「读到这一章为止」，与「记忆里本来就没关系」分开', async () => {
    const { app } = await mountGraph(memory(), { chapters: CHAPTERS, uptoChapterIndex: 1 })
    expect(document.querySelector('[data-node-id]')).toBeNull()
    expect(document.querySelector('.memory-graph-empty')?.textContent).toBe('读到这一章为止，还没有人物关系')
    app.unmount()
    document.body.innerHTML = ''

    // 不传进度时还是那句「先更新一次记忆」：这里记忆本身是空的。
    const plain = await mountGraph({ ...memory(), relations: [] })
    expect(document.querySelector('.memory-graph-empty')?.textContent).toBe('还没有人物关系，先更新一次记忆')
    plain.app.unmount()
  })

  it('切片进度拉满时与全量图一致', async () => {
    const { app } = await mountGraph(memory(), { chapters: CHAPTERS, uptoChapterIndex: 3 })
    // 第3章为止两条关系都成立，但没有来源的自环依然隐藏（宁缺勿漏）。
    expect(document.querySelectorAll('.memory-graph-edges line')).toHaveLength(2)
    expect(document.querySelectorAll('.memory-graph-selfloop')).toHaveLength(0)
    app.unmount()
  })
})

describe('MemoryGraph（人多时的标签策略）', () => {
  it('12 人以内标签全显示', async () => {
    const { app } = await mountGraph(memory(), { chapters: CHAPTERS, uptoChapterIndex: 3 })
    expect(document.querySelectorAll('.memory-graph-name')).toHaveLength(3)
    expect(document.querySelectorAll('[data-label="hidden"]')).toHaveLength(0)
    app.unmount()
  })

  it('超过 12 人时只给度数前 6 个挂标签，其余靠 hover 出现', async () => {
    const { app } = await mountGraph(crowdMemory(), { chapters: CROWD_CHAPTERS, uptoChapterIndex: 1 })
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(16)
    expect(document.querySelectorAll('.memory-graph-name')).toHaveLength(6)
    expect(document.querySelectorAll('[data-label="visible"]')).toHaveLength(6)
    expect(document.querySelectorAll('[data-label="hidden"]')).toHaveLength(10)
    // 度数最高的 人0 必须在挂出来的 6 个里。
    expect(node('人0')?.getAttribute('data-label')).toBe('visible')
    // 不挂标签的节点仍然可访问：名字一直在 aria-label 里。
    expect(node('人15')?.getAttribute('aria-label')).toBe('人物：人15')
    expect(node('人15')?.getAttribute('data-label')).toBe('hidden')

    // hover 到没标签的人身上，他的名字就出现。
    node('人15')?.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    expect(node('人15')?.getAttribute('data-label')).toBe('visible')
    expect(document.querySelectorAll('.memory-graph-name')).toHaveLength(7)
    app.unmount()
  })
})
