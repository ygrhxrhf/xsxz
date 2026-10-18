import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_PREFS, DEFAULT_APPEARANCE_PREFS, DEFAULT_READER_PREFS, DEFAULT_TTS_PREFS, type Settings } from '../shared/types'

const mocks = vi.hoisted(() => ({ complete: vi.fn(), settings: null as Settings | null }))

vi.mock('./settings', () => ({
  getSettings: async () => mocks.settings,
  getApiKey: async () => 'test-key',
  assertTrustedAiEndpoint: () => {},
  resolveEffectiveAiProvider: () => 'deepseek',
}))
vi.mock('./ai', async (original) => {
  const actual = await original<typeof import('./ai')>()
  return { ...actual, runAiTaskCompletion: mocks.complete }
})

import { AiQueue } from './aiScheduler'
import { BookOverviewService } from './bookOverview'
import { createBookFromBootstrap, listBooks, markChapterStatus, readAiUsage, setLibraryPath, updateChapterBody, writeChapterFile, refreshBookStatus } from './library'

let directory = ''
let service: BookOverviewService

async function view() {
  const [item] = await service.decorate(await listBooks(), mocks.settings!)
  return item!.overview!
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spbf-overview-'))
  await setLibraryPath(directory)
  mocks.settings = {
    libraryPath: directory, baseUrl: 'https://api.deepseek.com/v1', model: 'test', apiKeyConfigured: true,
    tierSenseKeyConfigured: false,
    reader: DEFAULT_READER_PREFS, tts: DEFAULT_TTS_PREFS, appearance: DEFAULT_APPEARANCE_PREFS,
    ai: { ...DEFAULT_AI_PREFS, autoBookOverview: true }, downloadPace: 'standard',
  }
  mocks.complete.mockReset().mockImplementation(async (...args: unknown[]) => {
    // 输出跟着输入走：真模型就是这样，而这正是归并缓存能不能命中的前提——
    // 固定返回同一段文字的话，「正文改了但摘要文本没变」会让缓存正确命中，计数就没法验了。
    // 注意 prompt 藏在 messages 数组里，要哈希整个入参才能拿到它。
    const tag = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 8)
    return { text: `主角寻宝，最终归来。【${tag}】`, truncated: false, usage: { inputTokens: 9, outputTokens: 5 } }
  })
  service = new BookOverviewService(new AiQueue(), () => {})
})

afterEach(async () => {
  service.stop()
  await rm(directory, { recursive: true, force: true })
})

async function seed(): Promise<string> {
  const book = await createBookFromBootstrap({
    bookId: 'i_overview', title: '测试书', author: '', importType: 'txt', chapterTitles: ['第一章', '第二章'],
  })
  for (const chapter of book.chapters) {
    await writeChapterFile(book.id, chapter.id, { title: chapter.title, body: `${chapter.title}，主角出发。`, status: 'ready' })
    await markChapterStatus(book.id, chapter.id, 'ready')
  }
  await refreshBookStatus(book.id)
  return book.id
}

/** 多章夹具：用来把归并阶段逼出多个分组。 */
async function seedMany(count: number): Promise<string> {
  const book = await createBookFromBootstrap({
    bookId: 'i_overview_many', title: '长书', author: '', importType: 'txt',
    chapterTitles: Array.from({ length: count }, (_, index) => `第${index + 1}章`),
  })
  for (const chapter of book.chapters) {
    await writeChapterFile(book.id, chapter.id, { title: chapter.title, body: `${chapter.title}，主角出发。`, status: 'ready' })
    await markChapterStatus(book.id, chapter.id, 'ready')
  }
  await refreshBookStatus(book.id)
  return book.id
}

