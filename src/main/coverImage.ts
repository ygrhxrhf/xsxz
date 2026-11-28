import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { imageBytesInfo } from '../shared/imageBytes'
import { DEFAULT_AI_PREFS, DEFAULT_COVER_GEN_PREFS, type Book, type CoverGenPrefs } from '../shared/types'
import { bookDir, getBook, readChapter, setCover } from './library'
import { assertTrustedAiEndpoint, getApiKey, getCoverGenApiKey, getSettings } from './settings'
import { aiFetch } from './aiFetch'

/**
 * AI 封面生成：没有封面的书，按「书名 + 作者 + 题材 + 梗概」画一张竖版封面。
 *
 * 走 AI 现有配置（`settings.baseUrl` + `settings.apiKeyEnc`）的 OpenAI 兼容
 * `/images/generations`：用户已经为聊天配过一次地址和 Key，再让他为封面配第二套
 * 服务和第二把密钥没有意义，也多一处密钥落盘的地方。
 *
 * 整条链路是「拿字节 → 校验是真图片 → 交给 library.setCover 落盘」：写 book.json、
 * 清理旧封面名、更新索引都由 setCover 负责，这里不碰书库文件结构。
 */

export type CoverGenFailCode =
  | 'disabled'
  | 'has-cover'
  | 'no-api-key'
  | 'no-model'
  | 'http'
  | 'rate-limited'
  | 'policy'
  | 'timeout'
  | 'bad-image'
  | 'failed'

export type CoverGenResult =
  | { ok: true; bookId: string; coverPath: string }
  | { ok: false; code: CoverGenFailCode; message: string }

/** 单张封面请求的超时：图片模型普遍比聊天慢，但 2 分钟还没回基本就是挂了。 */
const IMAGE_REQUEST_TIMEOUT_MS = 120_000
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000
/** 与 library.setCover 的上限一致：大于 8MB 的图直接判坏，省一次拷贝。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_SYNOPSIS_CHARS = 700
const MAX_CHAPTER_CHARS = 1200

/**
 * 这些标签只适合留在书架元数据里，不送给图片模型。
 * 带这类词的题材，模型侧会直接拒答（返回 400 / 内容策略），
 * 而这跟画面需求无关——只取「玄幻 / 都市 / 悬疑」这类能决定画面气质的标签就够了。
 */
const PROMPT_TAG_BLOCKLIST = [
  '乱伦',
  '萝莉',
  '正太',
  'ntr',
  '媚黑',
  '调教',
  '凌辱',
  '重口',
  '熟女',
  '人妻',
  '母子',
  '父女',
  '绿帽',
  '露出',
]

function promptableTags(tags: string[]): string[] {
  return (tags ?? [])
    .map((tag) => String(tag || '').trim())
    .filter((tag) => tag.length > 0 && !PROMPT_TAG_BLOCKLIST.some((bad) => tag.toLowerCase().includes(bad)))
    .slice(0, 6)
}

/** 梗概只用来决定氛围，不需要原样喂进去；折掉换行、去掉多余空白并截断。 */
function tidySynopsis(text: string): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SYNOPSIS_CHARS)
}

