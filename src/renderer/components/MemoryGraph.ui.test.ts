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

async function mountGraph(payload: AiMemoryFile | null) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const jumps: AiCitation[] = []
  const app = createApp({
    render: () => h(MemoryGraph, {
      memory: payload,
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
