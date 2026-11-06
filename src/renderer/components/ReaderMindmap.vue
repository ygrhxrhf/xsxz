<script setup lang="ts">
/**
 * M4 章节思维导图视图层。
 *
 * 只消费 `readerMindmap.ts` 的纯树模型，不调用 AI、不读 IPC、不使用 v-html。
 * SVG 节点保持原始段落锚点；Reader 接入时只需监听 `select`，即可复用经典/真实书籍
 * 两套跳转路径。
 */
import { computed, ref, watch } from 'vue'
import {
  flattenVisibleNodes,
  mindmapAnchor,
  setAllCollapsed,
  setNodeCollapsed,
  type MindmapAnchor,
  type MindmapNode,
} from '../pages/readerMindmap'

const props = withDefaults(defineProps<{
  root: MindmapNode | null
  /** 画布最小宽度，超出面板时由外层滚动 */
  minWidth?: number
}>(), {
  minWidth: 720,
})

const emit = defineEmits<{
  (event: 'select', anchor: MindmapAnchor, node: MindmapNode): void
}>()

const tree = ref<MindmapNode | null>(props.root)
const nodeWidth = 190
const nodeHeight = 48
const horizontalGap = 72
const verticalGap = 24

watch(() => props.root, (root) => {
  tree.value = root
}, { deep: true })

interface PositionedNode {
  node: MindmapNode
  x: number
  y: number
}

interface MindmapLink {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * 树布局：按层排 x（层 × 节点宽 + 间距），按叶子顺序排 y。
 *
 * 父节点的 y 取它可见子节点首尾的中点——自底向上算，所以要先算子树再定父节点，
 * 不能把父节点先压进数组再回头找子节点。
 */
function layoutTree(root: MindmapNode): { nodes: PositionedNode[]; links: MindmapLink[]; width: number; height: number } {
  const nodes: PositionedNode[] = []
  const links: MindmapLink[] = []
  const row = nodeHeight + verticalGap
  let leafCursor = 0

  const visit = (node: MindmapNode): PositionedNode => {
    const x = node.level * (nodeWidth + horizontalGap)
    const visibleChildren = node.collapsed ? [] : node.children
    if (!visibleChildren.length) {
      const placed = { node, x, y: leafCursor * row }
      leafCursor += 1
      nodes.push(placed)
      return placed
    }
    const children = visibleChildren.map((child) => visit(child))
    const first = children[0]!
    const last = children[children.length - 1]!
    const placed = { node, x, y: (first.y + last.y) / 2 }
    nodes.push(placed)
    for (const child of children) {
      links.push({
        key: `${node.id}->${child.node.id}`,
        x1: placed.x + nodeWidth,
        y1: placed.y + nodeHeight / 2,
        x2: child.x,
        y2: child.y + nodeHeight / 2,
      })
    }
    return placed
  }

  visit(root)
  const maxX = Math.max(0, ...nodes.map((item) => item.x + nodeWidth))
  const maxY = Math.max(0, ...nodes.map((item) => item.y + nodeHeight))
  return { nodes, links, width: Math.max(props.minWidth, maxX + 24), height: Math.max(120, maxY + 24) }
}

const positioned = computed(() => tree.value ? layoutTree(tree.value) : { nodes: [], links: [], width: props.minWidth, height: 120 })
const visibleCount = computed(() => tree.value ? flattenVisibleNodes(tree.value).length : 0)

function toggle(node: MindmapNode): void {
  if (!tree.value || !node.children.length) return
  setNodeCollapsed(tree.value, node.id, !node.collapsed)
}

function all(collapsed: boolean): void {
  if (!tree.value) return
  setAllCollapsed(tree.value, collapsed)
}

function select(node: MindmapNode): void {
  const anchor = mindmapAnchor(node)
  if (anchor) emit('select', anchor, node)
}

function onNodeKeydown(event: KeyboardEvent, node: MindmapNode): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  if (node.children.length) toggle(node)
  else select(node)
}

function nodeClass(node: MindmapNode): string {
  return `mindmap-node-level-${Math.min(2, Math.max(0, node.level))}`
}
</script>