describe('automatic full-book overview', () => {
  it('summarizes every chapter, persists the result, and avoids duplicate calls after restart', async () => {
    const bookId = await seed()
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 10_000 })
    expect(mocks.complete).toHaveBeenCalledTimes(3)
    const file = JSON.parse(await readFile(join(directory, bookId, 'ai', 'bookOverview.json'), 'utf-8'))
    expect(Object.keys(file.chapterSummaries)).toEqual(['c0001', 'c0002'])
    expect((await readAiUsage(bookId)).calls).toBe(3)
    service.stop()
    service = new BookOverviewService(new AiQueue(), () => {})
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.complete).toHaveBeenCalledTimes(3)
  })

  it('keeps the old overview visible and regenerates only changed chapter summaries', async () => {
    const bookId = await seed()
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 10_000 })
    service.stop()
    await updateChapterBody(bookId, 'c0002', '第二章，主角改变了目标。')
    expect((await view()).status).toBe('stale')
    expect((await view()).text).toContain('主角寻宝')
    service = new BookOverviewService(new AiQueue(), () => {})
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 10_000 })
    expect(mocks.complete).toHaveBeenCalledTimes(5)
  })

  it('改一章只重算那一章与它所在的归并组，不重跑整棵归并树', async () => {
    // 让每章摘要长到归并阶段必须分组（一组 8000 字），才谈得上「不重跑整棵树」。
    // 章数压到刚好分两组：这文件里每条用例都要真的写盘，夹具太大在并发下会拖累同文件的兄弟用例。
    const longSummary = '主角在破庙里醒来，发现身边的信物不见了，于是沿官道向北，遇上一个卖炭的老人。'.repeat(30)
    mocks.complete.mockReset().mockImplementation(async (...args: unknown[]) => {
      const tag = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 8)
      return { text: `${longSummary}【${tag}】`, truncated: false, usage: { inputTokens: 9, outputTokens: 5 } }
    })
    const bookId = await seedMany(8)

    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 10_000 })
    const firstRun = mocks.complete.mock.calls.length
    expect(firstRun, '首轮应当跑完 8 章摘要 + 多组归并 + 最终归并').toBeGreaterThan(9)

    await updateChapterBody(bookId, 'c0001', '第一章，主角改了目标。')
    // 用触发式重扫（不用 stop + 新建实例）：只为验证归并缓存，别再掺进启停时序
    service.settingsChanged(true)
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 10_000 })

    // 只有「那一章摘要 + 它所在的分组 + 最终归并」该花钱，与分了几个组无关；
    // 没有归并缓存时至少还要把其余分组重跑一遍（≥4 次）。
    expect(mocks.complete.mock.calls.length - firstRun).toBe(3)
  })

  it('does not call the model until the user enables automatic generation', async () => {
    await seed()
    mocks.settings!.ai = { ...DEFAULT_AI_PREFS, autoBookOverview: false }
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.complete).not.toHaveBeenCalled()
    expect((await view()).status).toBe('off')
    mocks.settings!.ai = { ...DEFAULT_AI_PREFS, autoBookOverview: true }
    service.settingsChanged(true)
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 10_000 })
  })

  it('waits for all chapters to be ready', async () => {
    await createBookFromBootstrap({ bookId: 'i_partial', title: '未完成', author: '', importType: 'txt', chapterTitles: ['第一章'] })
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await view()).status).toBe('waiting')
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('waits for an API Key without sending book content', async () => {
    await seed()
    mocks.settings!.apiKeyConfigured = false
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await view()).message).toBe('等待配置 API Key')
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('preserves a failure and resumes after an explicit retry', async () => {
    const bookId = await seed()
    mocks.complete.mockRejectedValueOnce(new Error('服务暂不可用'))
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('failed') }, { timeout: 10_000 })
    expect((await view()).message).toContain('服务暂不可用')
    await service.retry(bookId)
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 10_000 })
  })

  it('取消不写成失败：停止时不能被谎报为「AI 请求超时」并锁死', async () => {
    await seed()
    // 模型调用挂住，等我们取消
    let release!: () => void
    mocks.complete.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ text: 'x', truncated: false, usage: {} }) }))
    service.start()
    // 等模型真的被调用（running 状态早于 complete 被调用，直接等 release 就绪更稳）
    await vi.waitFor(() => { expect(typeof release).toBe('function') }, { timeout: 10_000 })
    service.stop()
    release()
    // 取消后不该留下 failed 标记
    await new Promise((r) => setTimeout(r, 200))
    expect((await view()).status).not.toBe('failed')
  })
})
