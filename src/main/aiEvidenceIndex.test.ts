import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiMemoryFile, Book, ChapterStatus } from '../shared/types'
import { bookDir, setLibraryPath } from './library'
import { MAX_EVIDENCE_CHAPTER_READS, retrieveLocalEvidence } from './aiEvidenceRetrieval'
import { clearEvidenceIndexCache, ensureEvidenceIndex, planEvidenceReads, wakeEvidenceIndex } from './aiEvidenceIndex'

const BOOK = 'b_index'
const NOW = '2026-10-08T00:00:00.000Z'

let directory = ''

interface Seeded {
  book: Book
  refs: Array<{ id: string; index: number; file: string }>
}

const NOUNS = ['玉印', '盐引', '船票', '当票', '官牒', '石匣', '火把', '雪道', '密信', '护院', '马槽', '井绳']
const FILLERS = ['山道', '渡口', '戏台', '井台', '柴房', '马厩', '后院', '书房', '廊下', '檐下', '桥头', '庙门']

function bodyFor(noun: string, filler: string): string {
  return [
    `${filler}的风从破窗灌进来，${noun}就在手边，众人都不敢先看它。`,
    `${noun}被${filler}的管事搬到桌上，烛火照出边角的旧痕，谁也说不出它的来历。`,
    `夜里${filler}安静下来，${noun}仍摆在灯下，像一件不属于这座院子的东西。`,
  ].join('\n\n')
}

function chapterBodies(count: number): string[] {
  const bodies: string[] = []
  for (let position = 0; position < count; position += 1) {
    const noun = NOUNS[position % NOUNS.length]!
    const filler = FILLERS[position % FILLERS.length]!
    bodies.push(`${bodyFor(noun, filler)}\n\n${filler}的第二日，${noun}被人提了一遍又一遍。`)
  }
  return bodies
}

/** 八百章夹具：每章词面互不重叠，只有目标章含「马槽」，才能证明剪枝确实生效。 */
function bulkBodies(count: number, targetIndex: number): string[] {
  return Array.from({ length: count }, (_, position) => position === targetIndex
    ? '马槽被人从墙根挪走，只剩几枚锈钉。'
    : `第${position}回渡口雾浓，行船靠岸时更鼓响过三遍，杂役各自散去。`)
}

async function seed(bodies: string[], progressChapterId?: string): Promise<Seeded> {
  const chapters = bodies.map((_, position) => ({
    id: `c${String(position + 1).padStart(4, '0')}`,
    index: position,
    title: `第${position + 1}章`,
    file: `chapters/c${String(position + 1).padStart(4, '0')}.json`,
    status: 'ready' as ChapterStatus,
  }))
  await mkdir(join(directory, BOOK, 'chapters'), { recursive: true })
  for (const [position, chapter] of chapters.entries()) {
    await writeFile(join(directory, BOOK, chapter.file), JSON.stringify({
      title: chapter.title, url: `https://example.test/${position}`, body: bodies[position], status: 'ready',
    }))
  }
  const book: Book = {
    id: BOOK, title: '测试书', author: '', tags: [], importType: 'download',
    createdAt: NOW, updatedAt: NOW, status: 'ready', chapters,
    progress: progressChapterId ? { chapterId: progressChapterId, scrollRatio: 0.5, updatedAt: NOW } : null,
  }
  await writeFile(join(directory, BOOK, 'book.json'), JSON.stringify(book, null, 2))
  return { book, refs: chapters.map((chapter) => ({ id: chapter.id, index: chapter.index, file: chapter.file })) }
}

function readerFor(seeded: Seeded): {
  calls: string[]
  readBody: (chapterId: string) => Promise<{ body: string; status: ChapterStatus | string }>
} {
  const calls: string[] = []
  const files = new Map(seeded.book.chapters.map((chapter) => [chapter.id, chapter.file]))
  return {
    calls,
    readBody: async (chapterId: string) => {
      calls.push(chapterId)
      const parsed = JSON.parse(await readFile(join(bookDir(BOOK), files.get(chapterId)!), 'utf-8')) as { body: string }
      return { body: parsed.body, status: 'ready' as ChapterStatus }
    },
  }
}

