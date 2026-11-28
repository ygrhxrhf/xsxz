import { describe, expect, it } from 'vitest'
import type { AiMemoryFile, AiSummaries } from '../shared/types'
import { isAiMemoryFile } from './library'
import { planAiRecap, selectRecapMaterials, validateAiRecapOutput } from './aiRecap'
import { AI_INPUT_CHARACTER_BUDGET, countTextCharacters } from './aiBudget'
import { activeEntityTerms } from './aiRecapDigest'

/** 与 aiRecap 的 DIGEST_RESERVE_CHARACTERS 对齐：装箱前先扣 2500 字留给旧章节选。 */
const DIGEST_RESERVE = 2_500

const chapters = [
  { id: 'c0001', index: 1, title: '第一章', status: 'ready' },
  { id: 'c0002', index: 2, title: '第二章', status: 'ready' },
  { id: 'c0003', index: 3, title: '第三章', status: 'ready' },
  { id: 'c0004', index: 4, title: '第四章', status: 'failed' },
]

const stored: AiSummaries = {
  version: 2,
  byChapter: {
    c0001: '摘要一 READ_ONE', c0002: '摘要二 READ_TWO', c0003: '摘要三 UNREAD_THREE', c0004: '失败章摘要',
  },
  storySoFar: { uptoChapterId: 'c0001', text: '旧前情', updatedAt: '2026-01-01T00:00:00.000Z' },
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function memory(): AiMemoryFile {
  return {
    version: 1,
    uptoChapterId: 'c0003',
    characters: [{
      id: 'character-0123456789abcdef', name: '顾清', aliases: [], role: '主角', status: '调查中',
      summary: '正常人物记忆', accuracy: 'normal', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev-c0001-p0-s1', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '甲'.repeat(80) }],
    }, {
      id: 'character-1123456789abcdef', name: '待复核者', aliases: [], role: '未知', status: '未知',
      summary: 'REVIEW_SECRET', accuracy: 'review', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev-c0001-p0-s2', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '乙'.repeat(80) }],
    }],
    relations: [{
      id: 'relation-0123456789abcdef', from: '顾清', to: '顾远', relation: '父女', status: '失联',
      summary: 'UNREAD_MEMORY', accuracy: 'normal', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev-c0003-p0-s1', chapterId: 'c0003', chapterTitle: '第三章', paragraphIndex: 0, excerpt: '丙'.repeat(80) }],
    }],
    foreshadows: [{
      id: 'foreshadow-0123456789abcdef', desc: '旧账册', status: 'uncertain', summary: 'UNCERTAIN_SECRET',
      accuracy: 'uncertain', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev-c0001-p0-s3', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '丁'.repeat(80) }],
    }],
    events: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('recap material selection', () => {
  it('clamps to progress, reads only stored summaries, and excludes failed/unread entries', () => {
    const result = selectRecapMaterials(chapters, 'c0004', 'c0002', stored, memory())
    expect(result.uptoChapterId).toBe('c0002')
    expect(result.summaries.map((item) => item.chapterId)).toEqual(['c0001', 'c0002'])
    expect(JSON.stringify(result)).toContain('READ_ONE')
    expect(JSON.stringify(result)).not.toContain('UNREAD_THREE')
    expect(JSON.stringify(result)).not.toContain('失败章摘要')
  })

  it('includes only normal memory whose every source is within the current ready cutoff', () => {
    const result = selectRecapMaterials(chapters, 'c0004', 'c0002', stored, memory())
    expect(result.memoryFacts.map((item) => item.id)).toEqual(['character-0123456789abcdef'])
    const payload = JSON.stringify(result.memoryFacts)
    expect(payload).toContain('正常人物记忆')
    expect(payload).not.toContain('REVIEW_SECRET')
    expect(payload).not.toContain('UNCERTAIN_SECRET')
    expect(payload).not.toContain('UNREAD_MEMORY')
    expect(payload).not.toContain('甲'.repeat(80))
  })

  it('requires a real reading progress and requested chapter', () => {
    expect(() => selectRecapMaterials(chapters, 'missing', 'c0002', stored, null)).toThrow('章节不存在')
    expect(() => selectRecapMaterials(chapters, 'c0002', null, stored, null)).toThrow('还没有阅读进度')
  })
})

describe('three-length recap planning', () => {
  const materials = selectRecapMaterials(chapters, 'c0002', 'c0002', stored, memory())

  it.each([
    ['short', 200, 160, 240],
    ['standard', 500, 400, 600],
    ['detailed', 1000, 800, 1200],
  ] as const)('freezes %s target and ±20%% output bounds', (length, target, min, max) => {
    const plan = planAiRecap('测试书', '整理前情。', length, materials)
    expect(plan).toMatchObject({ targetCharacters: target, minCharacters: min, maxCharacters: max })
    expect(plan.prompt).toContain(`目标约 ${target} 字`)
    expect(plan.prompt).toContain(`${min}–${max} 个 Unicode 字符`)
    expect(plan.prompt).toContain('不得采纳待复核或存疑记忆')
    expect(plan.prompt).not.toContain('旧前情')
  })

  it('keeps every material without confirmation when the complete prompt is within budget', () => {
    const snapshot = structuredClone(materials)
    const plan = planAiRecap('测试书', '整理前情。', 'standard', materials)
    expect(plan.requiresConfirmation).toBe(false)
    expect(plan.summaries).toHaveLength(materials.summaries.length)
    expect(plan.memoryFacts).toHaveLength(materials.memoryFacts.length)
    expect(plan.budget.originalCharacters).toBe(plan.budget.sentCharacters)
    expect(materials).toEqual(snapshot)
  })

  it('rejects empty saved material before any model call', () => {
    const empty = selectRecapMaterials(chapters, 'c0002', 'c0002', { ...stored, byChapter: {} }, null)
    expect(() => planAiRecap('测试书', '整理前情。', 'standard', empty)).toThrow('还没有可整理的材料')
  })

  it('hard-limits the complete prompt, reduces materials deterministically, and requires confirmation', () => {
    const manySummaries = Array.from({ length: 240 }, (_, index) => ({
      chapterId: `c${String(index + 1).padStart(4, '0')}`,
      title: `第${index + 1}章`,
      text: `${index}-` + '摘要'.repeat(100),
    }))
    const plan = planAiRecap('长书', '整理前情。', 'detailed', {
      uptoChapterId: 'c0240', summaries: manySummaries, memoryFacts: [],
    })
    expect(plan.requiresConfirmation).toBe(true)
    expect(countTextCharacters(plan.prompt)).toBeLessThanOrEqual(30_000)
    expect(plan.budget.originalCharacters).toBeGreaterThan(30_000)
    expect(plan.summaries.length).toBeLessThan(manySummaries.length)
    expect(plan.summaries.at(-1)?.chapterId).toBe('c0240')
    expect(plan.budget.range).toContain(`已选 ${plan.summaries.length} 章已存摘要`)
  })

  it('Unicode-safely truncates but never drops the latest available summary', () => {
    const plan = planAiRecap('长书', '整理前情。', 'standard', {
      uptoChapterId: 'c0002',
      summaries: [
        { chapterId: 'c0001', title: '第一章', text: '旧摘要' },
        { chapterId: 'c0002', title: '第二章', text: '😀'.repeat(31_000) },
      ],
      memoryFacts: [{
        id: 'character-0123456789abcdef', kind: '人物', title: '顾清', summary: '正常记忆',
        status: '调查', sourceChapters: ['第一章'],
      }],
    })
    expect(plan.requiresConfirmation).toBe(true)
    expect(plan.summaries.some((item) => item.chapterId === 'c0002')).toBe(true)
    expect(plan.summaries.find((item) => item.chapterId === 'c0002')?.text).toContain('摘要过长，已截断')
    expect(countTextCharacters(plan.prompt)).toBeLessThanOrEqual(30_000)
    expect(plan.prompt).not.toContain('\ud83d\n')
  })

  it('rejects fixed/custom requirements that leave no material room', () => {
    expect(() => planAiRecap('测试书', '要求'.repeat(20_000), 'standard', materials))
      .toThrow('AI 请求固定内容过长，无法在 30000 字预算内发送')
  })
})

describe('recap output validation', () => {
  it.each([
    ['short', 160, 240], ['standard', 400, 600], ['detailed', 800, 1200],
  ] as const)('accepts %s only within its Unicode bounds', (length, min, max) => {
    expect(validateAiRecapOutput('😀'.repeat(min), length)).toHaveLength(min * 2)
    expect(validateAiRecapOutput('甲'.repeat(max), length)).toHaveLength(max)
    // 偏短接受（短一点也比整段丢掉有用），偏长按句子边界裁剪到上限内。
    expect(validateAiRecapOutput('甲'.repeat(min - 1), length)).toHaveLength(min - 1)
    const clipped = validateAiRecapOutput(`${'甲'.repeat(max - 1)}。${'乙'.repeat(50)}`, length)
    expect(clipped.length).toBeLessThanOrEqual(max)
    expect(clipped.endsWith('。')).toBe(true)
  })

  it('keeps produced memory schema valid in its fixture', () => {
    expect(isAiMemoryFile(memory())).toBe(true)
  })
})


/** 只提供「还活着的线索」词表：人物名 + 别名；记忆正文本身不会进提示词。 */
function termsMemory(): AiMemoryFile {
  return {
    version: 1,
    characters: [{
      id: 'character-terms0001', name: '顾清', aliases: ['小清'], role: '主角', status: '调查中',
      summary: '人物说明', accuracy: 'normal', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev-c0001-p0-s9', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '摘' }],
    }],
    relations: [],
    foreshadows: [],
    events: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * 有记忆，但一个「可用线索词」都没有：人物名/别名只剩单字（词表会滤掉），关系不进词表。
 * 用来验「挑不出原句时节选不生成，预留的版面要退回装箱」。
 */
function noTermMemory(): AiMemoryFile {
  return {
    version: 1,
    characters: [{
      id: 'character-single0001', name: '甲', aliases: ['乙'], role: '路人', status: '在场',
      summary: '只有一个字的称呼', accuracy: 'normal', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev-c0001-p0-s9', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '摘' }],
    }],
    relations: [{
      id: 'relation-single0001', from: '甲', to: '乙', relation: '邻居', status: '在场',
      summary: '邻居关系', accuracy: 'normal', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev-c0001-p0-s8', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 0, excerpt: '摘' }],
    }],
    foreshadows: [],
    events: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * 每章摘要都提到线索词，所以只要未覆盖章数够，就一定节选得出东西。
 *
 * `characters` 默认 2000 字（老用例的「余量够」场景）；真实压缩比是 400 字上下，
 * 新用例用它复现「贪心装箱后余量只剩几百字」那个真实缺陷。
 */
function longSummaries(count: number, characters = 2_000) {
  return Array.from({ length: count }, (_, index) => ({
    chapterId: `c${String(index + 1).padStart(4, '0')}`,
    title: `第${index + 1}章`,
    text: `顾清在第${index + 1}章出现。${'情节'.repeat(Math.ceil(characters / 2))}`
  }))
}

describe('old-chapter digest', () => {
  const digestHeader = '旧章摘要节选（从已存摘要原句摘出，不是新写的总结）：'
  const digestWarning = '不得把节选当作完整剧情，不得据此补写未给出的细节；节选只覆盖较早的章节，当前进展以完整摘要和小说记忆为准。'

  it('未覆盖旧章达到 40 章时用摘要原句做节选，并写进发送范围', () => {
    const summaries = longSummaries(240)
    const plan = planAiRecap('长书', '整理前情。', 'detailed', {
      uptoChapterId: 'c0240', summaries, memoryFacts: [],
    }, termsMemory())
    const uncovered = summaries.length - plan.summaries.length
    expect(uncovered).toBeGreaterThanOrEqual(40)
    expect(plan.digest).toBeDefined()
    expect(plan.digest!.chapters).toBeGreaterThan(0)
    expect(plan.digest!.chapters).toBeLessThanOrEqual(uncovered)
    expect(plan.prompt).toContain(digestHeader)
    expect(plan.prompt).toContain('不得把节选当作完整剧情，不得据此补写未给出的细节')
    expect(plan.budget.range).toContain(`，另含 ${plan.digest!.chapters} 章旧章摘要节选`)
  })

  it('未覆盖不足 40 章时不引入第二种材料，也不加多余的提示词', () => {
    // 45 章 × 2000 字：未覆盖只有 31 章，所以不该节选；45 章也够不到 60 章的入场线，
    // 所以连「预留版面」都不会发生（预留只会白白削掉本该装入的新章）。
    const summaries = longSummaries(45)
    const plan = planAiRecap('长书', '整理前情。', 'detailed', {
      uptoChapterId: 'c0045', summaries, memoryFacts: [],
    }, termsMemory())
    const uncovered = summaries.length - plan.summaries.length
    expect(uncovered).toBeGreaterThan(0)
    expect(uncovered).toBeLessThan(40)
    // 门槛从「余量要超过 400 字」改成了「装箱前预留版面」，这条断言的含义没变：
    // 装箱确实把预算填满了（余量小于一章摘要），没因为别的原因少装。
    expect(30_000 - plan.budget.sentCharacters).toBeGreaterThan(400)
    expect(plan.budget.sentCharacters).toBeGreaterThan(AI_INPUT_CHARACTER_BUDGET - DIGEST_RESERVE)
    expect(plan.digest).toBeUndefined()
    expect(plan.prompt).not.toContain('旧章摘要节选')
    expect(plan.budget.range).not.toContain('另含')
  })

  it('真实压缩比（200 章 × 400 字）下节选必须真的触发', () => {
    // 200 章 × 400 字 ≈ 8.4 万字。旧规则让贪心装箱先装满，余量只剩两三百字，
    // 永远过不了 400 字门槛——节选等于没做。现在改成装箱前预留版面，这条用例就是守它。
    const summaries = longSummaries(200, 400)
    const plan = planAiRecap('长书', '整理前情。', 'detailed', {
      uptoChapterId: 'c0200', summaries, memoryFacts: [],
    }, termsMemory())
    const uncovered = summaries.length - plan.summaries.length
    // 预留之后仍然不许越预算：节选再值钱也不能撑破 30000 字。
    expect(countTextCharacters(plan.prompt)).toBeLessThanOrEqual(30_000)
    expect(uncovered).toBeGreaterThanOrEqual(40)
    expect(plan.digest).toBeDefined()
    // 被丢掉的旧章一共 7 个窗（20 章一窗），每窗 3 句，也就 21 章可挑；
    // 节选必须把 7 个窗都发到手上——这正是「预留 2500 字版面」在起作用：
    // 若不预留、只捡装箱余量（~250 字），只能装下 5 个窗 / 15 章。
    expect(plan.digest!.chapters).toBeGreaterThanOrEqual(20)
    expect(plan.digest!.chapters).toBeLessThanOrEqual(uncovered)
    expect(plan.prompt).toContain(digestHeader)
    expect(plan.budget.range).toContain('另含')
    expect(plan.budget.range).toContain(`另含 ${plan.digest!.chapters} 章旧章摘要节选`)
    expect(plan.budget.sentCharacters).toBe(countTextCharacters(plan.prompt))
  })

  it('同样的书只截到 40 章时章数不够，不生成节选，也不白扣版面', () => {
    // 40 章 × 400 字 ≈ 1.7 万字，整本装得下：既没有未覆盖章，也够不到 60 章的入场线。
    const summaries = longSummaries(40, 400)
    const plan = planAiRecap('长书', '整理前情。', 'detailed', {
      uptoChapterId: 'c0040', summaries, memoryFacts: [],
    }, termsMemory())
    expect(plan.digest).toBeUndefined()
    expect(plan.prompt).not.toContain('旧章摘要节选')
    expect(plan.summaries).toHaveLength(summaries.length)
  })

  it('章数不够但确实超预算时，预留的 2500 字必须还给装箱', () => {
    // 40 章 × 1000 字 ≈ 4 万字：真的超预算，但章数不到 60，不值得引入第二种材料。
    const summaries = longSummaries(40, 1_000)
    const plan = planAiRecap('长书', '整理前情。', 'detailed', {
      uptoChapterId: 'c0040', summaries, memoryFacts: [],
    }, termsMemory())
    expect(plan.digest).toBeUndefined()
    expect(plan.prompt).not.toContain('旧章摘要节选')
    expect(plan.summaries.length).toBeLessThan(summaries.length)
    // 「预留前」的装箱结果：装 29 章 × 1000 字 > 27500 字，说明 2500 字预留确实退回来了。
    // 若预留被白扣，这里只会装入 27 章，打包字符数也卡在 27500 以下。
    expect(plan.summaries.length).toBeGreaterThanOrEqual(29)
    expect(plan.budget.sentCharacters).toBeGreaterThan(AI_INPUT_CHARACTER_BUDGET - DIGEST_RESERVE)
  })

  it('章数不到 60 但未覆盖已过 40 章时，仍然不引入节选', () => {
    // 55 章 × 2500 字：未覆盖 44 章（过 40 章门槛），但全书不足 60 章。
    // 规则把「章数够多」当入场线：书不够长时多装几章完整摘要更值，不用两种材料。
    const summaries = longSummaries(55, 2_500)
    const plan = planAiRecap('长书', '整理前情。', 'detailed', {
      uptoChapterId: 'c0055', summaries, memoryFacts: [],
    }, termsMemory())
    expect(summaries.length - plan.summaries.length).toBeGreaterThanOrEqual(40)
    expect(plan.digest).toBeUndefined()
    expect(plan.prompt).not.toContain('旧章摘要节选')
  })

  it('记忆里没有可用线索词时不硬凑节选，预留的版面还回装箱', () => {
    const summaries = longSummaries(200, 400)
    const memory = noTermMemory()
    // 线索词只剩单字（「甲」「乙」）会被词表滤掉：没有可用线索，就没有节选的依据。
    expect(activeEntityTerms(memory)).toEqual([])
    const plan = planAiRecap('长书', '整理前情。', 'detailed', {
      uptoChapterId: 'c0200', summaries, memoryFacts: [],
    }, memory)
    expect(plan.digest).toBeUndefined()
    expect(plan.prompt).not.toContain('旧章摘要节选')
    expect(plan.budget.range).not.toContain('另含')
    // 装入章数得回到「没有预留」的水平（这份数据实测 70 章），不能被一个用不上的版面削减。
    expect(plan.summaries.length).toBeGreaterThanOrEqual(70)
    expect(plan.budget.sentCharacters).toBeGreaterThan(AI_INPUT_CHARACTER_BUDGET - DIGEST_RESERVE)
  })

  it('节选版面取 min(3000, 剩余预算)，加进去也不会撑破预算', () => {
    // 旧规则只肯把「装箱余量的 60%」给节选，而余量本来就只有两三百字，节选等于被饿死；
    // 现在版面在装箱前就预留好了，节选按 min(3000, 30000 - 已装字符) 取：
    // 既不会因为余量碎片而消失，也依旧受 30000 字硬上限约束。
    const summaries = longSummaries(240)
    const plan = planAiRecap('长书', '整理前情。', 'detailed', {
      uptoChapterId: 'c0240', summaries, memoryFacts: [],
    }, termsMemory())
    const bodyStart = plan.prompt.indexOf(digestHeader) + digestHeader.length + 1 + digestWarning.length + 1
    const digestBody = plan.prompt.slice(bodyStart)
    // 节选不是无限额度：封顶 3000 字，而且这一段确实装进了东西。
    expect(plan.digest).toBeDefined()
    expect(countTextCharacters(digestBody)).toBeGreaterThan(0)
    expect(countTextCharacters(digestBody)).toBeLessThanOrEqual(3_000)
    expect(countTextCharacters(plan.prompt)).toBeLessThanOrEqual(30_000)
    // 节选也是马上要送出去的字，估算不能漏掉它。
    expect(plan.budget.sentCharacters).toBe(countTextCharacters(plan.prompt))
  })

  it('节选只取已读章摘要，未读与失败章的已存摘要不得出现', () => {
    const ready = Array.from({ length: 100 }, (_, index) => ({
      id: `c${String(index + 1).padStart(4, '0')}`, index: index + 1, title: `第${index + 1}章`, status: 'ready',
    }))
    // 100 章 × 2000 字：未覆盖 86 章（过 40 章门槛）、章数也过了 60 章入场线，节选一定会发生。
    // 节选只能从 selectRecapMaterials 给进来的已读章摘要里挑，未读/失败章的已存摘要不在候选集里。
    const byChapter: Record<string, string> = {}
    for (const chapter of ready) {
      byChapter[chapter.id] = `顾清在第${chapter.index}章出现。${'情节'.repeat(1_000)}`
    }
    byChapter.c0101 = 'UNREAD_SECRET 顾清'
    byChapter.c0102 = 'FAILED_SECRET 顾清'
    const materials = selectRecapMaterials([
      ...ready,
      { id: 'c0101', index: 101, title: '第一百零一章', status: 'ready' },
      { id: 'c0102', index: 102, title: '第一百零二章', status: 'failed' },
    ], 'c0102', 'c0100', { version: 2, byChapter, updatedAt: '' }, termsMemory())
    const plan = planAiRecap('长书', '整理前情。', 'detailed', materials, termsMemory())
    expect(materials.summaries.length - plan.summaries.length).toBeGreaterThanOrEqual(40)
    expect(plan.digest).toBeDefined()
    expect(plan.prompt).toContain(digestHeader)
    // 节选和完整摘要走同一批材料：未读章、失败章的已存摘要必须一个不落地被挡在外面。
    expect(plan.prompt).not.toContain('UNREAD_SECRET')
    expect(plan.prompt).not.toContain('FAILED_SECRET')
    expect(countTextCharacters(plan.prompt)).toBeLessThanOrEqual(30_000)
  })
})
