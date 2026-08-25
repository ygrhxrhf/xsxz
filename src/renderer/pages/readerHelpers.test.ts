import { describe, expect, it } from 'vitest'
import { failAdvice, formatCharacterCard, resolveReaderKey } from './readerHelpers'

describe('resolveReaderKey', () => {
  it('maps arrow keys to chapter navigation', () => {
    expect(resolveReaderKey({ key: 'ArrowLeft' })).toBe('prev-chapter')
    expect(resolveReaderKey({ key: 'ArrowRight' })).toBe('next-chapter')
  })

  it('maps space to paging, shift+space back up', () => {
    expect(resolveReaderKey({ key: ' ' })).toBe('page-down')
    expect(resolveReaderKey({ key: ' ', shift: true })).toBe('page-up')
  })

  it('maps +/-/=/_ to font size, including numpad-style =', () => {
    expect(resolveReaderKey({ key: '+' })).toBe('font-larger')
    expect(resolveReaderKey({ key: '=' })).toBe('font-larger')
    expect(resolveReaderKey({ key: '-' })).toBe('font-smaller')
    expect(resolveReaderKey({ key: '_' })).toBe('font-smaller')
  })

  it('ignores keys while typing in inputs or contenteditable', () => {
    expect(resolveReaderKey({ key: ' ', targetTag: 'input' })).toBeNull()
    expect(resolveReaderKey({ key: 'ArrowRight', targetTag: 'textarea' })).toBeNull()
    expect(resolveReaderKey({ key: '-', isContentEditable: true })).toBeNull()
  })

  it('ignores ctrl/cmd combos so browser zoom keeps working', () => {
    expect(resolveReaderKey({ key: '+', ctrlOrMeta: true })).toBeNull()
    expect(resolveReaderKey({ key: 'ArrowLeft', ctrlOrMeta: true })).toBeNull()
  })

  it('while a drawer is open only Escape does something', () => {
    expect(resolveReaderKey({ key: 'Escape', anyDrawerOpen: true })).toBe('close-drawer')
    expect(resolveReaderKey({ key: ' ', anyDrawerOpen: true })).toBeNull()
    expect(resolveReaderKey({ key: 'ArrowRight', anyDrawerOpen: true })).toBeNull()
  })

  it('returns null for unrelated keys', () => {
    expect(resolveReaderKey({ key: 'a' })).toBeNull()
    expect(resolveReaderKey({ key: 'F5' })).toBeNull()
  })
})

describe('failAdvice', () => {
  it('stays silent for codes without advice', () => {
    expect(failAdvice(undefined)).toBe('')
    expect(failAdvice('CatalogNotFound')).toBe('')
  })
})

describe('formatCharacterCard', () => {
  it('renders characters and foreshadows with chapter label', () => {
    const text = formatCharacterCard(
      {
        uptoChapterId: 'c0003',
        characters: [{ name: '张若尘', role: '主角', relations: '池瑶的未婚夫' }],
        foreshadows: [{ desc: '九转轮回诀', where: '第一章', open: true }],
      },
      (id) => (id === 'c0003' ? '第 3 章 入门' : id),
    )
    expect(text).toContain('截至：第 3 章 入门')
    expect(text).toContain('【人物】')
    expect(text).toContain('· 张若尘 （主角）；池瑶的未婚夫')
    expect(text).toContain('【伏笔】')
    expect(text).toContain('九转轮回诀（首次出现：第一章） [未回收]')
  })

  it('falls back to raw output when nothing parsed', () => {
    expect(formatCharacterCard({ raw: '模型直接写的文字' })).toBe('模型直接写的文字')
    expect(formatCharacterCard({})).toBe('（人物卡为空）')
  })
})
