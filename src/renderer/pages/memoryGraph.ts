/**
 * 记忆页签「人物关系图」的纯数据层与布局层。
 *
 * 小说记忆里本来就有 `characters` / `relations`，但只有列表这一种出口：读者要顺着
 * 「谁和谁有什么关系」把剧情串起来时，只能一条条读文字。这里把关系表压成图，
 * 只做三件可测的事——筛（谁上图）、排（圆环坐标）、邻（高亮谁）。
 *
 * 刻意不 import Vue、DOM 或 IPC：布局是纯函数，同样的输入必须给出逐字节相同的坐标，
 * 这样才能在无浏览器环境里断言「确定性」，组件也只负责监听事件与画 SVG。
 */
import type { AiCitation, AiMemoryBase, AiMemoryCharacter, AiMemoryFile } from '@shared/types'

export type MemoryAccuracy = AiMemoryBase['accuracy']

export interface MemoryGraphNode {
  /** 人物名，同时是高亮、布局与 SVG data 属性的键。 */
  id: string
  name: string
  /** characters 里有没有这张人物卡；false 表示只在关系里被提到。 */
  known: boolean
  /**
   * 截断**之前**的关联关系条数。
   *
   * 用截断前的数字，节点排序与边的排序才不互相依赖（边按两端 degree 之和降序，
   * 如果 degree 又由截断后的边算，就成了循环定义）。代价是边被 80 条上限截掉时，
   * 少量节点的 degree 会大于画面上看得见的线。
   */
  degree: number
  /** 身份，如「剑修」；只在 characters 里有。 */
  role: string
  /** 自由文本状态，如「主角」「龙套」；组件按哈希映射颜色，不查颜色表。 */
  status: string
  aliases: string[]
  summary: string
  accuracy: MemoryAccuracy
}

export interface MemoryGraphEdge {
  /** 在 graph.edges 里的下标；neighborhoodOf 返回的就是它。 */
  id: number
  from: string
  to: string
  relation: string
  status: string
  summary: string
  accuracy: MemoryAccuracy
  /** 该关系 sources 里最早的一条；没有可用的来源时省略（详情块就不出按钮）。 */
  firstSource?: AiCitation
}

export interface MemoryGraph {
  /** 恒为 degree 降序；切片后由 sliceMemoryGraph 重新排序，保持这条不变量可用。 */
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
}

/**
 * 切片只需要章节表的这三列（ChapterMeta 结构兼容），所以不 import 主进程的 ChapterMeta：
 * 纯数据层不该为了一个 index 把整条进程边界拖进来，测试里三行就能造一本书。
 */
export interface MemoryGraphChapterRef {
  id: string
  index: number
  title: string
}

/** 大书动辄上百个人物、上千条关系，全画出来是一团毛线；按关联度砍到可读规模。 */
export const MAX_GRAPH_NODES = 24
export const MAX_GRAPH_EDGES = 80

export interface MemoryLayoutOptions {
  width: number
  height: number
  padding: number
}

export interface MemoryLayoutNode extends MemoryGraphNode {
  x: number
  y: number
  radius: number
}

