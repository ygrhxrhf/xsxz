import { describe, expect, it } from 'vitest'
import { MindmapError, parseMindmapContent, validateMindmapTree } from './aiMindmap'

describe('aiMindmap（infinite-reader 导图解析与校验）', () => {
  it('解析标准 JSON 树并去除首尾空白', () => {
    const tree = parseMindmapContent(JSON.stringify({
      text: ' 第一章 ',
      children: [
        { text: ' 核心冲突 ', children: [{ text: '分支一', children: [] }] },
        { text: ' 人物动机 ', children: [] },
      ],
    }))
    expect(tree).toEqual({
      text: '第一章',
      children: [
        { text: '核心冲突', children: [{ text: '分支一', children: [] }] },
        { text: '人物动机', children: [] },
      ],
    })
  })

  it('兼容 markdown json 代码块和单层 root/mindmap 包装', () => {
    const wrapped = '```json\n{"mindmap":{"title":"章节","children":["要点A",{"label":"要点B"}]}}\n```'
    const tree = parseMindmapContent(wrapped)
    expect(tree).toEqual({
      text: '章节',
      children: [
        { text: '要点A', children: [] },
        { text: '要点B', children: [] },
      ],
    })
  })

  it('拒绝非法 JSON、空分支和超限深度', () => {
    expect(() => parseMindmapContent('{bad json')).toThrowError(MindmapError)
    expect(() => validateMindmapTree({ text: '仅标题', children: [] })).toThrowError(MindmapError)

    let deep: Record<string, unknown> = { text: 'leaf', children: [] }
    for (let i = 0; i < 15; i += 1) deep = { text: `L${i}`, children: [deep] }
    expect(() => validateMindmapTree(deep)).toThrowError(MindmapError)
  })
})