<template>
  <section class="reader-mindmap" aria-label="章节思维导图">
    <div class="reader-mindmap-toolbar">
      <span class="reader-mindmap-count">{{ visibleCount }} 个节点</span>
      <span class="reader-mindmap-spacer"></span>
      <button type="button" class="reader-mindmap-control" aria-label="全部展开" @click="all(false)">全部展开</button>
      <button type="button" class="reader-mindmap-control" aria-label="全部折叠" @click="all(true)">全部折叠</button>
    </div>
    <div v-if="!tree" class="reader-mindmap-empty" role="status">当前章节还没有可生成的结构。</div>
    <div v-else class="reader-mindmap-scroll">
      <svg
        class="reader-mindmap-svg"
        :width="positioned.width"
        :height="positioned.height"
        :viewBox="`0 0 ${positioned.width} ${positioned.height}`"
        role="tree"
        :aria-label="tree.label"
      >
        <g class="reader-mindmap-links" aria-hidden="true">
          <path
            v-for="link in positioned.links"
            :key="link.key"
            :d="`M ${link.x1} ${link.y1} C ${link.x1 + 28} ${link.y1}, ${link.x2 - 28} ${link.y2}, ${link.x2} ${link.y2}`"
          />
        </g>
        <g
          v-for="item in positioned.nodes"
          :key="item.node.id"
          class="reader-mindmap-node"
          :class="nodeClass(item.node)"
          :data-node-id="item.node.id"
          :transform="`translate(${item.x}, ${item.y})`"
          role="treeitem"
          :tabindex="0"
          :aria-label="`${item.node.label}${item.node.children.length ? (item.node.collapsed ? '，已折叠' : '，已展开') : ''}`"
          :aria-expanded="item.node.children.length ? String(!item.node.collapsed) : undefined"
          @keydown="onNodeKeydown($event, item.node)"
          @click="item.node.children.length ? toggle(item.node) : select(item.node)"
        >
          <rect :width="nodeWidth" :height="nodeHeight" rx="10" />
          <text x="14" y="22" class="reader-mindmap-label">{{ item.node.label }}</text>
          <text v-if="item.node.children.length" x="14" y="39" class="reader-mindmap-toggle">
            {{ item.node.collapsed ? '展开' : '折叠' }}
          </text>
        </g>
      </svg>
    </div>
  </section>
</template>

<style scoped>
.reader-mindmap {
  display: flex;
  min-height: 260px;
  flex-direction: column;
  color: var(--text, #2f2a24);
}

.reader-mindmap-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 10px;
}

.reader-mindmap-count {
  color: var(--muted, #6b6257);
  font-size: 12px;
}

.reader-mindmap-spacer { flex: 1; }

.reader-mindmap-control {
  border: 1px solid var(--line, #d8d0c0);
  border-radius: 6px;
  padding: 4px 8px;
  background: var(--surface-2, #fff);
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.reader-mindmap-control:focus-visible,
.reader-mindmap-node:focus-visible {
  outline: 2px solid var(--focus, #4b93dd);
  outline-offset: 2px;
}

.reader-mindmap-scroll {
  min-height: 220px;
  overflow: auto;
  border: 1px solid var(--line, #d8d0c0);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-2, #fff) 94%, transparent);
}

.reader-mindmap-svg { display: block; min-width: 100%; }

.reader-mindmap-links path {
  fill: none;
  stroke: color-mix(in srgb, var(--muted, #6b6257) 52%, transparent);
  stroke-width: 1.5;
}

.reader-mindmap-node { cursor: pointer; }
.reader-mindmap-node rect { fill: var(--surface-2, #fff); stroke: var(--line, #d8d0c0); stroke-width: 1; }
.reader-mindmap-node:hover rect { stroke: var(--focus, #4b93dd); }
.reader-mindmap-node-level-0 rect { fill: color-mix(in srgb, var(--focus, #4b93dd) 13%, var(--surface-2, #fff)); stroke: var(--focus, #4b93dd); }
.reader-mindmap-node-level-1 rect { fill: color-mix(in srgb, var(--surface-2, #fff) 90%, var(--focus, #4b93dd)); }
.reader-mindmap-label { fill: currentColor; font-size: 13px; }
.reader-mindmap-toggle { fill: var(--muted, #6b6257); font-size: 10px; }
.reader-mindmap-empty { padding: 28px 12px; color: var(--muted, #6b6257); text-align: center; }
</style>
