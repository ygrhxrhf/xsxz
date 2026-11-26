import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AI_CHAT_THREAD_LIMIT,
  DEFAULT_CHAT_THREAD_ID,
  DEFAULT_CHAT_THREAD_TITLE,
  bookDir,
  chatThreadTitleFromQuestion,
  createBookFromBootstrap,
  createChatThread,
  deleteChatThread,
  markChatThreadStarted,
  readChat,
  readChatThread,
  readChatThreads,
  readChatThreadsState,
  setLibraryPath,
  writeChat,
  writeChatThreads,
} from './library'
import type { AiChatThread, AiChatThreadsFile } from '../shared/types'

/**
 * 多会话问答的存储层：一本书的问答历史从 `ai/chat.json` 搬进 `ai/chats.json`
 * （`{version:1, activeThreadId, threads[]}`）。
 *
 * 这里守的是几条删了就没人发现的语义：
 * - 旧 chat.json 只在内存里迁移，读历史不该产生写盘；
 * - 坏文件 / 坏消息各自降级，不能连累整条会话打不开；
 * - 删除当前会话后 active 必须落到一条真实存在、且最近更新过的会话上；
 * - 写一条会话不能碰到另一条（分线程的意义全在这里）；
 * - 指定了不存在的会话宁可报错，也不静默写进别的会话。
 */

const BOOK = 'd_threads'

function thread(seed: {
  id: string
  title?: string
  updatedAt: string
  messages?: AiChatThread['messages']
}): AiChatThread {
  return {
    id: seed.id,
    title: seed.title ?? '',
    createdAt: seed.updatedAt,
    updatedAt: seed.updatedAt,
    messages: seed.messages ?? [],
  }
}

function fileOf(seed: { activeThreadId: string; threads: AiChatThread[] }): AiChatThreadsFile {
  return { version: 1, activeThreadId: seed.activeThreadId, threads: seed.threads }
}

const aiDir = () => join(bookDir(BOOK), 'ai')
const chatsFile = () => join(aiDir(), 'chats.json')
const legacyFile = () => join(aiDir(), 'chat.json')

