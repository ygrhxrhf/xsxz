<script setup lang="ts">
/**
 * 章节思维导图视图层（移植自 infinite-reader 的 MindmapDialog / useMindmapCanvas /
 * MindmapConnections / MindmapThemePicker，渲染层改写为 Vue）。
 *
 * 只消费 `readerMindmap.ts` 的纯树模型，不调用 AI、不读 IPC、不使用 v-html。
 * 能力：5 套主题、分支彩色连线、拖拽平移、滚轮平移 / Ctrl+滚轮缩放、双指捏合、适应视口。
 * 节点保持原始段落锚点；Reader 接入时只需监听 `select`。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  flattenVisibleNodes,
  mindmapAnchor,
  setAllCollapsed,
  setNodeCollapsed,
  type MindmapAnchor,
  type MindmapNode,
} from '../pages/readerMindmap'
import {
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  cameraTransform,
  fitCamera,
  panCamera,
  pointDistance,
  pointMiddle,
  wheelIntent,
  zoomCameraAt,
  type Camera,
  type Point,
} from '../pages/readerMindmapCanvas'
import {
  MINDMAP_THEMES,
  findMindmapTheme,
  loadMindmapThemeId,
  mindmapThemeStyle,
  saveMindmapThemeId,
  type MindmapThemeId,
} from '../pages/readerMindmapThemes'

const props = withDefaults(defineProps<{
  root: MindmapNode | null
  /** 画布最小宽度，超出面板时由外层滚动 */
  minWidth?: number
  /** 当前导图来源：ai（AI 提炼）或 local（按段落句组切分）。 */
  mode?: 'ai' | 'local'
  /** AI 导图是否正在生成。 */
  loading?: boolean
  /** AI 导图生成失败时的提示（此时画布仍可展示本地切分导图）。 */
  error?: string
  /** 是否显示「AI 提炼 / 重新生成」按钮。 */
  canGenerate?: boolean
}>(), {
  minWidth: 720,
  mode: 'local',
  loading: false,
  error: '',
  canGenerate: false,
})

const emit = defineEmits<{
  (event: 'select', anchor: MindmapAnchor, node: MindmapNode): void
  (event: 'generate', force: boolean): void
}>()

const tree = ref<MindmapNode | null>(props.root)
const nodeWidth = 190
const nodeHeight = 48
const horizontalGap = 72
const verticalGap = 24
const canvasPadding = 48

const themeId = ref<MindmapThemeId>(loadMindmapThemeId())
const theme = computed(() => findMindmapTheme(themeId.value))
const themeStyle = computed(() => mindmapThemeStyle(theme.value))
const themePanelOpen = ref(false)

function chooseTheme(id: MindmapThemeId): void {
  themeId.value = id
  saveMindmapThemeId(id)
}

interface PositionedNode {
  node: MindmapNode
  x: number
  y: number
  /** 所属一级分支下标（根为 -1），决定连线与描边颜色。 */
  branch: number
}

interface MindmapLink {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  branch: number
  depth: number
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

  const visit = (node: MindmapNode, branch: number): PositionedNode => {
    const x = node.level * (nodeWidth + horizontalGap)
    const visibleChildren = node.collapsed ? [] : node.children
    if (!visibleChildren.length) {
      const placed = { node, x, y: leafCursor * row, branch }
      leafCursor += 1
      nodes.push(placed)
      return placed
    }
    const children = visibleChildren.map((child, index) => visit(child, node.level === 0 ? index : branch))
    const first = children[0]!
    const last = children[children.length - 1]!
    const placed = { node, x, y: (first.y + last.y) / 2, branch }
    nodes.push(placed)
    for (const child of children) {
      links.push({
        key: `${node.id}->${child.node.id}`,
        x1: placed.x + nodeWidth,
        y1: placed.y + nodeHeight / 2,
        x2: child.x,
        y2: child.y + nodeHeight / 2,
        branch: child.branch,
        depth: child.node.level,
      })
    }
    return placed
  }

  visit(root, -1)
  const maxX = Math.max(0, ...nodes.map((item) => item.x + nodeWidth))
  const maxY = Math.max(0, ...nodes.map((item) => item.y + nodeHeight))
  return { nodes, links, width: maxX + canvasPadding * 2, height: maxY + canvasPadding * 2 }
}

