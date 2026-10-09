/**
 * 自动追剧：读者读完一章 → 自动整理本章摘要，攒够一批再推进记忆。
 * 状态落 <bookDir>/ai/follow.json，所以关窗、切书、重启后都能接着跑；
 * 渲染进程的 localStorage 队列不再是真源。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AiBudgetEstimate, AiFollowCoverage, AiFollowMode, AiFollowStart, Book, ChapterMeta, Settings,
} from '../shared/types'
import { DEFAULT_AI_PREFS } from '../shared/types'
import { resolveAiTaskInstruction } from '../shared/aiPrompts'
import { planChapterSummaryRequest, runAiTaskCompletion, type AiConfig } from './ai'
import { estimateAiTokens, promptBudget } from './aiBudget'
import { reserveAutomaticTokens } from './aiMonthlyBudget'
import { MEMORY_BATCH_CHAPTERS, preserveUserMemoryCorrections } from './aiMaterial'
import { executeMemoryOrchestration } from './aiMemoryOrchestrator'
import { AiQueue } from './aiScheduler'
import {
  atomicWriteText, bookDir, getBook, listBooks, readAiMemory, readChapter, recordAiUsage,
  withBookLock, writeAiMemory, writeChapterSummary,
} from './library'
import { assertTrustedAiEndpoint, getApiKey, getSettings, resolveEffectiveAiProvider } from './settings'
import { isLibraryRestoring } from './libraryMaintenance'
import { getReadFrontier, isFullyRead, visibleMemory } from './readFrontier'
import { syncTimeline } from './aiTimeline'

const FOLLOW_FILE = 'follow.json'
/** 连续网络失败的退避节奏，用完仍未成功就停下来等用户点「继续」。 */
const BACKOFF_MS = [5_000, 15_000, 60_000]
/** 渲染层已按比率判定「读完」，这里只兜住明显不合理的上报。 */
const FINISHED_RATIO_FLOOR = 0.999
const QUEUE_CANCELLED = '已从队列取消'

interface FollowChapterRecord {
  sig: string
  at: string
  memoryApplied: boolean
}

interface FollowFile {
  version: 1
  mode: AiFollowMode
  /** 摘要真正落盘的最后一章。 */
  uptoChapterId?: string
  queued: string[]
  done: Record<string, FollowChapterRecord>
  failed?: { chapterId: string; sig: string; message: string; at: string }
  paused?: boolean
  pauseReason?: string
  /** 本轮已整理的章数，对应 followMaxChaptersPerRun 护栏。 */
  runChapters: number
  budget: { calls: number; estimatedTokens: number }
  updatedAt: string
}

export interface AiFollowHooks {
  isDownloadBusy: () => boolean
  sleep: (ms: number) => Promise<void>
}

