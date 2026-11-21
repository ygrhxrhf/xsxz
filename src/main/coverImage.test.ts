import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_PREFS, DEFAULT_COVER_GEN_PREFS } from '../shared/types'

const state = vi.hoisted(() => ({
  settings: {
    baseUrl: 'https://api.example.com/v1',
    coverGen: { ...{ enabled: true, autoOnImport: true, model: 'gpt-image-1', size: '1024x1536', style: '风格' } },
    ai: { provider: 'custom', trustedCustomOrigins: ['https://api.example.com'] },
  } as Record<string, unknown>,
  apiKey: 'sk-test-secret',
  coverKey: '',
  book: {
    id: 'd_test',
    title: '测试书',
    author: '某作者',
    tags: ['玄幻', '萝莉', '热血'],
    coverPath: undefined as string | undefined,
    chapters: [{ id: 'c0001', status: 'ready' }],
  } as Record<string, unknown>,
  setCoverCalls: [] as Array<{ bookId: string; sourcePath: string }>,
  setCoverResult: { ok: true, coverPath: 'cover.png' } as { ok: true; coverPath: string } | { ok: false; message: string },
}))

vi.mock('./settings', () => ({
  getSettings: async () => ({ ...state.settings, ai: { ...DEFAULT_AI_PREFS, ...(state.settings.ai as object) } }),
  getApiKey: async () => state.apiKey,
  getCoverGenApiKey: async () => state.coverKey,
  assertTrustedAiEndpoint: () => {},
}))

vi.mock('./library', () => ({
  bookDir: (bookId: string) => `C:/spbf-nonexistent/${bookId}`,
  getBook: async () => state.book,
  readChapter: async () => ({ body: '第一章正文：少年在雨夜里拔剑。'.repeat(20) }),
  setCover: async (payload: { bookId: string; sourcePath: string }) => {
    state.setCoverCalls.push(payload)
    return state.setCoverResult
  },
}))

const { buildCoverPrompt, generateBookCover, parseImageResponse } = await import('./coverImage')