const positioned = computed(() => tree.value ? layoutTree(tree.value) : { nodes: [], links: [], width: 0, height: 0 })
const visibleCount = computed(() => tree.value ? flattenVisibleNodes(tree.value).length : 0)

function branchVar(branch: number): string {
  return branch < 0 ? 'var(--map-root)' : `var(--map-branch-${branch % 6})`
}

function linkPath(link: MindmapLink): string {
  const bend = (link.x2 - link.x1) * 0.5
  return `M ${link.x1} ${link.y1} C ${link.x1 + bend} ${link.y1}, ${link.x2 - bend} ${link.y2}, ${link.x2} ${link.y2}`
}

// ---------------------------------------------------------------------------
// 画布相机：拖拽平移、滚轮平移 / Ctrl+滚轮缩放、双指捏合
// ---------------------------------------------------------------------------
const viewport = ref<HTMLElement | null>(null)
const camera = ref<Camera>({ x: 0, y: 0, scale: 1 })
const panning = ref(false)
const zoomPercent = computed(() => `${Math.round(camera.value.scale * 100)}%`)
const canvasTransform = computed(() => cameraTransform(camera.value))

const DRAG_THRESHOLD = 4
const pointers = new Map<number, Point>()
let dragOrigin: Point | null = null
let dragMoved = false
let suppressClick = false
let pinchStart: { distance: number; scale: number } | null = null

function viewportCenter(): Point {
  const el = viewport.value
  return { x: (el?.clientWidth ?? 0) / 2, y: (el?.clientHeight ?? 0) / 2 }
}

function localPoint(event: { clientX: number; clientY: number }): Point {
  const rect = viewport.value?.getBoundingClientRect()
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
}

function zoomBy(factor: number, point: Point = viewportCenter()): void {
  camera.value = zoomCameraAt(camera.value, camera.value.scale * factor, point)
}

function resetView(): void {
  camera.value = { x: 0, y: 0, scale: 1 }
}

function fitView(): void {
  const el = viewport.value
  if (!el) return
  camera.value = fitCamera(
    { width: el.clientWidth, height: el.clientHeight },
    { width: positioned.value.width, height: positioned.value.height },
  )
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const intent = wheelIntent(event)
  if (intent.kind === 'zoom') zoomBy(intent.factor, localPoint(event))
  else camera.value = panCamera(camera.value, intent.dx, intent.dy)
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  pointers.set(event.pointerId, localPoint(event))
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()] as [Point, Point]
    pinchStart = { distance: pointDistance(a, b), scale: camera.value.scale }
    dragOrigin = null
    dragMoved = true
    return
  }
  dragOrigin = localPoint(event)
  dragMoved = false
}

function onPointerMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return
  const current = localPoint(event)
  const previous = pointers.get(event.pointerId)!
  pointers.set(event.pointerId, current)

  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()] as [Point, Point]
    const distance = pointDistance(a, b)
    if (pinchStart.distance > 0) {
      camera.value = zoomCameraAt(camera.value, pinchStart.scale * (distance / pinchStart.distance), pointMiddle(a, b))
    }
    return
  }

  if (!dragOrigin) return
  if (!dragMoved && pointDistance(current, dragOrigin) < DRAG_THRESHOLD) return
  if (!dragMoved) {
    dragMoved = true
    panning.value = true
    try { viewport.value?.setPointerCapture(event.pointerId) } catch { /* 合成事件没有可捕获的指针 */ }
  }
  camera.value = panCamera(camera.value, current.x - previous.x, current.y - previous.y)
}

function endPointer(event: PointerEvent): void {
  pointers.delete(event.pointerId)
  if (pointers.size < 2) pinchStart = null
  if (pointers.size === 0) {
    // 拖拽结束后紧跟的 click 不能当作节点点击，否则平移会误触展开/跳转。
    suppressClick = dragMoved
    dragOrigin = null
    panning.value = false
    try { viewport.value?.releasePointerCapture(event.pointerId) } catch { /* 已释放 */ }
    if (suppressClick) setTimeout(() => { suppressClick = false }, 0)
  }
}

function onViewportKeydown(event: KeyboardEvent): void {
  if (event.target !== viewport.value) return
  const step = 48
  if (event.key === '+' || event.key === '=') zoomBy(1.2)
  else if (event.key === '-') zoomBy(1 / 1.2)
  else if (event.key === '0') fitView()
  else if (event.key === 'ArrowLeft') camera.value = panCamera(camera.value, step, 0)
  else if (event.key === 'ArrowRight') camera.value = panCamera(camera.value, -step, 0)
  else if (event.key === 'ArrowUp') camera.value = panCamera(camera.value, 0, step)
  else if (event.key === 'ArrowDown') camera.value = panCamera(camera.value, 0, -step)
  else return
  event.preventDefault()
}