export interface MemoryLayoutEdge extends MemoryGraphEdge {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface MemoryGraphLayout {
  nodes: MemoryLayoutNode[]
  edges: MemoryLayoutEdge[]
}

/**
 * 自然序比较：数字段按数值比，其余按码点比。
 *
 * 不用 `localeCompare`：结果会随运行环境的 locale/ICU 变，而布局必须可复现。
 * 数字按数值比是为了「第3章」排在「第10章」前面——纯函数拿不到书籍章节表，
 * 只有 chapterTitle 这一列能判断谁在前面。
 */
function naturalCompare(left: string, right: string): number {
  if (left === right) return 0
  const leftParts = left.match(/\d+|\D+/gu) ?? []
  const rightParts = right.match(/\d+|\D+/gu) ?? []
  const shared = Math.min(leftParts.length, rightParts.length)
  for (let index = 0; index < shared; index += 1) {
    const l = leftParts[index]!
    const r = rightParts[index]!
    if (l === r) continue
    if (/^\d+$/u.test(l) && /^\d+$/u.test(r)) {
      const diff = Number(l) - Number(r)
      if (diff !== 0) return diff
      continue
    }
    return l < r ? -1 : 1
  }
  return leftParts.length - rightParts.length
}

/** 关系来源里最早的一条：先比章节标题，再比段落下标，最后按原有顺序兜底。 */
function earliestSource(sources: readonly AiCitation[] | undefined): AiCitation | undefined {
  if (!sources?.length) return undefined
  let bestIndex = 0
  for (let index = 1; index < sources.length; index += 1) {
    const current = sources[index]!
    const best = sources[bestIndex]!
    const byTitle = naturalCompare(current.chapterTitle, best.chapterTitle)
    if (byTitle < 0) {
      bestIndex = index
      continue
    }
    if (byTitle === 0 && current.paragraphIndex < best.paragraphIndex) bestIndex = index
  }
  return sources[bestIndex]
}

function byDegreeThenName(left: MemoryGraphNode, right: MemoryGraphNode): number {
  if (left.degree !== right.degree) return right.degree - left.degree
  return naturalCompare(left.name, right.name)
}

/**
 * 人物关系表 → 可画的图。
 *
 * 只收「至少出现在一条关系里」的人物：记忆里可能有几十张还没进关系的人物卡，
 * 全画成孤点只会把真正的关系挤到角落。关系两端在 characters 里找不到时也建节点
 * （`known: false`），否则图里会出现一条指向虚空的边。
 */
export function buildMemoryGraph(memory: AiMemoryFile | null | undefined): MemoryGraph {
  const characters = new Map<string, AiMemoryCharacter>()
  for (const item of memory?.characters ?? []) {
    const name = item.name.trim()
    // 同名只认第一张卡：后面的多半是模型重复生成的同一个人。
    if (name && !characters.has(name)) characters.set(name, item)
  }

  const degree = new Map<string, number>()
  const relations: Array<{ from: string; to: string; relation: AiMemoryFile['relations'][number] }> = []
  for (const item of memory?.relations ?? []) {
    const from = item.from.trim()
    const to = item.to.trim()
    // 端点为空的关系画不出来，也不该造出一个空名节点。
    if (!from || !to) continue
    relations.push({ from, to, relation: item })
    if (from === to) {
      // 自环只算一条关联边：它确实是这个人身上的关系，但不是两条。
      degree.set(from, (degree.get(from) ?? 0) + 1)
      continue
    }
    degree.set(from, (degree.get(from) ?? 0) + 1)
    degree.set(to, (degree.get(to) ?? 0) + 1)
  }

  const nodes: MemoryGraphNode[] = [...degree.keys()]
    .map((name) => {
      const character = characters.get(name)
      return {
        id: name,
        name,
        known: Boolean(character),
        degree: degree.get(name) ?? 0,
        role: character?.role ?? '',
        status: character?.status ?? '',
        aliases: character?.aliases ?? [],
        summary: character?.summary ?? '',
        // 没有人物卡就没有「准确度」可言，按正常处理；存疑只在卡片上标注。
        accuracy: character?.accuracy ?? ('normal' as MemoryAccuracy),
      }
    })
    .sort(byDegreeThenName)
    .slice(0, MAX_GRAPH_NODES)

  const kept = new Set(nodes.map((node) => node.id))
  // 边的排序也用截断前的 degree，理由见 MemoryGraphNode.degree 的注释。
  const ranked = relations
    .map((item, index) => ({ ...item, index }))
    .filter((item) => kept.has(item.from) && kept.has(item.to))
    .sort((left, right) => {
      const leftWeight = (degree.get(left.from) ?? 0) + (degree.get(left.to) ?? 0)
      const rightWeight = (degree.get(right.from) ?? 0) + (degree.get(right.to) ?? 0)
      if (leftWeight !== rightWeight) return rightWeight - leftWeight
      const byFrom = naturalCompare(left.from, right.from)
      if (byFrom !== 0) return byFrom
      const byTo = naturalCompare(left.to, right.to)
      if (byTo !== 0) return byTo
      // 同一对人物可能有多条关系，用原始顺序兜底，保证排序稳定。
      return left.index - right.index
    })
    .slice(0, MAX_GRAPH_EDGES)

  const edges: MemoryGraphEdge[] = ranked.map((item, index) => {
    const source = earliestSource(item.relation.sources)
    return {
      id: index,
      from: item.from,
      to: item.to,
      relation: item.relation.relation,
      status: item.relation.status,
      summary: item.relation.summary,
      accuracy: item.relation.accuracy,
      ...(source ? { firstSource: source } : {}),
    }
  })

  return { nodes, edges }
}

/**
 * 章节标题比较用的归一形式：去掉所有空白，
 * 因为「第 3 章」「第3章」「第03章」在记忆和章节表里往往写得不一样，
 * 但它们指的是同一章，按字面比较会把所有边都判成未知章节。
 */
function normalizeChapterTitle(title: string): string {
  return title.replace(/\s+/gu, '').trim()
}

/**
 * 一条边「最早成立」的章节 index，未知是 Infinity。
 *
 * 先认 chapterId（唯一可靠），再退一步按标题比（老记忆里的引用可能没写 chapterId，
 * 或者书籍重新导入后章节 id 变了，标题却还是那个标题），都认不出来就是 Infinity。
 */
function chapterIndexOfSource(
  source: AiCitation | undefined,
  byId: ReadonlyMap<string, number>,
  byTitle: ReadonlyMap<string, number>,
  chapters: readonly MemoryGraphChapterRef[],
): number {
  if (!source) return Infinity
  const bySourceId = source.chapterId ? byId.get(source.chapterId) : undefined
  if (bySourceId !== undefined) return bySourceId

  const title = normalizeChapterTitle(source.chapterTitle ?? '')
  if (!title) return Infinity
  const exact = byTitle.get(title)
  if (exact !== undefined) return exact

  // 还认不出来就做两次模糊比较，都只取最靠前的那一章，同一序号命中多条时结果也不变：
  // 1. 数字段按数值相等：「第3章」= 「第03章」；
  // 2. 互相包含：「第5章 剑气」↔ 「第5章」。
  // 两条规则都要求标题至少 2 个字：太短的标题（比如「序」）互相包含的概率太高，
  // 一旦误认成早期章节，本该隐藏的边就会提前画出来，所以宁可当未知（Infinity）。
  if (title.length < 2) return Infinity
  let matched = Infinity
  for (const chapter of chapters) {
    const candidate = normalizeChapterTitle(chapter.title)
    if (candidate.length < 2) continue
    const same = naturalCompare(candidate, title) === 0
    const partial = !same && (candidate.includes(title) || title.includes(candidate))
    if (!same && !partial) continue
    if (chapter.index < matched) matched = chapter.index
  }
  return matched
}

/**
 * 每条边最早成立的章节序号（Map：边 id → 章节 index）。
 *
 * 用 Map 而不是数组：MemoryGraphEdge.id 才是边的权威键，
 * 调用方已经可能把边复制并重新编号（sliceMemoryGraph 就这么干），按下标对位迟早错位。
 *
 * 返回 Infinity 的边就是「不知道它什么时候成立」的边。这种边在切片时一律不显示：
 * 关系图是给读者看到当前进度为止的信息，猜错一个等于提前抖出一个设定。
 */
export function memoryGraphChapterIndex(
  edges: readonly MemoryGraphEdge[],
  chapters: readonly MemoryGraphChapterRef[] | null | undefined,
): Map<number, number> {
  const byId = new Map<string, number>()
  const byTitle = new Map<string, number>()
  for (const chapter of chapters ?? []) {
    // 同一个 id / 标题重复出现时只认第一个：章节表里重复本身就是脏数据，
    // 取哪一个都不影响切片正确性，固定取第一个才能可测。
    if (chapter.id && !byId.has(chapter.id)) byId.set(chapter.id, chapter.index)
    const title = normalizeChapterTitle(chapter.title)
    if (title && !byTitle.has(title)) byTitle.set(title, chapter.index)
  }

  const result = new Map<number, number>()
  for (const edge of edges) {
    result.set(edge.id, chapterIndexOfSource(edge.firstSource, byId, byTitle, chapters ?? []))
  }
  return result
}

/**
 * 按阅读进度切片：只留 uptoIndex 之前（含）成立的边，再按剩下的边重算 degree。
 *
 * 为什么不直接改 buildMemoryGraph：切片是「视图」问题，跟记忆本身无关。
 * 记忆永远是全量的（纠错、搜索、时间线都要全量），只是这张图一次只看一段。
 *
 * 纯函数：不改入参，节点/边都是新对象，调用方可以拿着全量图反复切不同进度。
 */
export function sliceMemoryGraph(
  graph: MemoryGraph,
  chapters: readonly MemoryGraphChapterRef[] | null | undefined,
  uptoIndex: number,
): MemoryGraph {
  // 没有章节表或进度非法时不切片，原图返回：
  // 宁可多显示，也不能因为缺数据把整张图抹成空白（那看起来就像记忆坏了）。
  if (!chapters?.length || !Number.isFinite(uptoIndex)) return graph

  const edgeChapter = memoryGraphChapterIndex(graph.edges, chapters)
  const edges: MemoryGraphEdge[] = []
  for (const edge of graph.edges) {
    const at = edgeChapter.get(edge.id) ?? Infinity
    if (at > uptoIndex) continue
    // id 必须是新数组的下标：neighborhoodOf 返回的是下标，组件又拿 edge.id 去比，
    // 过滤后不重编号，点一个人就不会高亮任何线。
    edges.push({ ...edge, id: edges.length })
  }

  // 自环只算一条关联，与 buildMemoryGraph 的口径一致。
  const degree = new Map<string, number>()
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    if (edge.to !== edge.from) degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }

  const nodes = graph.nodes
    // 边被切掉的人不该以孤点形式留在图上：孤点没有信息，只占位置。
    // 自环节点这里自然会被保住（自环自身算一条关联），不会误删。
    .filter((node) => (degree.get(node.id) ?? 0) > 0)
    .map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 }))
    // 还原「degree 降序」不变量：切完度数会变，圆环布局与标签取舍都靠这个顺序。
    .sort(byDegreeThenName)

  return { nodes, edges }
}


/** 保留一位小数，顺便把 -0 归一成 0：-0 会让深比较和快照对不上。 */
function round1(value: number): number {
  const rounded = Math.round(value * 10) / 10
  return rounded === 0 ? 0 : rounded
}

/** 度数决定点的粗细：社交中心明显一点，龙套小一点。 */
function nodeRadius(degree: number): number {
  return round1(Math.min(12, 5 + degree * 1.2))
}

/**
 * 确定性圆环布局。
 *
 * 为什么是圆环：力导向布局要迭代、要随机种子，同样的记忆两次打开会画出两张不同的图，
 * 既没法测、读者也会失去空间记忆。圆环只要「按 degree 排好序」就唯一确定，
 * 度数高的固定落在 12 点方向开始顺时针的靠前位置，同一个人的位置下次还在那儿。
 */
