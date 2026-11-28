import { describe, expect, it } from 'vitest'
import { chapterNumberIn, firstChapterUrl } from './browseCatalog'

describe('chapterNumberIn', () => {
  it('识破阿拉伯数字与全角数字', () => {
    expect(chapterNumberIn('第781章 娜塔莉日记⑤（大结局）')).toBe(781)
    expect(chapterNumberIn('第 12 节 夜行')).toBe(12)
    expect(chapterNumberIn('第９９回 归途')).toBe(99)
  })

  it('认得中文数字，含「十」「百」这类组合', () => {
    expect(chapterNumberIn('第三章 归途')).toBe(3)
    expect(chapterNumberIn('第十章 夜行')).toBe(10)
    expect(chapterNumberIn('第二十三章 出发')).toBe(23)
    expect(chapterNumberIn('第一百零五章 抵达')).toBe(105)
    expect(chapterNumberIn('第一千零二章 终局')).toBe(1002)
  })

  it('标题里没有章号就返回 null，不含糊猜一个', () => {
    expect(chapterNumberIn('楔子')).toBeNull()
    expect(chapterNumberIn('序章')).toBeNull()
    expect(chapterNumberIn('')).toBeNull()
    expect(chapterNumberIn('娜塔莉日记⑤（大结局）')).toBeNull()
  })
})

describe('firstChapterUrl', () => {
  it('倒序目录里取章号最小的一条，而不是物理第一条', () => {
    // 真实站点的形状：最新章节打头，序号一路倒着排
    const chapters = [
      { title: '第781章 娜塔莉日记⑤（大结局）', url: 'https://x/908.html' },
      { title: '第780章 不是我不给你机会（4）', url: 'https://x/906.html' },
      { title: '第90章 蓝羽军立（上）', url: 'https://x/99.html' },
      { title: '第1章 楔子', url: 'https://x/1.html' },
      { title: '第2章 出发', url: 'https://x/2.html' },
    ]
    expect(firstChapterUrl(chapters)).toBe('https://x/1.html')
  })

  it('正序目录同样正确', () => {
    const chapters = [
      { title: '第1章 楔子', url: 'https://x/1.html' },
      { title: '第2章 出发', url: 'https://x/2.html' },
    ]
    expect(firstChapterUrl(chapters)).toBe('https://x/1.html')
  })

  it('一条章号都认不出时退回物理第一条', () => {
    const chapters = [
      { title: '楔子', url: 'https://x/a.html' },
      { title: '序章', url: 'https://x/b.html' },
    ]
    expect(firstChapterUrl(chapters)).toBe('https://x/a.html')
  })

  it('空目录返回 null，不编一个地址出来', () => {
    expect(firstChapterUrl([])).toBeNull()
  })
})