export function buildCoverPrompt(input: {
  title: string
  author?: string
  tags?: string[]
  synopsis?: string
  style: string
}): string {
  const title = String(input.title || '').trim() || '无题'
  const author = String(input.author || '').trim()
  const tags = promptableTags(input.tags ?? [])
  const synopsis = tidySynopsis(input.synopsis ?? '')
  const style = String(input.style || '').trim()

  const lines = [
    '为一本中文网络小说画一张书籍封面插画，竖版构图。',
    `书名：《${title}》`,
    author ? `作者：${author}` : '',
    tags.length ? `题材：${tags.join('、')}` : '',
    synopsis ? `故事梗概（只用来把握氛围与主角形象，不要把梗概文字画进画面）：${synopsis}` : '',
    `要求：${style || '构图完整，主体居中'}；画面里不要出现任何文字、书名、作者名、字母、数字、水印或边框；主体人物或场景要与题材相符，缩略图尺寸下也要能看清主体。`,
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * 提示词由强到弱分三档。成人向书库的首选提示词（带梗概、带标签）经常被图片模型
 * 按内容策略打回（400 content_policy），所以被拒时自动降级：先去梗概，再去书名，
 * 最后只留氛围——一张风格对得上的图，比书架上永远空着一块强。
 */
export function coverPromptVariants(input: {
  title: string
  author?: string
  tags?: string[]
  synopsis?: string
  style: string
}): string[] {
  const style = String(input.style || '').trim() || '构图完整，主体居中'
  return [
    buildCoverPrompt(input),
    buildCoverPrompt({ ...input, synopsis: '' }),
    [
      '为一本中文网络小说画一张书籍封面插画，竖版构图。',
      `氛围要求：${style}`,
      '只画场景、光影与人物剪影，不要出现任何文字、书名、人名字母、数字、水印或边框；主体居中，缩略图尺寸下也要能看清。',
    ].join('\n'),
  ]
}

export function parseImageResponse(json: unknown): { b64?: string; url?: string } {
  if (!json || typeof json !== 'object') return {}
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) return {}
  const first = data[0]
  if (!first || typeof first !== 'object') return {}
  const record = first as { b64_json?: unknown; url?: unknown }
  const b64 = typeof record.b64_json === 'string' ? record.b64_json.trim() : ''
  if (b64) {
    // 部分中转站会把 data URI 前缀一起塞进 b64_json。
    return { b64: b64.replace(/^data:[^,]*,/, '') }
  }
  const url = typeof record.url === 'string' ? record.url.trim() : ''
  return url ? { url } : {}
}

/** 梗概来源：优先已落盘的全书概览（没有就不额外花一次模型调用），其次首章正文。 */
async function collectSynopsis(bookId: string, book: Book): Promise<string> {
  try {
    const raw = await readFile(join(bookDir(bookId), 'ai', 'bookOverview.json'), 'utf-8')
    const text = (JSON.parse(raw) as { text?: unknown }).text
    if (typeof text === 'string' && text.trim()) return tidySynopsis(text)
  } catch {
    /* 没生成过概览，或文件坏了：退回首章 */
  }
  const first = book.chapters.find((chapter) => chapter.status === 'ready')
  if (first) {
    try {
      const file = await readChapter(bookId, first.id)
      const body = String(file.body || '')
      if (body.trim()) return tidySynopsis(body.slice(0, MAX_CHAPTER_CHARS))
    } catch {
      /* 读章失败就当没有梗概 */
    }
  }
  return ''
}

function imageExtOf(bytes: Uint8Array): '.jpg' | '.png' | '.webp' | null {
  const info = imageBytesInfo(bytes)
  if (!info) return null
  if (info.ext === '.jpg' || info.ext === '.png' || info.ext === '.webp') return info.ext
  return null
}

function describeHttpFailure(status: number, body: string): string {
  const snippet = String(body || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return snippet
    ? `图片服务返回 HTTP ${status}：${snippet}`
    : `图片服务返回 HTTP ${status}`
}

async function readImageBytesFromUrl(url: string): Promise<Uint8Array> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new CoverGenError('bad-image', '图片服务返回的地址无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CoverGenError('bad-image', '图片服务返回的地址不是 http(s)')
  }
  const response = await aiFetch(url, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new CoverGenError('http', describeHttpFailure(response.status, ''))
  const length = Number(response.headers.get('content-length') || '0')
  if (length > MAX_IMAGE_BYTES) throw new CoverGenError('bad-image', '封面图超过 8MB，已放弃')
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new CoverGenError('bad-image', '封面图超过 8MB，已放弃')
  return buffer
}

class CoverGenError extends Error {
  constructor(
    readonly code: CoverGenFailCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** 429 退避：图片服务按账号限速，批量补齐时必然会撞上。 */
const RATE_LIMIT_BACKOFF_MS = [10_000, 40_000, 120_000]

async function requestImageBytes(input: {
  endpoint: string
  apiKey: string
  model: string
  size: string
  prompt: string
}): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await aiFetch(input.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        size: input.size,
        n: 1,
        response_format: 'b64_json',
      }),
      signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
    })
    if (response.status === 429) {
      const wait = RATE_LIMIT_BACKOFF_MS[attempt]
      if (wait === undefined) {
        throw new CoverGenError('rate-limited', '图片服务限流（HTTP 429），等一会儿再试', 429)
      }
      await new Promise((resolve) => setTimeout(resolve, wait))
      continue
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new CoverGenError('http', describeHttpFailure(response.status, body), response.status)
    }
    const parsed = parseImageResponse(await response.json())
    if (!parsed.b64 && !parsed.url) {
      throw new CoverGenError('bad-image', '图片服务没有返回可用图片')
    }
    const bytes = parsed.b64
      ? new Uint8Array(Buffer.from(parsed.b64, 'base64'))
      : await readImageBytesFromUrl(parsed.url!)
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new CoverGenError('bad-image', '封面图超过 8MB，已放弃')
    }
    const ext = imageExtOf(bytes)
    if (!ext) throw new CoverGenError('bad-image', '图片服务返回的不是图片')
    return bytes
  }
}

