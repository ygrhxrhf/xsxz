import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({
      result: buffer.toString('utf8').replace(/^enc:/, ''),
    }),
  },
}))

import { createCraftStore, setCraftDir } from './craftPush'
import { registerCraftIpc, type CraftIpcDeps } from './craftIpc'
import { craftNoteTitle } from './craftMarkdown'
import type { CraftMaterials } from './craftMaterials'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'craft-ipc-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  setCraftDir(null)
})

const materials: CraftMaterials = {
  book: {
    id: 'd_1',
    title: '长夜行',
    author: '某人',
    tags: [],
    importType: 'txt',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    status: 'ready',
    chapters: [{ id: 'c0001', index: 1, title: '第一章 归来', file: 'chapters/0001.json', status: 'ready' }],
    progress: { chapterId: 'c0001', scrollRatio: 0.3, updatedAt: '2026-11-01T00:00:00.000Z' },
  },
  overview: '主角回乡查案。',
  memory: null,
  notes: [{ chapterId: 'c0001', bodyHash: 'h', text: '这一章记下：铜锁。', updatedAt: '2026-11-02T00:00:00.000Z' }],
  annotations: [],
}

type Handlers = Map<string, (event: unknown, payload?: any) => Promise<any>>

function wire(overrides: Partial<CraftIpcDeps> = {}, calls: any[] = []): Handlers {
  const handlers: Handlers = new Map()
  registerCraftIpc((channel, listener) => handlers.set(channel, listener), {
    store: createCraftStore(),
    bookDirOf: (bookId) => join(root, 'library', bookId),
    loadMaterials: async () => materials,
    fetchJson: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { status: 200, body: { ok: true, documents: [{ id: 'doc-1', title: '《长夜行》', created: true }] } }
    },
    now: () => '2026-11-28T10:00:00.000Z',
    ...overrides,
  })
  return handlers
}

describe('craft.* 频道', () => {
  it('status 不带令牌，只给布尔位', async () => {
    mocks.userData = await mkdtemp(join(root, 'ud-'))
    const handlers = wire()
    const before = await handlers.get('craft.status')!(null)
    expect(before).toEqual({ ok: true, state: { configured: false, endpoint: '', tokenConfigured: false } })

    await handlers.get('craft.configure')!(null, { endpoint: 'https://craft.example.com', token: 'tk' })
    const after = await handlers.get('craft.status')!(null)
    expect(after.state).toEqual({ configured: true, endpoint: 'https://craft.example.com', tokenConfigured: true })
    expect(JSON.stringify(after)).not.toContain('tk')
  })

  it('configure 拒绝没有协议的地址，合法地址能存能清', async () => {
    mocks.userData = await mkdtemp(join(root, 'ud-'))
    const handlers = wire()
    const bad = await handlers.get('craft.configure')!(null, { endpoint: 'craft.example.com' })
    expect(bad).toEqual({ ok: false, message: '地址要以 http:// 或 https:// 开头' })

    await handlers.get('craft.configure')!(null, { endpoint: 'https://craft.example.com', token: 'tk' })
    const cleared = await handlers.get('craft.configure')!(null, { token: '' })
    expect(cleared.ok).toBe(true)
    expect(cleared.state.tokenConfigured).toBe(false)
  })

  it('push 把读书产物拼成一篇 Markdown 发出去', async () => {
    mocks.userData = await mkdtemp(join(root, 'ud-'))
    const calls: any[] = []
    const handlers = wire({}, calls)
    await handlers.get('craft.configure')!(null, { endpoint: 'https://craft.example.com', token: 'tk' })

    const response = await handlers.get('craft.push')!(null, { bookId: 'd_1' })
    expect(response.ok).toBe(true)
    expect(response.result).toMatchObject({ docId: 'doc-1', created: true, endpoint: 'https://craft.example.com' })

    const sent = calls[0].body.files[0]
    expect(sent.name).toBe(`${craftNoteTitle('长夜行')}.md`)
    expect(sent.text).toContain('## 全书概览')
    expect(sent.text).toContain('主角回乡查案。')
    expect(sent.text).toContain('这一章记下：铜锁。')
    expect(calls[0].body.folder).toBe('阅读笔记')
  })

  it('没选书 / 没配置都给中文提示，不发请求', async () => {
    mocks.userData = await mkdtemp(join(root, 'ud-'))
    const calls: any[] = []
    const handlers = wire({}, calls)

    expect(await handlers.get('craft.push')!(null, {})).toEqual({ ok: false, message: '请先选择一本书' })
    const unconfigured = await handlers.get('craft.push')!(null, { bookId: 'd_1' })
    expect(unconfigured.ok).toBe(false)
    expect(unconfigured.message).toContain('Crafty 地址')
    expect(calls).toHaveLength(0)
  })

  it('读材料失败（书不存在）只回显提示，不抛错', async () => {
    mocks.userData = await mkdtemp(join(root, 'ud-'))
    const handlers = wire({
      loadMaterials: async () => {
        throw new Error('书籍不存在')
      },
    })
    await handlers.get('craft.configure')!(null, { endpoint: 'https://craft.example.com', token: 'tk' })
    expect(await handlers.get('craft.push')!(null, { bookId: 'nope' })).toEqual({ ok: false, message: '书籍不存在' })
  })
})
