import type {
  AiBudgetEstimate,
  AiMemoryCharacter,
  AiMemoryRelation,
  AiMemoryForeshadow,
  AiMemoryEvent,
  AiMemoryFile,
  AiSummaries,
  ChapterStatus,
} from '../shared/types'
import { AI_INPUT_CHARACTER_BUDGET, countTextCharacters, estimateAiTokens } from './aiBudget'
import { activeEntityTerms, buildRecapDigest, groupSummaryWindows } from './aiRecapDigest'

type AiRecapLength = 'short' | 'standard' | 'detailed'

interface RecapChapterInput {
  id: string
  index: number
  title: string
  status: ChapterStatus | string
}

interface RecapMemoryFact {
  id: string
  kind: '人物' | '关系' | '伏笔' | '关键事件'
  title: string
  summary: string
  status?: string
  sourceChapters: string[]
}

interface AiRecapPlan {
  prompt: string
  uptoChapterId: string
  summaries: Array<{ chapterId: string; title: string; text: string }>
  memoryFacts: RecapMemoryFact[]
  budget: AiBudgetEstimate
  requiresConfirmation: boolean
  targetCharacters: number
  minCharacters: number
  maxCharacters: number
  /** 装不进预算的旧章里，有多少章是靠摘要原句节选补上的；没有节选时不出现。 */
  digest?: { windows: number; chapters: number }
}

const LENGTH_RULES: Record<AiRecapLength, { target: number; min: number; max: number }> = {
  short: { target: 200, min: 160, max: 240 },
  standard: { target: 500, min: 400, max: 600 },
  detailed: { target: 1_000, min: 800, max: 1_200 },
}

/**
 * 未覆盖旧章达到这个量级才值得做节选。
 *
 * 只丢了几章时，把这几章完整摘要挤进预算更划算：节选是第二套材料形态，
 * 引入它要让模型多守一条「别把节选当剧情」的规则，代价大于收益。
 */
const DIGEST_MIN_UNCOVERED_CHAPTERS = 40
/**
 * 全书不足这么多章时不引入节选。
 *
 * 几十章的书把预算全给完整摘要就够了：多装几章是同一套材料，读起来也更连贯；
 * 而节选是第二种材料形态，章数不多时收益抵不过「别把节选当剧情」这条额外规则。
 */
const DIGEST_MIN_TOTAL_CHAPTERS = 60
/**
 * 装箱阶段先扣下的节选版面（字符）。
 *
 * 贪心装箱一定会填到「下一个候选装不下」为止，剩下的余量只有单章摘要的量级（几百字），
 * 节选永远过不了门槛——这就是「节选几乎不触发」的根因。所以要在装箱前先把节选的版面扣出来，
 * 装箱结束后再判定：真不节选就把这 2500 字还给装箱。
 */
const DIGEST_RESERVE_CHARACTERS = 2_500
/** 节选上限：旧章是补充材料，不该和当前剧情争版面。 */
const DIGEST_MAX_CHARACTERS = 3_000
/** 每窗 20 章：一块节选讲一小段阅读历史，比一整本旧章更容易读。 */
const DIGEST_WINDOW_SIZE = 20
/** 只用来量「节选那一段固定说明文字」占多少字符的探针，本身不会出现在提示词里。 */
const DIGEST_LENGTH_PROBE = '\u0000'

type RecapMemoryItem =
  | { collection: 'character'; item: AiMemoryCharacter }
  | { collection: 'relation'; item: AiMemoryRelation }
  | { collection: 'foreshadow'; item: AiMemoryForeshadow }
  | { collection: 'event'; item: AiMemoryEvent }

function allMemoryItems(memory: AiMemoryFile): RecapMemoryItem[] {
  return [
    ...memory.characters.map((item) => ({ collection: 'character' as const, item })),
    ...memory.relations.map((item) => ({ collection: 'relation' as const, item })),
    ...memory.foreshadows.map((item) => ({ collection: 'foreshadow' as const, item })),
    ...memory.events.map((item) => ({ collection: 'event' as const, item })),
  ]
}