/** 同一本书同时点两次「生成封面」时只发一次请求。 */
const inflight = new Map<string, Promise<CoverGenResult>>()

export function generateBookCover(
  bookId: string,
  opts: { force?: boolean } = {},
): Promise<CoverGenResult> {
  const running = inflight.get(bookId)
  if (running) return running
  const task = runGenerate(bookId, opts).finally(() => inflight.delete(bookId))
  inflight.set(bookId, task)
  return task
}

async function runGenerate(bookId: string, opts: { force?: boolean }): Promise<CoverGenResult> {
  let settings: Awaited<ReturnType<typeof getSettings>>
  try {
    settings = await getSettings()
  } catch (error) {
    return { ok: false, code: 'failed', message: error instanceof Error ? error.message : '读取设置失败' }
  }
  const prefs: CoverGenPrefs = settings.coverGen ?? DEFAULT_COVER_GEN_PREFS
  if (!prefs.enabled) return { ok: false, code: 'disabled', message: '封面生成已关闭' }
  if (!prefs.model || !prefs.model.trim()) return { ok: false, code: 'no-model', message: '还没有填写图片模型名' }

  let book: Book
  try {
    book = await getBook(bookId)
  } catch {
    return { ok: false, code: 'failed', message: '书不存在' }
  }
  if (book.coverPath && !opts.force) {
    return { ok: false, code: 'has-cover', message: '这本书已经有封面' }
  }

  // 图片服务优先用封面自己的地址与 Key；都没填才回退 AI 那一套。
  const dedicatedBase = (prefs.baseUrl || '').trim()
  const imageBase = (dedicatedBase || settings.baseUrl || '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(imageBase)) {
    return { ok: false, code: 'failed', message: '图片服务地址无效，请在设置里填写 http(s) 地址' }
  }
  const apiKey = (await getCoverGenApiKey()) || (await getApiKey())
  if (!apiKey) return { ok: false, code: 'no-api-key', message: '还没有配置 API Key' }
  // 自定义图片服务由用户自己在设置里填写（与在线语音端点同一套口径）；
  // 只有回退到 AI 的地址时才需要过 AI 的信任校验。
  if (!dedicatedBase) {
    const ai = settings.ai ?? DEFAULT_AI_PREFS
    try {
      assertTrustedAiEndpoint(settings.baseUrl, ai)
    } catch (error) {
      return { ok: false, code: 'failed', message: error instanceof Error ? error.message : '接口地址未信任' }
    }
  }

  const synopsis = await collectSynopsis(bookId, book)
  const variants = coverPromptVariants({
    title: book.title,
    author: book.author,
    tags: book.tags,
    synopsis,
    style: prefs.style,
  })
  const endpoint = `${imageBase}/images/generations`

  let bytes: Uint8Array | null = null
  let lastError: CoverGenError | null = null
  for (let index = 0; index < variants.length; index += 1) {
    try {
      bytes = await requestImageBytes({
        endpoint,
        apiKey,
        model: prefs.model.trim(),
        size: prefs.size,
        prompt: variants[index]!,
      })
      break
    } catch (error) {
      if (!(error instanceof CoverGenError)) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          return { ok: false, code: 'timeout', message: '图片服务超时，请稍后再试' }
        }
        return {
          ok: false,
          code: 'failed',
          message: `请求图片服务失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      lastError = error
      // 只有「提示词被拒」才值得换更保守的写法；限流/鉴权/超时换提示词没用。
      const promptRejected = error.status === 400 || error.status === 422
      if (!promptRejected || index === variants.length - 1) break
    }
  }
  if (!bytes) {
    if (lastError && (lastError.status === 400 || lastError.status === 422)) {
      return { ok: false, code: 'policy', message: '这本题材被图片服务按内容策略拒了，换个模型或改风格再试' }
    }
    return {
      ok: false,
      code: lastError?.code ?? 'failed',
      message: lastError?.message ?? '生成封面失败',
    }
  }

  const ext = imageExtOf(bytes)
  if (!ext) return { ok: false, code: 'bad-image', message: '图片服务返回的不是图片' }

  const tempPath = join(tmpdir(), `spbf-cover-${randomUUID()}${ext}`)
  try {
    await writeFile(tempPath, bytes)
    const saved = await setCover({ bookId, sourcePath: tempPath })
    if (!saved.ok) return { ok: false, code: 'failed', message: saved.message }
    return { ok: true, bookId, coverPath: saved.coverPath }
  } catch (error) {
    return {
      ok: false,
      code: 'failed',
      message: `写入封面失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}
