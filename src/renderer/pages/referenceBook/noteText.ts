const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const words = new Intl.Segmenter(undefined, { granularity: 'word' })
const closing = /^[，。、；：！？）」』》〉】〕］｝”’,!?;:)\]}]/u
const opening = /[（「『《〈【〔［｛“‘([{]$/u

export const NOTE_LINE_HEIGHT = 1.35

export function noteFont(text: string) {
  // Use one face for Chinese letters AND punctuation, rather than Latin quotes
  // from Caveat next to Chinese glyphs from a platform-dependent fallback.
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u.test(text)
  return {
    cjk,
    family: cjk ? '"LXGW WenKai", "Kaiti SC", serif' : '"Caveat Variable", "Bradley Hand", cursive',
    weight: cjk ? 500 : 600,
  }
}

/** Wrap without relying on spaces; never split an emoji or combining sequence. */
export function wrapNoteText(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n').flatMap((paragraph) => {
    const chars = Array.from(graphemes.segment(paragraph), (s) => s.segment)
    const boundaries = new Set(Array.from(words.segment(paragraph), (s) => s.index + s.segment.length))
    const lines: string[] = []
    let offset = 0
    while (chars.length) {
      let fit = 0
      while (fit < chars.length && measure(chars.slice(0, fit + 1).join('')) <= maxWidth) fit++
      fit = Math.max(1, fit)
      let end = fit
      if (fit < chars.length) {
        // Prefer word boundaries and keep opening/closing punctuation with text.
        let length = 0
        let preferred = 0
        let legal = 0
        for (let i = 1; i <= fit; i++) {
          length += chars[i - 1].length
          if (!opening.test(chars[i - 1]) && !closing.test(chars[i])) {
            legal = i
            if (boundaries.has(offset + length)) preferred = i
          }
        }
        end = preferred || legal || fit
      }
      const line = chars.splice(0, end).join('')
      offset += line.length
      lines.push(line.trimEnd())
      while (chars.length && /^\s+$/u.test(chars[0])) offset += chars.shift()!.length
    }
    return lines.length ? lines : ['']
  })
}

export function ellipsizeNoteText(text: string, maxWidth: number, measure: (text: string) => number) {
  const chars = Array.from(graphemes.segment(text.trimEnd()), (s) => s.segment)
  while (chars.length && measure(chars.join('') + '…') > maxWidth) chars.pop()
  return chars.join('').trimEnd() + '…'
}


