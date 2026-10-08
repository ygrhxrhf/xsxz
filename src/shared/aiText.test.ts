import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  normalizeSearchView,
  normalizedTerm,
  renderedParagraphs,
  retrievalTerms,
  scanViewTokens,
  tokenSet,
  tokenize,
} from './aiText'

/** 归一化必须与搬迁前的实现逐字符一致，否则既有引用坐标与记忆提示会集体漂移。 */
function legacyNormalizedSearchView(text: string): { text: string; originalOffsets: number[] } {
  let normalized = ''
  const originalOffsets: number[] = []
  let pendingWhitespaceOffset: number | null = null
  let utf16Offset = 0
  for (const character of text) {
    if (/\s/u.test(character)) {
      if (normalized && pendingWhitespaceOffset === null) pendingWhitespaceOffset = utf16Offset
      utf16Offset += character.length
      continue
    }
    if (pendingWhitespaceOffset !== null) {
      normalized += ' '
      originalOffsets.push(pendingWhitespaceOffset)
      pendingWhitespaceOffset = null
    }
    const lowered = character.toLocaleLowerCase()
    normalized += lowered
    for (let index = 0; index < lowered.length; index += 1) originalOffsets.push(utf16Offset)
    utf16Offset += character.length
  }
  return { text: normalized, originalOffsets }
}

const CORPUS = [
  '',
  '   ',
  '她把玉印交了出去。',
  '　　她把玉印　交了出去。\n',
  '顾清 推开了门\n\n  风从里面吹来。',
  'ABC abc123 123 😀笑',
  'ＡＢ全角与🙂表情混排',
  'line1\r\nline2\rline3',
  '\n\n只有一段',
  '甲\n\n\n\n乙',
]

describe('normalizeSearchView 搬迁等价', () => {
  it('与搬迁前的实现逐字符一致，包含偏移映射', () => {
    for (const text of CORPUS) {
      expect(normalizeSearchView(text)).toEqual(legacyNormalizedSearchView(text))
    }
  })

  it('空白折叠后的字符仍可映射回原始偏移', () => {
    const view = normalizeSearchView('她把 玉印\n\n交了出去')
    const position = view.text.indexOf('玉印')
    expect(view.text.slice(position, position + 2)).toBe('玉印')
    expect(view.originalOffsets[position]!).toBe(Array.from('她把 ').join('').length)
  })
})

describe('renderedParagraphs 段号真源', () => {
  it('与渲染层 splitIntoParagraphs 完全等价', () => {
    // 渲染规则：body.split(/\n{2,}/).filter(Boolean)，见 useTts.splitIntoParagraphs。
    for (const text of CORPUS) {
      expect(renderedParagraphs(text)).toEqual(text.split(/\n{2,}/).filter(Boolean))
    }
  })

  it('渲染层规则未被悄悄改动', async () => {
    const source = await readFile(new URL('../renderer/pages/useTts.ts', import.meta.url), 'utf-8')
    expect(source).toContain('return body.split(/\\n{2,}/).filter(Boolean)')
  })

  it('重复段落各占一个段号', () => {
    const body = '相同的一句话\n\n另一句\n\n相同的一句话'
    expect(renderedParagraphs(body)).toEqual(['相同的一句话', '另一句', '相同的一句话'])
  })
})

describe('tokenize 分词', () => {
  it('中日韩给出单字与相邻二元组', () => {
    expect(tokenize('她把玉印')).toEqual(['她', '把', '玉', '印', '她把', '把玉', '玉印'])
  })

  it('空白与标点都是词界，不跨段拼词', () => {
    expect(tokenize('她把 玉印，交了出去')).not.toContain('她把玉印')
    expect(tokenize('她把 玉印')).toEqual(['她', '把', '她把', '玉', '印', '玉印'])
  })

  it('单字成段时只出单字', () => {
    expect(tokenize('门')).toEqual(['门'])
  })

  it('字母数字按整词小写，代理对不拆坏', () => {
    expect(tokenize('Lv10 码头')).toEqual(['lv10', '码', '头', '码头'])
    expect(tokenize('😀')).toEqual([])
    expect(tokenize('😀她把')).toEqual(['她', '把', '她把'])
  })

  it('scanViewTokens 的位置是原始 UTF-16 偏移', () => {
    const view = normalizeSearchView('😀她把玉印')
    const found = scanViewTokens(view.text).find((token) => token.term === '她把')
    expect(found).toBeDefined()
    expect(view.text.slice(found!.at, found!.at + 2)).toBe('她把')
    expect(view.originalOffsets[found!.at]).toBe('😀'.length)
  })

  it('改述查询与原句共享单字，因此不再要求字面命中', () => {
    const sentence = tokenSet('她把玉印交给了码头的账房先生')
    const paraphrase = tokenize('玉印 交 给 账房')
    expect(paraphrase.every((term) => sentence.has(term))).toBe(true)
    expect(normalizedTerm('她把玉印交给了码头的账房先生')).not.toContain('玉印交给账房')
  })
})

describe('retrievalTerms 剪枝词形', () => {
  it('给出二元窗与词形，不给单字', () => {
    expect(retrievalTerms('她把玉印')).toEqual(new Set(['她把', '把玉', '玉印']))
    expect(retrievalTerms('玉')).toEqual(new Set())
    expect(retrievalTerms('')).toEqual(new Set())
  })

  it('拉丁词的子串命中不会被剪掉：v10 与 lv10 至少共享一个词形', () => {
    const chapter = retrievalTerms('她报了 Lv10 的编号')
    const query = retrievalTerms('v10')
    expect([...query].some((term) => chapter.has(term))).toBe(true)
    expect(chapter.has('lv10')).toBe(true)
  })

  it('逐段词形并集必被整章词形覆盖，布隆判「无」才可安全跳过读盘', () => {
    const body = '　　她把玉印交了出去。\n\n   \n门\n\n顾清 推开了门\n另一句\n\nLv10 码头'
    const chapter = retrievalTerms(body)
    for (const paragraph of renderedParagraphs(body)) {
      for (const term of retrievalTerms(normalizeSearchView(paragraph).text)) {
        expect(chapter.has(term), `段落词形「${term}」不在整章`).toBe(true)
      }
    }
  })
})