const DEFAULT_HOOKS: AiFollowHooks = {
  isDownloadBusy: () => false,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

type UnitOutcome = 'progress' | 'idle' | 'yielded' | 'stopped'
type JobOutcome = { kind: 'done' } | { kind: 'yielded' } | { kind: 'failed'; message: string }

type MemoryChapterBody = ChapterMeta & { body: string }

function followPath(bookId: string): string {
  return join(bookDir(bookId), 'ai', FOLLOW_FILE)
}

function chapterSignature(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

function nowIso(): string {
  return new Date().toISOString()
}

function emptyFile(): FollowFile {
  return {
    version: 1, mode: 'manual', queued: [], done: {}, runChapters: 0,
    budget: { calls: 0, estimatedTokens: 0 }, updatedAt: nowIso(),
  }
}

/** 只认白名单键：磁盘上的多余字段一律丢掉。 */
function parseFollow(value: Partial<FollowFile>): FollowFile {
  const file = emptyFile()
  file.mode = value.mode === 'auto' || value.mode === 'ask' ? value.mode : 'manual'
  if (typeof value.uptoChapterId === 'string') file.uptoChapterId = value.uptoChapterId
  if (Array.isArray(value.queued)) {
    file.queued = [...new Set(value.queued.filter((id): id is string => typeof id === 'string'))]
  }
  if (value.done && typeof value.done === 'object') {
    for (const [chapterId, record] of Object.entries(value.done)) {
      if (!record || typeof record.sig !== 'string' || typeof record.at !== 'string') continue
      file.done[chapterId] = { sig: record.sig, at: record.at, memoryApplied: record.memoryApplied === true }
    }
  }
  if (value.failed && typeof value.failed === 'object') {
    const { chapterId, sig, message, at } = value.failed
    if (typeof chapterId === 'string' && typeof sig === 'string' &&
      typeof message === 'string' && typeof at === 'string') {
      file.failed = { chapterId, sig, message, at }
    }
  }
  if (value.paused === true) file.paused = true
  if (typeof value.pauseReason === 'string') file.pauseReason = value.pauseReason
  if (typeof value.runChapters === 'number' && Number.isSafeInteger(value.runChapters) && value.runChapters >= 0) {
    file.runChapters = value.runChapters
  }
  if (value.budget && typeof value.budget === 'object') {
    const { calls, estimatedTokens } = value.budget
    file.budget = {
      calls: typeof calls === 'number' && Number.isFinite(calls) ? calls : 0,
      estimatedTokens: typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens) ? estimatedTokens : 0,
    }
  }
  if (typeof value.updatedAt === 'string') file.updatedAt = value.updatedAt
  return file
}

async function readFollow(bookId: string): Promise<FollowFile> {
  try {
    return parseFollow(JSON.parse(await readFile(followPath(bookId), 'utf-8')) as Partial<FollowFile>)
  } catch {
    return emptyFile()
  }
}

async function saveFollow(bookId: string, file: FollowFile): Promise<void> {
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  file.updatedAt = nowIso()
  await atomicWriteText(followPath(bookId), JSON.stringify(file, null, 2))
}

function pendingMemoryChapters(file: FollowFile): string[] {
  return Object.keys(file.done).filter((chapterId) => !file.done[chapterId]!.memoryApplied)
}

function hasWork(file: FollowFile): boolean {
  return file.queued.length > 0 || pendingMemoryChapters(file).length > 0
}

export class AiReadingFollowService {
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = true
  private drainPromise: Promise<void> | null = null
  private activeBookId = ''
  private readonly pending = new Set<string>()
  private readonly explicit = new Set<string>()
  private readonly streaks = new Map<string, number>()
  private readonly hooks: AiFollowHooks

  constructor(private readonly queue: AiQueue, hooks: Partial<AiFollowHooks> = {}) {
    this.hooks = { ...DEFAULT_HOOKS, ...hooks }
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    void this.discover()
    // 只为「确实有活」的书自转，空队列不产生任何磁盘读取。
    this.timer = setInterval(() => { if (this.pending.size > 0) void this.wake() }, 15_000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.pending.clear()
    this.explicit.clear()
    this.activeBookId = ''
  }

  /** `explicit` 表示用户亲自点了「继续 / 现在整理」，这一次不受设置页总开关约束。 */
  wake(bookId?: string, options: { explicit?: boolean } = {}): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (bookId) {
      if (options.explicit) this.explicit.add(bookId)
      this.pending.add(bookId)
    }
    return this.drain()
  }

  settingsChanged(): Promise<void> {
    return this.wake()
  }

  private async discover(): Promise<void> {
    try {
      for (const item of await listBooks()) {
        const file = await readFollow(item.id)
        if (file.mode === 'auto' && !file.paused && hasWork(file)) this.pending.add(item.id)
      }
    } catch (error) {
      console.warn('追剧队列恢复失败：', error)
    }
    if (this.pending.size > 0) await this.wake()
  }

  /**
   * 追剧状态是读-改-写：模型调用一跑几十秒，期间读者还会继续上报新章。
   * 所以每次写入都基于「此刻磁盘上的最新内容」只套用增量，绝不把过期的整份文件写回去。
   */
  private async mutate(bookId: string, apply: (file: FollowFile) => void): Promise<FollowFile> {
    return withBookLock(bookId, async () => {
      const file = await readFollow(bookId)
      apply(file)
      await saveFollow(bookId, file)
      return file
    })
  }

  /** 渲染层上报「这一章读完了」；ask / manual 模式只记账，不自动花额度。 */
  async chapterFinished(bookId: string, chapterId: string, ratio: number): Promise<AiFollowCoverage> {
    const book = await getBook(bookId)
    const meta = book.chapters.find((chapter) => chapter.id === chapterId)
    const current = await readFollow(bookId)
    if (current.done[chapterId]) return this.view(bookId, current, book.chapters)
    if (meta?.status !== 'ready' || ratio < FINISHED_RATIO_FLOOR) return this.view(bookId, current, book.chapters)
    const chapter = await readChapter(bookId, chapterId)
    const frontier = await getReadFrontier(bookId)
    if (!isFullyRead(chapter.body, frontier.chapters[chapterId])) return this.view(bookId, current, book.chapters)
    const file = await this.mutate(bookId, (fresh) => {
      if (!fresh.queued.includes(chapterId)) fresh.queued.push(chapterId)
    })
    if (file.mode === 'auto') void this.wake(bookId)
    return this.view(bookId, file, book.chapters)
  }

  async setMode(bookId: string, mode: AiFollowMode, confirmOverBudget = false): Promise<AiFollowStart> {
    const book = await getBook(bookId)
    const file = await readFollow(bookId)
    if (mode === 'auto' && file.mode !== 'auto' && !confirmOverBudget) {
      return {
        ok: false,
        confirmationRequired: true,
        message: '开启自动追剧后，每读完一章都会把本章正文送给模型整理摘要与记忆。',
        budget: await this.estimateRun(book, file),
      }
    }
    const next = await this.mutate(bookId, (fresh) => {
      fresh.mode = mode
      if (mode === 'manual') return
      fresh.paused = false
      delete fresh.pauseReason
      fresh.runChapters = 0
    })
    if (mode === 'auto') void this.wake(bookId)
    return { ok: true, coverage: this.view(bookId, next, book.chapters) }
  }

  /** 「继续」/「现在整理」：清掉失败与暂停标记，用户亲自授权这一次运行。 */
  async retry(bookId: string): Promise<AiFollowCoverage> {
    const book = await getBook(bookId)
    this.streaks.delete(bookId)
    const file = await this.mutate(bookId, (fresh) => {
      fresh.paused = false
      delete fresh.pauseReason
      delete fresh.failed
      fresh.runChapters = 0
    })
    void this.wake(bookId, { explicit: true })
    return this.view(bookId, file, book.chapters)
  }

  async coverage(bookId: string): Promise<AiFollowCoverage> {
    const [file, chapters] = await Promise.all([
      readFollow(bookId),
      getBook(bookId).then((book) => book.chapters).catch(() => [] as ChapterMeta[]),
    ])
    return this.view(bookId, file, chapters)
  }

  private view(bookId: string, file: FollowFile, chapters: readonly ChapterMeta[]): AiFollowCoverage {
    const upto = file.uptoChapterId
      ? chapters.find((chapter) => chapter.id === file.uptoChapterId)
      : undefined
    // 单元之间即使正让路，只要这一轮 drain 还带着这本书，界面就当作「在跑」继续轮询。
    const running = this.activeBookId === bookId || (this.drainPromise !== null && this.pending.has(bookId))
    return {
      mode: file.mode,
      running,
      paused: file.paused === true,
      ...(file.pauseReason ? { pauseReason: file.pauseReason } : {}),
      queuedChapters: file.queued.length + pendingMemoryChapters(file).length,
      organizedChapters: Object.keys(file.done).length,
      ...(file.uptoChapterId
        ? { uptoChapterId: file.uptoChapterId, uptoChapterTitle: upto?.title ?? '' }
        : {}),
      ...(file.failed ? { failed: { message: file.failed.message, at: file.failed.at } } : {}),
      calls: file.budget.calls,
      estimatedTokens: file.budget.estimatedTokens,
    }
  }

  /** 下一次运行最多要送多少字，用于开启 auto 前的确认。 */
  private async estimateRun(book: Book, file: FollowFile): Promise<AiBudgetEstimate> {
    const settings = await getSettings()
    const cap = settings.ai?.followMaxChaptersPerRun ?? DEFAULT_AI_PREFS.followMaxChaptersPerRun
    const instruction = resolveAiTaskInstruction(settings.ai ?? DEFAULT_AI_PREFS, 'chapterSummary')
    const groups: string[][] = []
    const picked: ChapterMeta[] = []
    for (const chapterId of file.queued.slice(0, cap)) {
      const meta = book.chapters.find((chapter) => chapter.id === chapterId)
      if (!meta) continue
      const chapter = await readChapter(book.id, chapterId)
      if (!chapter.body.trim()) continue
      groups.push([planChapterSummaryRequest(book.title, chapter.title || meta.title, chapter.body, instruction).prompt])
      picked.push(meta)
    }
    return promptBudget(groups, picked, picked.length, picked.length ? undefined : '本章暂无可整理正文')
  }

  private trustedConfig(settings: Settings, apiKey: string): AiConfig {
    const ai = settings.ai ?? DEFAULT_AI_PREFS
    assertTrustedAiEndpoint(settings.baseUrl, ai)
    return {
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey,
      provider: resolveEffectiveAiProvider(settings.baseUrl, ai.provider),
      thinkingEnabled: ai.thinkingEnabled,
    }
  }

  /** 同一时间只跑一轮 drain；重复调用等同一个 promise，避免两遍并发整理。 */
  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise
    const settled = this.drainLoop().finally(() => {
      if (this.drainPromise === settled) this.drainPromise = null
    })
    this.drainPromise = settled
    return settled
  }

  private async drainLoop(): Promise<void> {
    try {
      for (const bookId of [...this.pending]) {
        let outcome: UnitOutcome = 'progress'
        while (outcome === 'progress') outcome = await this.runUnit(bookId)
        if (outcome !== 'yielded') {
          this.pending.delete(bookId)
          this.explicit.delete(bookId)
          this.streaks.delete(bookId)
        }
        if (outcome === 'yielded') break
      }
    } catch (error) {
      console.warn('自动追剧运行失败：', error)
    }
  }

  private async runUnit(bookId: string): Promise<UnitOutcome> {
    if (this.stopped) return 'stopped'
    if (isLibraryRestoring() || this.hooks.isDownloadBusy()) return 'yielded'
    const [settings, file] = await Promise.all([getSettings(), readFollow(bookId)])
    if (file.mode === 'manual') return 'stopped'
    // 自动触发受设置页总开关约束；用户点了「继续 / 现在整理」才算当场授权。
    if (!settings.ai?.autoReadingFollow && !this.explicit.has(bookId)) return 'stopped'
    if (file.paused) return this.reviveIfMaterialChanged(bookId, file)
    if (!settings.apiKeyConfigured) return 'yielded'
    const apiKey = await getApiKey()
    if (!apiKey) return 'yielded'
    const book = await getBook(bookId)
    this.activeBookId = bookId
    try {
      const waiting = await this.pendingMemory(book, file)
      // 记忆攒够一批就先推进，避免几十章积压时记忆长时间不动。
      if (waiting.length >= MEMORY_BATCH_CHAPTERS) {
        return this.runMemoryBatch(book, file, waiting.slice(0, MEMORY_BATCH_CHAPTERS), settings, apiKey)
      }
      if (file.queued.length > 0) {
        const cap = settings.ai?.followMaxChaptersPerRun ?? DEFAULT_AI_PREFS.followMaxChaptersPerRun
        if (file.runChapters >= cap) return this.pauseForBudget(bookId)
        return this.runSummaryUnit(book, file, settings, apiKey)
      }
      if (!waiting.length) return 'idle'
      return this.runMemoryBatch(book, file, waiting, settings, apiKey)
    } finally {
      this.activeBookId = ''
    }
  }

  /**
   * 待推进记忆的章，按书的章节顺序返回；正文已被删除的章顺手从 done 里清掉，
   * 否则追剧会因为一条永远凑不齐的记录而反复自转。
   */
  private async pendingMemory(book: Book, file: FollowFile): Promise<string[]> {
    const known = new Set(book.chapters.map((chapter) => chapter.id))
    const gone = Object.keys(file.done).filter((chapterId) => !known.has(chapterId))
    if (gone.length) {
      await this.mutate(book.id, (fresh) => {
        for (const chapterId of gone) delete fresh.done[chapterId]
      })
      for (const chapterId of gone) delete file.done[chapterId]
    }
    return [...book.chapters]
      .sort((left, right) => left.index - right.index)
      .map((chapter) => chapter.id)
      .filter((chapterId) => file.done[chapterId] && !file.done[chapterId]!.memoryApplied)
  }

  /** 暂停后正文又变了（重下、清正文）就自动重试；同一份正文失败过就不再重复花额度。 */
  private async reviveIfMaterialChanged(bookId: string, file: FollowFile): Promise<UnitOutcome> {
    if (!file.failed) return 'stopped'
    let body = ''
    try {
      body = (await readChapter(bookId, file.failed.chapterId)).body.trim()
    } catch {
      body = ''
    }
    if (body && chapterSignature(body) === file.failed.sig) return 'stopped'
    this.streaks.delete(bookId)
    await this.mutate(bookId, (fresh) => {
      delete fresh.failed
      fresh.paused = false
      delete fresh.pauseReason
      fresh.runChapters = 0
    })
    return 'progress'
  }

  private async pauseForBudget(bookId: string): Promise<UnitOutcome> {
    await this.mutate(bookId, (fresh) => {
      fresh.paused = true
      fresh.pauseReason = `本轮已整理 ${fresh.runChapters} 章，达到单次章数上限`
    })
    return 'stopped'
  }

  /** 章节不存在、没正文、或这份正文已经整理过：不花钱，直接出队。 */
  private async skipChapter(bookId: string, chapterId: string): Promise<UnitOutcome> {
    await this.mutate(bookId, (fresh) => {
      fresh.queued = fresh.queued.filter((id) => id !== chapterId)
    })
    return 'progress'
  }

  private async runSummaryUnit(
    book: Book,
    file: FollowFile,
    settings: Settings,
    apiKey: string,
  ): Promise<UnitOutcome> {
    const chapterId = file.queued[0]!
    const meta = book.chapters.find((chapter) => chapter.id === chapterId)
    const progressIndex = book.progress?.chapterId
      ? book.chapters.find((chapter) => chapter.id === book.progress?.chapterId)?.index
      : undefined
    // 只整理读者确实读到的位置以内、且正文已就绪的章。
    if (!meta || meta.status !== 'ready' || (progressIndex !== undefined && meta.index > progressIndex)) {
      return this.skipChapter(book.id, chapterId)
    }
    const chapter = await readChapter(book.id, chapterId)
    const frontier = await getReadFrontier(book.id)
    if (!isFullyRead(chapter.body, frontier.chapters[chapterId])) return this.skipChapter(book.id, chapterId)
    const body = chapter.body.trim()
    if (!body) return this.skipChapter(book.id, chapterId)
    const sig = chapterSignature(body)
    if (file.done[chapterId]?.sig === sig) return this.skipChapter(book.id, chapterId)
    const title = chapter.title || meta.title
    const instruction = resolveAiTaskInstruction(settings.ai ?? DEFAULT_AI_PREFS, 'chapterSummary')
    const plan = planChapterSummaryRequest(book.title, title, body, instruction)
    const config = this.trustedConfig(settings, apiKey)
    const job = await this.runJob(book.id, `follow:${book.id}:summary:${chapterId}`, (signal) =>
      this.summarize(config, book.id, chapterId, plan.prompt, signal))
    if (job.kind === 'yielded') return 'yielded'
    if (job.kind === 'failed') return this.handleFailure(book.id, chapterId, sig, job.message)
    this.streaks.set(book.id, 0)
    await this.mutate(book.id, (fresh) => {
      fresh.queued = fresh.queued.filter((id) => id !== chapterId)
      fresh.done[chapterId] = { sig, at: nowIso(), memoryApplied: false }
      const uptoIndex = fresh.uptoChapterId
        ? book.chapters.find((chapter) => chapter.id === fresh.uptoChapterId)?.index ?? -1
        : -1
      if (meta.index >= uptoIndex) fresh.uptoChapterId = chapterId
      fresh.runChapters += 1
      fresh.budget.calls += 1
      fresh.budget.estimatedTokens += plan.budget.estimatedTokens
      delete fresh.failed
    })
    return 'progress'
  }

  private async summarize(
    config: AiConfig,
    bookId: string,
    chapterId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    const limit = (await getSettings()).ai?.autoMonthlyTokenLimit ?? DEFAULT_AI_PREFS.autoMonthlyTokenLimit
    const reservation = await reserveAutomaticTokens(bookId, estimateAiTokens(prompt) + 500, limit)
    let settled = false
    let completion: Awaited<ReturnType<typeof runAiTaskCompletion>>
    try {
      completion = await runAiTaskCompletion(config, [{ role: 'user', content: prompt }], { task: 'chapterSummary', signal })
      await reservation.settle(completion.usage)
      settled = true
    } finally {
      if (!settled) await reservation.settle().catch(() => {})
    }
    if (!completion.text.trim()) throw new Error('模型没有返回可用的章节摘要')
    await writeChapterSummary(bookId, chapterId, completion.text.trim(), { signal })
    await recordAiUsage(bookId, completion.usage)
  }

  private async runMemoryBatch(
    book: Book,
    file: FollowFile,
    chapterIds: readonly string[],
    settings: Settings,
    apiKey: string,
  ): Promise<UnitOutcome> {
    const ordered: MemoryChapterBody[] = []
    for (const meta of [...book.chapters].sort((left, right) => left.index - right.index)) {
      if (!chapterIds.includes(meta.id) || meta.status !== 'ready') continue
      const chapter = await readChapter(book.id, meta.id)
      const frontier = await getReadFrontier(book.id)
      if (chapter.body.trim() && isFullyRead(chapter.body, frontier.chapters[meta.id])) ordered.push({ ...meta, body: chapter.body })
    }
    if (!ordered.length) {
      await this.markMemoryApplied(book.id, chapterIds, false)
      return 'progress'
    }
    const existing = await visibleMemory(book.id, await readAiMemory(book.id))
    const instruction = resolveAiTaskInstruction(settings.ai ?? DEFAULT_AI_PREFS, 'memory')
    const config = this.trustedConfig(settings, apiKey)
    const job = await this.runJob(book.id, `follow:${book.id}:memory:${chapterIds.join('+')}`, async (signal) => {
      const memoryUpdate = await executeMemoryOrchestration(
        book.title,
        existing,
        [ordered],
        0,
        instruction,
        async (request, requestSignal) => {
          const limit = (await getSettings()).ai?.autoMonthlyTokenLimit ?? DEFAULT_AI_PREFS.autoMonthlyTokenLimit
          const reservation = await reserveAutomaticTokens(book.id, estimateAiTokens(request.prompt) + 3_000, limit)
          let settled = false
          let completion: Awaited<ReturnType<typeof runAiTaskCompletion>>
          try {
            completion = await runAiTaskCompletion(config, [{ role: 'user', content: request.prompt }], { task: 'memory', signal: requestSignal })
            await reservation.settle(completion.usage)
            settled = true
          } finally {
            if (!settled) await reservation.settle().catch(() => {})
          }
          await recordAiUsage(book.id, completion.usage)
          if (!completion.json) throw new Error('模型返回的记忆 JSON 无法识别，原有记忆未改变')
          return completion.json
        },
        { signal },
      )
      const merged = preserveUserMemoryCorrections(memoryUpdate.memory, existing)
      await writeAiMemory(book.id, merged, { signal })
      await syncTimeline(book.id, existing, merged)
    })
    if (job.kind === 'yielded') return 'yielded'
    if (job.kind === 'failed') {
      // 失败标记落在本批第一章与其自己的正文指纹上，才能和「正文变了没」直接比较。
      const first = chapterIds[0]!
      return this.handleFailure(book.id, first, file.done[first]?.sig ?? '', job.message)
    }
    await this.markMemoryApplied(book.id, chapterIds, true)
    return 'progress'
  }

  private async markMemoryApplied(bookId: string, chapterIds: readonly string[], spent: boolean): Promise<void> {
    await this.mutate(bookId, (fresh) => {
      for (const chapterId of chapterIds) {
        const record = fresh.done[chapterId]
        if (record) record.memoryApplied = true
      }
      if (!spent) return
      fresh.budget.calls += 1
      delete fresh.failed
    })
  }

  private async runJob(bookId: string, dedupeKey: string, work: (signal: AbortSignal) => Promise<void>)
    : Promise<JobOutcome> {
    try {
      const result = await this.queue.runExclusive(work, {
        lane: 'background', cls: 'follow', bookId, resource: `${bookId}:write`, dedupeKey,
      })
      // 排队期间被交互任务挤掉不会有模型结果，对追剧来说那是退让而不是失败。
      if (!result.ok) {
        return result.message === QUEUE_CANCELLED
          ? { kind: 'yielded' }
          : { kind: 'failed', message: result.message }
      }
      return { kind: 'done' }
    } catch (error: unknown) {
      // 交互任务抢同一本书的写入时会打断后台单元，那也是退让。
      if (error instanceof Error && error.name === 'AbortError') return { kind: 'yielded' }
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 连续网络失败先退避重试，退避用完才落到磁盘上的失败标记并等用户点「继续」。 */
  private async handleFailure(
    bookId: string,
    chapterId: string,
    sig: string,
    message: string,
  ): Promise<UnitOutcome> {
    const streak = (this.streaks.get(bookId) ?? 0) + 1
    this.streaks.set(bookId, streak)
    if (streak > BACKOFF_MS.length) {
      await this.mutate(bookId, (fresh) => {
        fresh.failed = { chapterId, sig, message, at: nowIso() }
        fresh.paused = true
        fresh.pauseReason = message
      })
      return 'stopped'
    }
    await this.hooks.sleep(BACKOFF_MS[streak - 1]!)
    return 'progress'
  }
}
