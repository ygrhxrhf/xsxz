import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Book, BookListItem, BookOverviewView, Settings } from '../shared/types'
import { DEFAULT_AI_PREFS } from '../shared/types'
import { runAiTaskCompletion, type AiConfig } from './ai'
import type { AiQueue } from './aiScheduler'
import { atomicWriteText, bookDir, getBook, listBooks, readChapter, recordAiUsage } from './library'
import { getApiKey, getSettings, assertTrustedAiEndpoint, resolveEffectiveAiProvider } from './settings'
import { isLibraryRestoring } from './libraryMaintenance'
import { estimateAiTokens } from './aiBudget'
import { monthlyBudgetStatus, reserveAutomaticTokens } from './aiMonthlyBudget'

/**
 * 全书概览只生成一次：`text` 一旦落盘就是这本书的最终结果，之后所有读取都走磁盘，
 * 正文改过、加了新章都不再调模型。`chapterSummaries` / `reduceCache` 只服务于
 * 「一次生成中途失败或被打断」的续做——不是给后续重新生成铺路。
 */
interface OverviewFile {
  version: 1
  text: string
  chapterSummaries: Record<string, { hash: string; text: string }>
  /** 归并阶段的中间结果：键是「变体 + 书名 + 指令 + 分组内容」的哈希 → 该组摘要。 */
  reduceCache?: Record<string, string>
  error?: string
  updatedAt: string
}

const MAX_SOURCE_CHARS = 7_000
const MAX_GROUP_CHARS = 8_000
/**
 * 单章最多取几个片段。源站常把整卷正文塞进「一章」（实测有 87 万字一章）：
 * 逐片全读要上百次调用、几十万 token，额度用完也写不出一章摘要。
 * 超长章节按比例抽片段，首尾必取，其余等距。
 */
const MAX_CHAPTER_SEGMENTS = 6
const OVERVIEW_FILE = 'bookOverview.json'
/**
 * 「已加入书架，等待生成概览」的标记文件。
 * 单独一个文件而不是写进 bookOverview.json：生成过程会反复读改写概览，
 * 两处共用一份文件会让登记与生成互相覆盖。
 */
const REQUEST_FILE = 'overview-request.json'

function overviewPath(bookId: string): string {
  return join(bookDir(bookId), 'ai', OVERVIEW_FILE)
}

function requestMarkerPath(bookId: string): string {
  return join(bookDir(bookId), 'ai', REQUEST_FILE)
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function chunks(text: string, size: number): string[] {
  const chars = Array.from(text)
  const result: string[] = []
  for (let i = 0; i < chars.length; i += size) result.push(chars.slice(i, i + size).join(''))
  return result
}

/** 等距抽片段：limit 不小于片段数时原样返回，否则取首、尾与中间均匀分布的第 limit 个。 */
function sampleSegments(segments: string[], limit: number): string[] {
  if (limit <= 0 || segments.length <= limit) return segments
  if (limit === 1) return [segments[0]!]
  const last = segments.length - 1
  const picked: string[] = []
  for (let index = 0; index < limit; index += 1) {
    picked.push(segments[Math.round((index * last) / (limit - 1))]!)
  }
  return picked
}

function emptyFile(): OverviewFile {
  return { version: 1, text: '', chapterSummaries: {}, updatedAt: new Date().toISOString() }
}

/** 归并缓存只保留字符串值；损坏的条目直接丢掉（丢了只是多花一次模型调用）。 */
function sanitizeReduceCache(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === 'string' && text) out[key] = text
  }
  return out
}

async function readOverview(bookId: string): Promise<OverviewFile> {
  try {
    const value: unknown = JSON.parse(await readFile(overviewPath(bookId), 'utf-8'))
    if (value && typeof value === 'object' && (value as OverviewFile).version === 1) {
      const file = value as OverviewFile
      return {
        ...emptyFile(), ...file,
        text: typeof file.text === 'string' ? file.text : '',
        chapterSummaries: file.chapterSummaries && typeof file.chapterSummaries === 'object' ? file.chapterSummaries : {},
        reduceCache: sanitizeReduceCache(file.reduceCache),
      }
    }
  } catch { /* absent or damaged file: start safely */ }
  return emptyFile()
}

