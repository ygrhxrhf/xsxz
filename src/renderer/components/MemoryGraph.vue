<script setup lang="ts">
/**
 * 记忆页签的人物关系图（SVG）。
 *
 * 只消费 `memoryGraph.ts` 的纯模型：不读 IPC、不调模型、不写 v-html。
 * 交互只做三件事——hover/点节点时把别人调暗、点击在下方给出小详情块、
 * 详情块里的「最早出处」把引用交给外层（Reader 复用 jumpToMemorySource）。
 *
 * 传了 chapters + uptoChapterIndex 就只画「读到这一章为止」的关系（防剧透），
 * 这两个 prop 都是可选的，不传时行为与之前完全一样。
 */
import { computed, ref, watch } from 'vue'
import type { AiCitation, AiMemoryFile } from '@shared/types'
import {
  buildMemoryGraph,
  layoutMemoryGraph,
  neighborhoodOf,
  sliceMemoryGraph,
  statusPaintSlot,
  type MemoryGraphChapterRef,
  type MemoryLayoutEdge,
  type MemoryLayoutNode,
} from '../pages/memoryGraph'

const props = withDefaults(defineProps<{
  memory: AiMemoryFile | null
  /**
   * 书籍章节表（只要有 id / index / title）。
   * 不传：画全量关系（与旧行为一致）；传了才能按阅读进度切片。
   */
  chapters?: MemoryGraphChapterRef[] | null
  /** 阅读进度上限：只画 index <= uptoChapterIndex 的章节里成立的关系。 */
  uptoChapterIndex?: number
  /** viewBox 的逻辑尺寸；CSS 宽度始终 100%，所以图上按容器宽自适应缩放。 */
  width?: number
  height?: number
}>(), {
  width: 340,
  height: 260,
})

const emit = defineEmits<{
  (event: 'jump', citation: AiCitation): void
}>()

/**
 * 全量图：不管有没有接进度，记忆本身变了都要重算，顺便给切片当输入。
 *
 * 切片接在 build 之后而不是之前：关系成立的章节是边的属性，
 * 得先把 relation.sources 压成 edge.firstSource（buildMemoryGraph 干的活）才判得出来。
 */
const fullGraph = computed(() => buildMemoryGraph(props.memory))
const graph = computed(() => {
  // 没传章节表或进度就是原来的全量行为；sliceMemoryGraph 自己也会退化，这里只省一次计算。
  if (!props.chapters?.length || props.uptoChapterIndex === undefined) return fullGraph.value
  return sliceMemoryGraph(fullGraph.value, props.chapters, props.uptoChapterIndex)
})
/** 是否处在「按进度切片」状态：空图文案要分清「切片后还没关系」与「本来就没关系」。 */
const slicing = computed(() => Boolean(props.chapters?.length)
  && props.uptoChapterIndex !== undefined
  && Number.isFinite(props.uptoChapterIndex))
const emptyText = computed(() => (slicing.value
  ? '读到这一章为止，还没有人物关系'
  : '还没有人物关系，先更新一次记忆'))
const layout = computed(() => layoutMemoryGraph(graph.value, {
  width: props.width,
  height: props.height,
  padding: 34,
}))

const hoveredId = ref<string | null>(null)
const selectedId = ref<string | null>(null)
/** hover 优先于点击：鼠标扫过时不该被之前选中的节点拖住。 */
const activeId = computed(() => hoveredId.value ?? selectedId.value)
const highlight = computed(() => (activeId.value ? neighborhoodOf(graph.value, activeId.value) : null))

function nodeLit(id: string): boolean {
  if (!highlight.value) return true
  return id === activeId.value || highlight.value.nodes.has(id)
}

function edgeLit(id: number): boolean {
  return !highlight.value || highlight.value.edges.has(id)
}

/** 记忆刷新后选中的人可能已经不在了，留着会让详情块显示一个空壳。 */
watch(graph, (next) => {
  hoveredId.value = null
  if (selectedId.value && !next.nodes.some((node) => node.id === selectedId.value)) selectedId.value = null
})