function memoryFact(entry: RecapMemoryItem): RecapMemoryFact {
  const { collection, item } = entry
  if (collection === 'character') {
    return {
      id: item.id, kind: '人物', title: item.name, summary: item.summary,
      status: item.status, sourceChapters: [...new Set(item.sources.map((source) => source.chapterTitle))],
    }
  }
  if (collection === 'relation') {
    return {
      id: item.id, kind: '关系', title: `${item.from} — ${item.to}：${item.relation}`,
      summary: item.summary, status: item.status,
      sourceChapters: [...new Set(item.sources.map((source) => source.chapterTitle))],
    }
  }
  if (collection === 'foreshadow') {
    return {
      id: item.id, kind: '伏笔', title: item.desc, summary: item.summary,
      status: item.status, sourceChapters: [...new Set(item.sources.map((source) => source.chapterTitle))],
    }
  }
  return {
    id: item.id, kind: '关键事件', title: item.title, summary: item.summary,
    status: item.result, sourceChapters: [...new Set(item.sources.map((source) => source.chapterTitle))],
  }
}

export function selectRecapMaterials(
  chapters: readonly RecapChapterInput[],
  requestedUptoChapterId: string,
  progressChapterId: string | null | undefined,
  stored: AiSummaries,
  memory: AiMemoryFile | null,
): {
  uptoChapterId: string
  summaries: Array<{ chapterId: string; title: string; text: string }>
  memoryFacts: RecapMemoryFact[]
} {
  const ordered = [...chapters].sort((left, right) => left.index - right.index)
  const requestedPosition = ordered.findIndex((chapter) => chapter.id === requestedUptoChapterId)
  if (requestedPosition < 0) throw new Error('章节不存在')
  if (!progressChapterId) throw new Error('还没有阅读进度，打开阅读器读几章再来。')
  const progressPosition = ordered.findIndex((chapter) => chapter.id === progressChapterId)
  if (progressPosition < 0) throw new Error('还没有阅读进度，打开阅读器读几章再来。')
  const cutoffPosition = Math.min(requestedPosition, progressPosition)
  const cutoff = ordered[cutoffPosition]!
  const eligible = ordered.filter((chapter, position) => position <= cutoffPosition && chapter.status === 'ready')
  const eligibleIds = new Set(eligible.map((chapter) => chapter.id))
  const summaries = eligible
    .map((chapter) => ({ chapterId: chapter.id, title: chapter.title, text: stored.byChapter[chapter.id]?.trim() ?? '' }))
    .filter((item) => item.text)
  const memoryFacts = memory
    ? allMemoryItems(memory)
      .filter(({ item }) => item.accuracy === 'normal' && item.sources.every((source) => eligibleIds.has(source.chapterId)))
      .map(memoryFact)
    : []
  return { uptoChapterId: cutoff.id, summaries, memoryFacts }
}

function buildPrompt(
  bookTitle: string,
  instruction: string,
  length: AiRecapLength,
  summaries: AiRecapPlan['summaries'],
  memoryFacts: RecapMemoryFact[],
  digestText?: string,
): string {
  const rule = LENGTH_RULES[length]
  const summaryPayload = summaries.map((item) => `【${item.title}】\n${item.text}`).join('\n\n') || '无'
  const memoryPayload = memoryFacts.map((item) =>
    `[${item.kind}] ${item.title}\n摘要：${item.summary}${item.status ? `\n状态：${item.status}` : ''}\n来源章节：${item.sourceChapters.join('、')}`,
  ).join('\n\n') || '无'
  // 节选是补充材料，固定放在最后：它比完整摘要旧得多，放前面容易被当成主线。
  const digestPayload = digestText
    ? `\n\n旧章摘要节选（从已存摘要原句摘出，不是新写的总结）：\n不得把节选当作完整剧情，不得据此补写未给出的细节；节选只覆盖较早的章节，当前进展以完整摘要和小说记忆为准。\n${digestText}`
    : ''
  return `用户任务要求：\n${instruction}\n\n固定规则：只能使用下方已经保存的已读章节摘要和正常状态小说记忆；不得使用或推测未提供的正文、章节或后续剧情；不得采纳待复核或存疑记忆；目标约 ${rule.target} 字，必须控制在 ${rule.min}–${rule.max} 个 Unicode 字符；突出继续阅读最需要回忆的人物、冲突、目标和未回收伏笔；只返回前情正文，不返回推理过程。\n\n书名：《${bookTitle}》\n\n已读章节摘要：\n${summaryPayload}\n\n正常状态小说记忆：\n${memoryPayload}${digestPayload}`
}

