/**
 * M4 章节思维导图的纯数据层。
 *
 * 首版不调用 AI：章节标题 + 规范化段落就是结构真源。这里刻意不 import Vue、DOM 或
 * IPC，SVG 组件只消费这棵树；节点保存原始段落下标，净化过滤不能改变标注/进度坐标。
 *
 * 层级约定：根节点 level=0；章节段落 level=1；段落内部按句号/问号/感叹号/分号
 * 的句组 level=2。默认只展开到 level 2，超长章不会一次展开无限深度。
 */

export interface MindmapAnchor {
  paragraphIndex: number
  paragraphOffset: number
}

export interface MindmapNode {
  id: string
  label: string
  level: number
  /** 对应规范化正文中的原始段落下标；根节点没有锚点。 */
  paragraphIndex?: number
  /** 节点在段落内的起始字符偏移。 */
  paragraphOffset?: number
  children: MindmapNode[]
  collapsed: boolean
}

interface MindmapBuildOptions {
  /** 默认展开到此层级；根为 0，默认展开到句组层（2）。 */
  expandedThroughLevel?: number
  /** 长标签最大显示字符数；不改变原文坐标，只影响节点文案。 */
  maxLabelLength?: number
}

const DEFAULT_EXPANDED_LEVEL = 2
const DEFAULT_MAX_LABEL_LENGTH = 48
const SENTENCE_END = /[。！？!?；;]+/u

function labelOf(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/gu, ' ').trim()
  if (compact.length <= maxLength) return compact || '（空段）'
  return `${compact.slice(0, Math.max(1, maxLength - 1))}…`
}

function splitSentenceGroups(text: string): Array<{ text: string; offset: number }> {
  const groups: Array<{ text: string; offset: number }> = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_END.test(text[index]!)) continue
    const end = index + 1
    const value = text.slice(start, end).trim()
    if (value) {
      const leading = text.slice(start, end).search(/\S/u)
      groups.push({ text: value, offset: start + Math.max(0, leading) })
    }
    start = end
  }
  const tail = text.slice(start).trim()
  if (tail) {
    const leading = text.slice(start).search(/\S/u)
    groups.push({ text: tail, offset: start + Math.max(0, leading) })
  }
  return groups
}

function applyDefaultExpansion(node: MindmapNode, expandedThroughLevel: number): void {
  node.collapsed = node.level >= expandedThroughLevel && node.children.length > 0
  for (const child of node.children) applyDefaultExpansion(child, expandedThroughLevel)
}

/** 根据章节标题与原始段落下标构建导图树。 */
export function buildMindmapTree(
  chapterTitle: string,
  paragraphs: readonly string[],
  paragraphIndexes: readonly number[] = paragraphs.map((_, index) => index),
  options: MindmapBuildOptions = {},
): MindmapNode {
  const expandedThroughLevel = Number.isFinite(options.expandedThroughLevel)
    ? Math.max(0, Math.floor(options.expandedThroughLevel as number))
    : DEFAULT_EXPANDED_LEVEL
  const maxLabelLength = Number.isFinite(options.maxLabelLength) && (options.maxLabelLength as number) > 0
    ? Math.floor(options.maxLabelLength as number)
    : DEFAULT_MAX_LABEL_LENGTH

  const paragraphNodes: MindmapNode[] = paragraphs.map((text, inputIndex) => {
    const paragraphIndex = paragraphIndexes[inputIndex] ?? inputIndex
    const sentenceNodes = splitSentenceGroups(text).map((sentence, sentenceIndex) => ({
      id: `p${paragraphIndex}-s${sentenceIndex}`,
      label: labelOf(sentence.text, maxLabelLength),
      level: 2,
      paragraphIndex,
      paragraphOffset: sentence.offset,
      children: [],
      collapsed: false,
    }))
    return {
      id: `p${paragraphIndex}`,
      label: labelOf(text, maxLabelLength),
      level: 1,
      paragraphIndex,
      paragraphOffset: 0,
      children: sentenceNodes,
      collapsed: false,
    }
  })

  const root: MindmapNode = {
    id: 'root',
    label: chapterTitle.trim() || '本章',
    level: 0,
    children: paragraphNodes,
    collapsed: false,
  }
  applyDefaultExpansion(root, expandedThroughLevel)
  return root
}

/** 深度优先列出当前未折叠状态下可见的节点（包含根节点）。 */
export function flattenVisibleNodes(root: MindmapNode): MindmapNode[] {
  const nodes: MindmapNode[] = []
  const visit = (node: MindmapNode) => {
    nodes.push(node)
    if (node.collapsed) return
    for (const child of node.children) visit(child)
  }
  visit(root)
  return nodes
}

/** 修改单节点折叠状态；返回是否找到目标。 */
export function setNodeCollapsed(root: MindmapNode, nodeId: string, collapsed: boolean): boolean {
  if (root.id === nodeId) {
    root.collapsed = collapsed && root.children.length > 0
    return true
  }
  for (const child of root.children) {
    if (setNodeCollapsed(child, nodeId, collapsed)) return true
  }
  return false
}

/** 全部展开或全部折叠；根节点始终保持可见，折叠只影响有子节点的节点。 */
export function setAllCollapsed(root: MindmapNode, collapsed: boolean): void {
  const visit = (node: MindmapNode) => {
    node.collapsed = collapsed && node.children.length > 0
    for (const child of node.children) visit(child)
  }
  visit(root)
}

/** 节点 → 正文锚点；根节点没有可跳转位置。 */
export function mindmapAnchor(node: MindmapNode): MindmapAnchor | null {
  if (!Number.isSafeInteger(node.paragraphIndex) || node.paragraphIndex! < 0) return null
  return {
    paragraphIndex: node.paragraphIndex!,
    paragraphOffset: Number.isSafeInteger(node.paragraphOffset) && node.paragraphOffset! >= 0
      ? node.paragraphOffset!
      : 0,
  }
}
