import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userData: '',
  failDecrypt: false,
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => {
      if (mocks.failDecrypt) throw new Error('decrypt failed')
      return { result: buffer.toString('utf8').replace(/^enc:/, '') }
    },
  },
}))

import {
  CraftError,
  craftImportUrl,
  createCraftStore,
  normalizeCraftEndpoint,
  pushCraftNote,
  readCraftLink,
  setCraftDir,
  type CraftPushDeps,
} from './craftPush'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'craft-push-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  mocks.failDecrypt = false
  const userData = await mkdtemp(join(root, 'ud-'))
  mocks.userData = userData
  setCraftDir(null)
})

describe('地址规范化', () => {
  it('去尾斜杠，非 http(s) 一律空串', () => {
    expect(normalizeCraftEndpoint(' https://craft.example.com/ ')).toBe('https://craft.example.com')
    expect(normalizeCraftEndpoint('craft.example.com')).toBe('')
    expect(normalizeCraftEndpoint('   ')).toBe('')
  })

  it('拼导入地址；直接粘完整地址也认', () => {
    expect(craftImportUrl('https://craft.example.com')).toBe('https://craft.example.com/api/v1/import/markdown')
    expect(craftImportUrl('https://craft.example.com/api/v1/import/markdown')).toBe(
      'https://craft.example.com/api/v1/import/markdown',
    )
  })
})

describe('连接配置', () => {
  it('令牌加密落盘，读回来只给布尔位', async () => {
    const store = createCraftStore()
    await store.save({ endpoint: 'https://craft.example.com', token: 'mcp_abc.write.xyz' })

    const state = await store.read()
    expect(state).toEqual({
      configured: true,
      endpoint: 'https://craft.example.com',
      tokenConfigured: true,
    })
    const snapshot = await store.credential()
    expect(snapshot).toEqual({ endpoint: 'https://craft.example.com', token: 'mcp_abc.write.xyz', unreadable: false })

    const raw = await readFile(join(mocks.userData, 'craft-push.json'), 'utf-8')
    expect(raw).not.toContain('mcp_abc.write.xyz')
    expect(raw).toContain('tokenEnc')
  })

  it('本机解不开的密文提示「重新粘贴」而不是「没配」', async () => {
    const store = createCraftStore()
    await store.save({ endpoint: 'https://craft.example.com', token: 't' })
    mocks.failDecrypt = true
    const state = await store.read()
    expect(state.tokenConfigured).toBe(false)
    expect(state.configured).toBe(false)
    expect(state.tokenUnreadable).toBe(true)
  })

  it('空令牌等于清除；清空配置连地址一起清', async () => {
    const store = createCraftStore()
    await store.save({ endpoint: 'https://craft.example.com', token: 't' })
    expect((await store.save({ token: '' })).tokenConfigured).toBe(false)
    const cleared = await store.clear()
    expect(cleared).toEqual({ configured: false, endpoint: '', tokenConfigured: false })
  })
})

