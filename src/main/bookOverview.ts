import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Book, BookListItem, BookOverviewView, Settings } from '../shared/types'
import { DEFAULT_AI_PREFS } from '../shared/types'
import { runAiTaskCompletion, type AiConfig } from './ai'
import type { AiQueue } from './aiScheduler'
import { atomicWriteText, bookDir, getBook, listBooks, readChapter, recordAiUsage } from './library'
import { getApiKey, getSettings, assertTrustedAiEndpoint, resolveEffectiveAiProvider } from './settings'
import { isLibraryRestoring } from './libraryMaintenance'

interface OverviewFile {
  version: 1
  text: string
  source: Record<string, string>
  chapterSummaries: Record<string, { hash: string; text: string }>
  error?: string
  failedSignature?: string
  updatedAt: string
}

const MAX_SOURCE_CHARS = 7_000
const MAX_GROUP_CHARS = 8_000
const OVERVIEW_FILE = 'bookOverview.json'

function overviewPath(bookId: string): string {
  return join(bookDir(bookId), 'ai', OVERVIEW_FILE)
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

function emptyFile(): OverviewFile {
  return { version: 1, text: '', source: {}, chapterSummaries: {}, updatedAt: new Date().toISOString() }
}

async function readOverview(bookId: string): Promise<OverviewFile> {
  try {
    const value: unknown = JSON.parse(await readFile(overviewPath(bookId), 'utf-8'))
    if (value && typeof value === 'object' && (value as OverviewFile).version === 1) {
      const file = value as OverviewFile
      return {
        ...emptyFile(), ...file,
        text: typeof file.text === 'string' ? file.text : '',
        source: file.source && typeof file.source === 'object' ? file.source : {},
        chapterSummaries: file.chapterSummaries && typeof file.chapterSummaries === 'object' ? file.chapterSummaries : {},
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

async function sourceSignature(book: Book): Promise<Record<string, string>> {
  const source: Record<string, string> = {}
  for (const chapter of book.chapters) {
    const info = await stat(join(bookDir(book.id), chapter.file))
    source[chapter.id] = `${info.size}:${info.mtimeMs}`
  }
  return source
}

function signatureKey(source: Record<string, string>): string {
  return hash(JSON.stringify(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))))
}

function isComplete(item: BookListItem): boolean {
  return item.status === 'ready' && item.chapterCount > 0 && item.readyCount === item.chapterCount
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

  constructor(private readonly queue: AiQueue, private readonly changed: () => void) {}

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.wake(), 15_000)
    this.wake()
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

  settingsChanged(enabled: boolean): void {
    if (!enabled && this.aiJobId) this.queue.cancel(this.aiJobId)
    this.wake()
  }

  async retry(bookId: string): Promise<void> {
    const book = await getBook(bookId)
    const file = await readOverview(book.id)
    delete file.error
    delete file.failedSignature
    await saveOverview(book.id, file)
    this.changed()
    this.wake()
  }

  async decorate(items: BookListItem[], settings: Settings): Promise<BookListItem[]> {
    return Promise.all(items.map(async (item) => ({ ...item, overview: await this.viewFor(item, settings) })))
  }

  private async viewFor(item: BookListItem, settings: Settings): Promise<BookOverviewView> {
    const file = await readOverview(item.id)
    if (this.runningBookId === item.id) return { status: 'running', text: file.text || undefined, message: '正在生成全书概览…' }
    if (!isComplete(item)) return {
      status: 'waiting', text: file.text || undefined,
      message: item.status === 'downloading' ? '下载完成后生成' : '章节未全部就绪，暂不能生成全书概览',
    }
    let current: Record<string, string>
    try { current = await sourceSignature(await getBook(item.id)) }
    catch { return { status: 'waiting', text: file.text || undefined, message: '章节文件暂不可用' } }
    const fresh = file.text && signatureKey(file.source) === signatureKey(current)
    if (fresh) return { status: 'ready', text: file.text }
    if (file.error && file.failedSignature === signatureKey(current)) {
      return { status: 'failed', text: file.text || undefined, message: file.error }
    }
    if (!settings.ai?.autoBookOverview) return { status: file.text ? 'stale' : 'off', text: file.text || undefined, message: file.text ? '章节已变化；开启自动生成后更新' : '自动概览未开启' }
    if (!settings.apiKeyConfigured) return { status: 'waiting', text: file.text || undefined, message: '等待配置 API Key' }
    try { assertTrustedAiEndpoint(settings.baseUrl, settings.ai ?? DEFAULT_AI_PREFS) }
    catch { return { status: 'waiting', text: file.text || undefined, message: '等待信任 AI 服务地址' } }
    return { status: file.text ? 'stale' : 'pending', text: file.text || undefined, message: file.text ? '全书概览待更新' : '等待生成全书概览' }
  }

  private async scan(): Promise<void> {
    this.scanning = true
    try {
      if (isLibraryRestoring()) return
      const settings = await getSettings()
      if (!settings.ai?.autoBookOverview || !settings.apiKeyConfigured) {
        if (this.aiJobId) this.queue.cancel(this.aiJobId)
        return
      }
      try { assertTrustedAiEndpoint(settings.baseUrl, settings.ai) }
      catch { return }
      if (this.runningBookId) return
      const books = await listBooks()
      for (const item of books) {
        if (!isComplete(item)) continue
        const view = await this.viewFor(item, settings)
        if (view.status !== 'pending' && view.status !== 'stale') continue
        this.runningBookId = item.id
        this.changed()
        try { await this.generate(item.id) }
        finally { this.runningBookId = ''; this.changed() }
        break
      }
    } catch (error) {
      console.warn('全书概览扫描失败：', error)
    } finally {
      this.scanning = false
    }
  }

  private async complete(bookId: string, prompt: string): Promise<string> {
    while (!this.stopped) {
      const settings = await getSettings()
      if (!settings.ai?.autoBookOverview) throw new Error('自动生成已关闭')
      if (isLibraryRestoring()) throw new Error('书库正在恢复')
      const apiKey = await getApiKey()
      if (!apiKey) throw new Error('等待配置 API Key')
      assertTrustedAiEndpoint(settings.baseUrl, settings.ai)
      const config: AiConfig = {
        baseUrl: settings.baseUrl, model: settings.model, apiKey,
        provider: resolveEffectiveAiProvider(settings.baseUrl, settings.ai.provider),
        thinkingEnabled: false,
      }
      // 全书概览是自动任务：只能在后台车道取活，交互车道必须完全空闲。
      const result = await this.queue.runExclusive(async (signal, jobId) => {
        this.aiJobId = jobId
        try {
          const response = await runAiTaskCompletion(config, [{ role: 'user', content: prompt }], { task: 'recap', recapLength: 'standard', signal })
          await recordAiUsage(bookId, response.usage).catch(() => {})
          if (response.truncated || !response.text.trim()) throw new Error('模型输出不完整')
          return response.text.trim()
        } finally { this.aiJobId = '' }
      }, { lane: 'background', cls: 'overview', bookId })
      if (result.ok) return result.value
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error('自动生成已停止')
  }

  private async generate(bookId: string): Promise<void> {
    const file = await readOverview(bookId)
    let source: Record<string, string> | undefined
    try {
      const book = await getBook(bookId)
      source = await sourceSignature(book)
      const summaries: string[] = []
      for (const chapter of [...book.chapters].sort((a, b) => a.index - b.index)) {
        if (this.stopped) throw new Error('自动生成已停止')
        const body = (await readChapter(bookId, chapter.id)).body.trim()
        if (!body) throw new Error(`《${chapter.title}》正文为空`)
        const bodyHash = hash(body)
        let summary = file.chapterSummaries[chapter.id]?.hash === bodyHash ? file.chapterSummaries[chapter.id]!.text : ''
        if (!summary) {
          const parts: string[] = []
          for (const segment of chunks(body, MAX_SOURCE_CHARS)) {
            parts.push(await this.complete(bookId, `只根据以下《${book.title}》章节片段，提炼发生的事件、人物变化和伏笔。不要编造，约 150–250 字，只返回纯文本。\n章节：${chapter.title}\n片段：\n${segment}`))
          }
          summary = parts.length === 1 ? parts[0]! : await this.reduce(bookId, book.title, parts, '把同一章的片段摘要合成一份按情节顺序的章节摘要。')
          file.chapterSummaries[chapter.id] = { hash: bodyHash, text: summary }
          await saveOverview(bookId, file)
          this.changed()
        }
        summaries.push(`第 ${chapter.index} 章《${chapter.title}》：${summary}`)
      }
      const overview = await this.reduce(bookId, book.title, summaries, '综合全书各章剧情，介绍主要人物、故事主线、关键转折与结局。可以剧透，但不能编造。控制在 300–500 字，只返回纯文本。')
      const latest = await sourceSignature(await getBook(bookId))
      if (signatureKey(latest) !== signatureKey(source)) throw new Error('章节已变化，等待重新生成')
      file.text = overview
      file.source = source
      delete file.error
      delete file.failedSignature
      await saveOverview(bookId, file)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === '自动生成已关闭' || message === '自动生成已停止' || message === '书库正在恢复' || message === '章节已变化，等待重新生成' || !(await getSettings()).ai?.autoBookOverview) return
      file.error = message
      if (source) file.failedSignature = signatureKey(source)
      await saveOverview(bookId, file).catch(() => {})
    }
  }

  private async reduce(bookId: string, title: string, items: string[], instruction: string): Promise<string> {
    let current = items
    while (true) {
      const groups = groupItems(current)
      if (groups.length === 1) {
        return this.complete(bookId, `书名：《${title}》。${instruction}\n材料：\n${groups[0]!.join('\n')}`)
      }
      const next: string[] = []
      for (const group of groups) {
        next.push(await this.complete(bookId, `书名：《${title}》。按顺序压缩以下连续章节摘要，保留主线、重要转折、结局线索，不得编造。约 300–500 字，纯文本。\n${group.join('\n')}`))
      }
      current = next
    }
  }
}