function memoryFixture(chapterId: string, paragraphIndex: number, excerpt: string): AiMemoryFile {
  return {
    version: 1, uptoChapterId: chapterId,
    characters: [{
      id: 'ch1', name: '顾清', aliases: ['顾家姑娘'], role: '账房', status: 'alive',
      summary: '顾清管着内库的出入。', accuracy: 'normal', updatedAt: NOW,
      sources: [{ id: 's1', chapterId, chapterTitle: '第五章', paragraphIndex, excerpt }],
    }],
    relations: [], foreshadows: [], events: [], updatedAt: NOW,
  }
}

async function indexFiles(): Promise<string[]> {
  try {
    return await readdir(join(directory, BOOK, 'ai', 'index'))
  } catch {
    return []
  }
}

function sidecars(files: string[]): string[] {
  return files.filter((file) => file !== 'index-manifest.json')
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spbf-evidence-index-'))
  await setLibraryPath(directory)
})

afterEach(async () => {
  clearEvidenceIndexCache()
  await rm(directory, { recursive: true, force: true })
})

describe('按章布隆证据索引', () => {
  it('建索引后签名一致就不重算，正文变了只重算那一章', async () => {
    const seeded = await seed(chapterBodies(6))
    expect(await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 6 })).toEqual({ built: 6, indexed: 6, total: 6 })
    expect((await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 6 })).built, '签名未变的章不得重算').toBe(0)

    await writeFile(join(directory, BOOK, seeded.refs[2]!.file), JSON.stringify({
      title: '第三章', body: '这一章新写了铜镜的对话，铜镜映出廊下的灯。', status: 'ready',
    }))
    expect((await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 6 })).built, '只有正文变过的那一章需要重算').toBe(1)

    const mirror = await planEvidenceReads({ bookId: BOOK, refs: seeded.refs, terms: new Set(['铜镜']) })
    expect([...mirror.readIds].sort()).toEqual(['c0003'])
    expect((await planEvidenceReads({ bookId: BOOK, refs: seeded.refs, terms: new Set(['官牒']) })).readIds.has('c0003'),
      '重算后的旧内容不再被判定为可能命中').toBe(false)
  })

  it('索引文件里不含任何连续正文', async () => {
    const bodies = chapterBodies(4)
    const seeded = await seed(bodies)
    await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 4 })
    const files = await indexFiles()
    expect(sidecars(files)).toHaveLength(4)
    const dump = (await Promise.all(files.map((file) => readFile(join(directory, BOOK, 'ai', 'index', file), 'utf-8')))).join('\n')
    for (const body of bodies) {
      const characters = Array.from(body)
      for (let start = 0; start + 12 < characters.length; start += 5) {
        expect(dump.includes(characters.slice(start, start + 12).join('')), '索引里出现了连续正文').toBe(false)
      }
    }
  })

  it('剪枝不会漏掉全扫能引用的章，并且确实省掉读盘', async () => {
    const bodies = chapterBodies(12)
    bodies[9] = `${bodies[9]}\n\n她把银子藏在墙根的暗格里，谁也没有看见。`
    const seeded = await seed(bodies)
    const upto = seeded.refs[11]!.id
    const query = { originalQuestion: '顾清把银子藏在何处' }
    const options = { requestedUptoChapterId: upto, progressChapterId: upto }

    const before = readerFor(seeded)
    const full = await retrieveLocalEvidence({ bookId: BOOK, chapters: seeded.book.chapters, query, options, readBody: before.readBody })
    expect(full.reads.indexed, '还没建索引时不得声称有覆盖').toBe(0)
    expect(before.calls).toHaveLength(12)

    await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 12 })
    const after = readerFor(seeded)
    const pruned = await retrieveLocalEvidence({ bookId: BOOK, chapters: seeded.book.chapters, query, options, readBody: after.readBody })
    expect(pruned.citations.length, '改述提问应有引用').toBeGreaterThan(0)
    expect(pruned.citations.map((citation) => citation.id)).toEqual(full.citations.map((citation) => citation.id))
    expect(pruned.reads.indexed).toBe(12)
    expect(after.calls.length, '剪枝必须真的省掉读盘').toBeLessThan(before.calls.length)
  })

  it('读盘之前回报一次剪枝计划，界面才说得出第一次提问为什么慢', async () => {
    const bodies = chapterBodies(12)
    bodies[9] = `${bodies[9]}\n\n她把银子藏在墙根的暗格里，谁也没有看见。`
    const seeded = await seed(bodies)
    const upto = seeded.refs[11]!.id
    const query = { originalQuestion: '顾清把银子藏在何处' }
    const options = { requestedUptoChapterId: upto, progressChapterId: upto }

    const events: string[] = []
    const planOf = () => (progress: { indexed: number; total: number; read: number }) => {
      events.push(`plan:${progress.indexed}/${progress.total}/${progress.read}`)
    }
    const before = readerFor(seeded)
    await retrieveLocalEvidence({
      bookId: BOOK, chapters: seeded.book.chapters, query, options,
      readBody: async (chapterId) => { events.push(`read:${chapterId}`); return before.readBody(chapterId) },
      onProgress: planOf(),
    })
    expect(events[0], '没建索引时不得声称有覆盖，且要老实说本次通读全部已读章').toBe('plan:0/12/12')

    await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 12 })
    events.length = 0
    const after = readerFor(seeded)
    await retrieveLocalEvidence({
      bookId: BOOK, chapters: seeded.book.chapters, query, options,
      readBody: async (chapterId) => { events.push(`read:${chapterId}`); return after.readBody(chapterId) },
      onProgress: planOf(),
    })
    const [plan, ...reads] = events
    expect(plan, '计划必须先于任何一次读盘').toBe(`plan:12/12/${after.calls.length}`)
    expect(reads).toHaveLength(after.calls.length)
    expect(after.calls.length, '有索引后计划读盘应远少于全扫').toBeLessThan(12)
  })

  it('记忆提示指向的章即使词面毫不重叠也必须读盘', async () => {
    const seeded = await seed(chapterBodies(12))
    const upto = seeded.refs[11]!.id
    const excerpt = '官牒被柴房的管事搬到桌上'
    expect(bodyFor('官牒', '柴房').includes(excerpt), '夹具需保证摘录真的在第五章').toBe(true)
    await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 12 })
    const reader = readerFor(seeded)
    const result = await retrieveLocalEvidence({
      bookId: BOOK,
      chapters: seeded.book.chapters,
      query: { originalQuestion: '顾清是谁' },
      options: {
        requestedUptoChapterId: upto,
        progressChapterId: upto,
        memory: memoryFixture('c0005', 1, excerpt),
      },
      readBody: reader.readBody,
    })
    expect(reader.calls, '问题里的词形在第五章一个都没有，只有必选集能救回它').toEqual(['c0005', 'c0012'])
    expect(result.citations.some((citation) => citation.chapterId === 'c0005')).toBe(true)
  })

  it('单字面短语提问时不剪枝，照旧读全部已读章', async () => {
    const seeded = await seed(chapterBodies(8))
    await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 8 })
    const upto = seeded.refs[7]!.id
    const reader = readerFor(seeded)
    const result = await retrieveLocalEvidence({
      bookId: BOOK,
      chapters: seeded.book.chapters,
      query: { originalQuestion: '玉', corePhrase: '玉' },
      options: { requestedUptoChapterId: upto, progressChapterId: upto },
      readBody: reader.readBody,
    })
    expect(reader.calls, '单字测不出词形，只能全读').toHaveLength(8)
    expect(result.citations.length).toBeGreaterThan(0)
  })

  it('侧挂损坏、被删或清单损坏都当未建处理，退回读盘而不报错', async () => {
    const seeded = await seed(chapterBodies(5))
    await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 5 })
    const terms = new Set(['玉印'])
    expect((await planEvidenceReads({ bookId: BOOK, refs: seeded.refs, terms })).readIds.has('c0002'),
      '夹具需先证明不含词形的章会被剪掉').toBe(false)

    clearEvidenceIndexCache()
    await writeFile(join(directory, BOOK, 'ai', 'index', 'c0002.json'), '{"filter":"broken')
    expect((await planEvidenceReads({ bookId: BOOK, refs: seeded.refs, terms })).readIds.has('c0002'),
      '坏侧挂要当不知道，退回读盘').toBe(true)

    clearEvidenceIndexCache()
    await rm(join(directory, BOOK, 'ai', 'index', 'c0003.json'), { force: true })
    expect((await planEvidenceReads({ bookId: BOOK, refs: seeded.refs, terms })).readIds.has('c0003')).toBe(true)

    clearEvidenceIndexCache()
    await writeFile(join(directory, BOOK, 'ai', 'index', 'index-manifest.json'), 'garbage')
    expect((await planEvidenceReads({ bookId: BOOK, refs: seeded.refs, terms })).readIds.size, '清单坏了就全读').toBe(5)
  })

  it('未读章即使已建索引也绝不读盘', async () => {
    const seeded = await seed(chapterBodies(8))
    await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 8 })
    const upto = 'c0003'
    const reader = readerFor(seeded)
    const result = await retrieveLocalEvidence({
      bookId: BOOK,
      chapters: seeded.book.chapters,
      query: { originalQuestion: '盐值多少', corePhrase: '盐引' },
      options: { requestedUptoChapterId: upto, progressChapterId: upto },
      readBody: reader.readBody,
    })
    expect(reader.calls, '已建索引的未读章也不能被读盘').toEqual(['c0002', 'c0003'])
    expect(result.uptoChapterId).toBe(upto)
    expect(result.citations.length).toBeGreaterThan(0)
    expect(result.citations.every((citation) => citation.chapterId === 'c0002')).toBe(true)
  })

  it('八百章的书一次提问只读预算内的章', async () => {
    const seeded = await seed(bulkBodies(800, 10))
    expect((await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 800 })).indexed).toBe(800)
    const upto = seeded.refs[799]!.id
    const reader = readerFor(seeded)
    const result = await retrieveLocalEvidence({
      bookId: BOOK,
      chapters: seeded.book.chapters,
      query: { originalQuestion: '马槽是谁搬走的', corePhrase: '马槽' },
      options: { requestedUptoChapterId: upto, progressChapterId: upto, currentChapterId: upto },
      readBody: reader.readBody,
    })
    expect(reader.calls.length, `读盘数远在 ${MAX_EVIDENCE_CHAPTER_READS} 之内`).toBeLessThanOrEqual(MAX_EVIDENCE_CHAPTER_READS)
    expect(reader.calls.length).toBeLessThan(800 / 2)
    expect(result.citations.map((citation) => citation.chapterId)).toContain('c0011')
  }, 60_000)

  it('拉丁词的子串命中不会被剪掉', async () => {
    const bodies = chapterBodies(6)
    bodies[3] = '她报了 Lv10 的编号，码头的人就让开了路。'
    const seeded = await seed(bodies)
    await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 6 })
    const upto = seeded.refs[5]!.id
    const reader = readerFor(seeded)
    const result = await retrieveLocalEvidence({
      bookId: BOOK,
      chapters: seeded.book.chapters,
      query: { originalQuestion: 'v10 的编号是谁给的', corePhrase: 'v10' },
      options: { requestedUptoChapterId: upto, progressChapterId: upto },
      readBody: reader.readBody,
    })
    expect(reader.calls, '正文里 v10 只是 lv10 的子串，索引必须存二元窗才剪不掉它').toContain('c0004')
    expect(result.citations.some((citation) => citation.chapterId === 'c0004')).toBe(true)
  })

  it('读章唤醒只补到进度章，重复唤醒会合并成一轮', async () => {
    await seed(chapterBodies(6), 'c0002')
    wakeEvidenceIndex(BOOK)
    wakeEvidenceIndex(BOOK)
    await vi.waitFor(async () => expect(await indexFiles()).toContain('c0002.json'), { timeout: 8_000 })
    expect(sidecars(await indexFiles()).sort(), '进度之后的章不在唤醒范围内').toEqual(['c0001.json', 'c0002.json'])
  })
})

describe('证据读盘计划', () => {
  it('没有任何可测词形时不剪枝', async () => {
    const seeded = await seed(chapterBodies(4))
    await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 4 })
    expect((await planEvidenceReads({ bookId: BOOK, refs: seeded.refs, terms: new Set<string>() })).readIds.size).toBe(4)
  })

  it('必选集不受读盘预算限制', async () => {
    const seeded = await seed(chapterBodies(6))
    await ensureEvidenceIndex(BOOK, seeded.refs, { maxChapters: 6 })
    const plan = await planEvidenceReads({
      bookId: BOOK, refs: seeded.refs, terms: new Set(['玉印', '盐引']), mandatory: ['c0004', 'c0005'], maxRead: 1,
    })
    expect(plan.readIds.has('c0004')).toBe(true)
    expect(plan.readIds.has('c0005')).toBe(true)
    expect(plan.readIds.has('c0001')).toBe(true)
    expect([...plan.readIds].filter((id) => !['c0001', 'c0004', 'c0005'].includes(id))).toHaveLength(0)
  })
})
