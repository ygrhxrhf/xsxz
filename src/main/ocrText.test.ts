import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_OCR_IMAGES,
  OCR_LANGS,
  PAGE_OCR_SCRIPT,
  __setOcrEngineForTests,
  hasLangPack,
  langPackStatus,
  langPathCandidates,
  missingLangPacks,
  ocrEngineReady,
  cleanOcrText,
  ocrImages,
  parseOcrPayload,
} from './ocrText'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+g6wAAAAASUVORK5CYII='

function fakeEngine(textByCall: string[]): {
  calls: number
  recognize: () => Promise<{ data: { text: string } }>
} {
  const engine = {
    calls: 0,
    async recognize(): Promise<{ data: { text: string } }> {
      const index = engine.calls++
      return { data: { text: textByCall[index] ?? '' } }
    },
  }
  return engine
}

afterEach(() => {
  __setOcrEngineForTests(null)
})

describe('页面 OCR 脚本', () => {
  it('带 cookie 取图、等字体就绪、只在私用区乱码时重绘', () => {
    expect(PAGE_OCR_SCRIPT).toContain("credentials: 'include'")
    expect(PAGE_OCR_SCRIPT).toContain('document.fonts.ready')
    expect(PAGE_OCR_SCRIPT).toContain('\\ue000-\\uf8ff')
    expect(PAGE_OCR_SCRIPT).toContain("toDataURL('image/png')")
    expect(PAGE_OCR_SCRIPT).toContain('FileReader')
    expect(PAGE_OCR_SCRIPT).not.toContain('${')
  })
})

describe('页面脚本返回值解析', () => {
  it('字体混淆重绘排在图片正文前面', () => {
    const payload = JSON.stringify({ redraw: [PNG], images: [{ src: PNG }, { src: 'https://cdn/a.png' }] })
    const { images } = parseOcrPayload(payload)
    expect(images.map((image) => image.detail)).toEqual(['字体混淆重绘', '图片正文'])
    expect(images).toHaveLength(2)
  })

  it('非 data:image 的东西一律不收', () => {
    const payload = JSON.stringify({ redraw: ['http://x/a.png'], images: [{ src: 'blob:http://x/y' }] })
    expect(parseOcrPayload(payload).images).toEqual([])
  })

  it('坏 JSON 当空结果', () => {
    expect(parseOcrPayload('不是 JSON').images).toEqual([])
    expect(parseOcrPayload('[1,2]').images).toEqual([])
    expect(parseOcrPayload('').images).toEqual([])
  })
})