describe('pushCraftNote', () => {
  async function deps(
    handler: (url: string, init: { body: string; headers: Record<string, string> }) => Promise<{
      status: number
      body: unknown
    }>,
  ): Promise<CraftPushDeps & { calls: Array<{ url: string; body: any }> }> {
    const calls: Array<{ url: string; body: any }> = []
    const store = createCraftStore()
    await store.save({ endpoint: 'https://craft.example.com', token: 'mcp_abc.write.xyz' })
    return {
      store,
      bookDirOf: (bookId: string) => join(root, 'library', bookId),
      fetchJson: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) })
        return handler(url, init)
      },
      now: () => '2026-11-28T10:00:00.000Z',
      calls,
    }
  }

  it('首次推送：不建文档 id，成功后在书里记下 docId', async () => {
    const d = await deps(async () => ({
      status: 200,
      body: { ok: true, documents: [{ id: 'doc-1', title: '《长夜行》', created: true }] },
    }))
    const result = await pushCraftNote(d, { bookId: 'd_1', title: '《长夜行》', markdown: '# 长夜行\n' })

    expect(d.calls[0]!.url).toBe('https://craft.example.com/api/v1/import/markdown')
    expect(d.calls[0]!.body.folder).toBe('阅读笔记')
    expect(d.calls[0]!.body.files[0].documentId).toBeUndefined()
    expect(result).toMatchObject({ docId: 'doc-1', created: true, endpoint: 'https://craft.example.com' })

    const link = await readCraftLink(join(root, 'library', 'd_1'))
    expect(link).toMatchObject({
      docId: 'doc-1',
      // 映射里存站点身份（规范形），根地址与完整导入地址在这里是同一个值
      endpoint: 'https://craft.example.com/api/v1/import/markdown',
    })
    expect(link!.contentHash).toHaveLength(64)
  })

  it('第二次推送带上上次的 documentId，更新而不是新建', async () => {
    const d = await deps(async (_url, init) => {
      const body = JSON.parse(init.body)
      const documentId = body.files[0].documentId
      return {
        status: 200,
        body: { ok: true, documents: [{ id: documentId ?? 'doc-1', created: !documentId }] },
      }
    })
    await pushCraftNote(d, { bookId: 'd_2', title: '《长夜行》', markdown: '# v1\n' })
    const second = await pushCraftNote(d, { bookId: 'd_2', title: '《长夜行》', markdown: '# v2\n' })

    expect(d.calls[1]!.body.files[0].documentId).toBe('doc-1')
    expect(second.created).toBe(false)
  })

  it('对端说 404（那篇被删了）就清映射重推一次新建', async () => {
    let round = 0
    const d = await deps(async (_url, init) => {
      round += 1
      const body = JSON.parse(init.body)
      if (round === 1) return { status: 200, body: { ok: true, documents: [{ id: 'doc-9', created: true }] } }
      if (body.files[0].documentId) return { status: 404, body: { ok: false, code: 'not_found', message: '目标文档不存在或已删除' } }
      return { status: 200, body: { ok: true, documents: [{ id: 'doc-10', created: true }] } }
    })

    await pushCraftNote(d, { bookId: 'd_3', title: '《长夜行》', markdown: '# v1\n' })
    const result = await pushCraftNote(d, { bookId: 'd_3', title: '《长夜行》', markdown: '# v2\n' })

    expect(d.calls).toHaveLength(3)
    expect(d.calls[2]!.body.files[0].documentId).toBeUndefined()
    expect(result.docId).toBe('doc-10')
    expect((await readCraftLink(join(root, 'library', 'd_3')))!.docId).toBe('doc-10')
  })

  it('换了站点就不复用旧 docId（旧 id 在另一台服务器上没意义）', async () => {
    const d = await deps(async () => ({ status: 200, body: { ok: true, documents: [{ id: 'doc-new', created: true }] } }))
    await pushCraftNote(d, { bookId: 'd_4', title: '《长夜行》', markdown: '# v1\n' })
    await d.store.save({ endpoint: 'https://other.example.com' })
    await pushCraftNote(d, { bookId: 'd_4', title: '《长夜行》', markdown: '# v2\n' })
    expect(d.calls[1]!.body.files[0].documentId).toBeUndefined()
  })

  it('同一站点的两种写法复用同一篇文档（根地址 ↔ 完整导入地址）', async () => {
    const d = await deps(async (_url, init) => {
      const body = JSON.parse(init.body)
      const documentId = body.files[0].documentId
      return { status: 200, body: { ok: true, documents: [{ id: documentId ?? 'doc-1', created: !documentId }] } }
    })
    await pushCraftNote(d, { bookId: 'd_7', title: '《长夜行》', markdown: '# v1 ' })
    await d.store.save({ endpoint: 'https://craft.example.com/api/v1/import/markdown' })
    const second = await pushCraftNote(d, { bookId: 'd_7', title: '《长夜行》', markdown: '# v2 ' })

    expect(d.calls[1]!.body.files[0].documentId).toBe('doc-1')
    expect(second.created).toBe(false)
  })

  it('同一本书并发推两次只建一篇：第二次拿到第一次的 documentId', async () => {
    let created = 0
    const d = await deps(async (_url, init) => {
      const body = JSON.parse(init.body)
      const documentId = body.files[0].documentId
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (documentId) return { status: 200, body: { ok: true, documents: [{ id: documentId, created: false }] } }
      created += 1
      return { status: 200, body: { ok: true, documents: [{ id: `doc-${created}`, created: true }] } }
    })

    const [a, b] = await Promise.all([
      pushCraftNote(d, { bookId: 'd_8', title: '《长夜行》', markdown: '# v1 ' }),
      pushCraftNote(d, { bookId: 'd_8', title: '《长夜行》', markdown: '# v2 ' }),
    ])

    expect(created).toBe(1)
    expect(d.calls).toHaveLength(2)
    expect(d.calls[1]!.body.files[0].documentId).toBe('doc-1')
    expect([a.docId, b.docId]).toEqual(['doc-1', 'doc-1'])
  })

  it('只读令牌 403：给的是能照着做的中文提示', async () => {
    const d = await deps(async () => ({
      status: 403,
      body: { ok: false, code: 'read_only', message: '这个令牌是只读的' },
    }))
    await expect(
      pushCraftNote(d, { bookId: 'd_5', title: '《长夜行》', markdown: '# v1\n' }),
    ).rejects.toBeInstanceOf(CraftError)
    await expect(
      pushCraftNote(d, { bookId: 'd_5', title: '《长夜行》', markdown: '# v1\n' }),
    ).rejects.toThrow('写入令牌')
  })

  it('没配地址 / 没配令牌 / 笔记过长都直接拒绝，不发请求', async () => {
    const store = createCraftStore()
    const fetchJson = vi.fn()
    const base = { store, bookDirOf: () => join(root, 'library', 'x'), fetchJson }

    await expect(pushCraftNote(base, { bookId: 'x', title: 't', markdown: 'm' })).rejects.toThrow('Crafty 地址')

    await store.save({ endpoint: 'https://craft.example.com' })
    await expect(pushCraftNote(base, { bookId: 'x', title: 't', markdown: 'm' })).rejects.toThrow('写入令牌')

    await store.save({ token: 'tk' })
    await expect(
      pushCraftNote(base, { bookId: 'x', title: 't', markdown: 'x'.repeat(450_001) }),
    ).rejects.toThrow('单篇上限')
    expect(fetchJson).not.toHaveBeenCalled()
  })

  it('坏掉的 craft-link.json 当作没推过', async () => {
    const bookDir = join(root, 'library', 'd_6')
    await mkdir(join(bookDir, 'ai'), { recursive: true })
    await writeFile(join(bookDir, 'ai', 'craft-link.json'), '{oops', 'utf-8')
    expect(await readCraftLink(bookDir)).toBeNull()
  })
})
