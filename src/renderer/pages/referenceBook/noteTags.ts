import { noteFontIdOf } from './noteFontCatalog'
import { noteTextColorOf, type StickyNote } from './annotations'

/** How many labels one sticky note can carry. */
export const NOTE_TAG_LIMIT = 5
/** Graphemes, so an emoji or a Chinese character each count as one. */
export const NOTE_TAG_MAX_GRAPHEMES = 24

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function clipGraphemes(raw: string, max: number) {
  const chars = Array.from(graphemes.segment(raw), (s) => s.segment)
  return chars.length <= max ? raw : chars.slice(0, max).join('')
}

/** A tag is a short label. Leading hashes are decoration, not part of the stored value. */
export function normalizeNoteTag(raw: string): string | null {
  const cleaned = raw.replace(/[\r\n]+/g, ' ').trim().replace(/^(?:[#＃]+\s*)+/u, '').trim().replace(/\s+/g, ' ')
  const text = clipGraphemes(cleaned, NOTE_TAG_MAX_GRAPHEMES).trim()
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return null
  return text
}

export function noteTagKey(tag: string) {
  return tag.toLocaleLowerCase()
}

/** Drop blanks and duplicates and keep at most NOTE_TAG_LIMIT, preserving the first spelling. */
export function sanitizeNoteTags(raw: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const tag = normalizeNoteTag(item)
    if (!tag) continue
    const key = noteTagKey(tag)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length === NOTE_TAG_LIMIT) break
  }
  return out
}

/** Commas commit a tag. The last piece is still being typed. */
export function splitTagDraft(raw: string): { ready: string[]; rest: string } {
  const parts = raw.split(/[,，、]/u)
  const rest = parts.pop() ?? ''
  return { ready: parts, rest }
}

/** Returns the same array when nothing was added. */
export function addNoteTags(tags: readonly string[], raw: string): string[] {
  const { ready, rest } = splitTagDraft(raw)
  const pieces = rest.trim() ? [...ready, rest] : ready
  if (!pieces.length) return tags as string[]
  const next = sanitizeNoteTags([...tags, ...pieces])
  if (next.length === tags.length && next.every((tag, i) => tag === tags[i])) return tags as string[]
  return next
}

/** An empty edit removes the tag. Renaming onto an existing tag drops the edited one. */
export function replaceNoteTag(tags: readonly string[], index: number, raw: string): string[] {
  if (index < 0 || index >= tags.length) return tags as string[]
  const tag = normalizeNoteTag(raw)
  if (!tag) return tags.filter((_, i) => i !== index)
  if (tag === tags[index]) return tags as string[]
  const key = noteTagKey(tag)
  if (tags.some((item, i) => i !== index && noteTagKey(item) === key)) return tags.filter((_, i) => i !== index)
  const next = tags.slice()
  next[index] = tag
  return next
}

export function removeNoteTag(tags: readonly string[], index: number): string[] {
  if (index < 0 || index >= tags.length) return tags as string[]
  return tags.filter((_, i) => i !== index)
}

/** Note anchor stored by the signed-in API. Tags are omitted when the note has none. */
export function noteWireAnchor(note: Pick<StickyNote, 'rot' | 'tags' | 'textColor' | 'font'>, locator: { chapter: number; start: number; end: number }) {
  const anchor: Record<string, unknown> = { chapter: locator.chapter, start: locator.start, end: locator.end, rot: note.rot }
  if (note.tags?.length) anchor.tags = note.tags
  const textColor = noteTextColorOf(note.textColor)
  if (textColor !== 'default') anchor.textColor = textColor
  const font = noteFontIdOf(note.font)
  if (font !== 'inherit') anchor.font = font
  return anchor
}

export function noteTagsFromAnchor(anchor: Record<string, unknown> | null | undefined): string[] | undefined {
  const raw = anchor?.tags
  if (!Array.isArray(raw)) return undefined
  const tags = sanitizeNoteTags(raw.filter((item): item is string => typeof item === 'string'))
  return tags.length ? tags : undefined
}