describe('多会话问答：旧 chat.json 迁移', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-threads-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: BOOK, title: '会话书', author: '', importType: 'download', chapterTitles: ['一'],
    })
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('只有旧 chat.json 时读成一条 default 会话，且读操作不落盘', async () => {
    await writeFile(legacyFile(), JSON.stringify({
      version: 2,
      updatedAt: '2026-02-01T00:00:00.000Z',
      messages: [
        { role: 'user', content: '玉印去了哪里？' },
        { role: 'assistant', content: '她把玉印交了出去。' },
      ],
    }), 'utf-8')

    const state = await readChatThreadsState(BOOK)
    expect(state.migrated).toBe(true)
    expect(state.corrupt).toBe(false)
    expect(state.file.activeThreadId).toBe(DEFAULT_CHAT_THREAD_ID)
    expect(state.file.threads).toHaveLength(1)
    expect(state.file.threads[0]).toMatchObject({
      id: DEFAULT_CHAT_THREAD_ID,
      title: DEFAULT_CHAT_THREAD_TITLE,
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
    expect(state.file.threads[0]!.messages.map((message) => message.content))
      .toEqual(['玉印去了哪里？', '她把玉印交了出去。'])

    // 迁移只在内存里发生：打开侧栏就改写书库是很脏的副作用。
    expect(await readdir(aiDir())).not.toContain('chats.json')
    const found = await readChatThread(BOOK)
    expect(found).toMatchObject({ ok: true, threadId: DEFAULT_CHAT_THREAD_ID })
  })

  it('chats.json 存在时优先读它，旧 chat.json 整份忽略', async () => {
    await writeFile(legacyFile(), JSON.stringify({
      version: 2,
      messages: [{ role: 'user', content: '旧文件里的话' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }), 'utf-8')
    await writeChatThreads(BOOK, fileOf({
      activeThreadId: 'th_a',
      threads: [thread({
        id: 'th_a',
        title: '人物线',
        updatedAt: '2026-03-01T00:00:00.000Z',
        messages: [{ role: 'user', content: '新文件里的话' }],
      })],
    }))

    const state = await readChatThreadsState(BOOK)
    expect(state.migrated).toBe(false)
    expect(state.corrupt).toBe(false)
    expect(state.file.activeThreadId).toBe('th_a')
    expect(state.file.threads.map((item) => item.id)).toEqual(['th_a'])
    expect(state.file.threads[0]!.messages.map((message) => message.content)).toEqual(['新文件里的话'])
  })
})

describe('多会话问答：坏文件与坏消息', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-threads-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: BOOK, title: '会话书', author: '', importType: 'download', chapterTitles: ['一'],
    })
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('chats.json 是坏 JSON 时按「没有会话」读，不抛', async () => {
    await writeFile(chatsFile(), '{ 坏文件', 'utf-8')

    // 报错就等于侧栏打不开：按空结果读，可读原因由 listThreads 带回界面。
    await expect(readChatThreads(BOOK)).resolves.toEqual({ version: 1, activeThreadId: '', threads: [] })
    const state = await readChatThreadsState(BOOK)
    expect(state.corrupt).toBe(true)
    expect(state.migrated).toBe(false)
    // 一条会话都没有时 threadId 是空串，界面据此回欢迎态。
    await expect(readChatThread(BOOK)).resolves.toMatchObject({ ok: true, threadId: '', messages: [] })
  })

  it('某条消息形状坏只丢那一条，线程仍可读、其余消息保留', async () => {
    await writeFile(chatsFile(), JSON.stringify(fileOf({
      activeThreadId: 'th_a',
      threads: [thread({
        id: 'th_a',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [
          { role: 'user', content: 'Q1' },
          { role: 'user' } as unknown as AiChatThread['messages'][number],
          { role: 'assistant', content: 'A2' },
          { role: 'system', content: '角色不认识' } as unknown as AiChatThread['messages'][number],
          { role: 'user', content: 'Q3' },
          { role: 'assistant', content: 'A4' },
        ],
      })],
    })), 'utf-8')

    const found = await readChatThread(BOOK)
    expect(found).toMatchObject({ ok: true, threadId: 'th_a' })
    expect(found.ok && found.messages.map((message) => message.content)).toEqual(['Q1', 'A2', 'Q3', 'A4'])
    // 坏消息是这一条的事，不是整份文件 corruption 的事。
    await expect(readChatThreadsState(BOOK)).resolves.toMatchObject({ corrupt: false })
  })
})

describe('多会话问答：会话数量上限', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-threads-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: BOOK, title: '会话书', author: '', importType: 'download', chapterTitles: ['一'],
    })
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('连建 20 条后第 21 条报「会话数量已达上限（20）」', async () => {
    expect(AI_CHAT_THREAD_LIMIT).toBe(20)
    for (let index = 0; index < AI_CHAT_THREAD_LIMIT; index += 1) {
      const created = await createChatThread(BOOK)
      expect(created.ok, `第 ${index + 1} 条应当建得出来`).toBe(true)
    }
    const full = await readChatThreads(BOOK)
    expect(full.threads).toHaveLength(AI_CHAT_THREAD_LIMIT)

    const overflow = await createChatThread(BOOK)
    expect(overflow.ok).toBe(false)
    expect(overflow.ok ? '' : overflow.message).toContain('上限')
    expect(overflow.ok ? '' : overflow.message).toContain('20')
    // 超限这一条一个字节都不该落盘。
    expect((await readChatThreads(BOOK)).threads).toHaveLength(AI_CHAT_THREAD_LIMIT)
  })
})