export function layoutMemoryGraph(graph: MemoryGraph, options: MemoryLayoutOptions): MemoryGraphLayout {
  const ordered = [...graph.nodes].sort(byDegreeThenName)
  if (!ordered.length) return { nodes: [], edges: [] }

  const width = Math.max(1, options.width)
  const height = Math.max(1, options.height)
  const padding = Math.max(0, Math.min(options.padding, Math.min(width, height) / 2))
  // 画布比 padding 还窄时上下界会翻转，用中点兜住，避免出现 NaN 或越界坐标。
  const lowX = Math.min(padding, width / 2)
  const highX = Math.max(width - padding, width / 2)
  const lowY = Math.min(padding, height / 2)
  const highY = Math.max(height - padding, height / 2)
  const centerX = width / 2
  const centerY = height / 2
  const radiusX = (highX - lowX) / 2
  const radiusY = (highY - lowY) / 2

  const nodes: MemoryLayoutNode[] = ordered.map((node, index) => {
    if (ordered.length === 1) {
      // 单人物（常见于只有一条自环关系）放正中间，比在 12 点方向的弧上好看。
      return { ...node, x: round1(centerX), y: round1(centerY), radius: nodeRadius(node.degree) }
    }
    // 从 12 点开始顺时针均分；起始角固定，不随机、不随插入顺序变。
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / ordered.length
    const x = centerX + Math.cos(angle) * radiusX
    const y = centerY + Math.sin(angle) * radiusY
    return {
      ...node,
      x: round1(Math.min(highX, Math.max(lowX, x))),
      y: round1(Math.min(highY, Math.max(lowY, y))),
      radius: nodeRadius(node.degree),
    }
  })

  const positions = new Map(nodes.map((node) => [node.id, node]))
  const edges: MemoryLayoutEdge[] = []
  for (const edge of graph.edges) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (!from || !to) continue
    edges.push({ ...edge, x1: from.x, y1: from.y, x2: to.x, y2: to.y })
  }

  return { nodes, edges }
}

/**
 * 一个节点的直接邻居与相邻边（边用 graph.edges 的下标，与 MemoryGraphEdge.id 相同）。
 *
 * 不含自身：调用方要高亮「自己和邻居」时自己并上被选中的 id 即可，
 * 而图上做「只给直接邻居加亮」这类判断时，集合里混进自身反而要多写一次排除。
 */
export function neighborhoodOf(graph: MemoryGraph, id: string): { nodes: Set<string>; edges: Set<number> } {
  const nodes = new Set<string>()
  const edges = new Set<number>()
  graph.edges.forEach((edge, index) => {
    if (edge.from !== id && edge.to !== id) return
    edges.add(index)
    if (edge.from !== id) nodes.add(edge.from)
    if (edge.to !== id) nodes.add(edge.to)
  })
  return { nodes, edges }
}

/**
 * status 是模型写的自由文本（「主角」「配角」「龙套」「反派」……），没有固定的枚举，
 * 所以不能写颜色表：用码点之和哈希到 4 个现有主题色槽位，同一个词永远同一个颜色。
 */
export function statusPaintSlot(status: string): 0 | 1 | 2 | 3 {
  let hash = 0
  for (let index = 0; index < status.length; index += 1) {
    hash = (hash + status.charCodeAt(index)) % 4096
  }
  return (hash % 4) as 0 | 1 | 2 | 3
}
