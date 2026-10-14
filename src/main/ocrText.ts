/**
 * 图片正文 / 字体混淆的兜底：把人眼能看见、DOM 里却不是字的正文交给 OCR。
 *
 * 两类站点在这里合流：
 *   1. 图片化正文：VIP 章整段用 `<img>` 切片贴出来，页面里没有文字。
 *   2. 字形替换（字体混淆）：DOM 里是私用区码点，只有渲染出来才是真字
 *      → 在页面里用页面自己的字体把这段文本画到 canvas，再当图片认。
 *
 * 引擎按需动态加载，没装 tesseract.js 时不报错、只给一句可读原因。
 * 语言包优先用仓库自带的 `chi_sim.traineddata` / `eng.traineddata`，离线可用。
 * 这条路默认关闭，按站点在「站点规则」里开。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface OcrImage {
  /** data:image/png;base64,... */
  dataUrl: string
  detail: string
}

export interface OcrText {
  text: string
  detail: string
}

/** 一章最多认多少张切片图：再多就是漫画，不是正文。 */
export const MAX_OCR_IMAGES = 12

/** 一张图最多多大（base64 字符数，约 2MB 原图）。 */
export const MAX_OCR_IMAGE_CHARS = 3_000_000

/** canvas 重绘每块最多这么多字。 */
export const MAX_CANVAS_CHARS = 800

/**
 * 在页面上下文里执行：带 cookie 取回切片图，并把被字体混淆的文本重绘成图。
 * 返回 JSON 字符串。
 */
export const PAGE_OCR_SCRIPT = `(async () => {
  var out = { images: [], redraw: [], note: '' };
  var SELECTORS = ['#content', '#chaptercontent', '#booktext', '#readbook', '.content', '.chapter-content', '.read-content', 'article'];
  var host = null;
  for (var s = 0; s < SELECTORS.length; s++) {
    try { host = document.querySelector(SELECTORS[s]); } catch (e) { host = null; }
    if (host) break;
  }
  if (!host) host = document.body;

  var toDataUrl = async function (src) {
    if (!src) return '';
    if (src.indexOf('data:image') === 0) return src;
    try {
      var res = await fetch(src, { credentials: 'include', cache: 'force-cache' });
      if (!res.ok) return '';
      var blob = await res.blob();
      if (!blob || blob.size === 0 || blob.size > 2500000) return '';
      return await new Promise(function (resolve) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { resolve(''); };
        reader.readAsDataURL(blob);
      });
    } catch (e) { return ''; }
  };

  try {
    var imgs = host.querySelectorAll('img');
    for (var i = 0; i < imgs.length && out.images.length < ${MAX_OCR_IMAGES}; i++) {
      var el = imgs[i];
      var src = el.currentSrc || el.src || '';
      if (!src) continue;
      if (el.naturalWidth && el.naturalWidth < 120) continue;
      if (el.naturalHeight && el.naturalHeight < 40) continue;
      var dataUrl = await toDataUrl(src);
      if (!dataUrl || dataUrl.length > ${MAX_OCR_IMAGE_CHARS}) continue;
      out.images.push({ src: dataUrl, alt: el.alt || '' });
    }
  } catch (e) {}

  try {
    var raw = host.innerText || host.textContent || '';
    var compact = raw.replace(/\\s+/g, '');
    var pua = compact.match(/[\\ue000-\\uf8ff]/g);
    if (pua && pua.length > 30 && pua.length / compact.length > 0.3) {
      try { await document.fonts.ready; } catch (e) {}
      var style = getComputedStyle(host);
      var font = (style.fontSize || '18px') + ' ' + (style.fontFamily || 'serif');
      var lineHeight = Math.max(24, parseInt(style.fontSize || '18', 10) * 1.8);
      var maxWidth = 900;
      for (var start = 0; start < raw.length; start += ${MAX_CANVAS_CHARS}) {
        if (out.redraw.length >= ${MAX_OCR_IMAGES}) break;
        var chunk = raw.slice(start, start + ${MAX_CANVAS_CHARS});
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        ctx.font = font;
        var lines = [];
        var line = '';
        for (var k = 0; k < chunk.length; k++) {
          var probe = line + chunk[k];
          if (ctx.measureText(probe).width > maxWidth) { lines.push(line); line = ''; }
          line += chunk[k];
        }
        if (line) lines.push(line);
        canvas.width = maxWidth + 24;
        canvas.height = lineHeight * Math.max(1, lines.length) + 24;
        ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000000';
        ctx.font = font;
        ctx.textBaseline = 'top';
        for (var l = 0; l < lines.length; l++) {
          ctx.fillText(lines[l], 12, 12 + l * lineHeight);
        }
        out.redraw.push(canvas.toDataURL('image/png'));
      }
    }
  } catch (e) {}

  return JSON.stringify(out);
})()`