// wheel 必须是非 passive 才能 preventDefault，Vue 的 @wheel 默认是 passive，所以手动绑定。
// 画布元素只在有章节树时才渲染，树可能晚于挂载到达（或中途被清空再出现），
// 所以不能只在 onMounted 绑定一次：用函数式 ref，元素出现时绑定、替换/消失时解绑。
function setViewport(el: unknown): void {
  const next = el instanceof HTMLElement ? el : null
  const previous = viewport.value
  if (previous === next) return
  previous?.removeEventListener('wheel', onWheel)
  viewport.value = next
  if (next) {
    next.addEventListener('wheel', onWheel, { passive: false })
    void nextTick(fitView)
  }
}
onMounted(() => {
  void nextTick(fitView)
})
onBeforeUnmount(() => {
  viewport.value?.removeEventListener('wheel', onWheel)
})

watch(() => props.root, (root) => {
  tree.value = root
  void nextTick(fitView)
}, { deep: false })

// ---------------------------------------------------------------------------
// 节点交互
// ---------------------------------------------------------------------------
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

function onNodeClick(node: MindmapNode): void {
  if (suppressClick) return
  if (node.children.length) toggle(node)
  else select(node)
}

/** 有子节点的节点单击折叠/展开；Alt+单击或「定位」按钮才跳转正文，避免父节点无法跳转。 */
function onNodeLocate(node: MindmapNode): void {
  if (suppressClick) return
  select(node)
}

function onNodeKeydown(event: KeyboardEvent, node: MindmapNode): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  if (node.children.length) toggle(node)
  else select(node)
}

function nodeClass(item: PositionedNode): string {
  return `mindmap-node-level-${Math.min(2, Math.max(0, item.node.level))}`
}
</script>

