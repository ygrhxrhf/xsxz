import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_AI_PREFS, DEFAULT_APPEARANCE_PREFS, DEFAULT_READER_PREFS, DEFAULT_TTS_PREFS,
  type AiMemoryFile, type Settings,
} from '../shared/types'

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  settings: null as Settings | null,
  apiKey: 'test-key',
}))

vi.mock('./settings', () => ({
  getSettings: async () => mocks.settings,
  getApiKey: async () => mocks.apiKey,
  assertTrustedAiEndpoint: () => {},
  resolveEffectiveAiProvider: () => 'deepseek',
}))
vi.mock('./ai', async (original) => {
  const actual = await original<typeof import('./ai')>()
  return { ...actual, runAiTaskCompletion: mocks.complete }
})

import { AiReadingFollowService } from './aiReadingFollow'
import { AiQueue } from './aiScheduler'
import {
  createBookFromBootstrap, readAiMemory, readAiUsage, readSummaries,
  setLibraryPath, setProgress, updateChapterBody, writeAiMemory, writeChapterFile,
} from './library'
import { markReadFrontier } from './readFrontier'
import { renderedParagraphs } from '../shared/aiText'

let directory = ''
let queue: AiQueue
let service: AiReadingFollowService
let sleeps: number[]

function baseSettings(autoReadingFollow: boolean, followMaxChaptersPerRun = 12): Settings {
  return {
    libraryPath: directory, baseUrl: 'https://api.deepseek.com/v1', model: 'test', apiKeyConfigured: true,
    tierSenseKeyConfigured: false,
    reader: DEFAULT_READER_PREFS, tts: DEFAULT_TTS_PREFS, appearance: DEFAULT_APPEARANCE_PREFS,
    ai: { ...DEFAULT_AI_PREFS, autoReadingFollow, followMaxChaptersPerRun },
    downloadPace: 'standard',
  }
}

function createService(): AiReadingFollowService {
  return new AiReadingFollowService(queue, {
    isDownloadBusy: () => false,
    sleep: async (ms) => { sleeps.push(ms) },
  })
}

function callsFor(task: string): number {
  return mocks.complete.mock.calls.filter((call) =>
    (call[2] as { task?: string } | undefined)?.task === task).length
}

function chapterId(index: number): string {
  return `c${String(index).padStart(4, '0')}`
}

async function seed(chapterCount: number, readTo = chapterCount): Promise<string> {
  const book = await createBookFromBootstrap({
    bookId: 'i_follow', title: '追剧测试', author: '', importType: 'txt',
    chapterTitles: Array.from({ length: chapterCount }, (_unused, index) => `第${index + 1}章`),
  })
  // 正文必须长到能切出记忆候选证据（少于 80 字不会送模型），否则测不到记忆批次。
  const body = (title: string): string =>
    `${title}，主角继续北上，在渡口遇见一名白发剑客。剑客说旧账未清，转身消失在雨里。\n`
    + '夜里破庙宿了一晚，主角翻出那枚旧铜钱，听见门外马蹄声由远及近，剑客的声音隔着雨幕再次响起，问他要不要一起北上。'
  for (const chapter of book.chapters) {
    // writeChapterFile 自己会把 ready 写回目录元数据，不必再来一次 markChapterStatus
    await writeChapterFile(book.id, chapter.id, {
      title: chapter.title, body: body(chapter.title), status: 'ready',
    })
  }
  await setProgress(book.id, {
    chapterId: chapterId(readTo), scrollRatio: 1, updatedAt: '2026-01-01T00:00:00.000Z',
  })
  // setProgress 不写已读前沿：追剧按前沿判断「读者真的读到这一章了」，
  // 所以 seed 必须把读过的章逐章标到章末，否则任何一章都不会入队。
  for (const chapter of book.chapters.slice(0, readTo)) {
    const paragraphs = renderedParagraphs(body(chapter.title))
    await markReadFrontier(book.id, chapter.id, paragraphs.length - 1, paragraphs.at(-1)!.length)
  }
  return book.id
}

async function followFile(bookId: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(directory, bookId, 'ai', 'follow.json'), 'utf-8')
  return JSON.parse(text) as Record<string, unknown>
}

