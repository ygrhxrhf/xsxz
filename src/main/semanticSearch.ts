import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderedParagraphs } from '../shared/aiText'
import type { AiCitation, AiUsage, Book } from '../shared/types'
import { estimateAiTokens } from './aiBudget'
import { reserveAutomaticTokens } from './aiMonthlyBudget'
import type { AiQueue } from './aiScheduler'
import { selectLocalEvidence } from './aiEvidenceSearch'
import { atomicWriteText, bookDir, getBook, readChapter, withBookLock } from './library'
import { clipReadBody, getReadFrontier } from './readFrontier'
import { assertTrustedAiEndpoint, getEmbeddingApiKey, getSettings } from './settings'

interface SemanticChunk { id: string; chapterId: string; paragraphIndex: number; text: string; hash: string; vector: number[] }
interface SemanticFile { version: 1; modelKey: string; chunks: SemanticChunk[] }
const errors = new Map<string, string>()
let queue: AiQueue | null = null
const LIMIT = 20_000

function aiPath(bookId: string, name: string): string { return join(bookDir(bookId), 'ai', name) }
function sha(text: string): string { return createHash('sha256').update(text).digest('hex') }
async function readEnabled(bookId: string): Promise<boolean> {
  try { return (JSON.parse(await readFile(aiPath(bookId, 'semantic-settings.json'), 'utf-8')) as { enabled?: unknown }).enabled === true }
  catch { return false }
}
async function readIndex(bookId: string, modelKey: string): Promise<SemanticFile> {
  try {
    const value = JSON.parse(await readFile(aiPath(bookId, 'semantic-index.json'), 'utf-8')) as SemanticFile
    if (value.version === 1 && value.modelKey === modelKey && Array.isArray(value.chunks) &&
      value.chunks.every((chunk) => typeof chunk.id === 'string' && typeof chunk.text === 'string' && Array.isArray(chunk.vector) && chunk.vector.every(Number.isFinite))) return value
    errors.set(bookId, '语义索引已损坏或模型已更换，正在重新建立')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.set(bookId, '语义索引已损坏，正在重新建立')
  }
  return { version: 1, modelKey, chunks: [] }
}
async function saveIndex(bookId: string, value: SemanticFile): Promise<void> {
  await mkdir(aiPath(bookId, ''), { recursive: true })
  await atomicWriteText(aiPath(bookId, 'semantic-index.json'), JSON.stringify(value))
}
function modelKey(baseUrl: string, model: string): string { return sha(`${baseUrl.replace(/\/+$/, '')}\n${model}`) }
function unit(vector: number[]): number[] {
  if (vector.length < 2 || vector.length > 8192 || vector.some((value) => !Number.isFinite(value))) throw new Error('向量服务返回无效向量')
  const norm = Math.hypot(...vector)
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('向量服务返回零向量')
  return vector.map((value) => value / norm)
}
async function embeddings(texts: string[], signal?: AbortSignal): Promise<{ vectors: number[][]; usage?: AiUsage }> {
  const settings = await getSettings()
  const embedding = settings.embedding
  const apiKey = await getEmbeddingApiKey()
  if (!embedding?.baseUrl || !embedding.model || !apiKey) throw new Error('请先在设置中配置向量服务地址、模型和 Key')
  assertTrustedAiEndpoint(embedding.baseUrl, { ...settings.ai!, provider: 'custom' })
  const response = await fetch(`${embedding.baseUrl.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: embedding.model, input: texts }),
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(90_000)]),
  })
  if (!response.ok) throw new Error(`向量服务请求失败（${response.status}）`)
  const payload = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }>; usage?: { prompt_tokens?: number; total_tokens?: number } }
  if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new Error('向量服务返回数量不符')
  const ordered = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const vectors = ordered.map((item) => unit(item.embedding ?? []))
  if (vectors.some((vector) => vector.length !== vectors[0]!.length)) throw new Error('向量服务返回维度不一致')
  const tokens = payload.usage?.total_tokens ?? payload.usage?.prompt_tokens
  return { vectors, ...(Number.isFinite(tokens) ? { usage: { inputTokens: tokens } } : {}) }
}

async function desiredChunks(book: Book): Promise<SemanticChunk[]> {
  const frontier = await getReadFrontier(book.id)
  const result: SemanticChunk[] = []
  for (const meta of [...book.chapters].sort((a, b) => a.index - b.index)) {
    if (!frontier.chapters[meta.id] || meta.status !== 'ready') continue
    const original = (await readChapter(book.id, meta.id)).body
    const body = clipReadBody(original, frontier.chapters[meta.id])
    for (const [paragraphIndex, paragraph] of renderedParagraphs(body).entries()) {
      for (let offset = 0; offset < paragraph.length; offset += 700) {
        const text = paragraph.slice(offset, offset + 700)
        if (text.trim().length < 8) continue
        const id = `${meta.id}:${paragraphIndex}:${offset}`
        result.push({ id, chapterId: meta.id, paragraphIndex, text, hash: sha(text), vector: [] })
        if (result.length > LIMIT) throw new Error('已读正文超过语义索引上限，请缩小书籍范围')
      }
    }
  }
  return result
}

async function build(bookId: string, signal: AbortSignal): Promise<void> {
  if (!await readEnabled(bookId)) return
  const settings = await getSettings()
  const embedding = settings.embedding
  if (!embedding?.baseUrl || !embedding.model || !embedding.keyConfigured) throw new Error('请先配置向量服务')
  const key = modelKey(embedding.baseUrl, embedding.model)
  const book = await getBook(bookId)
  const wanted = await desiredChunks(book)
  const file = await readIndex(bookId, key)
  const old = new Map(file.chunks.map((chunk) => [chunk.id, chunk]))
  file.chunks = wanted.map((chunk) => {
    const cached = old.get(chunk.id)
    return cached?.hash === chunk.hash ? cached : chunk
  })
  await saveIndex(bookId, file)
  for (let index = 0; index < file.chunks.length; index += 8) {
    if (signal.aborted || !await readEnabled(bookId)) return
    const batch = file.chunks.slice(index, index + 8).filter((chunk) => !chunk.vector.length)
    if (!batch.length) continue
    const estimate = batch.reduce((sum, chunk) => sum + estimateAiTokens(chunk.text), 0)
    const reservation = await reserveAutomaticTokens(bookId, Math.max(1, estimate), settings.ai?.autoMonthlyTokenLimit ?? 100_000)
    let settled = false
    try {
      const result = await embeddings(batch.map((chunk) => chunk.text), signal)
      await reservation.settle(result.usage)
      settled = true
      batch.forEach((chunk, offset) => { chunk.vector = result.vectors[offset]! })
      await saveIndex(bookId, file)
    } finally { if (!settled) await reservation.settle().catch(() => {}) }
  }
  errors.delete(bookId)
}

export function configureSemanticQueue(value: AiQueue): void { queue = value }
export function wakeSemanticIndex(bookId: string): void {
  if (!queue) return
  queue.start(async (_jobId, signal) => {
    try { await build(bookId, signal) }
    catch (error) { errors.set(bookId, error instanceof Error ? error.message : String(error)) }
  }, { lane: 'background', cls: 'semanticIndex', bookId, dedupeKey: `semantic:${bookId}` })
}

export async function setSemanticEnabled(bookId: string, enabled: boolean): Promise<void> {
  await getBook(bookId)
  if (enabled) {
    const settings = await getSettings()
    if (!settings.embedding?.baseUrl || !settings.embedding.model || !await getEmbeddingApiKey()) throw new Error('请先配置向量服务')
    assertTrustedAiEndpoint(settings.embedding.baseUrl, { ...settings.ai!, provider: 'custom' })
  }
  await withBookLock(bookId, async () => {
    await mkdir(aiPath(bookId, ''), { recursive: true })
    await atomicWriteText(aiPath(bookId, 'semantic-settings.json'), JSON.stringify({ enabled }))
  })
  if (enabled) wakeSemanticIndex(bookId)
}

export async function semanticStatus(bookId: string): Promise<{ enabled: boolean; indexed: number; total: number; message: string }> {
  const enabled = await readEnabled(bookId)
  const settings = await getSettings()
  const config = settings.embedding
  const key = config?.baseUrl && config.model ? modelKey(config.baseUrl, config.model) : ''
  const file = await readIndex(bookId, key)
  const total = enabled ? await desiredChunks(await getBook(bookId)).then((chunks) => chunks.length).catch(() => 0) : 0
  const indexed = file.chunks.filter((chunk) => chunk.vector.length).length
  const message = errors.get(bookId) ?? (!config?.keyConfigured ? '向量服务尚未配置' : indexed < total ? '正在建立或等待更新索引' : '语义索引已就绪')
  return { enabled, indexed, total, message }
}

export async function findScenes(bookId: string, rawQuestion: string): Promise<{ hits: AiCitation[]; mode: 'semantic' | 'local'; message: string }> {
  const question = rawQuestion.trim()
  if (!question || question.length > 500) throw new Error('问题须为 1 至 500 字')
  const book = await getBook(bookId)
  const frontier = await getReadFrontier(bookId)
  const progressChapterId = book.progress?.chapterId
  if (!progressChapterId) throw new Error('还没有阅读进度')
  const searchChapters = await Promise.all(book.chapters.map(async (meta) => ({
    id: meta.id, index: meta.index, title: meta.title, status: meta.status,
    body: frontier.chapters[meta.id] ? clipReadBody((await readChapter(bookId, meta.id)).body, frontier.chapters[meta.id]) : '',
  })))
  const local = selectLocalEvidence(searchChapters, { originalQuestion: question }, {
    requestedUptoChapterId: progressChapterId, progressChapterId, currentChapterId: progressChapterId, maxResults: 5,
  }).citations
  const currentIndex = book.chapters.find((chapter) => chapter.id === progressChapterId)?.index ?? -1
  if (!await readEnabled(bookId)) return { hits: local, mode: 'local', message: '语义索引未开启，当前为本地字面检索' }
  const settings = await getSettings()
  const config = settings.embedding
  if (!config?.baseUrl || !config.model || !config.keyConfigured) return { hits: local, mode: 'local', message: '向量服务未配置，当前为本地字面检索' }
  const index = await readIndex(bookId, modelKey(config.baseUrl, config.model))
  if (!index.chunks.some((chunk) => chunk.vector.length)) return { hits: local, mode: 'local', message: '语义索引尚未建立，当前为本地字面检索' }
  try {
    const { vectors } = await embeddings([question])
    const query = vectors[0]!
    const title = new Map(book.chapters.map((chapter) => [chapter.id, chapter.title]))
    const valid = index.chunks.filter((chunk) => chunk.vector.length === query.length &&
      searchChapters.some((chapter) => chapter.id === chunk.chapterId && chapter.index <= currentIndex &&
        renderedParagraphs(chapter.body)[chunk.paragraphIndex]?.includes(chunk.text)))
    const semantic = valid.map((chunk) => ({ chunk, score: chunk.vector.reduce((sum, value, i) => sum + value * query[i]!, 0) }))
      .sort((a, b) => b.score - a.score).slice(0, 8)
      .map(({ chunk }) => ({ id: `scene-${chunk.id}`, chapterId: chunk.chapterId, chapterTitle: title.get(chunk.chapterId) ?? '', paragraphIndex: chunk.paragraphIndex, excerpt: chunk.text.slice(0, 160) }))
    const hits = [...semantic, ...local].filter((hit, index, all) => all.findIndex((item) => item.chapterId === hit.chapterId && item.paragraphIndex === hit.paragraphIndex) === index).slice(0, 5)
    return { hits, mode: 'semantic', message: '已结合语义与本地字面检索' }
  } catch (error) {
    return { hits: local, mode: 'local', message: `向量服务不可用，已回退本地检索：${error instanceof Error ? error.message : String(error)}` }
  }
}
