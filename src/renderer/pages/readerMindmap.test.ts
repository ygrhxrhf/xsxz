import { describe, expect, it } from 'vitest'
import {
  buildMindmapTree,
  flattenVisibleNodes,
  mindmapAnchor,
  setAllCollapsed,
  setNodeCollapsed,
} from './readerMindmap'

describe('readerMindmap（章节思维导图树模型）', () => {
  it('空章仍有可见根节点，没有虚构段落', () => {
    const root = buildMindmapTree('第一章', [])
    expect(root).toMatchObject({ id: 'root', label: '第一章', level: 0, children: [], collapsed: false })
    expect(flattenVisibleNodes(root)).toEqual([root])
    expect(mindmapAnchor(root)).toBeNull()
  })

  it('构建章节标题、段落节点和句组节点', () => {
    const root = buildMindmapTree('风起', ['第一句。第二句！', '第三句？'])
    expect(root.label).toBe('风起')
    expect(root.children.map((node) => node.id)).toEqual(['p0', 'p1'])
    expect(root.children[0]!.children.map((node) => node.id)).toEqual(['p0-s0', 'p0-s1'])
    expect(root.children[0]!.children[1]!.label).toBe('第二句！')
  })

  it('默认展开到句组层，段落和句组都可见', () => {
    const root = buildMindmapTree('风起', ['第一句。第二句！'])
    expect(root.collapsed).toBe(false)
    expect(root.children[0]!.collapsed).toBe(false)
    expect(flattenVisibleNodes(root).map((node) => node.id)).toEqual(['root', 'p0', 'p0-s0', 'p0-s1'])
  })

  it('默认展开层级可配置，长章可以压缩到段落层', () => {
    const root = buildMindmapTree('长章', ['第一句。第二句！'], [], { expandedThroughLevel: 1 })
    expect(root.collapsed).toBe(false)
    expect(root.children[0]!.collapsed).toBe(true)
    expect(flattenVisibleNodes(root).map((node) => node.id)).toEqual(['root', 'p0'])
  })

  it('净化过滤不改变原始段落下标', () => {
    const root = buildMindmapTree('章节', ['保留段', '另一个段'], [3, 7])
    expect(root.children.map((node) => node.paragraphIndex)).toEqual([3, 7])
    expect(root.children[1]!.children).toHaveLength(1)
    expect(root.children[1]!.children[0]!.paragraphIndex).toBe(7)
  })

  it('句组锚点保留段内偏移，段落锚点落在段首', () => {
    const root = buildMindmapTree('章节', ['前置文字。目标句！'], [5])
    expect(mindmapAnchor(root.children[0]!)).toEqual({ paragraphIndex: 5, paragraphOffset: 0 })
    expect(mindmapAnchor(root.children[0]!.children[1]!)).toEqual({ paragraphIndex: 5, paragraphOffset: 5 })
  })

  it('节点折叠只影响目标节点及其后代可见性', () => {
    const root = buildMindmapTree('章节', ['第一句。第二句！', '第三句？'])
    expect(setNodeCollapsed(root, 'p0', true)).toBe(true)
    expect(flattenVisibleNodes(root).map((node) => node.id)).toEqual(['root', 'p0', 'p1', 'p1-s0'])
    expect(setNodeCollapsed(root, 'missing', true)).toBe(false)
  })

  it('全部折叠与全部展开可逆', () => {
    const root = buildMindmapTree('章节', ['第一句。第二句！', '第三句？'])
    setAllCollapsed(root, true)
    expect(flattenVisibleNodes(root).map((node) => node.id)).toEqual(['root'])
    setAllCollapsed(root, false)
    expect(flattenVisibleNodes(root).map((node) => node.id)).toHaveLength(6)
  })

  it('空白标题与空白段落有稳定回退文案', () => {
    const root = buildMindmapTree('  ', ['   '])
    expect(root.label).toBe('本章')
    expect(root.children[0]!.label).toBe('（空段）')
  })

  it('长标签只截显示文案，不截坐标', () => {
    const text = '一二三四五六七八九十。'
    const root = buildMindmapTree('章节', [text], [12], { maxLabelLength: 5 })
    expect(root.children[0]!.label).toBe('一二三四…')
    expect(mindmapAnchor(root.children[0]!.children[0]!)).toEqual({ paragraphIndex: 12, paragraphOffset: 0 })
  })
})
