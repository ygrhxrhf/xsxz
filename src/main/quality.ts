import { createHash } from 'node:crypto'
import { getBook, normalizeChapterUrl, readChapter } from './library'
import { looksGarbled } from './bodyText'
import { UNLOCK_METHOD_ZH } from '../shared/types'
import type { ChapterFile, QualityIssue, QualityReport } from '../shared/types'

const WALL_RE =
  /(?:请先登录|登录后(?:阅读|查看)|访问过于频繁|验证码|人机验证|403\s*forbidden|购买本章|付费(?:阅读|章节)|本章需要付费|订阅后(?:可|再)?阅读|解锁(?:本章|后续章节|后续内容)|VIP(?:章节|会员)?才能阅读|开通会员(?:才能|方可)?阅读)/i
const AD_RE =
  /(?:最新网址|手机用户请|本章未完|加入书架|广告合作|点击下一页|请收藏本站|本站所有小说|转载作品|由网友上传|内容均来自互联网|只为宣传本书|请记住本站|请支持正版)/i
const TRUNCATED_END_RE = /(?:未完待续|本章未完|请翻下一页|点击下一页|下页继续|\.{3,}|…{2,})\s*$/i

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
    let file: ChapterFile
    try { file = await readChapter(bookId, chapter.id) } catch { continue }
    const body = file.body.trim()
    const compact = body.replace(/\s+/g, '')
    if (file.unlockedBy) {
      add('unlockedBody', `正文由付费墙自动恢复（${UNLOCK_METHOD_ZH[file.unlockedBy] || file.unlockedBy}）；请核对内容是否完整`)
    }
    if (compact.length < 120) add('short', `疑似正文过短（${compact.length} 字）`)
    if (looksGarbled(body)) add('garbled', '正文疑似乱码或字形替换（私用区码点）；建议用「重试失败章」重下')
    if (compact.length >= 120 && (TRUNCATED_END_RE.test(body) || /[，、：；（(“‘]$/.test(body))) {
      add('truncated', '疑似正文在句中截断或残留下一页提示；请核对并重下或手修')
    }
    if (WALL_RE.test(body.slice(0, 1000))) add('suspectedWall', '疑似登录、付费或拦截页面')
    if (AD_RE.test(body) && compact.length >= 500) add('suspectedAd', '疑似正文混入广告或站点杂质，可先预览 AI 清理结果')
    else if (AD_RE.test(body.slice(0, 1000)) && compact.length < 500) add('suspectedAd', '疑似广告或导航残页；请核对并重下或手修')
    if (compact.length >= 120) {
      const hash = createHash('sha256').update(compact).digest('hex')
      const previous = bodyHashes.get(hash)
      if (previous) add('duplicateBody', `疑似与「${previous}」正文重复`)
      else bodyHashes.set(hash, chapter.title)
    }
  }
  return { bookId, checked, issues }
}