const selectedNode = computed(() => graph.value.nodes.find((node) => node.id === selectedId.value) ?? null)
const selectedRelations = computed(() => {
  if (!selectedId.value) return []
  return graph.value.edges.filter((edge) => edge.from === selectedId.value || edge.to === selectedId.value)
})

function select(id: string): void {
  selectedId.value = selectedId.value === id ? null : id
}

function jump(citation: AiCitation | undefined): void {
  if (citation) emit('jump', citation)
}

/**
 * 人多时不挂标签：切片后节点超过 12 个，就只给度数最高的 6 个挂名字。
 *
 * 为什么不是继续缩字数：以前的做法是人越多名字越短（24 人时只剩 2 个字），
 * 但 24 个人均分一圈本来就只有不到 31px 的横向空间，2 个字照样叠在一起，
 * 读者看到的是一圈看不清的字。改为「少数人挂标签」：
 * 真正需要一眼认出来的是社交中心，其余人的名字 hover/选中时出现，
 * 完整名字还一直在 aria-label 和详情块里。
 * 切片后人数通常已经变少了，所以现在只在仍然拥挤时才取舍。
 */
const DENSE_NODE_THRESHOLD = 12
const DENSE_LABEL_COUNT = 6
const labeledIds = computed(() => {
  const nodes = graph.value.nodes
  // graph.nodes 恒为 degree 降序（buildMemoryGraph 与 sliceMemoryGraph 都排过），
  // 直接取前 N 就是「度数前 6」，不用在这里重算一遍排序。
  const kept = nodes.length > DENSE_NODE_THRESHOLD ? nodes.slice(0, DENSE_LABEL_COUNT) : nodes
  return new Set(kept.map((node) => node.id))
})
/** 没在名单里的人，名字只在悬停/选中（activeId）时出现。 */
function labelShown(node: MemoryLayoutNode): boolean {
  return labeledIds.value.has(node.id) || node.id === activeId.value
}

/**
 * 名字长度上限按「实际挂出来的标签数」收紧：
 * 十多个人各自一个标签时，6 个字会互相压，收成 4 个字；
 * 密集模式最多挂 6 个标签，位置充足，不必再把名字砍成 2 个字。
 * 完整名字始终在详情块与 aria-label 里。
 */
function labelLimit(count: number): number {
  if (count <= 10) return 6
  return 4
}

function displayName(node: MemoryLayoutNode): string {
  const limit = labelLimit(labeledIds.value.size)
  return node.name.length > limit ? `${node.name.slice(0, limit - 1)}…` : node.name
}

function edgeMidpoint(edge: MemoryLayoutEdge): { x: number; y: number; angle: number } {
  const x = (edge.x1 + edge.x2) / 2
  const y = (edge.y1 + edge.y2) / 2
  const angle = (Math.atan2(edge.y2 - edge.y1, edge.x2 - edge.x1) * 180) / Math.PI
  return { x, y, angle }
}

/**
 * 文字挤在线上会糊成一片，所以默认只画线；只有高亮到这条边时才把关系文字和中点算出来。
 * 自环没有中点可言（两端同一个坐标），它的关系文字交给下面的详情块。
 */
const labeledEdges = computed(() => {
  if (!highlight.value) return []
  return layout.value.edges
    .filter((edge) => edge.from !== edge.to && highlight.value!.edges.has(edge.id))
    .map((edge) => ({ id: edge.id, relation: edge.relation, ...edgeMidpoint(edge) }))
})
</script>