async function saveOverview(bookId: string, file: OverviewFile): Promise<void> {
  await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
  file.updatedAt = new Date().toISOString()
  await atomicWriteText(overviewPath(bookId), JSON.stringify(file, null, 2))
}

/** 归并缓存上限：只增不减会随编辑次数膨胀，留最近这些条足够覆盖下一次重新生成。 */
const REDUCE_CACHE_LIMIT = 256

/** 归并缓存键：变体（分组压缩 / 最终归并）+ 书名 + 指令 + 这一组的材料，任一变化才算不同。 */
function reduceKey(variant: 'group' | 'final', title: string, instruction: string, items: string[]): string {
  return hash(`${variant}\n${title}\n${instruction}\n${items.join('\n')}`)
}

function rememberReduce(file: OverviewFile, key: string, text: string): void {
  const cache: Record<string, string> = { ...(file.reduceCache ?? {}), [key]: text }
  const keys = Object.keys(cache)
  if (keys.length > REDUCE_CACHE_LIMIT) {
    for (const stale of keys.slice(0, keys.length - REDUCE_CACHE_LIMIT)) delete cache[stale]
  }
  file.reduceCache = cache
}

/** 生成全书概览需要的书目摘要：列表项与 Book 都能给出这一组字段。 */
interface OverviewTarget {
  id: string
  status: Book['status']
  chapterCount: number
  readyCount: number
}

function targetOfListItem(item: BookListItem): OverviewTarget {
  return { id: item.id, status: item.status, chapterCount: item.chapterCount, readyCount: item.readyCount }
}

function targetOfBook(book: Book): OverviewTarget {
  return {
    id: book.id,
    status: book.status,
    chapterCount: book.chapters.length,
    readyCount: book.chapters.filter((chapter) => chapter.status === 'ready').length,
  }
}

function isComplete(item: OverviewTarget): boolean {
  return item.status === 'ready' && item.chapterCount > 0 && item.readyCount === item.chapterCount
}

export interface OverviewBacklogResult {
  books: number
  generated: number
  failed: number
  skipped: number
  chapters: number
  calls: number
}

/** 抽样：首末章 + 每隔 every 章取一章。长书用它把上千次调用压到百次以内。 */
function sampleChapters(chapters: Book['chapters'], every: number): Book['chapters'] {
  if (every <= 1 || chapters.length <= every * 2) return chapters
  const picked = chapters.filter((_, index) => index % every === 0)
  const last = chapters[chapters.length - 1]
  if (last && picked[picked.length - 1]?.id !== last.id) picked.push(last)
  return picked
}

/** 一章（含片段归并）实测均值，用来把抽样量压在批处理的预算里。 */
const TOKENS_PER_CHAPTER_ESTIMATE = 2_200
/**
 * 概览调用的输出上限。推理型模型（如 deepseek-flash）会把 reasoning 也算进
 * max_tokens：recap 策略的 900 不够它推理 + 写摘要，正文就回空。
 */
const OVERVIEW_MAX_OUTPUT_TOKENS = 4_000

/** 可重试的瞬时故障：服务端返回空/不完整、限流、超时。额度、取消、设置一律不重试。 */
function isTransientAiError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false
  const message = error instanceof Error ? error.message : String(error)
  if (
    message.includes('本月自动 AI 额度') || message.includes('自动生成已关闭') ||
    message.includes('自动生成已停止') || message.includes('书库正在恢复') ||
    message.includes('等待配置 API Key') || message.includes('信任 AI 服务地址') ||
    message.includes('正文为空')
  ) return false
  return ['模型服务未返回有效内容', '模型输出不完整', '超时', '限流', '429', '503', '502', '500']
    .some((marker) => message.includes(marker))
}

function groupItems(items: string[]): string[][] {
  const groups: string[][] = []
  let group: string[] = []
  let size = 0
  for (const item of items) {
    if (group.length && size + item.length > MAX_GROUP_CHARS) {
      groups.push(group)
      group = []
      size = 0
    }
    group.push(item)
    size += item.length
  }
  if (group.length) groups.push(group)
  return groups
}

