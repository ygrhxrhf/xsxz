import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  parseChapterFinishedPayload,
  parseFollowBookPayload,
  parseFollowSetPayload,
} from './aiFollowIpcValidation'

const BOOK_ID = 'd_0123456789abcdef'

function handlerBlock(source: string, channel: string): string {
  const start = source.indexOf(`ipcMain.handle('${channel}'`)
  expect(start, `主进程没有注册 ${channel}`).toBeGreaterThan(-1)
  const next = source.indexOf('ipcMain.handle(', start + 1)
  return source.slice(start, next < 0 ? source.length : next)
}

describe('自动追剧 IPC 契约', () => {
  it('入参只认白名单，参数不对绝不动用模型额度', () => {
    expect(parseFollowBookPayload({ bookId: BOOK_ID })).toEqual({ bookId: BOOK_ID })
    expect(() => parseFollowBookPayload({})).toThrow('书籍不存在')
    expect(() => parseFollowBookPayload({ bookId: '../../../etc' })).toThrow('书籍不存在')

    expect(parseFollowSetPayload({ bookId: BOOK_ID, mode: 'auto' }))
      .toEqual({ bookId: BOOK_ID, mode: 'auto', confirmOverBudget: false })
    expect(parseFollowSetPayload({ bookId: BOOK_ID, mode: 'auto', confirmOverBudget: true }).confirmOverBudget)
      .toBe(true)
    expect(() => parseFollowSetPayload({ bookId: BOOK_ID, mode: 'always' })).toThrow('追剧模式无效')
    // 只有严格的 true 才算确认，字符串或 1 都不行。
    expect(parseFollowSetPayload({ bookId: BOOK_ID, mode: 'auto', confirmOverBudget: 'true' }).confirmOverBudget)
      .toBe(false)

    expect(parseChapterFinishedPayload({ bookId: BOOK_ID, chapterId: 'c0001', ratio: 1 }))
      .toEqual({ bookId: BOOK_ID, chapterId: 'c0001', ratio: 1 })
    expect(() => parseChapterFinishedPayload({ bookId: BOOK_ID, chapterId: 'c1', ratio: 1 }))
      .toThrow('章节不存在')
    for (const ratio of [1.5, -0.1, Number.NaN, '1', undefined]) {
      expect(() => parseChapterFinishedPayload({ bookId: BOOK_ID, chapterId: 'c0001', ratio }))
        .toThrow('阅读进度无效')
    }
  })

  it('三个频道只入队或读状态，绝不因为别的任务在跑就拒绝', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    const finished = handlerBlock(source, 'ai.chapterFinished')
    expect(finished).toContain('parseChapterFinishedPayload(unsafePayload)')
    expect(finished).toContain('aiReadingFollow.chapterFinished(')
    // 上报「读完了」被挡掉就等于追剧断了，所以这一条不许有任何忙守卫。
    for (const guard of ['busyFor', 'AI_BUSY_MESSAGE', 'aiStart(', 'aiExclusive(']) {
      expect(finished).not.toContain(guard)
    }
    expect(handlerBlock(source, 'ai.followSet')).toContain('aiReadingFollow.setMode(payload.bookId, payload.mode, payload.confirmOverBudget)')
    expect(handlerBlock(source, 'ai.followRetry')).toContain('aiReadingFollow.retry(bookId)')
    for (const channel of ['ai.chapterFinished', 'ai.followSet', 'ai.followRetry']) {
      expect(handlerBlock(source, channel)).toContain('catch (e: unknown)')
    }
  })

  it('运行状态只随 coverage.follow 拉取，不另开事件通道', async () => {
    const [source, preload, contract] = await Promise.all([
      readFile(new URL('./index.ts', import.meta.url), 'utf-8'),
      readFile(new URL('../preload/index.ts', import.meta.url), 'utf-8'),
      readFile(new URL('../../docs/ipc-contract.md', import.meta.url), 'utf-8'),
    ])
    expect(source).toContain('follow: await aiReadingFollow.coverage(bookId)')
    expect(preload).toContain("ipcRenderer.invoke('ai.chapterFinished', { bookId, chapterId, ratio })")
    expect(preload).toContain("ipcRenderer.invoke('ai.followSet', { bookId, mode, confirmOverBudget })")
    expect(preload).toContain("ipcRenderer.invoke('ai.followRetry', { bookId })")
    for (const channel of ['ai.chapterFinished', 'ai.followSet', 'ai.followRetry']) {
      expect(contract).toContain(`| \`${channel}\` | invoke |`)
    }
    // 追剧不新增推送频道，界面靠轮询拿进度。
    for (const channel of ['ai.follow', 'ai.followChanged', 'ai.chapterFinished']) {
      expect(preload).not.toContain(`on('${channel}'`)
    }
  })

  it('总开关只约束自动触发，设置改动立刻重排队列', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
    expect(handlerBlock(source, 'settings.set')).toContain('void aiReadingFollow.settingsChanged()')
    expect(source).toContain('aiReadingFollow.start()')
  })
})
