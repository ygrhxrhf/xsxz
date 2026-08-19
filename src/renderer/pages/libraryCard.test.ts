import { describe, expect, it } from 'vitest'
import {
  applyAddedChapterCount,
  checkUpdateMessage,
  hasFailedChapters,
  isDownloadBook,
} from './libraryCard'

describe('library check-update card helpers', () => {
  it('shows 检查更新 only for download books', () => {
    expect(isDownloadBook({ importType: 'download' })).toBe(true)
    expect(isDownloadBook({ importType: 'txt' })).toBe(false)
    expect(isDownloadBook({ importType: 'epub' })).toBe(false)
  })

  it('keeps 重试失败章 on partial download cards only', () => {
    expect(
      hasFailedChapters({ status: 'partial', readyCount: 2, chapterCount: 6 }),
    ).toBe(true)
    expect(
      hasFailedChapters({ status: 'ready', readyCount: 6, chapterCount: 6 }),
    ).toBe(false)
    expect(
      hasFailedChapters({ status: 'partial', readyCount: 6, chapterCount: 6 }),
    ).toBe(false)
  })

  it('maps checkUpdate results to exact Chinese strings', () => {
    expect(checkUpdateMessage({ ok: true, added: 3 })).toBe('新增 3 章')
    expect(checkUpdateMessage({ ok: true, added: 0 })).toBe('没有更新')
    expect(
      checkUpdateMessage({
        ok: false,
        message: '已有下载任务在进行中，请等待完成或取消后再试',
      }),
    ).toBe('已有下载任务在进行中，请等待完成或取消后再试')
    expect(
      checkUpdateMessage({
        ok: false,
        message: '无原始目录地址，无法检查更新',
      }),
    ).toBe('无原始目录地址，无法检查更新')
  })

  it('bumps chapterCount by added when new chapters exist', () => {
    expect(applyAddedChapterCount(6, 1)).toBe(7)
    expect(applyAddedChapterCount(6, 0)).toBe(6)
  })
})
