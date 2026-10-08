import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TtsPosition } from '../shared/types'
import { atomicWriteText } from './atomicFile'
import { bookDir } from './library'
import { getSettings, getTtsApiKey } from './settings'

const MAX_CACHE_BYTES = 500 * 1024 * 1024
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const MAX_TEXT_LENGTH = 500
const active = new Map<string, AbortController>()

function validBookId(id: string): boolean { return /^[a-z0-9_]+$/i.test(id) }

function positionFile(bookId: string): string {
  if (!validBookId(bookId)) throw new Error('书籍编号无效')
  return join(bookDir(bookId), 'tts-position.json')
}

export function normalizeTtsPosition(value: unknown): TtsPosition | null {
  if (!value || typeof value !== 'object') return null
  const p = value as Partial<TtsPosition>
  if (typeof p.chapterId !== 'string' || !p.chapterId ||
    !Number.isSafeInteger(p.paragraphIndex) || (p.paragraphIndex ?? -1) < 0 ||
    typeof p.bodyHash !== 'string' || !/^[a-f0-9]{8}$/i.test(p.bodyHash) ||
    typeof p.updatedAt !== 'string' || !Number.isFinite(Date.parse(p.updatedAt))) return null
  return { chapterId: p.chapterId, paragraphIndex: p.paragraphIndex!, bodyHash: p.bodyHash, updatedAt: p.updatedAt }
}

export async function readTtsPosition(bookId: string): Promise<TtsPosition | null> {
  try { return normalizeTtsPosition(JSON.parse(await readFile(positionFile(bookId), 'utf8'))) }
  catch { return null }
}

export async function writeTtsPosition(bookId: string, value: unknown): Promise<void> {
  const position = normalizeTtsPosition(value)
  if (!position) throw new Error('听书位置无效')
  await stat(join(bookDir(bookId), 'book.json'))
  await atomicWriteText(positionFile(bookId), JSON.stringify(position, null, 2))
}

export function validateTtsEndpoint(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('在线语音接口地址无效') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username || url.password || url.hash) throw new Error('接口需使用 HTTPS；本机地址可用 HTTP')
  return url.toString()
}

function cacheDir(): string { return join(app.getPath('userData'), 'tts-cache') }

export async function trimTtsCache(dir: string, limit = MAX_CACHE_BYTES): Promise<void> {
  const entries = await Promise.all((await readdir(dir)).filter((name) => /^[a-f0-9]{64}\.mp3$/.test(name))
    .map(async (name) => ({ name, info: await stat(join(dir, name)) })))
  let total = entries.reduce((sum, entry) => sum + entry.info.size, 0)
  for (const entry of entries.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
    if (total <= limit) break
    await rm(join(dir, entry.name), { force: true })
    total -= entry.info.size
  }
}

async function synthesizeTtsInner(text: string, controller: AbortController): Promise<Uint8Array> {
  const prefs = (await getSettings()).tts
  const endpoint = validateTtsEndpoint(prefs.onlineEndpoint)
  if (!prefs.onlineModel || !prefs.onlineVoice) throw new Error('请先填写在线语音模型和音色')
  const key = await getTtsApiKey()
  if (!key) throw new Error('请先配置在线语音 API Key')
  if (controller.signal.aborted) throw new Error('在线语音请求已取消')
  const dir = cacheDir()
  const hash = createHash('sha256').update(JSON.stringify([endpoint, prefs.onlineModel, prefs.onlineVoice, text])).digest('hex')
  const file = join(dir, `${hash}.mp3`)
  try {
    const bytes = await readFile(file)
    if (bytes.length > 0 && bytes.length <= MAX_AUDIO_BYTES) {
      const now = new Date()
      void utimes(file, now, now).catch(() => {})
      return bytes
    }
    await rm(file, { force: true })
  } catch { /* cache miss */ }

  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: prefs.onlineModel, voice: prefs.onlineVoice, input: text, response_format: 'mp3' }),
    })
    if (!response.ok) throw new Error(response.status === 429 ? '在线语音额度不足或请求过多' : `在线语音请求失败（${response.status}）`)
    const claimed = Number(response.headers.get('content-length'))
    if (claimed > MAX_AUDIO_BYTES) throw new Error('在线语音音频过大')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('在线语音没有返回音频')
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_AUDIO_BYTES) { await reader.cancel(); throw new Error('在线语音音频过大') }
      chunks.push(value)
    }
    if (!size) throw new Error('在线语音没有返回音频')
    const bytes = Buffer.concat(chunks)
    try {
      await mkdir(dir, { recursive: true })
      const tmp = join(dir, `${randomUUID()}.tmp`)
      try { await writeFile(tmp, bytes); await rename(tmp, file) }
      finally { await rm(tmp, { force: true }).catch(() => {}) }
      await trimTtsCache(dir).catch(() => {})
    } catch { /* playback succeeds even when cache cannot be written */ }
    return bytes
  } catch (error) {
    if (controller.signal.aborted) throw new Error('在线语音请求已取消或超时')
    throw error
  }
}

export async function synthesizeTts(requestId: string, text: string): Promise<Uint8Array> {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId) || active.has(requestId)) throw new Error('语音请求编号无效')
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH) throw new Error('朗读文本长度无效')
  const controller = new AbortController()
  active.set(requestId, controller)
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try { return await synthesizeTtsInner(text, controller) }
  finally { clearTimeout(timeout); active.delete(requestId) }
}

export function cancelTts(requestId: string): void { active.get(requestId)?.abort() }