<template>
  <section class="reader-mindmap" :data-map-theme="theme.id" :style="themeStyle" aria-label="章节思维导图">
    <div class="reader-mindmap-toolbar">
      <span class="reader-mindmap-count">{{ visibleCount }} 个节点</span>
      <span v-if="mode === 'ai'" class="reader-mindmap-badge">AI 提炼</span>
      <button
        v-if="canGenerate"
        type="button"
        class="reader-mindmap-control reader-mindmap-ai-trigger"
        :disabled="loading"
        :aria-label="mode === 'ai' ? '重新生成 AI 导图' : 'AI 提炼导图'"
        @click="emit('generate', mode === 'ai')"
      >{{ loading ? '生成中…' : (mode === 'ai' ? '重新生成' : 'AI 提炼') }}</button>
      <span v-if="error" class="reader-mindmap-error" role="alert">{{ error }}</span>
      <span class="reader-mindmap-spacer"></span>
      <button type="button" class="reader-mindmap-control" aria-label="全部展开" @click="all(false)">全部展开</button>
      <button type="button" class="reader-mindmap-control" aria-label="全部折叠" @click="all(true)">全部折叠</button>
      <span class="reader-mindmap-divider" aria-hidden="true"></span>
      <button type="button" class="reader-mindmap-control" aria-label="缩小" :disabled="camera.scale <= MIN_MAP_ZOOM" @click="zoomBy(1 / 1.2)">−</button>
      <button type="button" class="reader-mindmap-control reader-mindmap-zoom" aria-label="重置缩放" @click="resetView">{{ zoomPercent }}</button>
      <button type="button" class="reader-mindmap-control" aria-label="放大" :disabled="camera.scale >= MAX_MAP_ZOOM" @click="zoomBy(1.2)">＋</button>
      <button type="button" class="reader-mindmap-control" aria-label="适应窗口" @click="fitView">适应</button>
      <div class="reader-mindmap-theme">
        <button
          type="button"
          class="reader-mindmap-control reader-mindmap-theme-trigger"
          :aria-expanded="themePanelOpen"
          :aria-label="`思维导图主题：${theme.name}`"
          @click="themePanelOpen = !themePanelOpen"
        >{{ theme.name }} ▾</button>
        <div v-if="themePanelOpen" class="reader-mindmap-theme-panel" role="group" aria-label="选择主题">
          <button
            v-for="option in MINDMAP_THEMES"
            :key="option.id"
            type="button"
            class="reader-mindmap-theme-option"
            :data-mindmap-theme-option="option.id"
            :aria-pressed="option.id === theme.id"
            @click="chooseTheme(option.id)"
          >
            <span class="reader-mindmap-theme-swatch" aria-hidden="true">
              <i v-for="color in option.branches.slice(0, 4)" :key="color" :style="{ background: color }"></i>
            </span>
            <span class="reader-mindmap-theme-name">{{ option.name }}<template v-if="option.id === theme.id"> ✓</template></span>
            <small>{{ option.description }}</small>
          </button>
        </div>
      </div>
    </div>
    <div v-if="!tree" class="reader-mindmap-empty" role="status">当前章节还没有可生成的结构。</div>
    <div
      v-else
      :ref="setViewport"
      class="reader-mindmap-viewport"
      :class="{ 'is-panning': panning }"
      tabindex="0"
      aria-label="导图画布：拖拽平移，Ctrl+滚轮缩放"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endPointer"
      @pointercancel="endPointer"
      @keydown="onViewportKeydown"
    >
      <div class="reader-mindmap-stage" :style="{ width: `${positioned.width}px`, height: `${positioned.height}px`, transform: canvasTransform }">
        <svg
          class="reader-mindmap-svg"
          :width="positioned.width"
          :height="positioned.height"
          :viewBox="`0 0 ${positioned.width} ${positioned.height}`"
          role="tree"
          :aria-label="tree.label"
        >
          <g :transform="`translate(${canvasPadding}, ${canvasPadding})`">
            <g class="reader-mindmap-links" aria-hidden="true">
              <path
                v-for="link in positioned.links"
                :key="link.key"
                :d="linkPath(link)"
                :stroke="branchVar(link.branch)"
                :stroke-width="link.depth === 1 ? 2.4 : 1.6"
              />
            </g>
            <g
              v-for="item in positioned.nodes"
              :key="item.node.id"
              class="reader-mindmap-node"
              :class="nodeClass(item)"
              :data-node-id="item.node.id"
              :transform="`translate(${item.x}, ${item.y})`"
              role="treeitem"
              :tabindex="0"
              :aria-label="`${item.node.label}${item.node.children.length ? (item.node.collapsed ? '，已折叠' : '，已展开') : ''}`"
              :aria-expanded="item.node.children.length ? String(!item.node.collapsed) : undefined"
              @keydown="onNodeKeydown($event, item.node)"
              @click="onNodeClick(item.node)"
              @dblclick.stop="onNodeLocate(item.node)"
            >
              <rect :width="nodeWidth" :height="nodeHeight" rx="10" :style="item.branch >= 0 ? { stroke: branchVar(item.branch) } : undefined" />
              <text x="14" y="22" class="reader-mindmap-label">{{ item.node.label }}</text>
              <text v-if="item.node.children.length" x="14" y="39" class="reader-mindmap-toggle">
                {{ item.node.collapsed ? '展开' : '折叠' }}<tspan v-if="mindmapAnchor(item.node)"> · 双击定位</tspan>
              </text>
            </g>
          </g>
        </svg>
      </div>
    </div>
    <p v-if="tree" class="reader-mindmap-hint">拖拽平移 · 捏合 / Ctrl+滚轮缩放 · 单击展开折叠 · 末级节点单击跳转正文</p>
  </section>
</template>

<style scoped>
.reader-mindmap {
  --map-canvas: #f5f7fa;
  --map-panel: #ffffff;
  --map-ink: #243247;
  --map-muted: #5c6979;
  --map-border: #dbe2eb;
  --map-node: #ffffff;
  --map-root: #284b70;
  --map-rootInk: #ffffff;
  --map-branch-0: #4969a6;
  display: flex;
  min-height: 320px;
  flex-direction: column;
  color: var(--map-ink);
}

.reader-mindmap-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 0 10px;
}

.reader-mindmap-count {
  color: var(--map-muted);
  font-size: 12px;
}

.reader-mindmap-spacer { flex: 1; }
.reader-mindmap-divider { width: 1px; height: 18px; background: var(--map-border); margin: 0 3px; }

.reader-mindmap-control {
  border: 1px solid var(--map-border);
  border-radius: 8px;
  padding: 4px 8px;
  background: var(--map-panel);
  color: var(--map-ink);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
}

