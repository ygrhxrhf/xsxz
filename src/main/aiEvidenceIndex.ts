/**
 * 证据检索的按章布隆侧挂索引：`<书库>/<bookId>/ai/index/`。
 *
 * 只用来剪枝：布隆过滤器没有假阴性，判「一定不含」才能跳过读盘，判「可能含」仍要读盘复核。
 * 位图之外不存正文；签名失效只重算该章；缺文件、坏文件、没建完一律算「不知道」，
 * 调用方照旧读盘 —— 这套代码坏掉的后果只能是变慢，不可能是漏引用。
 */
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChapterFile } from '../shared/types'
import { retrievalTerms } from '../shared/aiText'
import { atomicWriteText, bookDir, getLibraryPath, loadBook } from './library'
import { isLibraryRestoring } from './libraryMaintenance'

const INDEX_DIRECTORY = 'index'
const MANIFEST_FILE = 'index-manifest.json'
/** 假阳性率约 10% 起（每词形 10 个位），档位取 2 的幂以复用查询词下标。 */
const MIN_BITS = 16_384
const MAX_BITS = 1 << 22
const BITS_PER_TERM = 10
const HASH_COUNT = 4
const MISSING_SIGNATURE = 'missing'
const DEFAULT_BUILD_BATCH = 48
const DEFAULT_MAX_READS = 24
const STAT_YIELD_INTERVAL = 32
const BOOK_CACHE_LIMIT = 4
const SAFE_FILE_ID = /^[A-Za-z0-9_-]+$/

export interface EvidenceChapterRef {
  id: string
  index: number
  file: string
}

export interface EvidenceReadPlan {
  /** 必须读盘的章节 ID：必选集 + 索引不可用的章 + 布隆命中的前 maxRead 章。 */
  readIds: Set<string>
  indexed: number
  total: number
}

interface ManifestEntry {
  sig: string
  bits: number
  terms: number
}

interface IndexManifest {
  version: 1
  chapters: Record<string, ManifestEntry>
}

interface ChapterFilter {
  bits: number
  bytes: Buffer
}

const filterCache = new Map<string, Map<string, { sig: string; bits: number; bytes: Buffer }>>()
const wakeStates = new Map<string, { again: boolean }>()
let stopped = false

function indexDirectory(bookId: string): string {
  return join(bookDir(bookId), 'ai', INDEX_DIRECTORY)
}

function manifestPath(bookId: string): string {
  return join(indexDirectory(bookId), MANIFEST_FILE)
}

function sidecarPath(bookId: string, chapterId: string): string {
  return join(indexDirectory(bookId), `${chapterId}.json`)
}

function cacheKey(bookId: string): string {
  return `${getLibraryPath()}|${bookId}`
}

function filtersFor(bookId: string): Map<string, { sig: string; bits: number; bytes: Buffer }> {
  const key = cacheKey(bookId)
  const existing = filterCache.get(key)
  if (existing) {
    filterCache.delete(key)
    filterCache.set(key, existing)
    return existing
  }
  const created = new Map<string, { sig: string; bits: number; bytes: Buffer }>()
  filterCache.set(key, created)
  while (filterCache.size > BOOK_CACHE_LIMIT) {
    const oldest = filterCache.keys().next()
    if (oldest.done) break
    filterCache.delete(oldest.value)
  }
  return created
}

function emptyManifest(): IndexManifest {
  return { version: 1, chapters: {} }
}

async function readManifest(bookId: string): Promise<IndexManifest> {
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath(bookId), 'utf-8'))
    if (value && typeof value === 'object' && (value as IndexManifest).version === 1) {
      const chapters: Record<string, ManifestEntry> = {}
      for (const [chapterId, entry] of Object.entries((value as IndexManifest).chapters ?? {})) {
        if (!entry || typeof entry !== 'object') continue
        if (typeof entry.sig !== 'string' || typeof entry.bits !== 'number' || typeof entry.terms !== 'number') continue
        if (!SAFE_FILE_ID.test(chapterId)) continue
        chapters[chapterId] = { sig: entry.sig, bits: Math.trunc(entry.bits), terms: Math.trunc(entry.terms) }
      }
      return { version: 1, chapters }
    }
  } catch { /* 缺文件或坏文件：当没建过，读盘兜底 */ }
  return emptyManifest()
}

async function writeManifest(bookId: string, manifest: IndexManifest): Promise<void> {
  await mkdir(indexDirectory(bookId), { recursive: true })
  await atomicWriteText(manifestPath(bookId), JSON.stringify(manifest))
}

