import { describe, expect, it } from 'vitest'
import { indexingText, queueWaitingText } from './aiStageCopy'

describe('ai.stage 进度文案', () => {
  it('排队时说「前面还有几个」，第一位不谎报数字', () => {
    expect(queueWaitingText(1)).toBe('已排队，正在等待当前任务让路')
    expect(queueWaitingText(2)).toBe('已排队，前面还有 1 个任务')
    expect(queueWaitingText(5)).toBe('已排队，前面还有 4 个任务')
    expect(queueWaitingText(1), '排队文案不得出现「0 个任务」').not.toContain('0 个任务')
  })

  it('索引没建好时承认通读全部已读正文，建好后报覆盖度与本次读盘数', () => {
    expect(indexingText({ indexed: 0, total: 812, read: 812 })).toBe('检索索引还没建好，本次通读 812 章已读正文')
    expect(indexingText({ indexed: 812, total: 812, read: 9 })).toBe('检索索引已覆盖 812/812 章，本次只读 9 章')
    expect(indexingText({ indexed: 120, total: 812, read: 24 })).toBe('检索索引已覆盖 120/812 章，本次只读 24 章')
  })
})