export class BookOverviewService {
  private timer: ReturnType<typeof setInterval> | null = null
  private scanning = false
  private runningBookId = ''
  private aiJobId = ''
  private stopped = false
  /**
   * 待生成的书：只在「书加入书架」（下载确认 / 导入）时登记，外加启动时接手
   * 已经开过工但没写完的书。绝不遍历整库：默认开启时那会给上千本旧书排队，
   * 主进程会被整库的逐章总结占满。
   */
  private readonly requested = new Set<string>()
  /** 批处理专用：临时放宽的每书月度额度；不改用户设置。 */
  private budgetLimitOverride: number | null = null
  /** 批处理专用：每 N 章取 1 章；null = 逐章。 */
  private chapterSampleEvery: number | null = null
  private batchLog: ((line: string) => void) | null = null
  private batchCalls = 0
  /** 批处理不通知界面：一次几百次写盘会让书库页反复重拉列表。 */
  private quiet = false
  /** 批处理期间常驻扫描让位，避免同一本书被两处同时生成。 */
  private batching = false

  constructor(private readonly queue: AiQueue, private readonly changed: () => void) {}

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.wake(), 15_000)
    void this.adoptInterrupted()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.aiJobId) this.queue.cancel(this.aiJobId)
  }

  wake(): void {
    if (this.stopped || this.scanning) return
    void this.scan()
  }

  private notifyChanged(): void {
    if (!this.quiet) this.changed()
  }

  /** 书加入书架时登记一次生成：这是全书概览唯一的自动触发点。 */
  request(bookId: string): void {
    if (this.stopped) return
    this.requested.add(bookId)
    // 把登记落盘：生成途中退出时，下次启动只续做真正加入过书架的书，不碰存量书库。
    void this.markRequested(bookId)
    this.wake()
  }

  private async markRequested(bookId: string): Promise<void> {
    try {
      await mkdir(join(bookDir(bookId), 'ai'), { recursive: true })
      await atomicWriteText(requestMarkerPath(bookId), JSON.stringify({ requestedAt: new Date().toISOString() }))
    } catch {
      // 标记写不进去只影响「跨重启续做」，本次生成照常进行。
    }
  }

  private async clearRequested(bookId: string): Promise<void> {
    await rm(requestMarkerPath(bookId), { force: true }).catch(() => {})
  }

  /**
   * 启动时接手「加入过书架、但还没写完」的书：它们带着登记标记。
   * 没有标记的存量书一本也不动——默认开启不等于把整库排进生成队列。
   */
  private async adoptInterrupted(): Promise<void> {
    try {
      for (const item of await listBooks()) {
        try { await access(requestMarkerPath(item.id)) }
        catch { continue }
        // 有登记标记但已经写完的（标记没来得及清）直接回收。
        if ((await readOverview(item.id)).text) {
          await this.clearRequested(item.id)
          continue
        }
        this.requested.add(item.id)
      }
    } catch (error) {
      console.warn('全书概览续做扫描失败：', error)
    }
    this.wake()
  }

  settingsChanged(enabled: boolean): void {
    if (!enabled && this.aiJobId) this.queue.cancel(this.aiJobId)
    this.wake()
  }

  async retry(bookId: string): Promise<void> {
    const book = await getBook(bookId)
    // 正在为这本书生成时不要动文件：generate 手里握着一份启动时的 file 快照，
    // 这里的读改写会被它随后的 saveOverview 用旧快照覆盖，反而把失败标记和缓存弄乱。
    if (this.runningBookId === bookId) {
      this.wake()
      return
    }
    const file = await readOverview(book.id)
    delete file.error
    await saveOverview(book.id, file)
    // 手动重试也是显式请求：从未登记过的书可以借此单独生成，不必默认扫全库。
    this.requested.add(book.id)
    void this.markRequested(book.id)
    this.notifyChanged()
    this.wake()
  }

  async decorate(items: BookListItem[], settings: Settings): Promise<BookListItem[]> {
    return Promise.all(items.map(async (item) => ({
      ...item,
      overview: await this.viewFor(targetOfListItem(item), settings),
    })))
  }

  private async viewFor(item: OverviewTarget, settings: Settings): Promise<BookOverviewView> {
    const file = await readOverview(item.id)
    // 只生成一次：磁盘上有正文就是最终结果，章节后来改了也不重跑模型。
    if (file.text) return { status: 'ready', text: file.text }
    if (this.runningBookId === item.id) return { status: 'running', message: '正在生成全书概览…' }
    if (file.error) return { status: 'failed', message: file.error }
    // 没登记生成的书（旧库里的存量书）不显示等待文案，也不排队；失败过的仍可手动重试。
    if (!this.requested.has(item.id)) return { status: 'off' }
    if (!isComplete(item)) return {
      status: 'waiting',
      message: item.status === 'downloading' ? '下载完成后生成' : '章节未全部就绪，暂不能生成全书概览',
    }
    if (!settings.ai?.autoBookOverview) return { status: 'off', message: '自动概览未开启' }
    if ((await monthlyBudgetStatus(item.id, settings.ai.autoMonthlyTokenLimit)).remainingTokens < 1_000) {
      return { status: 'waiting', message: '本书本月自动 AI 额度已到上限' }
    }
    if (!settings.apiKeyConfigured) return { status: 'waiting', message: '等待配置 API Key' }
    try { assertTrustedAiEndpoint(settings.baseUrl, settings.ai ?? DEFAULT_AI_PREFS) }
    catch { return { status: 'waiting', message: '等待信任 AI 服务地址' } }
    return { status: 'pending', message: '等待生成全书概览' }
  }

  private async scan(): Promise<void> {
    this.scanning = true
    try {
      if (this.batching) return
      if (isLibraryRestoring() || this.runningBookId) return
      if (!this.requested.size) return
      const settings = await getSettings()
      if (!settings.ai?.autoBookOverview || !settings.apiKeyConfigured) {
        if (this.aiJobId) this.queue.cancel(this.aiJobId)
        return
      }
      try { assertTrustedAiEndpoint(settings.baseUrl, settings.ai) }
      catch { return }
      for (const bookId of [...this.requested]) {
        let target: OverviewTarget
        // 只读这本书的 book.json：为此重建整库索引在有上千本书时本身就是负担。
        try { target = targetOfBook(await getBook(bookId)) }
        catch { this.requested.delete(bookId); continue }
        const view = await this.viewFor(target, settings)
        // 生成完了或失败待重试：都该出队，后台不再自己反复重花额度。
        if (view.status === 'ready' || view.status === 'failed') {
          this.requested.delete(bookId)
          continue
        }
        if (view.status !== 'pending') continue
        this.runningBookId = bookId
        this.notifyChanged()
        try { await this.generate(bookId) }
        finally { this.runningBookId = ''; this.notifyChanged() }
        if ((await readOverview(bookId)).text) this.requested.delete(bookId)
        // 一轮只跑一本：整本总结要占很久，别把排队中的书排进同一拍。
        return
      }
    } catch (error) {
      console.warn('全书概览扫描失败：', error)
    } finally {
      this.scanning = false
    }
  }

  private async complete(bookId: string, prompt: string, maxTokens = OVERVIEW_MAX_OUTPUT_TOKENS): Promise<string> {
    while (!this.stopped) {
      const settings = await getSettings()
      if (!settings.ai?.autoBookOverview) throw new Error('自动生成已关闭')
      if (isLibraryRestoring()) throw new Error('书库正在恢复')
      const apiKey = await getApiKey()
      if (!apiKey) throw new Error('等待配置 API Key')
      assertTrustedAiEndpoint(settings.baseUrl, settings.ai)
      const config: AiConfig = {
        baseUrl: settings.baseUrl, model: settings.ai.overviewModel || settings.model, apiKey,
        provider: resolveEffectiveAiProvider(settings.baseUrl, settings.ai.provider),
        // 跟随用户的思考开关：硬关思考时，带推理的服务会把输出预算耗在推理上，
        // 正文返回空（表现为「模型服务未返回有效内容」），概览永远生不成。
        thinkingEnabled: false,
      }
      // 全书概览是自动任务：只能在后台车道取活，交互车道必须完全空闲。
      const result = await this.queue.runExclusive(async (signal, jobId) => {
        this.aiJobId = jobId
        let reservation: Awaited<ReturnType<typeof reserveAutomaticTokens>> | null = null
        let settled = false
        try {
          reservation = await reserveAutomaticTokens(bookId, estimateAiTokens(prompt) + maxTokens, this.budgetLimitOverride ?? settings.ai!.autoMonthlyTokenLimit)
          const response = await runAiTaskCompletion(config, [{ role: 'user', content: prompt }], { task: 'recap', recapLength: 'standard', signal, maxTokens })
          await reservation.settle(response.usage)
          settled = true
          await recordAiUsage(bookId, response.usage).catch(() => {})
          if (response.truncated || !response.text.trim()) throw new Error('模型输出不完整')
          return response.text.trim()
        } catch (error) {
          // runAiTaskCompletion 会把中止包装成「AI 请求超时」；这里按 signal 还原成 AbortError，
          // 否则用户点「停止」会被当成真实失败写进 failed 标记、锁死界面。
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          throw error
        } finally {
          if (reservation && !settled) await reservation.settle().catch(() => {})
          this.aiJobId = ''
        }
      }, { lane: 'background', cls: 'overview', bookId })
      if (result.ok) return result.value
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error('自动生成已停止')
  }

  /**
   * 模型调用带重试：服务端偶尔返回空响应（「模型服务未返回有效内容」），
   * 一次失败就让整本书记失败太浪费——瞬时故障退避后重试，额度/取消类错误照旧直接上抛。
   */
  private async completeWithRetry(bookId: string, prompt: string): Promise<string> {
    // 推理型模型把 reasoning 也算进 max_tokens：同一提示有时 900 就够，有时推理跑满
    // 预算、正文回空。先逐级抬高输出预算，再退避重试，最后才判失败。
    const budgets = [OVERVIEW_MAX_OUTPUT_TOKENS, 8_000, 12_000]
    const delays = [2_000, 8_000]
    for (let attempt = 0; ; attempt += 1) {
      const budget = budgets[Math.min(attempt, budgets.length - 1)]!
      try {
        const text = await this.complete(bookId, prompt, budget)
        if (this.batchLog) this.batchCalls += 1
        return text
      } catch (error) {
        if (this.stopped || !isTransientAiError(error)) throw error
        if (attempt >= budgets.length) throw error
        const wait = delays[Math.min(attempt, delays.length - 1)]!
        const next = budgets[Math.min(attempt + 1, budgets.length - 1)]!
        this.batchLog?.(`    重试 ${attempt + 1}/${budgets.length}：${error instanceof Error ? error.message : String(error)}（输出预算 ${budget}→${next}，${Math.round(wait / 1000)}s）`)
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
  }

  /** 存量待补书：完整入库、还没有概览正文、但已经开过工（有章节摘要）。 */
  private async backlogBooks(): Promise<string[]> {
    const out: string[] = []
    for (const item of await listBooks()) {
      if (!isComplete(targetOfListItem(item))) continue
      const file = await readOverview(item.id)
      if (file.text || !Object.keys(file.chapterSummaries).length) continue
      out.push(item.id)
    }
    return out
  }

  /**
   * 一次性补做存量书的概览：抽样章节（首末 + 每 N 章取一章）而不是逐章全跑。
   * 批处理专用：临时放宽每书额度、不通知界面，结束后把实例恢复成常驻状态。
   */
  async runBacklog(options: { sampleEvery: number; budgetTokens: number; log?: (line: string) => void }): Promise<OverviewBacklogResult> {
    const log = options.log ?? (() => {})
    const budgetTokens = Math.max(1, Math.floor(options.budgetTokens))
    this.budgetLimitOverride = budgetTokens
    this.chapterSampleEvery = Math.max(1, Math.floor(options.sampleEvery))
    this.batchLog = log
    this.batchCalls = 0
    this.quiet = true
    this.batching = true
    const result: OverviewBacklogResult = { books: 0, generated: 0, failed: 0, skipped: 0, chapters: 0, calls: 0 }
    try {
      const settings = await getSettings()
      if (!settings.ai?.autoBookOverview) throw new Error('自动全书概览在设置里是关闭的，批处理需要它开启')
      const targets = await this.backlogBooks()
      result.books = targets.length
      log(`待补书 ${targets.length} 本；每书额度 ${budgetTokens} token，抽样 1/${this.chapterSampleEvery} 起步（按预算自动降精度）`)
      for (const [index, bookId] of targets.entries()) {
        let book: Book
        try { book = await getBook(bookId) } catch { result.skipped += 1; continue }
        const label = `[${index + 1}/${targets.length}] 《${book.title}》`
        const remaining = (await monthlyBudgetStatus(bookId, budgetTokens)).remainingTokens
        if (remaining < 5_000) {
          result.skipped += 1
          log(`${label} 跳过：额度只剩 ${remaining}`)
          continue
        }
        // 按预算反推能抽多少章：一章连同片段归并约 2200 token，留 15% 给最终归并。
        const sampleCap = Math.max(1, Math.floor((remaining * 0.85) / TOKENS_PER_CHAPTER_ESTIMATE))
        const effectiveEvery = Math.max(this.chapterSampleEvery, Math.ceil(book.chapters.length / sampleCap))
        this.chapterSampleEvery = effectiveEvery
        const before = this.batchCalls
        this.runningBookId = bookId
        log(`${label} ${book.chapters.length} 章，抽样 1/${effectiveEvery}，额度 ${remaining}，开始`)
        try { await this.generate(bookId) } catch (error) {
          log(`  生成异常：${error instanceof Error ? error.message : String(error)}`)
        } finally { this.runningBookId = '' }
        const file = await readOverview(bookId)
        const calls = this.batchCalls - before
        if (file.text) {
          result.generated += 1
          result.chapters += Object.keys(file.chapterSummaries).length
          log(`${label} 完成：概览 ${file.text.length} 字，${calls} 次调用`)
        } else {
          result.failed += 1
          log(`${label} 失败：${file.error ?? '未知原因'}（${calls} 次调用）`)
        }
        this.chapterSampleEvery = Math.max(1, Math.floor(options.sampleEvery))
      }
    } finally {
      result.calls = this.batchCalls
      this.budgetLimitOverride = null
      this.chapterSampleEvery = null
      this.batchLog = null
      this.quiet = false
      this.batching = false
    }
    return result
  }

  private async generate(bookId: string): Promise<void> {
    const file = await readOverview(bookId)
    // 只生成一次：无论谁唤醒（启动、新书入架、设置变更），有正文就直接返回。
    if (file.text) return
    try {
      const book = await getBook(bookId)
      const summaries: string[] = []
      const ordered = [...book.chapters].sort((a, b) => a.index - b.index)
      const sampled = this.chapterSampleEvery !== null && this.chapterSampleEvery > 1
      const chapters = sampled ? sampleChapters(ordered, this.chapterSampleEvery!) : ordered
      for (const chapter of chapters) {
        if (this.stopped) throw new Error('自动生成已停止')
        const body = (await readChapter(bookId, chapter.id)).body.trim()
        if (!body) {
          // 抽样批次里个别章节空正文不该拖垮整本：跳过，其余抽样章照常。
          if (sampled) continue
          throw new Error(`《${chapter.title}》正文为空`)
        }
        const bodyHash = hash(body)
        let summary = file.chapterSummaries[chapter.id]?.hash === bodyHash ? file.chapterSummaries[chapter.id]!.text : ''
        if (!summary) {
          const allSegments = chunks(body, MAX_SOURCE_CHARS)
          const segments = sampleSegments(allSegments, MAX_CHAPTER_SEGMENTS)
          // 抽过片段就得在提示词里说明白：别让模型以为拿到了整章，把略去的部分当不存在。
          const excerptNote = segments.length < allSegments.length ? '（以下是本章按比例抽取的片段，已略去部分内容）\n' : ''
          const parts: string[] = []
          try {
            for (const segment of segments) {
              parts.push(await this.completeWithRetry(bookId, `只根据以下《${book.title}》章节片段，提炼发生的事件、人物变化和伏笔。不要编造，约 150–250 字，只返回纯文本。\n${excerptNote}章节：${chapter.title}\n片段：\n${segment}`))
            }
          } catch (error) {
            // 抽样批次里单章持续失败就跳过：服务端对这些长调用很不稳定，
            // 一章的抖动不该让上百章的工作全部作废。
            if (!sampled) throw error
            this.batchLog?.(`    跳过《${chapter.title}》：${error instanceof Error ? error.message : String(error)}`)
            continue
          }
          summary = parts.length === 1 ? parts[0]! : await this.reduce(bookId, book.title, parts, '把同一章的片段摘要合成一份按情节顺序的章节摘要。', file)
          file.chapterSummaries[chapter.id] = { hash: bodyHash, text: summary }
          await saveOverview(bookId, file)
          this.notifyChanged()
        }
        summaries.push(`第 ${chapter.index} 章《${chapter.title}》：${summary}`)
      }
      if (sampled && !summaries.length) throw new Error('抽到的章节全部失败，没有可用的章节摘要')
      const instruction = sampled
        ? '以下是从全书中按比例抽取的部分章节摘要（并非全部章节）。据此写全书概览：主要人物、故事主线、关键转折与大致走向。可以剧透，但不能编造，也不要声称覆盖了全部章节。控制在 300–500 字，只返回纯文本。'
        : '综合全书各章剧情，介绍主要人物、故事主线、关键转折与结局。可以剧透，但不能编造。控制在 300–500 字，只返回纯文本。'
      const overview = await this.reduce(bookId, book.title, summaries, instruction, file)
      file.text = overview
      delete file.error
      // 生成完成：登记标记的使命结束，下次启动不必再接手。
      await this.clearRequested(bookId)
      await saveOverview(bookId, file)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 取消/停止不是失败：不能写成 failed 锁死，否则用户点「停止」会看到「AI 请求超时」。
      const cancelled = error instanceof Error && error.name === 'AbortError'
      if (
        cancelled ||
        message === '自动生成已关闭' || message === '自动生成已停止' || message === '书库正在恢复' ||
        message.includes('本月自动 AI 额度') ||
        !(await getSettings()).ai?.autoBookOverview
      ) return
      file.error = message
      // 失败不再跨重启自动重试：用户可在书库卡片上点「重试概览」。
      await this.clearRequested(bookId)
      await saveOverview(bookId, file).catch(() => {})
    }
  }

  private async reduce(
    bookId: string,
    title: string,
    items: string[],
    instruction: string,
    file: OverviewFile,
  ): Promise<string> {
    let current = items
    for (;;) {
      const groups = groupItems(current)
      if (groups.length === 1) {
        const key = reduceKey('final', title, instruction, groups[0]!)
        const cached = file.reduceCache?.[key]
        if (cached) return cached
        const text = await this.completeWithRetry(bookId, `书名：《${title}》。${instruction}\n材料：\n${groups[0]!.join('\n')}`)
        rememberReduce(file, key, text)
        await saveOverview(bookId, file)
        return text
      }
      const next: string[] = []
      let added = false
      for (const group of groups) {
        const key = reduceKey('group', title, instruction, group)
        const cached = file.reduceCache?.[key]
        if (cached) {
          next.push(cached)
          continue
        }
        const text = await this.completeWithRetry(bookId, `书名：《${title}》。按顺序压缩以下连续章节摘要，保留主线、重要转折、结局线索，不得编造。约 300–500 字，纯文本。\n${group.join('\n')}`)
        rememberReduce(file, key, text)
        added = true
        next.push(text)
      }
      // 一边算一边落盘：中途被打断时下次能接着复用，不必从头再来
      if (added) await saveOverview(bookId, file)
      current = next
    }
  }
}
