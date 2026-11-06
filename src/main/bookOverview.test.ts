import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
import { removeTempDir } from './testSupport/tempDir'

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
  await removeTempDir(directory)
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
    service.request(bookId)
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

  it('keeps the saved overview forever: chapter changes never spend another model call', async () => {
    const bookId = await seed()
    service.request(bookId)
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 10_000 })
    const saved = (await view()).text
    service.stop()
    await updateChapterBody(bookId, 'c0002', '第二章，主角改变了目标。')
    // 概览只生成一次：正文改了也照旧从磁盘读那次结果，不变成待更新。
    expect((await view()).status).toBe('ready')
    expect((await view()).text).toBe(saved)
    service = new BookOverviewService(new AiQueue(), () => {})
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(mocks.complete).toHaveBeenCalledTimes(3)
  })

  it('长篇首轮按组归并；正文后来改了也不再花模型调用', async () => {
    // 让每章摘要长到归并阶段必须分组（一组 8000 字）。
    // 章数压到刚好分两组：这文件里每条用例都要真的写盘，夹具太大在并发下会拖累同文件的兄弟用例。
    const longSummary = '主角在破庙里醒来，发现身边的信物不见了，于是沿官道向北，遇上一个卖炭的老人。'.repeat(30)
    mocks.complete.mockReset().mockImplementation(async (...args: unknown[]) => {
      const tag = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 8)
      return { text: `${longSummary}【${tag}】`, truncated: false, usage: { inputTokens: 9, outputTokens: 5 } }
    })
    const bookId = await seedMany(8)

    service.request(bookId)
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 10_000 })
    const firstRun = mocks.complete.mock.calls.length
    expect(firstRun, '首轮应当跑完 8 章摘要 + 多组归并 + 最终归并').toBeGreaterThan(9)
    const saved = (await view()).text

    await updateChapterBody(bookId, 'c0001', '第一章，主角改了目标。')
    // 用触发式重扫（不用 stop + 新建实例）：只为验证「不再生成」，别再掺进启停时序
    service.settingsChanged(true)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(mocks.complete.mock.calls.length).toBe(firstRun)
    expect((await view()).status).toBe('ready')
    expect((await view()).text).toBe(saved)
  })

  it('默认开启也不会给没登记过的存量书排队生成', async () => {
    const bookId = await seed()
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(mocks.complete).not.toHaveBeenCalled()
    expect((await view()).status).toBe('off')
    // 加入书架（或手动重试）登记后才开始生成。
    service.request(bookId)
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 10_000 })
  })

  it('自动生成关闭时登记了也不发模型请求', async () => {
    const bookId = await seed()
    mocks.settings!.ai = { ...DEFAULT_AI_PREFS, autoBookOverview: false }
    service.request(bookId)
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(mocks.complete).not.toHaveBeenCalled()
    expect((await view()).status).toBe('off')
  })

  it('waits for all chapters to be ready', async () => {
    const book = await createBookFromBootstrap({ bookId: 'i_partial', title: '未完成', author: '', importType: 'txt', chapterTitles: ['第一章'] })
    service.request(book.id)
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await view()).status).toBe('waiting')
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('waits for an API Key without sending book content', async () => {
    const bookId = await seed()
    mocks.settings!.apiKeyConfigured = false
    service.request(bookId)
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await view()).message).toBe('等待配置 API Key')
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('preserves a failure and resumes after an explicit retry without redoing finished chapters', async () => {
    const bookId = await seed()
    const real = mocks.complete.getMockImplementation()!
    mocks.complete
      .mockImplementationOnce(real) // 第一章摘要成功并落盘
      .mockImplementationOnce(async () => { throw new Error('服务暂不可用') })
    service.request(bookId)
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('failed') }, { timeout: 10_000 })
    expect((await view()).message).toContain('服务暂不可用')
    await service.retry(bookId)
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 10_000 })
    // 2 次失败尝试 + 重试时只补第二章摘要与最终归并；已有的第一章摘要不重跑。
    expect(mocks.complete).toHaveBeenCalledTimes(4)
  })

  it('超长章节按比例抽片段：单章最多 6 次摘要调用', async () => {
    const book = await createBookFromBootstrap({ bookId: 'i_huge', title: '巨章书', author: '', importType: 'txt', chapterTitles: ['第一卷'] })
    // 48 万字：按 7000 字切片是 69 段，逐段全读会烧光整月额度也写不出一章摘要。
    const body = '江湖路远，少年提剑入城。'.repeat(40_000)
    await writeChapterFile(book.id, book.chapters[0]!.id, { title: '第一卷', body, status: 'ready' })
    await markChapterStatus(book.id, book.chapters[0]!.id, 'ready')
    await refreshBookStatus(book.id)
    service.request(book.id)
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 20_000 })
    // 6 次片段摘要（69 段被抽到上限 6 段）+ 章节归并 + 全书终稿
    expect(mocks.complete).toHaveBeenCalledTimes(8)
    // 抽过片段就不能让模型以为读完了全章：提示词里要带抽样说明。
    const first = (mocks.complete.mock.calls[0]![1] as { content: string }[])[0]!.content
    expect(first).toContain('按比例抽取的片段')
  })

  it('服务端偶发空响应会退避重试，不把整本书判失败', async () => {
    const bookId = await seed()
    service.request(bookId)
    mocks.complete.mockRejectedValueOnce(new Error('模型服务未返回有效内容，请重试'))
    service.start()
    await vi.waitFor(async () => { expect((await view()).status).toBe('ready') }, { timeout: 20_000 })
    // 第一次失败 + 重试后成功：2 章摘要 + 最终归并 = 4 次
    expect(mocks.complete).toHaveBeenCalledTimes(4)
  })

  it('存量批处理按抽样补完，且临时额度不改用户设置', async () => {
    const bookId = await seedMany(30)
    // 预置「已经开过工」的半成品：否则不在存量待补名单里。
    await mkdir(join(directory, bookId, 'ai'), { recursive: true })
    await writeFile(join(directory, bookId, 'ai', 'bookOverview.json'), JSON.stringify({
      version: 1, text: '',
      chapterSummaries: { c0001: { hash: 'stale', text: '旧摘要' } },
      reduceCache: {}, updatedAt: new Date().toISOString(),
    }), 'utf-8')

    const result = await service.runBacklog({ sampleEvery: 10, budgetTokens: 400_000 })
    expect(result.books).toBe(1)
    expect(result.generated).toBe(1)
    // 30 章按 1/10 抽样：第 1/11/21 章 + 末章，而不是 30 章全跑。
    const file = JSON.parse(await readFile(join(directory, bookId, 'ai', 'bookOverview.json'), 'utf-8'))
    expect(Object.keys(file.chapterSummaries).sort()).toEqual(['c0001', 'c0011', 'c0021', 'c0030'])
    expect(file.text).toBeTruthy()
    // 临时放宽的额度只活在批处理里，用户设置原封不动。
    expect(mocks.settings!.ai?.autoMonthlyTokenLimit).toBe(DEFAULT_AI_PREFS.autoMonthlyTokenLimit)
  })

  it('取消不写成失败：停止时不能被谎报为「AI 请求超时」并锁死', async () => {
    const bookId = await seed()
    // 模型调用挂住，等我们取消
    let release!: () => void
    mocks.complete.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ text: 'x', truncated: false, usage: {} }) }))
    service.request(bookId)
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