async function chapterSignature(bookId: string, file: string): Promise<string> {
  try {
    // 用纳秒级 mtime/ctime + 大小：ms 级 mtime 在同尺寸改写（保时间戳恢复/同秒内替换）时可能判「没变」，
    // 从而复用旧布隆位图、把含新词的章误判为「一定不含」而漏读。纳秒精度把窗口压到可忽略，
    // 且仍只读元数据、不读正文（读正文会毁掉索引「避免读盘」的意义）。
    const info = await stat(join(bookDir(bookId), file), { bigint: true })
    return `${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  } catch {
    return MISSING_SIGNATURE
  }
}

async function readChapterBody(bookId: string, file: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(join(bookDir(bookId), file), 'utf-8')) as Partial<ChapterFile>
    return typeof parsed.body === 'string' ? parsed.body : ''
  } catch {
    return ''
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

function hash32(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function bitPositions(term: string, bits: number): number[] {
  const first = hash32(term, 0x811c9dc5)
  const step = (hash32(term, 0x9e3779b9) >>> 1) | 1
  const positions: number[] = []
  for (let round = 1; round <= HASH_COUNT; round += 1) {
    positions.push(((first + Math.imul(round, step)) >>> 0) % bits)
  }
  return positions
}

function sizedBits(termCount: number): number {
  const wanted = Math.max(MIN_BITS, Math.min(MAX_BITS, termCount * BITS_PER_TERM))
  let bits = MIN_BITS
  while (bits < wanted) bits *= 2
  return bits
}

function createFilter(terms: ReadonlySet<string>): ChapterFilter {
  const bits = sizedBits(terms.size)
  const bytes = Buffer.alloc(bits / 8)
  for (const term of terms) {
    for (const position of bitPositions(term, bits)) {
      const offset = position >>> 3
      bytes[offset] = (bytes[offset] ?? 0) | (1 << (position & 7))
    }
  }
  return { bits, bytes }
}

function mayContain(filter: ChapterFilter, term: string, memo: Map<string, number[]>): boolean {
  const key = `${filter.bits}|${term}`
  let positions = memo.get(key)
  if (!positions) {
    positions = bitPositions(term, filter.bits)
    memo.set(key, positions)
  }
  for (const position of positions) {
    if (!((filter.bytes[position >>> 3] ?? 0) & (1 << (position & 7)))) return false
  }
  return true
}

async function loadFilter(bookId: string, chapterId: string, entry: ManifestEntry): Promise<ChapterFilter | null> {
  const cache = filtersFor(bookId)
  const cached = cache.get(chapterId)
  if (cached && cached.sig === entry.sig) return { bits: cached.bits, bytes: cached.bytes }
  try {
    const value: unknown = JSON.parse(await readFile(sidecarPath(bookId, chapterId), 'utf-8'))
    if (!value || typeof value !== 'object') return null
    const file = value as { sig?: unknown; bits?: unknown; k?: unknown; filter?: unknown }
    if (file.sig !== entry.sig || file.bits !== entry.bits || file.k !== HASH_COUNT || typeof file.filter !== 'string') return null
    const bytes = Buffer.from(file.filter, 'base64')
    if (bytes.length !== entry.bits / 8) return null
    cache.set(chapterId, { sig: entry.sig, bits: entry.bits, bytes })
    return { bits: entry.bits, bytes }
  } catch {
    return null
  }
}

async function buildEntry(
  bookId: string,
  ref: EvidenceChapterRef,
  signature: string,
): Promise<{ entry: ManifestEntry; filter: ChapterFilter | null }> {
  const body = signature === MISSING_SIGNATURE ? '' : await readChapterBody(bookId, ref.file)
  const terms = retrievalTerms(body)
  // 空正文与读不出的文件都记成 0 位：确定不含任何词形，正文一旦变化签名就失效。
  if (!terms.size) return { entry: { sig: signature, bits: 0, terms: 0 }, filter: null }
  const filter = createFilter(terms)
  await mkdir(indexDirectory(bookId), { recursive: true })
  await atomicWriteText(sidecarPath(bookId, ref.id), JSON.stringify({
    version: 1, sig: signature, bits: filter.bits, k: HASH_COUNT, filter: filter.bytes.toString('base64'),
  }))
  return { entry: { sig: signature, bits: filter.bits, terms: terms.size }, filter }
}

/**
 * 补齐到 maxChapters 章为止：从最靠近当前阅读位置的章开始建，成本有界，可被 stopped/退让打断。
 */
export async function ensureEvidenceIndex(
  bookId: string,
  refs: readonly EvidenceChapterRef[],
  options: { maxChapters?: number; until?: () => boolean } = {},
): Promise<{ built: number; indexed: number; total: number }> {
  if (stopped || isLibraryRestoring()) return { built: 0, indexed: 0, total: refs.length }
  const manifest = await readManifest(bookId)
  const cache = filtersFor(bookId)
  const pending: Array<{ ref: EvidenceChapterRef; signature: string }> = []
  let indexed = 0
  let scanned = 0
  for (const ref of refs) {
    if (!SAFE_FILE_ID.test(ref.id)) continue
    const signature = await chapterSignature(bookId, ref.file)
    if (manifest.chapters[ref.id]?.sig === signature) {
      indexed += 1
      continue
    }
    pending.push({ ref, signature })
    if (++scanned % STAT_YIELD_INTERVAL === 0) await yieldToEventLoop()
  }
  pending.sort((left, right) => right.ref.index - left.ref.index)
  const budget = Math.max(0, Math.trunc(options.maxChapters ?? DEFAULT_BUILD_BATCH))
  let built = 0
  for (const item of pending.slice(0, budget)) {
    if (stopped || options.until?.() === true) break
    const result = await buildEntry(bookId, item.ref, item.signature)
    manifest.chapters[item.ref.id] = result.entry
    if (result.filter) cache.set(item.ref.id, { sig: result.entry.sig, bits: result.filter.bits, bytes: result.filter.bytes })
    else cache.delete(item.ref.id)
    built += 1
    await yieldToEventLoop()
  }
  if (built) await writeManifest(bookId, manifest)
  return { built, indexed: indexed + built, total: refs.length }
}

/**
 * 决定哪些章需要读盘。terms 为空集合表示问句里没有任何可测词形（例如单字提问），
 * 这时不做任何剪枝；索引缺失或过期的章同样照读，绝不因为「没建」就漏引用。
 */
export async function planEvidenceReads(input: {
  bookId: string
  refs: readonly EvidenceChapterRef[]
  terms: ReadonlySet<string>
  mandatory?: Iterable<string>
  currentIndex?: number
  maxRead?: number
}): Promise<EvidenceReadPlan> {
  const { bookId, refs, terms } = input
  const mandatory = new Set(input.mandatory ?? [])
  const maxRead = Math.max(1, Math.trunc(input.maxRead ?? DEFAULT_MAX_READS))
  const readIds = new Set<string>()
  if (!terms.size || stopped) {
    for (const ref of refs) readIds.add(ref.id)
    return { readIds, indexed: 0, total: refs.length }
  }
  const manifest = await readManifest(bookId)
  const memo = new Map<string, number[]>()
  const ranked: Array<{ id: string; distance: number; matches: number }> = []
  let indexed = 0
  for (const ref of refs) {
    const entry = SAFE_FILE_ID.test(ref.id) ? manifest.chapters[ref.id] : undefined
    const signature = entry ? await chapterSignature(bookId, ref.file) : MISSING_SIGNATURE
    if (!entry || entry.sig !== signature) {
      readIds.add(ref.id)
      continue
    }
    if (entry.bits === 0) {
      if (mandatory.has(ref.id)) readIds.add(ref.id)
      indexed += 1
      continue
    }
    const filter = await loadFilter(bookId, ref.id, entry)
    if (!filter) {
      readIds.add(ref.id)
      continue
    }
    indexed += 1
    if (mandatory.has(ref.id)) {
      readIds.add(ref.id)
      continue
    }
    let matches = 0
    for (const term of terms) {
      if (mayContain(filter, term, memo)) matches += 1
    }
    if (matches) {
      ranked.push({
        id: ref.id,
        matches,
        distance: input.currentIndex === undefined ? 0 : Math.abs(ref.index - input.currentIndex),
      })
    }
  }
  // 命中词形越多排前：含完整 corePhrase 的章必然集齐它的全部二元窗，天然压在首位。
  ranked.sort((left, right) => right.matches - left.matches || left.distance - right.distance)
  // 预算只管投机候选：必选集与索引不可用的章本来就得读，不占这份额度。
  for (const item of ranked.slice(0, maxRead)) readIds.add(item.id)
  return { readIds, indexed, total: refs.length }
}

/** 读到新章正文后顺手补索引：同一本书的唤醒会合并，跑完再补一轮最新进度。 */
export function wakeEvidenceIndex(bookId: string): void {
  if (stopped || isLibraryRestoring()) return
  const key = cacheKey(bookId)
  const state = wakeStates.get(key)
  if (state) {
    state.again = true
    return
  }
  wakeStates.set(key, { again: false })
  void (async () => {
    try {
      do {
        wakeStates.get(key)!.again = false
        const book = await loadBook(bookId)
        const progressIndex = book.progress
          ? book.chapters.find((chapter) => chapter.id === book.progress?.chapterId)?.index
          : undefined
        if (progressIndex === undefined) break
        const refs = book.chapters
          .filter((chapter) => chapter.index <= progressIndex)
          .map((chapter) => ({ id: chapter.id, index: chapter.index, file: chapter.file }))
        await ensureEvidenceIndex(bookId, refs, { maxChapters: DEFAULT_BUILD_BATCH, until: () => stopped })
      } while (wakeStates.get(key)?.again && !stopped && !isLibraryRestoring())
    } catch { /* 索引是加速件：任何失败都退回读盘，不打扰读章的调用方 */ }
    finally { wakeStates.delete(key) }
  })()
}

export function stopEvidenceIndex(): void {
  stopped = true
  wakeStates.clear()
  filterCache.clear()
}

/** 测试与书库路径切换后用：丢掉内存位图，磁盘索引保留。 */
export function clearEvidenceIndexCache(): void {
  filterCache.clear()
}