/**
 * 节选和正式摘要共用同一份 30000 字预算：装不下就按字符逐步缩短，
 * 截断处补省略号；缩到装不下就不放节选，绝不越预算。
 */
function fitDigestText(
  bookTitle: string,
  instruction: string,
  length: AiRecapLength,
  summaries: AiRecapPlan['summaries'],
  memoryFacts: RecapMemoryFact[],
  digestText: string,
): string | null {
  const overflowOf = (candidate: string) => countTextCharacters(
    buildPrompt(bookTitle, instruction, length, summaries, memoryFacts, candidate),
  ) - AI_INPUT_CHARACTER_BUDGET
  if (overflowOf(digestText) <= 0) return digestText
  const characters = Array.from(digestText)
  let limit = characters.length
  while (limit > 0) {
    const candidate = `${characters.slice(0, limit).join('')}…`
    const overflow = overflowOf(candidate)
    if (overflow <= 0) return candidate
    limit = Math.max(0, limit - Math.max(1, overflow))
  }
  return null
}

/**
 * 给「确定装不进去的旧章」做节选。
 *
 * 预算口径：节选能吃到的就是「整份 30000 字预算减去已装箱的提示词」，
 * 再封顶到 DIGEST_MAX_CHARACTERS；其中要先扣掉节选那段固定说明文字（它也占字数），
 * 剩下的才是可以放摘要原句的版面。挑不出原句（线索词没命中/一窗都装不下）就返回 null。
 */
function planDigestText(
  bookTitle: string,
  instruction: string,
  length: AiRecapLength,
  summaries: AiRecapPlan['summaries'],
  memoryFacts: RecapMemoryFact[],
  packedPrompt: string,
  uncovered: AiRecapPlan['summaries'],
  memory: AiMemoryFile | null,
): { text: string; windows: number; chapters: number } | null {
  const budget = Math.min(
    DIGEST_MAX_CHARACTERS,
    AI_INPUT_CHARACTER_BUDGET - countTextCharacters(packedPrompt),
  )
  const fixedCharacters = countTextCharacters(
    buildPrompt(bookTitle, instruction, length, summaries, memoryFacts, DIGEST_LENGTH_PROBE),
  ) - countTextCharacters(buildPrompt(bookTitle, instruction, length, summaries, memoryFacts))
    - countTextCharacters(DIGEST_LENGTH_PROBE)
  const bodyBudget = budget - fixedCharacters
  if (bodyBudget < 1) return null
  const built = buildRecapDigest(
    groupSummaryWindows(uncovered, DIGEST_WINDOW_SIZE),
    activeEntityTerms(memory),
    bodyBudget,
  )
  if (!built.text) return null
  // 版面已经算准了，这里只是最后一道兜底：无论如何不许撑破 30000 字。
  const fitted = fitDigestText(bookTitle, instruction, length, summaries, memoryFacts, built.text)
  if (!fitted) return null
  return { text: fitted, windows: built.windows, chapters: built.chapters }
}

