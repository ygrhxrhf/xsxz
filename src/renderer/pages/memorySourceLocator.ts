export type MemorySourceLocation =
  | { paragraphIndex: number; mode: 'exact' }
  | { paragraphIndex: number; mode: 'relocated' }
  | { paragraphIndex: 0; mode: 'fallback' }

export function normalizeMemorySourceText(text: string): string {
  return text.replace(/\s+/g, '')
}

export function locateMemorySourceParagraph(
  paragraphs: readonly string[],
  originalParagraphIndex: number,
  excerpt: string,
): MemorySourceLocation {
  const needle = normalizeMemorySourceText(excerpt)
  if (!needle) return { paragraphIndex: 0, mode: 'fallback' }
  const original = paragraphs[originalParagraphIndex]
  if (original !== undefined && normalizeMemorySourceText(original).includes(needle)) {
    return { paragraphIndex: originalParagraphIndex, mode: 'exact' }
  }
  const matches: number[] = []
  paragraphs.forEach((paragraph, index) => {
    if (normalizeMemorySourceText(paragraph).includes(needle)) matches.push(index)
  })
  if (!matches.length) return { paragraphIndex: 0, mode: 'fallback' }
  matches.sort((left, right) =>
    Math.abs(left - originalParagraphIndex) - Math.abs(right - originalParagraphIndex) || left - right)
  return { paragraphIndex: matches[0]!, mode: 'relocated' }
}