<template>
  <section class="memory-graph" aria-label="人物关系图">
    <p v-if="!layout.nodes.length" class="subtle memory-graph-empty">{{ emptyText }}</p>
    <template v-else>
      <svg
        class="memory-graph-svg"
        :viewBox="`0 0 ${width} ${height}`"
        :style="{ aspectRatio: `${width} / ${height}` }"
        role="group"
        aria-label="人物关系图"
        @mouseleave="hoveredId = null"
      >
        <g class="memory-graph-edges">
          <template v-for="edge in layout.edges" :key="edge.id">
            <line
              v-if="edge.from !== edge.to"
              :x1="edge.x1"
              :y1="edge.y1"
              :x2="edge.x2"
              :y2="edge.y2"
              :data-edge-id="edge.id"
              :class="{ 'is-dim': !edgeLit(edge.id) }"
            />
            <!-- 自环没有线段可画，用一个套在节点外的细环表示「自己跟自己的关系」。 -->
            <circle
              v-else
              class="memory-graph-selfloop"
              :cx="edge.x1"
              :cy="edge.y1"
              :r="(layout.nodes.find((node) => node.id === edge.from)?.radius ?? 8) + 5"
              :data-edge-id="edge.id"
              :class="{ 'is-dim': !edgeLit(edge.id) }"
            />
          </template>
        </g>
        <g class="memory-graph-edge-labels" aria-hidden="true">
          <text
            v-for="edge in labeledEdges"
            :key="edge.id"
            :x="edge.x"
            :y="edge.y - 4"
            :transform="`rotate(${edge.angle} ${edge.x} ${edge.y})`"
            text-anchor="middle"
          >{{ edge.relation }}</text>
        </g>
        <g
          v-for="node in layout.nodes"
          :key="node.id"
          class="memory-graph-node"
          :class="{ 'is-dim': !nodeLit(node.id), 'is-selected': node.id === activeId }"
          :data-node-id="node.id"
          :data-label="labelShown(node) ? 'visible' : 'hidden'"
          role="button"
          tabindex="0"
          :aria-label="`人物：${node.name}`"
          @mouseenter="hoveredId = node.id"
          @focus="hoveredId = node.id"
          @blur="hoveredId = null"
          @click="select(node.id)"
          @keydown.enter.prevent="select(node.id)"
          @keydown.space.prevent="select(node.id)"
        >
          <circle
            :cx="node.x"
            :cy="node.y"
            :r="node.radius"
            class="memory-graph-dot"
            :class="[
              `memory-graph-status-${statusPaintSlot(node.status)}`,
              { 'is-uncertain': node.accuracy !== 'normal', 'is-unknown': !node.known },
            ]"
          />
          <!--
            不挂标签的节点不是「没办法访问」：名字仍在 aria-label 里，
            鼠标悬停/键盘聚焦时也会把标签画出来（labelShown 看 activeId）。
          -->
          <text
            v-if="labelShown(node)"
            class="memory-graph-name"
            :x="node.x"
            :y="node.y + node.radius + 12"
            text-anchor="middle"
          >{{ displayName(node) }}</text>
        </g>
      </svg>

      <div v-if="selectedNode" class="memory-graph-detail">
        <div class="memory-graph-detail-head">
          <strong>{{ selectedNode.name }}</strong>
          <span v-if="!selectedNode.known" class="subtle">记忆里还没有这张人物卡</span>
          <span v-if="selectedNode.accuracy !== 'normal'" class="memory-graph-detail-tag">
            {{ selectedNode.accuracy === 'review' ? '待复核' : '存疑' }}
          </span>
        </div>
        <p v-if="selectedNode.aliases.length" class="subtle">别名：{{ selectedNode.aliases.join('、') }}</p>
        <p v-if="selectedNode.role" class="subtle">身份：{{ selectedNode.role }}</p>
        <p v-if="selectedNode.status" class="subtle">状态：{{ selectedNode.status }} · 关联 {{ selectedNode.degree }} 条关系</p>
        <p v-else class="subtle">关联 {{ selectedNode.degree }} 条关系</p>
        <p v-if="selectedNode.summary">{{ selectedNode.summary }}</p>
        <ul class="memory-graph-relations">
          <li v-for="edge in selectedRelations" :key="edge.id">
            <span>{{ edge.from }} — {{ edge.to }}：{{ edge.relation }}</span>
            <span v-if="edge.accuracy !== 'normal'" class="memory-graph-detail-tag">
              {{ edge.accuracy === 'review' ? '待复核' : '存疑' }}
            </span>
            <button
              v-if="edge.firstSource"
              class="memory-graph-source"
              type="button"
              @click="jump(edge.firstSource)"
            >最早出处 · {{ edge.firstSource.chapterTitle }}</button>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.memory-graph {
  /* 四个槽位全部取自现有主题 token，不新造颜色：status 是自由文本，只能哈希取色。 */
  --mg-slot-0: var(--focus, #5f7f14);
  --mg-slot-1: var(--note-accent, #4c6a0f);
  --mg-slot-2: var(--warning, #8a6a1d);
  --mg-slot-3: var(--success, #3b7f4a);
  display: block;
  color: inherit;
  font: inherit;
}

.memory-graph-empty {
  margin: 6px 0 0;
}

.memory-graph-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.memory-graph-edges line {
  stroke: var(--r-line, #dedfd5);
  stroke-width: 1;
  transition: opacity var(--motion-duration, 150ms) var(--motion-easing, ease);
}

.memory-graph-edges line.is-dim {
  opacity: 0.25;
}

.memory-graph-edge-labels text {
  fill: var(--r-muted, #828a7c);
  font-size: 9px;
  pointer-events: none;
}

.memory-graph-selfloop {
  fill: none;
  stroke: var(--r-muted, #828a7c);
  stroke-width: 1;
  stroke-dasharray: 2 2;
}

.memory-graph-node {
  cursor: pointer;
  transition: opacity var(--motion-duration, 150ms) var(--motion-easing, ease);
}

.memory-graph-node.is-dim {
  opacity: 0.28;
}

.memory-graph-node:focus-visible {
  outline: 2px solid var(--r-focus, #5f7f14);
  outline-offset: 2px;
}

.memory-graph-dot {
  stroke: var(--r-surface, #f3f3ee);
  stroke-width: 1.5;
}

.memory-graph-status-0 { fill: var(--mg-slot-0); }
.memory-graph-status-1 { fill: var(--mg-slot-1); }
.memory-graph-status-2 { fill: var(--mg-slot-2); }
.memory-graph-status-3 { fill: var(--mg-slot-3); }

/* 存疑/待复核的人物用虚线描边区分，与记忆列表里的「存疑」标签同一套语义。 */
.memory-graph-dot.is-uncertain {
  stroke: var(--warning-text, #7d5f14);
  stroke-dasharray: 3 2;
}

/* 只出现在关系里、没有人物卡的名字画成空心圈：它连身份都不知道。 */
.memory-graph-dot.is-unknown {
  fill-opacity: 0.25;
}

.memory-graph-node.is-selected .memory-graph-dot {
  stroke: var(--r-focus, #5f7f14);
  stroke-width: 2.5;
}

.memory-graph-name {
  fill: var(--r-muted, #828a7c);
  font-size: 10px;
  pointer-events: none;
  user-select: none;
}

.memory-graph-node.is-selected .memory-graph-name {
  fill: var(--r-focus, #5f7f14);
}

.memory-graph-detail {
  padding: 10px;
  margin-top: 6px;
  border: 1px solid var(--r-line, #dedfd5);
  border-radius: 8px;
}

.memory-graph-detail-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}

.memory-graph-detail-tag {
  color: var(--warning-text, #7d5f14);
  font-size: 11px;
}

.memory-graph-detail p {
  margin: 4px 0;
  font-size: 12px;
}

.memory-graph-relations {
  margin: 6px 0 0;
  padding-left: 16px;
  font-size: 12px;
}

.memory-graph-relations li {
  margin-bottom: 4px;
}

.memory-graph-source {
  display: block;
  margin-top: 2px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--r-focus, #5f7f14);
  font: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  text-decoration: underline;
}
</style>