describe('OCR 认字', () => {
  it('多张图按顺序拼接，中间空行分段', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spbf-ocr-'))
    try {
      const engine = fakeEngine(['第一段正文', '第二段正文'])
      __setOcrEngineForTests(engine)
      const result = await ocrImages(
        [
          { dataUrl: PNG, detail: '图片正文' },
          { dataUrl: PNG, detail: '图片正文' },
        ],
        dir,
      )
      expect(result.ok && result.text).toBe('第一段正文\n\n第二段正文')
      expect(engine.calls).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('单张失败只跳过那一张', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spbf-ocr-'))
    try {
      const engine = {
        calls: 0,
        async recognize(): Promise<{ data: { text: string } }> {
          engine.calls++
          if (engine.calls === 1) throw new Error('这张图坏了')
          return { data: { text: '后面这张认出来了' } }
        },
      }
      __setOcrEngineForTests(engine)
      const result = await ocrImages(
        [
          { dataUrl: PNG, detail: '图片正文' },
          { dataUrl: PNG, detail: '图片正文' },
        ],
        dir,
      )
      expect(result.ok && result.text).toBe('后面这张认出来了')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('没有图、没有引擎都给出原因码（不抛）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spbf-ocr-'))
    try {
      __setOcrEngineForTests(fakeEngine(['x']))
      expect(await ocrImages([], dir)).toEqual({ ok: false, reason: 'no-image' })
      __setOcrEngineForTests(null, '引擎没装')
      const missing = await ocrImages([{ dataUrl: PNG, detail: '图片正文' }], dir)
      expect(missing.ok).toBe(false)
      expect(!missing.ok && missing.reason).toBe('no-engine')
      expect(!missing.ok && missing.detail).toBe('引擎没装')
      const status = await ocrEngineReady()
      expect(status.ok).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('认完就把临时图删掉，不留在 %TEMP%', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spbf-ocr-'))
    try {
      __setOcrEngineForTests(fakeEngine(['认出来的字']))
      const result = await ocrImages([{ dataUrl: PNG, detail: '图片正文' }], dir)
      expect(result.ok).toBe(true)
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('注入引擎后状态为可用', async () => {
    __setOcrEngineForTests(fakeEngine(['x']))
    expect(await ocrEngineReady()).toEqual({ ok: true })
  })

  it('语言包不齐时 ocrEngineReady 如实报出缺哪个语言，而不是宣称可用', async () => {
    // 空目录：一个语言包都没有
    const dir = await mkdtemp(join(tmpdir(), 'spbf-ocr-reason-'))
    try {
      const none = langPackStatus([dir])
      expect(none.ok).toBe(false)
      if (!none.ok) expect(none.reason).toContain('chi_sim')

      // 只补 eng：仍不够（引擎要 chi_sim+eng），原因要指名 chi_sim
      await writeFile(join(dir, 'eng.traineddata.gz'), 'x')
      const partial = langPackStatus([dir])
      expect(partial.ok).toBe(false)
      if (!partial.ok) {
        expect(partial.reason).toContain('chi_sim')
        expect(partial.reason).toContain('联网下载')
      }

      // 两个都齐：可用
      await writeFile(join(dir, 'chi_sim.traineddata.gz'), 'x')
      expect(langPackStatus([dir])).toEqual({ ok: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('一个语言包目录都没有时，原因指向安装包完整性', () => {
    const status = langPackStatus([])
    expect(status.ok).toBe(false)
    if (!status.ok) expect(status.reason).toContain('重新安装')
  })

  it('语言包目录能认到仓库自带的那份', () => {
    const found = langPathCandidates()
    expect(found.length).toBeGreaterThan(0)
    expect(found.some((dir) => dir.includes('xsxz') || dir === process.cwd())).toBe(true)
  })

  it('hasLangPack 要求引擎真正要用的两个语言包都在，且认 .gz 与解压两种形态', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spbf-ocr-lang-'))
    try {
      expect(hasLangPack(dir)).toBe(false)
      await writeFile(join(dir, 'chi_sim.traineddata.gz'), 'x')
      // 只有 chi_sim：引擎要的是 chi_sim+eng，缺一个就够不上离线可用
      expect(hasLangPack(dir)).toBe(false)
      await writeFile(join(dir, 'eng.traineddata.gz'), 'x')
      expect(hasLangPack(dir)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }

    const dir2 = await mkdtemp(join(tmpdir(), 'spbf-ocr-lang-'))
    try {
      // 解压后的 .traineddata 同样认
      await writeFile(join(dir2, 'chi_sim.traineddata'), 'x')
      await writeFile(join(dir2, 'eng.traineddata'), 'x')
      expect(hasLangPack(dir2)).toBe(true)
      expect(missingLangPacks(dir2)).toEqual([])
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  })

  it('missingLangPacks 说清缺哪一个语言包', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spbf-ocr-missing-'))
    try {
      expect(missingLangPacks(dir)).toEqual(['chi_sim', 'eng'])
      await writeFile(join(dir, 'eng.traineddata.gz'), 'x')
      expect(missingLangPacks(dir)).toEqual(['chi_sim'])
      expect(hasLangPack(dir)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('OCR_LANGS 与引擎实际加载的语言一致', () => {
    expect([...OCR_LANGS]).toEqual(['chi_sim', 'eng'])
  })

  it('一章最多认这么多张图', () => {
    expect(MAX_OCR_IMAGES).toBeGreaterThanOrEqual(6)
    expect(MAX_OCR_IMAGES).toBeLessThanOrEqual(24)
  })
})

describe('OCR 后处理', () => {
  it('抹掉 tesseract 在汉字之间插的空格（照真实识别结果）', () => {
    const real =
      '石 阶 尽 头 的 石门 半 开 ， 门 缝 里 透 出 一 线 红 黄 的 灯 。\n林 舟 把 伞 收 拢 ， 拌 落 肩 上 的 雪 ， 抬 脚 踏 进 去 。'
    const cleaned = cleanOcrText(real)
    expect(cleaned).toContain('石阶尽头的石门半开')
    expect(cleaned).toContain('林舟把伞收拢')
    expect(cleaned.split('\n')[0]).not.toContain(' ')
  })

  it('英文与数字之间的空格保留', () => {
    expect(cleanOcrText('HTTP 404 not found')).toBe('HTTP 404 not found')
    expect(cleanOcrText('第 3 章 入门')).toBe('第3章入门')
  })
})
