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
  const originalIndex = Number.isSafeInteger(originalParagraphIndex) && originalParagraphIndex >= 0
    ? originalParagraphIndex
    : 0
  const original = paragraphs[originalIndex]
  if (original !== undefined && normalizeMemorySourceText(original).includes(needle)) {
    return { paragraphIndex: originalIndex, mode: 'exact' }
  }

  const segments: Array<{ paragraphIndex: number; start: number; text: string }> = []
  let completeText = ''
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const text = normalizeMemorySourceText(paragraph)
    if (!text) return
    segments.push({ paragraphIndex, start: completeText.length, text })
    completeText += text
  })
  const matches: number[] = []
  let from = 0
  while (from <= completeText.length - needle.length) {
    const position = completeText.indexOf(needle, from)
    if (position < 0) break
    let paragraphIndex = segments[0]?.paragraphIndex ?? 0
    for (const segment of segments) {
      if (segment.start > position) break
      paragraphIndex = segment.paragraphIndex
    }
    matches.push(paragraphIndex)
    from = position + 1
  }
  if (!matches.length) return { paragraphIndex: 0, mode: 'fallback' }
  const unique = [...new Set(matches)]
  unique.sort((left, right) =>
    Math.abs(left - originalIndex) - Math.abs(right - originalIndex) || left - right)
  return { paragraphIndex: unique[0]!, mode: 'relocated' }
}
