/**
 * 一本书的「读书笔记」Markdown——推到 Crafty 的那份正文。
 *
 * 纯函数：不动磁盘、不碰 electron，输入就是书库已经读出来的几份材料，输出一段 Markdown。
 * 只搬读书产物（概览、人物、伏笔、事件、章节笔记、划线批注），**正文不上传**：
 * 书库 `chapters/*.json` 永远留在本机，Crafty 那边只留读者的判断与引用片段。
 *
 * 空材料整段跳过——没有概览就不写「## 全书概览」这个空标题，读者在 Crafty 里看到的
 * 必须是他真有的东西。
 */
import type { AiChapterNote, AiMemoryFile, Annotation, Book } from '../shared/types'

export interface CraftNoteInput {
  book: Pick<Book, 'id' | 'title' | 'author' | 'status' | 'progress' | 'chapters'>
  /** `ai/bookOverview.json` 的 `text`；没有生成过就是空串。 */
  overview?: string
  memory?: AiMemoryFile | null
  notes?: AiChapterNote[]
  annotations?: Annotation[]
  /** 推送时间，ISO 8601；只用于页首一行。 */
  pushedAt?: string
}

/** Crafty 侧文档标题：书名加书名号，最多 80 字（对端同限）。 */
export function craftNoteTitle(title: string): string {
  const clean = title.trim() || '未命名书籍'
  return `《${clean}》`.slice(0, 80)
}

function chapterTitle(book: CraftNoteInput['book'], chapterId: string | undefined): string {
  if (!chapterId) return ''
  return book.chapters.find((chapter) => chapter.id === chapterId)?.title ?? ''
}

function progressLine(book: CraftNoteInput['book']): string {
  const progress = book.progress
  if (!progress) return '还没开始读'
  const index = book.chapters.findIndex((chapter) => chapter.id === progress.chapterId)
  const at = index >= 0 ? `第 ${index + 1} 章` : '未知章节'
  const ratio = Number.isFinite(progress.scrollRatio) ? Math.round(progress.scrollRatio * 100) : 0
  return `${at} · ${Math.min(100, Math.max(0, ratio))}%`
}

const FORESHADOW_STATUS: Record<string, string> = {
  open: '已埋未解',
  resolved: '已回收',
  uncertain: '存疑',
}

function charactersSection(memory: AiMemoryFile): string {
  if (!memory.characters.length) return ''
  const lines = ['## 人物', '']
  for (const character of memory.characters) {
    const head = [`### ${character.name}`, character.role ? `（${character.role}）` : ''].join('')
    lines.push(head)
    if (character.summary) lines.push(character.summary)
    if (character.aliases?.length) lines.push(`- 别名：${character.aliases.join('、')}`)
    if (character.status) lines.push(`- 当前：${character.status}`)
    lines.push('')
  }
  return lines.join('\n')
}

function relationsSection(memory: AiMemoryFile): string {
  if (!memory.relations.length) return ''
  const lines = ['## 关系', '']
  for (const relation of memory.relations) {
    const tail = relation.status ? ` · ${relation.status}` : ''
    lines.push(`- ${relation.from} — ${relation.to}：${relation.relation}${tail}`)
  }
  return `${lines.join('\n')}\n`
}

function foreshadowsSection(memory: AiMemoryFile): string {
  if (!memory.foreshadows.length) return ''
  const lines = ['## 伏笔', '']
  for (const foreshadow of memory.foreshadows) {
    const status = FORESHADOW_STATUS[foreshadow.status] ?? foreshadow.status
    lines.push(`- ${foreshadow.desc}（${status}）`)
  }
  return `${lines.join('\n')}\n`
}

function eventsSection(memory: AiMemoryFile): string {
  if (!memory.events.length) return ''
  const lines = ['## 关键事件', '']
  for (const event of memory.events) {
    const who = event.participants?.length ? `（${event.participants.join('、')}）` : ''
    const result = event.result ? ` — ${event.result}` : ''
    lines.push(`- ${event.title}${who}${result}`)
  }
  return `${lines.join('\n')}\n`
}

function notesSection(book: CraftNoteInput['book'], notes: AiChapterNote[]): string {
  const ordered = notes
    .filter((note) => note.text.trim())
    .map((note) => ({
      note,
      index: book.chapters.findIndex((chapter) => chapter.id === note.chapterId),
    }))
    .sort((left, right) => left.index - right.index)
  if (!ordered.length) return ''

  const lines = ['## 章节笔记', '']
  for (const { note, index } of ordered) {
    const title = chapterTitle(book, note.chapterId) || (index >= 0 ? `第 ${index + 1} 章` : note.chapterId)
    lines.push(`### ${title}`, '')
    const mark = note.userEdited ? '' : '（AI 生成）'
    lines.push(mark ? `${mark}\n${note.text.trim()}` : note.text.trim(), '')
  }
  return lines.join('\n')
}

function marksSection(book: CraftNoteInput['book'], annotations: Annotation[]): string {
  const ordered = annotations
    .slice()
    .sort((left, right) => {
      const byChapter =
        book.chapters.findIndex((chapter) => chapter.id === left.chapterId) -
        book.chapters.findIndex((chapter) => chapter.id === right.chapterId)
      return byChapter !== 0 ? byChapter : left.start - right.start
    })
  if (!ordered.length) return ''

  const lines = ['## 划线批注', '']
  for (const mark of ordered) {
    const title = chapterTitle(book, mark.chapterId)
    const head = title ? `**${title}**` : ''
    if (mark.kind === 'bookmark') {
      lines.push(`- ${head}${head ? ' ' : ''}书签${mark.note ? `：${mark.note}` : ''}`)
      continue
    }
    lines.push(`> ${head ? `${head} ` : ''}${mark.excerpt.replace(/\n+/g, ' ').trim()}`)
    if (mark.note) {
      const source = mark.noteSource === 'ai' ? '（AI 解释）' : ''
      lines.push(`${mark.note.trim()}${source}`)
    }
    if (mark.tags?.length) lines.push(`#${mark.tags.join(' #')}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function buildCraftNoteMarkdown(input: CraftNoteInput): string {
  const { book } = input
  const meta = [
    book.author ? `作者：${book.author}` : '',
    `进度：${progressLine(book)}`,
    `章节：${book.chapters.length} 章`,
    input.pushedAt ? `推送：${input.pushedAt.slice(0, 10)}` : '',
  ].filter(Boolean)

  const sections: string[] = [`# ${craftNoteTitle(book.title)}\n\n> ${meta.join(' ｜ ')}`]

  const overview = input.overview?.trim()
  if (overview) sections.push(`## 全书概览\n\n${overview}`)

  const memory = input.memory
  if (memory) {
    sections.push(
      charactersSection(memory),
      relationsSection(memory),
      foreshadowsSection(memory),
      eventsSection(memory),
    )
  }

  sections.push(notesSection(book, input.notes ?? []), marksSection(book, input.annotations ?? []))

  const body = sections
    .map((section) => section.trimEnd())
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
  return `${body}\n`
}