/** 一份合法的用户记忆：追剧不得覆盖它，除非记忆批次真的跑完。 */
function seededMemory(): AiMemoryFile {
  const excerpt = '主角继续北上，在渡口遇见一名白发剑客。剑客说旧账未清，转身消失在雨里。'.repeat(3)
  return {
    version: 1,
    characters: [{
      id: 'm_seed', name: '白发剑客', aliases: ['剑客'], role: '剑客', status: '存活',
      summary: '在渡口出现，旧账未清', accuracy: 'normal', updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: 'ev_seed', chapterId: 'c0001', chapterTitle: '第1章', paragraphIndex: 0, excerpt }],
    }],
    relations: [], foreshadows: [], events: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spbf-follow-'))
  await setLibraryPath(directory)
  queue = new AiQueue()
  sleeps = []
  mocks.settings = baseSettings(true)
  mocks.apiKey = 'test-key'
  mocks.complete.mockReset().mockImplementation(async (_config, _messages, options: { task?: string }) => {
    if (options?.task === 'memory') {
      return {
        text: '', truncated: false, usage: { inputTokens: 5, outputTokens: 3 },
        json: { characters: [], relations: [], foreshadows: [], events: [], reviewDecisions: [] },
      }
    }
    return { text: '本章整理结果', truncated: false, usage: { inputTokens: 9, outputTokens: 4 } }
  })
  service = createService()
})

afterEach(async () => {
  // 必须等在飞的整理写完再删目录：stop 只清定时器的话，后台那一轮还会去写
  // follow.json / 摘要 / 记忆，撞上 rm 就是偶发 ENOENT / ENOTEMPTY。
  await service.stop()
  await rm(directory, { recursive: true, force: true })
})

