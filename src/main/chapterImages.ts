import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chapterImageText, type ChapterImageRef } from '../shared/chapterImages'
import { collectChapterImageCandidates, findImageTokens, type ChapterImageCandidate } from '../shared/chapterImageSource'
import { imageBytesInfo } from '../shared/imageBytes'
import { getLibraryPath } from './library'

/**
 * 下载章节的配图：把抽取时注入的图片标记原位换成 `[图]` 段落。
 *
 * 抽取阶段（extract.ts）已把合格的 `<img>` 换成文本标记，正文因此天然带着
 * 图片的原始位置；这里按标记顺序取图、落盘、原位替换。没有标记的正文
 * （OCR / 章节接口解锁等路径）退回「追加到章末」，至少不丢图。
 */

const MAX_IMAGES_PER_CHAPTER = 20
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export interface AttachChapterImagesOptions {
  bookId: string
  /** 章节 id（c0001）：用作图片文件名前缀 */
  chapterKey: string
  pageUrl: string
  html: string
  body: string
  /** 在页面上下文里带会话取图；失败返回 null。 */
  fetchImage: (url: string) => Promise<Uint8Array | null>
}

function normalizeParagraphs(text: string): string {
  return text.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 抓图并把标记换成 `[图]` 段落。
 *
 * `[图]` 段落必须是独立段落（分页器按段落识别图片块），所以替换时两侧补空行；
 * 同一个 URL 只取一次，正文里重复引用的图共用一份文件。
 */
export async function attachChapterImages(options: AttachChapterImagesOptions): Promise<string> {
  const imagesDir = join(getLibraryPath(), options.bookId, 'images')
  let index = 0
  const byUrl = new Map<string, string>()

  const save = async (candidate: ChapterImageCandidate): Promise<string | null> => {
    let bytes: Uint8Array | null
    try {
      bytes = await options.fetchImage(candidate.url)
    } catch {
      bytes = null
    }
    if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
    const info = imageBytesInfo(bytes)
    if (!info || info.width < 40 || info.height < 40) return null
    index += 1
    const file = `${options.chapterKey}-${index}${info.ext}`
    try {
      await mkdir(imagesDir, { recursive: true })
      await writeFile(join(imagesDir, file), bytes)
    } catch {
      index -= 1
      return null
    }
    const ref: ChapterImageRef = { file, width: info.width, height: info.height, caption: candidate.alt }
    return chapterImageText(ref)
  }

  const tokens = findImageTokens(options.body)
  if (tokens.length) {
    let text = options.body
    for (const token of tokens) {
      let marker = byUrl.get(token.url)
      if (marker === undefined) {
        const saved = await save({ url: token.url, alt: token.alt })
        marker = saved ?? ''
        byUrl.set(token.url, marker)
      }
      text = text.split(token.raw).join(marker ? `\n\n${marker}\n\n` : '')
    }
    return normalizeParagraphs(text)
  }

  // 没有标记（OCR/接口解锁/续页）时，至少把这一页 HTML 里的图追加到章末。
  const candidates = collectChapterImageCandidates(options.html, options.pageUrl).slice(0, MAX_IMAGES_PER_CHAPTER)
  const refs: ChapterImageRef[] = []
  for (const candidate of candidates) {
    const marker = await save(candidate)
    if (!marker) continue
    const parsed = /^\[图\]([^|]+)\|(\d+)\|(\d+)(?:\|([\s\S]*))?$/.exec(marker)
    if (parsed) {
      refs.push({ file: parsed[1]!, width: Number(parsed[2]), height: Number(parsed[3]), caption: parsed[4] ?? '' })
    }
  }
  if (!refs.length) return options.body
  return `${options.body.trimEnd()}\n\n${refs.map((ref) => chapterImageText(ref)).join('\n\n')}`
}