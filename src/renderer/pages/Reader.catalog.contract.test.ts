import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Reader catalog badges', () => {
  it('uses catalogChapterBadge and Chinese status labels', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain('catalogChapterBadge')
    expect(source).toContain("catalogBadge(ch) === 'failed'")
    expect(source).toContain("catalogBadge(ch) === 'pending'")
    expect(source).toContain("catalogBadge(ch) === 'empty'")
    expect(source).toContain("catalogBadge(ch) === 'current'")
    expect(source).toContain("catalogBadge(ch) === 'read'")
    expect(source).toContain('FAIL_CODE_ZH')
    expect(source).toContain('未下')
    expect(source).toContain('空')
    expect(source).toContain('当前')
    expect(source).toContain('已读')
    expect(source).toContain('失败')
    expect(source).toContain("['ch-item', { active: ch.id === currentChapter?.id }]")
    expect(source).toContain('progressChapterId: book.value?.progress?.chapterId')
  })
})
