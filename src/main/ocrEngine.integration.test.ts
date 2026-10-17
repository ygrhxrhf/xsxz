import { afterEach, describe, expect, it } from 'vitest'
import { __setOcrEngineForTests, langPathCandidates, ocrEngineReady } from './ocrText'

/**
 * 真跑一次 tesseract.js（不 mock）。这是唯一能抓住「磁盘上有语言包、但引擎没把它吃进去」
 * 的检查：漏传 gzip、langPath 找错目录时，createWorker 不抛错（它把初始化异常吞了），
 * 只有引擎内的文件清单能证明它到底加载了什么。
 */
describe('本机 OCR 引擎（真实 tesseract.js）', () => {
  afterEach(() => __setOcrEngineForTests(null))

  it('用仓库自带的语言包把引擎真的起起来', async () => {
    expect(langPathCandidates().length).toBeGreaterThan(0)
    expect(await ocrEngineReady()).toEqual({ ok: true })
  }, 60_000)
})