describe('多会话问答：删除会话', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-threads-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: BOOK, title: '会话书', author: '', importType: 'download', chapterTitles: ['一'],
    })
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('删掉当前会话后 active 交给 updatedAt 最新的剩余会话', async () => {
    await writeChatThreads(BOOK, fileOf({
      activeThreadId: 'th_new',
      threads: [
        thread({ id: 'th_new', updatedAt: '2026-03-03T00:00:00.000Z', messages: [{ role: 'user', content: '最新的' }] }),
        thread({ id: 'th_mid', updatedAt: '2026-03-02T00:00:00.000Z', messages: [{ role: 'user', content: '中间那条' }] }),
        thread({ id: 'th_old', updatedAt: '2026-03-01T00:00:00.000Z', messages: [{ role: 'user', content: '最旧的' }] }),
      ],
    }))

    await expect(deleteChatThread(BOOK, 'th_new')).resolves.toEqual({ ok: true })

    const after = await readChatThreads(BOOK)
    expect(after.threads.map((item) => item.id)).toEqual(['th_mid', 'th_old'])
    // 不能落回最旧的那条：界面得停在读者最可能继续问的会话上。
    expect(after.activeThreadId).toBe('th_mid')
    await expect(readChatThread(BOOK)).resolves.toMatchObject({
      ok: true, threadId: 'th_mid', messages: [{ role: 'user', content: '中间那条' }],
    })
  })

  it('删到一条不剩时 activeThreadId 清空，界面回欢迎态', async () => {
    await writeChatThreads(BOOK, fileOf({
      activeThreadId: 'th_only',
      threads: [thread({ id: 'th_only', updatedAt: '2026-03-01T00:00:00.000Z', messages: [{ role: 'user', content: '唯一一条' }] })],
    }))

    await expect(deleteChatThread(BOOK, 'th_only')).resolves.toEqual({ ok: true })

    await expect(readChatThreads(BOOK)).resolves.toEqual({ version: 1, activeThreadId: '', threads: [] })
    // 空置的 active 不能再指向一条已经不存在的会话。
    await expect(readChatThread(BOOK)).resolves.toMatchObject({ ok: true, threadId: '', messages: [] })
  })

  it('删非当前会话不动 active，删不存在的会话给可读原因', async () => {
    await writeChatThreads(BOOK, fileOf({
      activeThreadId: 'th_keep',
      threads: [
        thread({ id: 'th_keep', updatedAt: '2026-03-02T00:00:00.000Z' }),
        thread({ id: 'th_drop', updatedAt: '2026-03-01T00:00:00.000Z' }),
      ],
    }))

    await expect(deleteChatThread(BOOK, 'th_drop')).resolves.toEqual({ ok: true })
    await expect(readChatThreads(BOOK)).resolves.toMatchObject({ activeThreadId: 'th_keep' })

    const missing = await deleteChatThread(BOOK, 'th_ghost')
    expect(missing.ok).toBe(false)
    expect(missing.ok ? '' : missing.message).toContain('会话不存在')
  })
})

describe('多会话问答：写隔离', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-threads-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: BOOK, title: '会话书', author: '', importType: 'download', chapterTitles: ['一'],
    })
    await writeChatThreads(BOOK, fileOf({
      activeThreadId: 'th_b',
      threads: [
        thread({
          id: 'th_a',
          title: '人物线',
          updatedAt: '2026-03-01T00:00:00.000Z',
          messages: [{ role: 'user', content: 'A 的老问题' }],
        }),
        thread({
          id: 'th_b',
          title: '剧情线',
          updatedAt: '2026-03-02T00:00:00.000Z',
          messages: [
            { role: 'user', content: 'B 的问题' },
            { role: 'assistant', content: 'B 的回答' },
          ],
        }),
      ],
    }))
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('writeChat 只改指定会话，另一条的消息与 updatedAt 都不变，active 也不被抢走', async () => {
    await writeChat(BOOK, [
      { role: 'user', content: 'A 的新问题' },
      { role: 'assistant', content: 'A 的新回答' },
    ], { threadId: 'th_a' })

    const after = await readChatThreads(BOOK)
    const a = after.threads.find((item) => item.id === 'th_a')!
    const b = after.threads.find((item) => item.id === 'th_b')!
    expect(a.messages.map((message) => message.content)).toEqual(['A 的新问题', 'A 的新回答'])
    // 另一条一个字、一个时间戳都不该动：这是分线程的全部意义。
    expect(b.messages.map((message) => message.content)).toEqual(['B 的问题', 'B 的回答'])
    expect(b.updatedAt).toBe('2026-03-02T00:00:00.000Z')
    expect(after.activeThreadId).toBe('th_b')
  })

  it('不带 threadId 时写进 active，别的会话同样不受影响', async () => {
    await writeChat(BOOK, [{ role: 'user', content: '写进当前会话' }])

    const after = await readChatThreads(BOOK)
    expect(after.threads.find((item) => item.id === 'th_b')!.messages.map((message) => message.content))
      .toEqual(['写进当前会话'])
    expect(after.threads.find((item) => item.id === 'th_a')!.messages.map((message) => message.content))
      .toEqual(['A 的老问题'])
    expect(after.threads.find((item) => item.id === 'th_a')!.updatedAt).toBe('2026-03-01T00:00:00.000Z')
  })
})