.reader-mindmap-control:hover:not(:disabled) { background: color-mix(in srgb, var(--map-branch-0) 10%, var(--map-panel)); }
.reader-mindmap-control:disabled { opacity: 0.4; cursor: default; }
.reader-mindmap-zoom { min-width: 52px; font-variant-numeric: tabular-nums; }

.reader-mindmap-control:focus-visible,
.reader-mindmap-node:focus-visible,
.reader-mindmap-viewport:focus-visible {
  outline: 2px solid var(--map-branch-0);
  outline-offset: 2px;
}

.reader-mindmap-theme { position: relative; }
.reader-mindmap-theme-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 5;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  width: 300px;
  max-width: calc(100vw - 32px);
  padding: 10px;
  border: 1px solid var(--map-border);
  border-radius: 12px;
  background: var(--map-panel);
  box-shadow: 0 8px 28px rgba(35, 51, 74, 0.18);
}
.reader-mindmap-theme-option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px 8px;
  border: 1px solid var(--map-border);
  border-radius: 10px;
  background: transparent;
  color: var(--map-ink);
  text-align: left;
  cursor: pointer;
  font: inherit;
  min-width: 0;
}
.reader-mindmap-theme-option:hover { background: color-mix(in srgb, var(--map-branch-0) 7%, var(--map-panel)); }
.reader-mindmap-theme-option[aria-pressed='true'] { border-color: var(--map-branch-0); box-shadow: 0 0 0 1px var(--map-branch-0); }
.reader-mindmap-theme-swatch { display: flex; gap: 3px; }
.reader-mindmap-theme-swatch i { flex: 1; height: 8px; border-radius: 4px; }
.reader-mindmap-theme-name { font-size: 12px; font-weight: 600; }
.reader-mindmap-theme-option small { font-size: 10px; line-height: 1.4; color: var(--map-muted); }

.reader-mindmap-viewport {
  position: relative;
  min-height: 260px;
  flex: 1;
  overflow: hidden;
  overscroll-behavior: contain;
  touch-action: none;
  user-select: none;
  cursor: grab;
  border: 1px solid var(--map-border);
  border-radius: 10px;
  background-color: var(--map-canvas);
  background-image: radial-gradient(color-mix(in srgb, var(--map-ink) 11%, transparent) 0.7px, transparent 0.7px);
  background-size: 24px 24px;
}
.reader-mindmap-viewport.is-panning { cursor: grabbing; }
.reader-mindmap-stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
.reader-mindmap-svg { display: block; overflow: visible; }

.reader-mindmap-links path { fill: none; stroke-linecap: round; opacity: 0.65; }

.reader-mindmap-node { cursor: pointer; }
.reader-mindmap-node rect { fill: var(--map-node); stroke: var(--map-border); stroke-width: 1.2; }
.reader-mindmap-node:hover rect { stroke-width: 2; }
.reader-mindmap-node-level-0 rect { fill: var(--map-root); stroke: var(--map-root); }
.reader-mindmap-node-level-0 .reader-mindmap-label { fill: var(--map-rootInk); font-weight: 600; }
.reader-mindmap-node-level-0 .reader-mindmap-toggle { fill: var(--map-rootInk); opacity: 0.75; }
.reader-mindmap-label { fill: var(--map-ink); font-size: 13px; }
.reader-mindmap-toggle { fill: var(--map-muted); font-size: 10px; }
.reader-mindmap-hint { margin: 8px 0 0; color: var(--map-muted); font-size: 11px; }
.reader-mindmap-empty { padding: 28px 12px; color: var(--map-muted); text-align: center; }

/* 各主题的个性化外观（移植自参考实现的 mindmap.css） */
[data-map-theme='ink'] .reader-mindmap-node rect { rx: 3px; }
[data-map-theme='ink'] .reader-mindmap-label { font-family: 'Songti SC', 'SimSun', serif; }
[data-map-theme='sand'] .reader-mindmap-node rect { rx: 18px; }
[data-map-theme='sand'] .reader-mindmap-viewport { background-size: 28px 28px; }
[data-map-theme='midnight'] .reader-mindmap-links path { opacity: 0.8; }
[data-map-theme='grove'] .reader-mindmap-links path { opacity: 0.8; }

@media (prefers-reduced-motion: reduce) {
  .reader-mindmap-stage { will-change: auto; }
}
</style>
