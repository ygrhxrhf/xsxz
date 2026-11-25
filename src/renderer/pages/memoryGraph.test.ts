import { describe, expect, it } from 'vitest'
import type { AiCitation, AiMemoryCharacter, AiMemoryFile, AiMemoryRelation } from '@shared/types'
import {
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
  buildMemoryGraph,
  layoutMemoryGraph,
  neighborhoodOf,
  statusPaintSlot,
} from './memoryGraph'

function citation(chapterTitle: string, paragraphIndex = 0): AiCitation {
  return {
    id: `${chapterTitle}-${paragraphIndex}`,
    chapterId: chapterTitle,
    chapterTitle,
    paragraphIndex,
    excerpt: `${chapterTitle} 的原文`,
  }
}

function character(name: string, overrides: Partial<AiMemoryCharacter> = {}): AiMemoryCharacter {
  return {
    id: `char-${name}`,
    name,
    aliases: [],
    role: '剑修',
    status: '主角',
    summary: `${name}的说明`,
    sources: [citation('第1章')],
    accuracy: 'normal',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function relation(
  from: string,
  to: string,
  relationText: string,
  overrides: Partial<AiMemoryRelation> = {},
): AiMemoryRelation {
  return {
    id: `rel-${from}-${to}-${relationText}`,
    from,
    to,
    relation: relationText,
    status: '稳定',
    summary: `${from}与${to}的${relationText}`,
    sources: [citation('第1章')],
    accuracy: 'normal',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function memoryFile(overrides: Partial<AiMemoryFile> = {}): AiMemoryFile {
  return {
    version: 1,
    characters: [],
    relations: [],
    foreshadows: [],
    events: [],
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const LAYOUT = { width: 340, height: 260, padding: 30 }

describe('buildMemoryGraph', () => {
  it('只保留出现在关系里的人物，并带上 degree / 状态 / 别名 / 准确度', () => {
    const memory = memoryFile({
      characters: [
        character('林小满', { aliases: ['小满'], status: '主角' }),
        character('陈七', { status: '配角', accuracy: 'uncertain' }),
        // 这张卡没进任何关系，不该出现在图上。
        character('路人甲'),
      ],
      relations: [relation('林小满', '陈七', '同门')],
    })

    const graph = buildMemoryGraph(memory)
    expect(graph.nodes.map((node) => node.name)).toEqual(['林小满', '陈七'])
    expect(graph.nodes.every((node) => node.known)).toBe(true)
    expect(graph.nodes.map((node) => node.degree)).toEqual([1, 1])
    expect(graph.nodes[0]).toMatchObject({ id: '林小满', aliases: ['小满'], status: '主角', role: '剑修' })
    expect(graph.nodes[1]).toMatchObject({ status: '配角', accuracy: 'uncertain' })
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({ from: '林小满', to: '陈七', relation: '同门', status: '稳定' })
  })

  it('关系里出现但 characters 没有的名字也建节点，标记 known: false', () => {
    const graph = buildMemoryGraph(memoryFile({
      characters: [character('林小满')],
      relations: [relation('林小满', '神秘人', '师徒')],
    }))

    const unknown = graph.nodes.find((node) => node.name === '神秘人')
    expect(unknown).toBeDefined()
    expect(unknown?.known).toBe(false)
    // 没有人物卡就没有身份/别名可写，但节点必须能画出来。
    expect(unknown).toMatchObject({ role: '', aliases: [], status: '', degree: 1 })
  })

  it('degree 统计每个端点的关系条数，自环只算一条', () => {
    const graph = buildMemoryGraph(memoryFile({
      characters: [character('甲'), character('乙'), character('丙')],
      relations: [
        relation('甲', '乙', '同门'),
        relation('甲', '丙', '师徒'),
        relation('乙', '丙', '宿敌'),
        relation('甲', '甲', '执念'),
      ],
    }))

    const degree = new Map(graph.nodes.map((node) => [node.name, node.degree]))
    expect(degree.get('甲')).toBe(3)
    expect(degree.get('乙')).toBe(2)
    expect(degree.get('丙')).toBe(2)
    // 自环保留在边上，但只算一条关联。
    expect(graph.edges.filter((edge) => edge.from === edge.to)).toHaveLength(1)
    // degree 降序；同 degree 按名字的码点升序（不用 locale 排序）：丙 < 乙。
    expect(graph.nodes.map((node) => node.name)).toEqual(['甲', '丙', '乙'])
  })

  it('排序稳定：同 degree 按名字，顺序与输入顺序无关', () => {
    const forward = buildMemoryGraph(memoryFile({
      relations: [relation('丙', '甲', '同门'), relation('乙', '甲', '师徒')],
    }))
    const backward = buildMemoryGraph(memoryFile({
      relations: [relation('乙', '甲', '师徒'), relation('丙', '甲', '同门')],
    }))

    // 甲 degree 最高排第一；丙/乙 同 degree，按码点 丙 在前。两次输入顺序不同，结果相同。
    expect(forward.nodes.map((node) => node.name)).toEqual(['甲', '丙', '乙'])
    expect(backward.nodes.map((node) => node.name)).toEqual(['甲', '丙', '乙'])
  })

  it('边带 firstSource：取章节最靠前的一条，没有来源就省略', () => {
    const graph = buildMemoryGraph(memoryFile({
      relations: [
        relation('甲', '乙', '同门', {
          sources: [citation('第10章', 3), citation('第3章', 7), citation('第3章', 2)],
        }),
        relation('甲', '丙', '师徒', { sources: [] }),
      ],
    }))

    const first = graph.edges.find((edge) => edge.to === '乙')
    const last = graph.edges.find((edge) => edge.to === '丙')
    // 「第3章」要排在「第10章」前面：数字按数值比较，不是字符串比较。
    expect(first?.firstSource).toMatchObject({ chapterTitle: '第3章', paragraphIndex: 2 })
    expect(last && 'firstSource' in last).toBe(false)
  })

  it('节点最多 24 个、边最多 80 条，都按关联度取前几名', () => {
    const characters = Array.from({ length: 40 }, (_, index) => character(`人${index}`))
    const relations: AiMemoryRelation[] = []
    // 人0 与其余每人一条，人0 的 degree 最高；剩下的人彼此不相连（degree 都为 1）。
    for (let index = 1; index < 40; index += 1) relations.push(relation('人0', `人${index}`, '同门'))
    // 再给前几个人加一点内部关系，制造高于 1 的 degree。
    for (let index = 1; index < 10; index += 1) relations.push(relation(`人${index}`, `人${index + 1}`, '切磋'))

    const graph = buildMemoryGraph(memoryFile({ characters, relations }))
    expect(graph.nodes).toHaveLength(MAX_GRAPH_NODES)
    expect(graph.edges.length).toBeLessThanOrEqual(MAX_GRAPH_EDGES)
    // 度数最高的人0 必须在，且排在第一位。
    expect(graph.nodes[0]?.name).toBe('人0')
    expect(graph.nodes[0]?.degree).toBe(39)
    // 被砍掉的人物不能再出现在边里，否则会画出指向虚空的线。
    const kept = new Set(graph.nodes.map((node) => node.id))
    expect(graph.edges.every((edge) => kept.has(edge.from) && kept.has(edge.to))).toBe(true)
  })

  it('空记忆、空关系都返回空图', () => {
    expect(buildMemoryGraph(memoryFile())).toEqual({ nodes: [], edges: [] })
    expect(buildMemoryGraph(null)).toEqual({ nodes: [], edges: [] })
    // 端点为空的关系不该造出一个空名节点。
    expect(buildMemoryGraph(memoryFile({ relations: [relation('', '甲', '同门')] }))).toEqual({ nodes: [], edges: [] })
  })
})

describe('layoutMemoryGraph', () => {
  function sampleGraph() {
    return buildMemoryGraph(memoryFile({
      characters: [character('甲'), character('乙'), character('丙')],
      relations: [
        relation('甲', '乙', '同门'),
        relation('甲', '丙', '师徒'),
        relation('乙', '丙', '宿敌'),
      ],
    }))
  }

  it('相同输入得到完全相同的输出', () => {
    const graph = sampleGraph()
    const first = layoutMemoryGraph(graph, LAYOUT)
    const second = layoutMemoryGraph(graph, LAYOUT)
    expect(second).toEqual(first)
    // 连重新构建一次图（同样的记忆）也必须落在同样的坐标上。
    expect(layoutMemoryGraph(sampleGraph(), LAYOUT)).toEqual(first)
  })

  it('坐标夹在 padding 内，且保留一位小数', () => {
    const layout = layoutMemoryGraph(sampleGraph(), LAYOUT)
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(LAYOUT.padding)
      expect(node.x).toBeLessThanOrEqual(LAYOUT.width - LAYOUT.padding)
      expect(node.y).toBeGreaterThanOrEqual(LAYOUT.padding)
      expect(node.y).toBeLessThanOrEqual(LAYOUT.height - LAYOUT.padding)
      expect(Math.round(node.x * 10)).toBeCloseTo(node.x * 10, 6)
      expect(Math.round(node.y * 10)).toBeCloseTo(node.y * 10, 6)
    }
    // 边的坐标直接用两端节点的坐标，不能自己再算一遍。
    for (const edge of layout.edges) {
      const from = layout.nodes.find((node) => node.id === edge.from)!
      const to = layout.nodes.find((node) => node.id === edge.to)!
      expect([edge.x1, edge.y1, edge.x2, edge.y2]).toEqual([from.x, from.y, to.x, to.y])
    }
  })

  it('按 degree 降序、同 degree 按名字落在圆环上：度数最高的人在最上面', () => {
    const layout = layoutMemoryGraph(sampleGraph(), LAYOUT)
    // 三个人的 degree 都是 2，按名字码点排：丙、乙、甲；第一个落在 12 点方向。
    expect(layout.nodes.map((node) => node.name)).toEqual(['丙', '乙', '甲'])
    expect(layout.nodes[0]?.x).toBe(LAYOUT.width / 2)
    expect(layout.nodes[0]?.y).toBe(LAYOUT.padding)
  })

  it('单节点放中心，空图返回空数组', () => {
    const single = buildMemoryGraph(memoryFile({
      characters: [character('甲')],
      relations: [relation('甲', '甲', '执念')],
    }))
    const layout = layoutMemoryGraph(single, LAYOUT)
    expect(layout.nodes).toHaveLength(1)
    expect(layout.nodes[0]).toMatchObject({ x: LAYOUT.width / 2, y: LAYOUT.height / 2 })
    // 自环保留成一条边，但只画一个节点。
    expect(layout.edges).toHaveLength(1)
    expect(layout.edges[0]).toMatchObject({ x1: layout.nodes[0]!.x, x2: layout.nodes[0]!.x })

    expect(layoutMemoryGraph({ nodes: [], edges: [] }, LAYOUT)).toEqual({ nodes: [], edges: [] })
  })
})

describe('neighborhoodOf', () => {
  it('只返回直接邻居和相邻边', () => {
    const graph = buildMemoryGraph(memoryFile({
      characters: [character('甲'), character('乙'), character('丙')],
      relations: [relation('甲', '乙', '同门'), relation('乙', '丙', '师徒')],
    }))

    const near = neighborhoodOf(graph, '乙')
    expect([...near.nodes].sort()).toEqual(['丙', '甲'].sort())
    expect(near.edges.size).toBe(2)
    // 隔一层的丙和甲之间没有边，不该把它们的边也算进来。
    const far = neighborhoodOf(graph, '甲')
    expect([...far.nodes]).toEqual(['乙'])
    expect(far.edges.size).toBe(1)
    // 不存在的 id 不给任何东西。
    expect(neighborhoodOf(graph, '无名').nodes.size).toBe(0)

    const selfLoop = buildMemoryGraph(memoryFile({ relations: [relation('甲', '甲', '执念')] }))
    const selfNear = neighborhoodOf(selfLoop, '甲')
    expect(selfNear.edges.size).toBe(1)
    // 自环只说明「跟自己有关系」，邻居集合不包含自身，所以这里是空的。
    expect(selfNear.nodes.size).toBe(0)
  })
})

describe('statusPaintSlot', () => {
  it('同一个状态永远同一个槽位，槽位只有 4 个', () => {
    expect(statusPaintSlot('主角')).toBe(statusPaintSlot('主角'))
    expect(statusPaintSlot('')).toBe(0)
    for (const status of ['主角', '配角', '龙套', '反派', '主角']) {
      expect(statusPaintSlot(status)).toBeGreaterThanOrEqual(0)
      expect(statusPaintSlot(status)).toBeLessThanOrEqual(3)
    }
  })
})