/** 页面脚本带回来的图。重绘块放前面：字体混淆章通常没有图片正文。 */
export function parseOcrPayload(payload: string): { images: OcrImage[]; note: string } {
  const empty = { images: [] as OcrImage[], note: '' }
  const raw = (payload ?? '').trim()
  if (!raw.startsWith('{')) return empty
  try {
    const parsed = JSON.parse(raw) as {
      images?: Array<{ src?: string }>
      redraw?: string[]
      note?: string
    }
    const images: OcrImage[] = []
    for (const dataUrl of Array.isArray(parsed.redraw) ? parsed.redraw : []) {
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image')) {
        images.push({ dataUrl, detail: '字体混淆重绘' })
      }
    }
    for (const item of Array.isArray(parsed.images) ? parsed.images : []) {
      const src = item?.src
      if (typeof src === 'string' && src.startsWith('data:image')) {
        images.push({ dataUrl: src, detail: '图片正文' })
      }
    }
    return { images, note: typeof parsed.note === 'string' ? parsed.note : '' }
  } catch {
    return empty
  }
}

interface OcrWorkerLike {
  recognize: (image: string) => Promise<{ data?: { text?: string } }>
  terminate?: () => Promise<void>
}

let cachedWorker: OcrWorkerLike | null = null
let engineUnavailableReason: string | null = null

/**
 * 找自带语言包目录：仓库开发态、打包后的 resources 目录都试一遍。
 * 找不到就让引擎自己按默认方式取。
 */
export function langPathCandidates(): string[] {
  const roots: string[] = []
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resources) roots.push(join(resources, 'resources'), resources, join(resources, 'app.asar.unpacked'))
  roots.push(join(process.cwd(), 'resources'), process.cwd())
  return roots.filter((root) => root && hasLangPack(root))
}

/** 目录里有没有可用的中文语言包（`resources/` 下放的是 gzip 版，引擎直接吃）。 */
function hasLangPack(root: string): boolean {
  return (
    existsSync(join(root, 'chi_sim.traineddata.gz')) ||
    existsSync(join(root, 'chi_sim.traineddata'))
  )
}

async function getWorker(): Promise<OcrWorkerLike | null> {
  if (cachedWorker) return cachedWorker
  if (engineUnavailableReason) return null
  try {
    // 变量说明符：没装这个可选依赖时也不会把主进程编译搞崩
    const specifier = 'tesseract.js'
    const mod = (await import(specifier)) as unknown as {
      createWorker: (langs: string, oem?: number, opts?: Record<string, unknown>) => Promise<OcrWorkerLike>
    }
    const langPath = langPathCandidates()[0]
    const worker = await mod.createWorker('chi_sim+eng', undefined, langPath ? { langPath } : undefined)
    cachedWorker = worker
    return worker
  } catch (e) {
    engineUnavailableReason = `OCR 引擎启动失败：${e instanceof Error ? e.message : String(e)}`
    return null
  }
}

/** 引擎可用性：设置页与失败提示都用这一个判断。 */
export async function ocrEngineReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const worker = await getWorker()
  if (worker) return { ok: true }
  return { ok: false, reason: engineUnavailableReason ?? '没装 OCR 引擎（tesseract.js）' }
}