describe('多会话问答：会话标题', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-threads-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: BOOK, title: '会话书', author: '', importType: 'download', chapterTitles: ['一'],
    })
    await writeChatThreads(BOOK, fileOf({
      activeThreadId: 'th_titled',
      threads: [
        thread({ id: 'th_titled', title: '人物线', updatedAt: '2026-03-02T00:00:00.000Z' }),
        thread({ id: 'th_empty', updatedAt: '2026-03-01T00:00:00.000Z' }),
      ],
    }))
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('markChatThreadStarted 只补空标题，已有标题一律不覆盖', async () => {
    await markChatThreadStarted(BOOK, 'th_titled', '这个问题不该改写已有的标题')
    await markChatThreadStarted(BOOK, 'th_empty', '  玉印\n后来去了哪里？ ')

    const after = await readChatThreads(BOOK)
    expect(after.threads.find((item) => item.id === 'th_titled')!.title).toBe('人物线')
    expect(after.threads.find((item) => item.id === 'th_empty')!.title).toBe('玉印 后来去了哪里？')
    // 发起一轮问答的那条会话同时成为 active：下一句提问要落回同一条。
    expect(after.activeThreadId).toBe('th_empty')
  })

  it('chatThreadTitleFromQuestion 压平换行与空白、超 24 码点才补省略号', async () => {
    expect(chatThreadTitleFromQuestion('  玉印\n去了哪里？\t ')).toBe('玉印 去了哪里？')
    expect(chatThreadTitleFromQuestion('   \n  ')).toBe('')
    // 正好 24 个码点：不截断、不加省略号
    expect(chatThreadTitleFromQuestion('一'.repeat(24))).toBe('一'.repeat(24))
    expect(chatThreadTitleFromQuestion('一'.repeat(25))).toBe(`${'一'.repeat(24)}…`)
    // 按码点切：把 emoji 劈成两半会得到替换字符
    const emoji = chatThreadTitleFromQuestion('😀'.repeat(30))
    expect(emoji).toBe(`${'😀'.repeat(24)}…`)
    expect(emoji).not.toContain('\uFFFD')
  })
})

describe('多会话问答：未知 threadId', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-threads-'))
    await setLibraryPath(dir)
    await createBookFromBootstrap({
      bookId: BOOK, title: '会话书', author: '', importType: 'download', chapterTitles: ['一'],
    })
    await writeChatThreads(BOOK, fileOf({
      activeThreadId: 'th_a',
      threads: [thread({
        id: 'th_a',
        updatedAt: '2026-03-01T00:00:00.000Z',
        messages: [{ role: 'user', content: '原名里的问题' }],
      })],
    }))
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('writeChat 指定不存在的会话直接抛错，绝不静默写进别的会话', async () => {
    await expect(writeChat(BOOK, [{ role: 'user', content: '会写错线程的消息' }], { threadId: 'th_ghost' }))
      .rejects.toThrow(/会话不存在，请刷新会话列表/)

    const after = await readChatThreads(BOOK)
    expect(after.threads).toHaveLength(1)
    expect(after.threads[0]!.messages.map((message) => message.content)).toEqual(['原名里的问题'])
  })

  it('readChatThread 对不存在的 id 返回 {ok:false}，readChat 抛错', async () => {
    const found = await readChatThread(BOOK, 'th_ghost')
    expect(found.ok).toBe(false)
    expect(found.ok ? '' : found.message).toContain('会话不存在')
    await expect(readChat(BOOK, 'th_ghost')).rejects.toThrow(/会话不存在/)
  })

  it('markChatThreadStarted 遇到不存在的会话是静默无操作', async () => {
    await expect(markChatThreadStarted(BOOK, 'th_ghost', '随便一句话')).resolves.toBeUndefined()
    const after = await readChatThreads(BOOK)
    expect(after.threads.map((item) => item.id)).toEqual(['th_a'])
    expect(after.activeThreadId).toBe('th_a')
  })
})
