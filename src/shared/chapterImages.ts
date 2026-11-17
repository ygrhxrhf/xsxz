/**
 * 章内图片的正文标记。
 *
 * 章节正文仍是纯文本（段落以空行分隔），图片用一个独立段落表示：
 *   `[图]<文件名>|<宽>|<高>|<图注>`
 * 文件名只含安全字符，实际文件存放在书目录的 `images/` 下，由主进程的
 * `spbf-image://` 协议读取。分页器把它当作一个「按行数占位」的段落，
 * 纹理层再把这个块画成图片，因此翻页、飞页、跨页选择都不必为图片另开一套模型。
 */

export const CHAPTER_IMAGE_PREFIX = '[图]'

export interface ChapterImageRef {
  /** 书目录 images/ 下的文件名（不含目录） */
  file: string
  /** 原图像素宽 */
  width: number
  /** 原图像素高 */
  height: number
  /** 图注（可空） */
  caption: string
}

const SAFE_FILE = /^[A-Za-z0-9._-]+$/

export function chapterImageText(ref: ChapterImageRef): string {
  const caption = ref.caption.replace(/[\r\n|]+/g, ' ').trim()
  return `${CHAPTER_IMAGE_PREFIX}${ref.file}|${Math.max(1, Math.round(ref.width))}|${Math.max(1, Math.round(ref.height))}${caption ? `|${caption}` : ''}`
}

export function parseChapterImage(text: string): ChapterImageRef | null {
  const value = (text ?? '').trim()
  if (!value.startsWith(CHAPTER_IMAGE_PREFIX)) return null
  const body = value.slice(CHAPTER_IMAGE_PREFIX.length)
  const parts = body.split('|')
  if (parts.length < 3) return null
  const file = parts[0]!.trim()
  const width = Number(parts[1])
  const height = Number(parts[2])
  if (!SAFE_FILE.test(file) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { file, width, height, caption: parts.slice(3).join('|').trim() }
}

/** 图片块按版心宽度换算出显示高度（px）。 */
export function chapterImageHeight(ref: ChapterImageRef, contentWidth: number, maxHeight: number): number {
  const width = Math.max(1, contentWidth)
  const raw = width * ref.height / Math.max(1, ref.width)
  return Math.max(24, Math.min(raw, Math.max(24, maxHeight)))
}
