/**
 * 网页阅读的目录小工具。
 *
 * 目录顺序不能当章节顺序用：笔趣阁这类站的目录是「最新章节」打头、
 * 序号倒着排的，第一条往往是大结局。找第一章只能按标题里的章号取最小值。
 */

/** 从章节标题里取章号：支持阿拉伯 / 全角阿拉伯 / 中文数字，取不到返回 null。 */
export function chapterNumberIn(title: string): number | null {
  const match = /第\s*([0-9０-９]+|[一二三四五六七八九十百千零两]+)\s*[章节回]/.exec(title)
  if (!match) return null
  const raw = match[1].replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10))
  if (/^\d+$/.test(raw)) return Number(raw)

  const DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
  let total = 0
  let current = 0
  for (const ch of raw) {
    if (ch in DIGITS) current = DIGITS[ch]
    else if (ch in UNITS) {
      total += (current || 1) * UNITS[ch]
      current = 0
    } else return null
  }
  return total + current
}

/**
 * 目录里真正的第一章。
 *
 * 优先取章号最小的那一条；标题都没有章号时（楔子 / 序章）退回物理第一条，
 * 站点的「最新章节」块一般带章号，所以这条兜底不会把大结局当开头。
 */
export function firstChapterUrl(chapters: { title: string; url: string }[]): string | null {
  if (!chapters.length) return null
  let bestNumber = Number.POSITIVE_INFINITY
  let bestUrl = ''
  for (const chapter of chapters) {
    const number = chapterNumberIn(chapter.title || '')
    if (number === null) continue
    if (number < bestNumber) {
      bestNumber = number
      bestUrl = chapter.url
    }
  }
  return bestUrl || chapters[0]?.url || null
}