/** 32 字节的最小 PNG 头：imageBytesInfo 只需要签名与 IHDR 里的宽高。 */
function pngBytes(width = 1024, height = 1536): Buffer {
  const buffer = Buffer.alloc(32)
  buffer[0] = 0x89
  buffer.write('PNG', 1, 'ascii')
  buffer[4] = 0x0d
  buffer[5] = 0x0a
  buffer[6] = 0x1a
  buffer[7] = 0x0a
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

const fetchMock = vi.fn()

beforeEach(() => {
  state.settings = {
    baseUrl: 'https://api.example.com/v1',
    coverGen: { ...DEFAULT_COVER_GEN_PREFS },
    ai: { provider: 'custom', trustedCustomOrigins: ['https://api.example.com'] },
  }
  state.apiKey = 'sk-test-secret'
  state.coverKey = ''
  state.book = {
    id: 'd_test',
    title: '测试书',
    author: '某作者',
    tags: ['玄幻', '萝莉', '热血'],
    coverPath: undefined,
    chapters: [{ id: 'c0001', status: 'ready' }],
  }
  state.setCoverCalls = []
  state.setCoverResult = { ok: true, coverPath: 'cover.png' }
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

describe('buildCoverPrompt', () => {
  it('carries title, author and safe tags, and always forbids text in the picture', () => {
    const prompt = buildCoverPrompt({
      title: '测试书',
      author: '某作者',
      tags: ['玄幻', '萝莉', '热血'],
      synopsis: '少年在雨夜里拔剑。',
      style: '水墨风',
    })
    expect(prompt).toContain('《测试书》')
    expect(prompt).toContain('某作者')
    expect(prompt).toContain('玄幻')
    expect(prompt).toContain('热血')
    // 敏感标签只留在书架元数据里，不进提示词，避免图片模型直接拒答
    expect(prompt).not.toContain('萝莉')
    expect(prompt).toContain('少年在雨夜里拔剑。')
    expect(prompt).toContain('水墨风')
    expect(prompt).toContain('不要出现任何文字')
  })

  it('drops the tag line entirely when every tag is blocked', () => {
    const prompt = buildCoverPrompt({ title: '书', tags: ['NTR', '调教'], synopsis: '', style: '' })
    expect(prompt).not.toContain('题材：')
    // 没有风格时也给一个能用的兜底构图要求
    expect(prompt).toContain('竖版构图')
  })
})

describe('parseImageResponse', () => {
  it('reads b64_json and strips a data URI prefix', () => {
    expect(parseImageResponse({ data: [{ b64_json: 'QUJD' }] })).toEqual({ b64: 'QUJD' })
    expect(parseImageResponse({ data: [{ b64_json: 'data:image/png;base64,QUJD' }] })).toEqual({ b64: 'QUJD' })
  })

  it('reads a url response and rejects malformed payloads', () => {
    expect(parseImageResponse({ data: [{ url: 'https://cdn.example.com/a.png' }] })).toEqual({
      url: 'https://cdn.example.com/a.png',
    })
    expect(parseImageResponse({ data: [] })).toEqual({})
    expect(parseImageResponse({ data: [{}] })).toEqual({})
    expect(parseImageResponse('nope')).toEqual({})
  })
})

describe('generateBookCover', () => {
  it('short-circuits when disabled', async () => {
    ;(state.settings.coverGen as Record<string, unknown>).enabled = false
    const result = await generateBookCover('d_test')
    expect(result).toMatchObject({ ok: false, code: 'disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips books that already have a cover unless forced', async () => {
    state.book.coverPath = 'cover.jpg'
    await expect(generateBookCover('d_test')).resolves.toMatchObject({ ok: false, code: 'has-cover' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a missing model and a missing key before touching the network', async () => {
    ;(state.settings.coverGen as Record<string, unknown>).model = '   '
    await expect(generateBookCover('d_test')).resolves.toMatchObject({ ok: false, code: 'no-model' })
    ;(state.settings.coverGen as Record<string, unknown>).model = 'gpt-image-1'
    state.apiKey = ''
    await expect(generateBookCover('d_test')).resolves.toMatchObject({ ok: false, code: 'no-api-key' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('writes the decoded image through setCover and returns the cover path', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: pngBytes().toString('base64') }] }),
    })
    const result = await generateBookCover('d_test')
    expect(result).toMatchObject({ ok: true, bookId: 'd_test', coverPath: 'cover.png' })
    const [call] = fetchMock.mock.calls[0]
    expect(String(call)).toBe('https://api.example.com/v1/images/generations')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ model: 'gpt-image-1', size: '1024x1536', n: 1 })
    expect(body.prompt).toContain('测试书')
    expect(state.setCoverCalls).toHaveLength(1)
    expect(state.setCoverCalls[0].sourcePath.endsWith('.png')).toBe(true)
  })

  it('prefers the dedicated image endpoint and its own key', async () => {
    ;(state.settings.coverGen as Record<string, unknown>).baseUrl = 'https://img.example.com/v1/'
    state.coverKey = 'sk-image-only'
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: pngBytes().toString('base64') }] }),
    })
    const result = await generateBookCover('d_test')
    expect(result).toMatchObject({ ok: true })
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://img.example.com/v1/images/generations')
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer sk-image-only')
  })

  it('falls back to the AI key when the image service has no key of its own', async () => {
    ;(state.settings.coverGen as Record<string, unknown>).baseUrl = 'https://img.example.com/v1'
    state.coverKey = ''
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: pngBytes().toString('base64') }] }),
    })
    await generateBookCover('d_test')
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer sk-test-secret')
  })

  it('rejects a non-http image endpoint before calling out', async () => {
    ;(state.settings.coverGen as Record<string, unknown>).baseUrl = 'ftp://img.example.com'
    const result = await generateBookCover('d_test')
    expect(result).toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an HTTP failure without leaking the API key', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'model not found' })
    const result = await generateBookCover('d_test')
    expect(result).toMatchObject({ ok: false, code: 'http' })
    if (!result.ok) {
      expect(result.message).toContain('400')
      expect(result.message).not.toContain('sk-test-secret')
    }
  })

  it('rejects a payload that is not a real image', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from('<html>nope</html>').toString('base64') }] }),
    })
    const result = await generateBookCover('d_test')
    expect(result).toMatchObject({ ok: false, code: 'bad-image' })
    expect(state.setCoverCalls).toHaveLength(0)
  })
})
