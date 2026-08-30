import type {
  AiBudgetEstimate,
  AiMemoryBase,
  AiMemoryFile,
  AiSummaries,
  ChapterStatus,
} from '../shared/types'
import { AI_INPUT_CHARACTER_BUDGET, countTextCharacters, estimateAiTokens } from './aiBudget'

export type AiRecapLength = 'short' | 'standard' | 'detailed'

export interface RecapChapterInput {
  id: string
  index: number
  title: string
  status: ChapterStatus | string
}

export interface RecapMemoryFact {
  id: string
  kind: '人物' | '关系' | '伏笔' | '关键事件'
  title: string
  summary: string
  status?: string
  sourceChapters: string[]
}

export interface AiRecapPlan {
  prompt: string
  uptoChapterId: string
  summaries: Array<{ chapterId: string; title: string; text: string }>
  memoryFacts: RecapMemoryFact[]
  budget: AiBudgetEstimate
  requiresConfirmation: boolean
  targetCharacters: number
  minCharacters: number
  maxCharacters: number
}

const LENGTH_RULES: Record<AiRecapLength, { target: number; min: number; max: number }> = {
  short: { target: 200, min: 160, max: 240 },
  standard: { target: 500, min: 400, max: 600 },
  detailed: { target: 1_000, min: 800, max: 1_200 },
}

function allMemoryItems(memory: AiMemoryFile): Array<{
  collection: 'character' | 'relation' | 'foreshadow' | 'event'
  item: AiMemoryBase & Record<string, unknown>
}> {
  return [
    ...memory.characters.map((item) => ({ collection: 'character' as const, item: item as AiMemoryBase & Record<string, unknown> })),
    ...memory.relations.map((item) => ({ collection: 'relation' as const, item: item as AiMemoryBase & Record<string, unknown> })),
    ...memory.foreshadows.map((item) => ({ collection: 'foreshadow' as const, item: item as AiMemoryBase & Record<string, unknown> })),
    ...memory.events.map((item) => ({ collection: 'event' as const, item: item as AiMemoryBase & Record<string, unknown> })),
  ]
}