describe('自动追剧', () => {
  it('读完一章就整理本章并推进记忆，读者没读到的章绝不送模型', async () => {
    const bookId = await seed(3, 2)
    service.start()
    await service.setMode(bookId, 'auto', true)
    await service.chapterFinished(bookId, chapterId(1), 1)
    await service.chapterFinished(bookId, chapterId(3), 1)
    await service.wake(bookId)

    expect(Object.keys((await readSummaries(bookId)).byChapter)).toEqual([chapterId(1)])
    expect(callsFor('chapterSummary')).toBe(1)
    expect(callsFor('memory')).toBe(1)
    expect((await readAiMemory(bookId))?.uptoChapterId).toBe(chapterId(1))
    expect((await readAiUsage(bookId)).calls).toBe(2)
    const coverage = await service.coverage(bookId)
    expect(coverage).toMatchObject({ mode: 'auto', organizedChapters: 1, queuedChapters: 0, paused: false })
    expect(coverage.uptoChapterTitle).toBe('第1章')
  })

  it('stop() 等在飞的那一轮整理写完，不把落盘半路截断', async () => {
    const bookId = await seed(2, 2)
    service.start()
    await service.setMode(bookId, 'auto', true)
    await service.chapterFinished(bookId, chapterId(1), 1)

    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    mocks.complete.mockImplementationOnce(async () => {
      await gate
      return { text: '本章整理结果', truncated: false, usage: { inputTokens: 9, outputTokens: 4 } }
    })

    const running = service.wake(bookId)
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1), { timeout: 5_000 })

    // 模型还没回来，stop 就不该放行：它一放行调用方就会去删目录 / 重开服务，
    // 而那一轮还在写 follow.json 与摘要。
    let stoppedSettled = false
    const stopped = service.stop().then(() => { stoppedSettled = true })
    await Promise.resolve()
    expect(stoppedSettled, '模型还没回来，stop 不该先返回').toBe(false)

    release()
    await stopped
    await running
    expect(stoppedSettled).toBe(true)
    expect(Object.keys((await readSummaries(bookId)).byChapter)).toEqual([chapterId(1)])
  })

  it('滚动比例不足的章不算读完，不入队也不花钱', async () => {
    const bookId = await seed(2, 2)
    service.start()
    await service.setMode(bookId, 'auto', true)
    await service.chapterFinished(bookId, chapterId(1), 0.4)
    await service.wake(bookId)
    expect((await service.coverage(bookId)).queuedChapters).toBe(0)
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('单次章数上限到点就带原因暂停，记忆按 5 章一批推进，零头留在队列', { timeout: 60_000 }, async () => {
    const bookId = await seed(30, 30)
    service.start()
    await service.setMode(bookId, 'auto', true)
    for (let index = 1; index <= 30; index += 1) await service.chapterFinished(bookId, chapterId(index), 1)
    await service.wake(bookId)

    expect(callsFor('chapterSummary')).toBe(12)
    expect(callsFor('memory')).toBe(2)
    expect(Object.keys((await readSummaries(bookId)).byChapter)).toHaveLength(12)
    expect((await readAiMemory(bookId))?.uptoChapterId).toBe(chapterId(10))
    const coverage = await service.coverage(bookId)
    expect(coverage.organizedChapters).toBe(12)
    expect(coverage.queuedChapters).toBe(20)
    expect(coverage.paused).toBe(true)
    expect(coverage.pauseReason).toContain('达到单次章数上限')
  })

  it('模型调用期间读者继续上报新章，落盘时不会把新章抹掉', async () => {
    const bookId = await seed(4, 4)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let enterGate: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => { enterGate = resolve })
    mocks.complete.mockImplementation(async (_config, _messages, options: { task?: string }) => {
      if (options?.task === 'memory') {
        return {
          text: '', truncated: false, usage: { inputTokens: 5, outputTokens: 3 },
          json: { characters: [], relations: [], foreshadows: [], events: [], reviewDecisions: [] },
        }
      }
      enterGate()
      await gate
      return { text: '本章整理结果', truncated: false, usage: { inputTokens: 9, outputTokens: 4 } }
    })
    service.start()
    await service.setMode(bookId, 'auto', true)
    await service.chapterFinished(bookId, chapterId(1), 1)
    await inFlight
    // 摘要还在飞，读者已经翻过两章并上报。
    await service.chapterFinished(bookId, chapterId(2), 1)
    await service.chapterFinished(bookId, chapterId(3), 1)
    release()
    await service.wake(bookId)

    expect(callsFor('chapterSummary')).toBe(3)
    expect(callsFor('memory')).toBe(1)
    expect(Object.keys((await readSummaries(bookId)).byChapter)).toEqual(
      [chapterId(1), chapterId(2), chapterId(3)],
    )
    const coverage = await service.coverage(bookId)
    expect(coverage).toMatchObject({ organizedChapters: 3, queuedChapters: 0, paused: false })
  })

  it('连续网络失败按 5s/15s/60s 退避，用尽后落失败标记并停住', async () => {
    const bookId = await seed(2, 2)
    mocks.complete.mockRejectedValue(new Error('网络中断'))
    service.start()
    await service.setMode(bookId, 'auto', true)
    await service.chapterFinished(bookId, chapterId(1), 1)
    await service.wake(bookId)

    expect(sleeps).toEqual([5_000, 15_000, 60_000])
    expect(callsFor('chapterSummary')).toBe(4)
    const coverage = await service.coverage(bookId)
    expect(coverage.paused).toBe(true)
    expect(coverage.failed?.message).toBe('网络中断')
    expect(coverage.organizedChapters).toBe(0)
  })

  it('同一份正文失败过不再重复花额度，正文变了才自动重来', async () => {
    const bookId = await seed(1, 1)
    mocks.complete.mockRejectedValue(new Error('网络中断'))
    service.start()
    await service.setMode(bookId, 'auto', true)
    await service.chapterFinished(bookId, chapterId(1), 1)
    await service.wake(bookId)
    expect(callsFor('chapterSummary')).toBe(4)

    await service.wake(bookId)
    await service.wake(bookId)
    expect(callsFor('chapterSummary')).toBe(4)
    expect((await service.coverage(bookId)).paused).toBe(true)

    mocks.complete.mockReset().mockResolvedValue({ text: '重新整理结果', truncated: false })
    await updateChapterBody(bookId, chapterId(1), '第一章，主角换了目标，往南走。')
    await service.wake(bookId)
    expect(callsFor('chapterSummary')).toBe(1)
    const coverage = await service.coverage(bookId)
    expect(coverage.paused).toBe(false)
    expect(coverage.failed).toBeUndefined()
    expect(coverage.organizedChapters).toBe(1)
  })

  it('记忆批次失败后停住，同一批正文不再重复花钱', async () => {
    const bookId = await seed(5, 5)
    mocks.complete.mockImplementation(async (_config, _messages, options: { task?: string }) => {
      if (options?.task === 'memory') throw new Error('记忆服务不可用')
      return { text: '本章整理结果', truncated: false }
    })
    service.start()
    await service.setMode(bookId, 'auto', true)
    for (let index = 1; index <= 5; index += 1) await service.chapterFinished(bookId, chapterId(index), 1)
    await service.wake(bookId)

    expect(callsFor('chapterSummary')).toBe(5)
    expect(sleeps).toEqual([5_000, 15_000, 60_000])
    expect(callsFor('memory')).toBe(4)
    const coverage = await service.coverage(bookId)
    expect(coverage.paused).toBe(true)
    expect(coverage.failed?.message).toBe('记忆服务不可用')

    await service.wake(bookId)
    await service.wake(bookId)
    expect(callsFor('memory')).toBe(4)
    expect(coverage.organizedChapters).toBe(5)
  })

  it('设置页总开关关闭时自动触发不花钱，用户点「继续」仍可跑这一次', async () => {
    const bookId = await seed(1, 1)
    mocks.settings = baseSettings(false)
    service.start()
    await service.setMode(bookId, 'auto', true)
    await service.chapterFinished(bookId, chapterId(1), 1)
    await service.wake(bookId)
    expect(mocks.complete).not.toHaveBeenCalled()
    expect((await followFile(bookId)).queued).toEqual([chapterId(1)])

    await service.retry(bookId)
    await vi.waitFor(async () => {
      expect(Object.keys((await readSummaries(bookId)).byChapter)).toEqual([chapterId(1)])
    }, { timeout: 10_000 })
  })

  it('关窗重启后从同一目录续跑，已整理过的章不再重复送模型', async () => {
    const bookId = await seed(2, 2)
    service.start()
    await service.setMode(bookId, 'auto', true)
    await service.chapterFinished(bookId, chapterId(1), 1)
    await service.wake(bookId)
    expect(callsFor('chapterSummary')).toBe(1)
    // 这步是「关窗」：不 await 完就重开，等于让两个服务同时写同一目录
    await service.stop()

    const reopened = createService()
    await reopened.chapterFinished(bookId, chapterId(2), 1)
    expect(callsFor('chapterSummary')).toBe(1)
    reopened.start()
    await vi.waitFor(async () => {
      expect((await reopened.coverage(bookId)).organizedChapters).toBe(2)
    }, { timeout: 10_000 })
    expect(callsFor('chapterSummary')).toBe(2)
    expect(Object.keys((await readSummaries(bookId)).byChapter)).toEqual([chapterId(1), chapterId(2)])
    reopened.stop()
  })

  it('退出取消打断记忆批次时保留原记忆，章仍是待推进而不是已完成', async () => {
    const bookId = await seed(5, 5)
    await writeAiMemory(bookId, seededMemory())
    mocks.complete.mockImplementation(async (_config, _messages, options: { task?: string }) => {
      if (options?.task === 'memory') {
        queue.cancelAll()
        return { text: '', truncated: false, json: { characters: [], relations: [], foreshadows: [], events: [] } }
      }
      return { text: '本章整理结果', truncated: false }
    })
    service.start()
    await service.setMode(bookId, 'auto', true)
    for (let index = 1; index <= 5; index += 1) await service.chapterFinished(bookId, chapterId(index), 1)
    await service.wake(bookId)

    const memory = await readAiMemory(bookId)
    expect(memory?.uptoChapterId).toBeUndefined()
    expect(memory?.characters.map((item) => item.name)).toEqual(['白发剑客'])
    expect(Object.keys((await readSummaries(bookId)).byChapter)).toHaveLength(5)
    const coverage = await service.coverage(bookId)
    expect(coverage.organizedChapters).toBe(5)
    expect(coverage.queuedChapters).toBe(5)
  })

  it('首次开启自动追剧先报预算，确认后才落盘模式', async () => {
    const bookId = await seed(2, 2)
    const first = await service.setMode(bookId, 'auto')
    expect(first.ok).toBe(false)
    if (!first.ok) {
      expect(first.confirmationRequired).toBe(true)
      expect(first.budget.chapterCount).toBe(0)
      expect(first.message).toContain('每读完一章')
    }
    expect((await service.coverage(bookId)).mode).toBe('manual')
    const second = await service.setMode(bookId, 'auto', true)
    expect(second.ok).toBe(true)
    expect(JSON.stringify(await followFile(bookId))).toContain('"mode":"auto"')
  })

  it('manual 模式只记录进度不自动花钱', async () => {
    const bookId = await seed(1, 1)
    service.start()
    await service.chapterFinished(bookId, chapterId(1), 1)
    await service.wake(bookId)
    expect(mocks.complete).not.toHaveBeenCalled()
    expect((await followFile(bookId)).queued).toEqual([chapterId(1)])
  })

  it('follow.json 只认白名单字段，损坏时当缺省处理', async () => {
    const bookId = await seed(1, 1)
    await writeFile(join(directory, bookId, 'ai', 'follow.json'), '{"mode":"auto","queued":["c0001"', 'utf-8')
    expect((await service.coverage(bookId)).mode).toBe('manual')
    await writeFile(join(directory, bookId, 'ai', 'follow.json'), JSON.stringify({
      mode: 'auto', queued: ['c0001', 'c0001', 'c9999'], done: { c0001: { sig: 1 } }, bogus: 1,
    }), 'utf-8')
    const coverage = await service.coverage(bookId)
    expect(coverage.mode).toBe('auto')
    expect(coverage.queuedChapters).toBe(2)
    expect(coverage.organizedChapters).toBe(0)
  })
})