/**
 * OCR 后处理：tesseract 认中文时会在每个字之间插空格（实测「石 阶 尽 头」），
 * 汉字之间的空格要抹掉；英文/数字之间的空格保留。
 */
export function cleanOcrText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/(?<=[\u3400-\u9fff\uf900-\ufaff])[ \t]+(?=[\u3400-\u9fff\uf900-\ufaff])/g, '')
    .replace(/(?<=[\u3400-\u9fff\uf900-\ufaff])[ \t]+(?=[，。！？、：；“”‘’（）《》〈〉…—·])/g, '')
    .replace(/(?<=[，。！？、：；“”‘’（）《》〈〉…—·])[ \t]+(?=[\u3400-\u9fff\uf900-\ufaff])/g, '')
    // 「第 3 章」这类汉字夹数字：空格也去掉，拉丁字母之间的空格照旧保留
    .replace(/(?<=[\u3400-\u9fff\uf900-\ufaff])[ \t]+(?=\d)/g, '')
    .replace(/(?<=\d)[ \t]+(?=[\u3400-\u9fff\uf900-\ufaff])/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function writeTempPng(dataUrl: string, targetDir: string, index: number): Promise<string | null> {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  try {
    const buffer = Buffer.from(dataUrl.slice(comma + 1), 'base64')
    if (buffer.length === 0) return null
    await mkdir(targetDir, { recursive: true })
    const file = join(targetDir, `spbf-ocr-${Date.now()}-${index}.png`)
    await writeFile(file, buffer)
    return file
  } catch {
    return null
  }
}

/** OCR 认不出来的原因：分清楚是「没引擎」「页面没图」还是「认了但没认出字」。 */
export type OcrFailureReason = 'no-engine' | 'no-image' | 'all-failed'

export type OcrImagesResult =
  | { ok: true; text: string; detail: string; failed: number }
  | { ok: false; reason: OcrFailureReason; detail?: string }

/**
 * 认一组图，按顺序拼接。单张失败只跳过它——OCR 是兜底，不该把整章判死。
 * 临时图认完就删：以前会一直堆在 %TEMP%\spbf-ocr。
 */
export async function ocrImages(images: OcrImage[], tempDir: string): Promise<OcrImagesResult> {
  if (images.length === 0) return { ok: false, reason: 'no-image' }
  const worker = await getWorker()
  if (!worker) return { ok: false, reason: 'no-engine', detail: engineUnavailableReason ?? undefined }
  const parts: string[] = []
  const written: string[] = []
  let failed = 0
  try {
    for (let index = 0; index < images.length; index++) {
      const image = images[index]
      const file = await writeTempPng(image.dataUrl, tempDir, index)
      if (!file) {
        failed++
        continue
      }
      written.push(file)
      try {
        const result = await worker.recognize(file)
        const text = cleanOcrText(result?.data?.text ?? '')
        if (text.length >= 2) parts.push(text)
        else failed++
      } catch {
        failed++
      }
    }
  } finally {
    await Promise.all(written.map((file) => rm(file, { force: true }).catch(() => {})))
  }
  if (parts.length === 0) {
    const detail = engineUnavailableReason ?? undefined
    return { ok: false, reason: failed > 0 ? 'all-failed' : 'no-image', detail }
  }
  return { ok: true, text: parts.join('\n\n'), detail: images[0]?.detail ?? 'OCR', failed }
}

export async function shutdownOcrEngine(): Promise<void> {
  const worker = cachedWorker
  cachedWorker = null
  try {
    await worker?.terminate?.()
  } catch {
    /* 已经没了 */
  }
}

/** 测试注入假引擎，避免单测真的跑 WASM。 */
export function __setOcrEngineForTests(engine: OcrWorkerLike | null, reason?: string): void {
  cachedWorker = engine
  engineUnavailableReason = reason ?? null
}
