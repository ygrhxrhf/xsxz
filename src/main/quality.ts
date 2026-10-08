import { createHash } from 'node:crypto'
import { getBook, normalizeChapterUrl, readChapter } from './library'
import type { QualityIssue, QualityReport } from '../shared/types'

const WALL_RE = /(?:请先登录|登录后(?:阅读|查看)|访问过于频繁|验证码|人机验证|403\s*forbidden)/i
const AD_RE = /(?:最新网址|手机用户请|本章未完|加入书架|广告合作|点击下一页|请收藏本站)/i

/** 报告只供人工核对，不改变章节状态或正文。 */
export async function auditBook(bookId: string): Promise<QualityReport> {
  const book = await getBook(bookId)
  const issues: QualityIssue[] = []
  const bodyHashes = new Map<string, string>()
  const urls = new Map<string, string>()
  let checked = 0
  for (const chapter of book.chapters) {
    const add = (kind: QualityIssue['kind'], reason: string) => issues.push({
      chapterId: chapter.id,
      chapterIndex: chapter.index,
      chapterTitle: chapter.title,
      kind,
      reason,
    })
    if (chapter.url) {
      const key = normalizeChapterUrl(chapter.url)
      const previous = urls.get(key)
      if (previous) add('duplicateUrl', `疑似与「${previous}」共用章节链接`)
      else urls.set(key, chapter.title)
    }
    if (chapter.status !== 'ready') continue
    checked++
    let body: string
    try { body = (await readChapter(bookId, chapter.id)).body.trim() } catch { continue }
    const compact = body.replace(/\s+/g, '')
    if (compact.length < 120) add('short', `疑似正文过短（${compact.length} 字）`)
    if (WALL_RE.test(body.slice(0, 1000))) add('suspectedWall', '疑似登录或拦截页面')
    if (AD_RE.test(body.slice(0, 1000)) && compact.length < 500) add('suspectedAd', '疑似广告或导航残页')
    if (compact.length >= 120) {
      const hash = createHash('sha256').update(compact).digest('hex')
      const previous = bodyHashes.get(hash)
      if (previous) add('duplicateBody', `疑似与「${previous}」正文重复`)
      else bodyHashes.set(hash, chapter.title)
    }
  }
  return { bookId, checked, issues }
}