function memoryFact(
  collection: 'character' | 'relation' | 'foreshadow' | 'event',
  item: AiMemoryBase & Record<string, unknown>,
): RecapMemoryFact {
  if (collection === 'character') {
    return {
      id: item.id, kind: '人物', title: String(item.name), summary: item.summary,
      status: String(item.status), sourceChapters: [...new Set(item.sources.map((source) => source.chapterTitle))],
    }
  }
  if (collection === 'relation') {
    return {
      id: item.id, kind: '关系', title: `${String(item.from)} — ${String(item.to)}：${String(item.relation)}`,
      summary: item.summary, status: String(item.status),
      sourceChapters: [...new Set(item.sources.map((source) => source.chapterTitle))],
    }
  }
  if (collection === 'foreshadow') {
    return {
      id: item.id, kind: '伏笔', title: String(item.desc), summary: item.summary,
      status: String(item.status), sourceChapters: [...new Set(item.sources.map((source) => source.chapterTitle))],
    }
  }
  return {
    id: item.id, kind: '关键事件', title: String(item.title), summary: item.summary,
    status: String(item.result), sourceChapters: [...new Set(item.sources.map((source) => source.chapterTitle))],
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
      .map(({ collection, item }) => memoryFact(collection, item))
    : []
  return { uptoChapterId: cutoff.id, summaries, memoryFacts }
}

function buildPrompt(
  bookTitle: string,
  instruction: string,
  length: AiRecapLength,
  summaries: AiRecapPlan['summaries'],
  memoryFacts: RecapMemoryFact[],
): string {
  const rule = LENGTH_RULES[length]
  const summaryPayload = summaries.map((item) => `【${item.title}】\n${item.text}`).join('\n\n') || '无'
  const memoryPayload = memoryFacts.map((item) =>
    `[${item.kind}] ${item.title}\n摘要：${item.summary}${item.status ? `\n状态：${item.status}` : ''}\n来源章节：${item.sourceChapters.join('、')}`,
  ).join('\n\n') || '无'
  return `用户任务要求：\n${instruction}\n\n固定规则：只能使用下方已经保存的已读章节摘要和正常状态小说记忆；不得使用或推测未提供的正文、章节或后续剧情；不得采纳待复核或存疑记忆；目标约 ${rule.target} 字，必须控制在 ${rule.min}–${rule.max} 个 Unicode 字符；突出继续阅读最需要回忆的人物、冲突、目标和未回收伏笔；只返回前情正文，不返回推理过程。\n\n书名：《${bookTitle}》\n\n已读章节摘要：\n${summaryPayload}\n\n正常状态小说记忆：\n${memoryPayload}`
}

export function planAiRecap(
  bookTitle: string,
  instruction: string,
  length: AiRecapLength,
  materials: ReturnType<typeof selectRecapMaterials>,
): AiRecapPlan {
  const fullPrompt = buildPrompt(bookTitle, instruction, length, materials.summaries, materials.memoryFacts)
  const emptyPrompt = buildPrompt(bookTitle, instruction, length, [], [])
  if (countTextCharacters(emptyPrompt) > AI_INPUT_CHARACTER_BUDGET) {
    throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
  }
  if (!materials.summaries.length && !materials.memoryFacts.length) {
    throw new Error('还没有可整理的材料。请先生成本章摘要或更新小说记忆。')
  }

  let summaries: AiRecapPlan['summaries'] = []
  let memoryFacts: RecapMemoryFact[] = []
  const recentSummaries = [...materials.summaries].reverse()
  if (recentSummaries[0]) {
    const latest = recentSummaries.shift()!
    let fitted = latest
    if (countTextCharacters(buildPrompt(bookTitle, instruction, length, [latest], [])) > AI_INPUT_CHARACTER_BUDGET) {
      const marker = '\n（摘要过长，已截断）'
      const characters = Array.from(latest.text)
      let limit = characters.length
      while (limit > 0) {
        const candidate = { ...latest, text: `${characters.slice(0, limit).join('')}${marker}` }
        const overflow = countTextCharacters(buildPrompt(bookTitle, instruction, length, [candidate], [])) - AI_INPUT_CHARACTER_BUDGET
        if (overflow <= 0) {
          fitted = candidate
          break
        }
        limit = Math.max(0, limit - Math.max(1, overflow))
      }
      if (limit < 1) throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
    }
    summaries = [fitted]
  }
  const facts = [...materials.memoryFacts].sort((left, right) => left.id.localeCompare(right.id))
  const candidates: Array<{ kind: 'summary'; value: AiRecapPlan['summaries'][number] } | { kind: 'memory'; value: RecapMemoryFact }> = []
  const lengthMax = Math.max(recentSummaries.length, facts.length)
  for (let index = 0; index < lengthMax; index += 1) {
    if (recentSummaries[index]) candidates.push({ kind: 'summary', value: recentSummaries[index]! })
    if (facts[index]) candidates.push({ kind: 'memory', value: facts[index]! })
  }
  for (const candidate of candidates) {
    const nextSummaries = candidate.kind === 'summary' ? [...summaries, candidate.value] : summaries
    const nextFacts = candidate.kind === 'memory' ? [...memoryFacts, candidate.value] : memoryFacts
    const orderedSummaries = [...nextSummaries].sort((left, right) =>
      materials.summaries.findIndex((item) => item.chapterId === left.chapterId) -
      materials.summaries.findIndex((item) => item.chapterId === right.chapterId))
    if (countTextCharacters(buildPrompt(bookTitle, instruction, length, orderedSummaries, nextFacts)) <= AI_INPUT_CHARACTER_BUDGET) {
      summaries = orderedSummaries
      memoryFacts = nextFacts
    }
  }
  const prompt = buildPrompt(bookTitle, instruction, length, summaries, memoryFacts)
  if (!summaries.length && !memoryFacts.length) throw new Error('AI 请求固定内容过长，无法在 30000 字预算内发送')
  const originalCharacters = countTextCharacters(fullPrompt)
  const sentCharacters = countTextCharacters(prompt)
  const rule = LENGTH_RULES[length]
  return {
    prompt,
    uptoChapterId: materials.uptoChapterId,
    summaries,
    memoryFacts,
    requiresConfirmation: originalCharacters > AI_INPUT_CHARACTER_BUDGET,
    targetCharacters: rule.target,
    minCharacters: rule.min,
    maxCharacters: rule.max,
    budget: {
      originalCharacters,
      sentCharacters,
      estimatedTokens: estimateAiTokens(prompt),
      chapterCount: summaries.length,
      paragraphCount: memoryFacts.length,
      batchCount: 1,
      range: `已选 ${summaries.length} 章已存摘要，${memoryFacts.length} 条正常记忆`,
    },
  }
}

export function validateAiRecapOutput(text: string, length: AiRecapLength): string {
  const normalized = text.trim()
  const characters = countTextCharacters(normalized)
  const rule = LENGTH_RULES[length]
  if (characters < rule.min || characters > rule.max) {
    throw new Error(`前情提要长度不符合 ${rule.min}–${rule.max} 字要求，原有前情未改变`)
  }
  return normalized
}