export function planAiRecap(
  bookTitle: string,
  instruction: string,
  length: AiRecapLength,
  materials: ReturnType<typeof selectRecapMaterials>,
  /** 只用来提取「还活着的线索」词表；记忆内容本身不进提示词，节选文字全部来自已存摘要。 */
  memory: AiMemoryFile | null = null,
): AiRecapPlan {
  const fullPrompt = buildPrompt(bookTitle, instruction, length, materials.summaries, materials.memoryFacts)
  const emptyPrompt = buildPrompt(bookTitle, instruction, length, [], [])
  if (countTextCharacters(emptyPrompt) > AI_INPUT_CHARACTER_BUDGET) {
    throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
  }
  if (!materials.summaries.length && !materials.memoryFacts.length) {
    throw new Error('还没有可整理的材料。请先生成本章摘要或更新小说记忆。')
  }

  // 最新一章必须留下：实在装不下就只截它自己的正文。
  const recentSummaries = [...materials.summaries].reverse()
  const latest = recentSummaries[0]
  let latestFitted: AiRecapPlan['summaries'][number] | undefined
  if (latest) {
    latestFitted = latest
    if (countTextCharacters(buildPrompt(bookTitle, instruction, length, [latest], [])) > AI_INPUT_CHARACTER_BUDGET) {
      const marker = '\n（摘要过长，已截断）'
      const characters = Array.from(latest.text)
      let limit = characters.length
      while (limit > 0) {
        const candidate = { ...latest, text: `${characters.slice(0, limit).join('')}${marker}` }
        const overflow = countTextCharacters(buildPrompt(bookTitle, instruction, length, [candidate], [])) - AI_INPUT_CHARACTER_BUDGET
        if (overflow <= 0) {
          latestFitted = candidate
          break
        }
        limit = Math.max(0, limit - Math.max(1, overflow))
      }
      if (limit < 1) throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
    }
  }
  const olderSummaries = recentSummaries.slice(1)
  const facts = [...materials.memoryFacts].sort((left, right) => left.id.localeCompare(right.id))
  const candidates: Array<{ kind: 'summary'; value: AiRecapPlan['summaries'][number] } | { kind: 'memory'; value: RecapMemoryFact }> = []
  const lengthMax = Math.max(olderSummaries.length, facts.length)
  for (let index = 0; index < lengthMax; index += 1) {
    if (olderSummaries[index]) candidates.push({ kind: 'summary', value: olderSummaries[index]! })
    if (facts[index]) candidates.push({ kind: 'memory', value: facts[index]! })
  }

  /**
   * 贪心装箱：按「新→旧摘要 + 记忆」的交错顺序逐条试装，装不下就跳过这条继续试后面的。
   *
   * 抽成函数是因为节选版面可能要还回来重装一次，两次只差预算。
   */
  const fillMaterials = (budget: number) => {
    let filledSummaries = latestFitted ? [latestFitted] : []
    let filledFacts: RecapMemoryFact[] = []
    for (const candidate of candidates) {
      const nextSummaries = candidate.kind === 'summary' ? [...filledSummaries, candidate.value] : filledSummaries
      const nextFacts = candidate.kind === 'memory' ? [...filledFacts, candidate.value] : filledFacts
      const orderedSummaries = [...nextSummaries].sort((left, right) =>
        materials.summaries.findIndex((item) => item.chapterId === left.chapterId) -
        materials.summaries.findIndex((item) => item.chapterId === right.chapterId))
      if (countTextCharacters(buildPrompt(bookTitle, instruction, length, orderedSummaries, nextFacts)) <= budget) {
        filledSummaries = orderedSummaries
        filledFacts = nextFacts
      }
    }
    return {
      summaries: filledSummaries,
      memoryFacts: filledFacts,
      prompt: buildPrompt(bookTitle, instruction, length, filledSummaries, filledFacts),
    }
  }

  // 要不要旧章节选：只有「真的超预算」且「章数够多」时才值得引入第二种材料。
  // 章数不够时多装几章完整摘要就覆盖了，扣版面只会白白削掉本该装入的新章。
  const wantsDigest = countTextCharacters(fullPrompt) > AI_INPUT_CHARACTER_BUDGET &&
    materials.summaries.length >= DIGEST_MIN_TOTAL_CHAPTERS

  // 先按扣掉节选版面的预算装一次；节选要是不发生，这 2500 字下面会还回来。
  let packed = fillMaterials(
    wantsDigest ? AI_INPUT_CHARACTER_BUDGET - DIGEST_RESERVE_CHARACTERS : AI_INPUT_CHARACTER_BUDGET,
  )
  if (!packed.summaries.length && !packed.memoryFacts.length) {
    throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
  }

  let digestText = ''
  let digest: AiRecapPlan['digest']
  if (wantsDigest) {
    // 被预算丢掉的旧章：按原顺序（由旧到新）取差集。
    // 不用「倒数第几章」推算，因为未装入的位置不保证连续。
    const keptIds = new Set(packed.summaries.map((item) => item.chapterId))
    const uncovered = materials.summaries.filter((item) => !keptIds.has(item.chapterId))
    if (uncovered.length >= DIGEST_MIN_UNCOVERED_CHAPTERS) {
      const planned = planDigestText(
        bookTitle, instruction, length, packed.summaries, packed.memoryFacts, packed.prompt, uncovered, memory,
      )
      if (planned) {
        digestText = planned.text
        digest = { windows: planned.windows, chapters: planned.chapters }
      }
    }
    if (!digest) {
      // 节选没生成（未覆盖不够 / 线索词挑不出原句 / 一窗都装不下）：预留的版面还给装箱。
      // 预算没变，多装几章完整摘要总比空着 2500 字强。
      packed = fillMaterials(AI_INPUT_CHARACTER_BUDGET)
    }
  }

  const summaries = packed.summaries
  const memoryFacts = packed.memoryFacts
  const prompt = digestText
    ? buildPrompt(bookTitle, instruction, length, summaries, memoryFacts, digestText)
    : packed.prompt

  const originalCharacters = countTextCharacters(fullPrompt)
  // 节选也算进发送量：它就是马上就要送出去的字，估算口径不能漏掉它。
  const sentCharacters = countTextCharacters(prompt)
  const rule = LENGTH_RULES[length]
  const rangeSuffix = digest ? `，另含 ${digest.chapters} 章旧章摘要节选` : ''
  return {
    prompt,
    uptoChapterId: materials.uptoChapterId,
    summaries,
    memoryFacts,
    requiresConfirmation: originalCharacters > AI_INPUT_CHARACTER_BUDGET,
    targetCharacters: rule.target,
    minCharacters: rule.min,
    maxCharacters: rule.max,
    ...(digest ? { digest } : {}),
    budget: {
      originalCharacters,
      sentCharacters,
      estimatedTokens: estimateAiTokens(prompt),
      chapterCount: summaries.length,
      paragraphCount: memoryFacts.length,
      batchCount: 1,
      range: `已选 ${summaries.length} 章已存摘要，${memoryFacts.length} 条正常记忆${rangeSuffix}`,
    },
  }
}

export function validateAiRecapOutput(text: string, length: AiRecapLength): string {
  const normalized = text.trim()
  const rule = LENGTH_RULES[length]
  // 偏短接受：模型已经按「只用已存摘要、不编造」的规则写完，字数少一点远比整段丢掉有用。
  // 偏长才裁剪，而且裁在句子边界上——半句话比超标更糟。
  if (countTextCharacters(normalized) <= rule.max) return normalized
  const chars = Array.from(normalized)
  for (let index = Math.min(chars.length, rule.max); index > rule.min; index -= 1) {
    if ('。！？；…\n'.includes(chars[index - 1]!)) return chars.slice(0, index).join('').trim()
  }
  return chars.slice(0, rule.max).join('').trim()
}
