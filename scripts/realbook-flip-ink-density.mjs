// 翻页四帧的墨迹密度统计：把「窄带里还有没有字」从目视变成可复算的数字。
//
// 为什么单独一个脚本：验收报告里的百分比必须能被任何人重跑出来。坐标、阈值、
// 通道加权、分母与舍入全部写在下面，不依赖任何手工框选或临时 PowerShell。
//
// 用法：node scripts/realbook-flip-ink-density.mjs
// 输出：docs/img/realbook-flip-seam-2026-11-10-ink.txt（同时打印到终端）
//
// 口径：
//   - 只读 docs/img 下的四帧 PNG，不重新截图；图片由 scripts/realbook-flip-fps-e2e.mjs 生成。
//   - 亮度 = 0.2126R + 0.7152G + 0.0722B（Rec.709 加权，作用在 sRGB 编码值上，与报告一致）。
//   - 亮度 < INK_LUMINANCE 的像素记为「墨迹」。
//   - 每个区域按 INK_STEP 像素步长采样（x、y 同一步长），分母 = 实际采样到的像素数。
//   - 百分比保留一位小数，四舍五入。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inflateSync } from 'node:zlib'

const INK_LUMINANCE = 170
const INK_STEP = 2

/**
 * 每帧的统计区域。坐标固定写在代码里，来源是同一轮 run.log 的命中测试区间
 * （每帧三采样行纸面 x 区间的并集）。
 *
 * band：翻动中的竖带（这一块里有字就是「撕开一条」的读感）。
 * body：右页正文区（这一块必须明显有字，用来证明压暗没有误伤正文）。
 *
 * 这里**不设通过阈值**：密度是一个观察量，判据是报告里的 84°–91° 角域与亮度剖面，
 * 不是这两个数字。脚本只负责把可复算的数值打印出来。
 */
const FRAMES = [
  { index: 1, band: { x0: 694, x1: 812, y0: 60, y1: 620 } },
  { index: 2, band: { x0: 615, x1: 730, y0: 60, y1: 620 } },
  { index: 3, band: { x0: 523, x1: 704, y0: 60, y1: 620 } },
  { index: 4, band: { x0: 446, x1: 698, y0: 60, y1: 620 } },
]
const BODY = { x0: 760, x1: 1180, y0: 95, y1: 560 }

const IMG_DIR = join(process.cwd(), 'docs', 'img')
const OUT_FILE = join(IMG_DIR, 'realbook-flip-seam-2026-11-10-ink.txt')

/**
 * 最小 PNG 解码器：只支持 8 位、非隔行的灰度/灰度+alpha/RGB/RGBA。
 * Chromium 的截图都是这几种之一；遇到别的类型直接报错，不猜。
 */
function decodePng(buffer) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) throw new Error('不是 PNG 文件')
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}（只处理 8 位）`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let source = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]
    source += 1
    const rowStart = y * stride
    const previous = (y - 1) * stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x]
      const left = x >= channels ? pixels[rowStart + x - channels] : 0
      const up = y > 0 ? pixels[previous + x] : 0
      const upLeft = y > 0 && x >= channels ? pixels[previous + x - channels] : 0
      let out
      switch (filter) {
        case 0: out = value; break
        case 1: out = value + left; break
        case 2: out = value + up; break
        case 3: out = value + ((left + up) >> 1); break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const predicted = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft)
          out = value + predicted
          break
        }
        default: throw new Error(`未知的行滤波 ${filter}`)
      }
      pixels[rowStart + x] = out & 0xff
    }
    source += stride
  }
  return { width, height, channels, pixels }
}

function inkDensity(image, box) {
  const { width, height, channels, pixels } = image
  const x1 = Math.min(box.x1, width - 1)
  const y1 = Math.min(box.y1, height - 1)
  let total = 0
  let ink = 0
  for (let y = Math.max(0, box.y0); y <= y1; y += INK_STEP) {
    for (let x = Math.max(0, box.x0); x <= x1; x += INK_STEP) {
      const i = (y * width + x) * channels
      let luminance
      if (channels >= 3) luminance = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]
      else luminance = pixels[i]
      total += 1
      if (luminance < INK_LUMINANCE) ink += 1
    }
  }
  return { total, ink, percent: total ? Math.round((1000 * ink) / total) / 10 : 0 }
}

const lines = []
lines.push('真实书籍翻页四帧：墨迹密度统计')
lines.push(`生成方式：node scripts/realbook-flip-ink-density.mjs`)
lines.push(`输入目录：docs/img/realbook-flip-seam-2026-11-10-flip-1.png … -flip-4.png`)
lines.push(`亮度口径：0.2126R + 0.7152G + 0.0722B（Rec.709，作用在 sRGB 编码值上）`)
lines.push(`墨迹判定：亮度 < ${INK_LUMINANCE}`)
lines.push(`采样步长：${INK_STEP}px（x、y 同一步长；分母 = 该区域实际采样到的像素数）`)
lines.push(`舍入：百分比保留一位小数（四舍五入）`)
lines.push('')
lines.push('区域定义（写死在脚本里，坐标来源于同一轮 run.log 的命中测试区间）')
lines.push(`  正文区（右页）：x ${BODY.x0}..${BODY.x1}, y ${BODY.y0}..${BODY.y1}`)
for (const frame of FRAMES) {
  lines.push(`  帧 ${frame.index} 竖带：x ${frame.band.x0}..${frame.band.x1}, y ${frame.band.y0}..${frame.band.y1}`)
}
lines.push('')
lines.push('结果')
for (const frame of FRAMES) {
  const name = `realbook-flip-seam-2026-11-10-flip-${frame.index}.png`
  const image = decodePng(readFileSync(join(IMG_DIR, name)))
  const band = inkDensity(image, frame.band)
  const body = inkDensity(image, BODY)
  lines.push(
    `帧 ${frame.index}（${name}，${image.width}×${image.height}）\n`
    + `  竖带：分母 ${band.total} px，墨迹 ${band.ink} px，密度 ${band.percent.toFixed(1)}%\n`
    + `  正文：分母 ${body.total} px，墨迹 ${body.ink} px，密度 ${body.percent.toFixed(1)}%`,
  )
}
lines.push('')
lines.push('读法：竖带区域含纸边暗部与阴影，因此不会严格为 0；正文区是同一帧右页的正文段落，')
lines.push('用来看侧对压暗有没有误伤正常阅读相位。这两个数字是观察量，不充当验收验据。')

const text = lines.join('\n') + '\n'
mkdirSync(dirname(OUT_FILE), { recursive: true })
writeFileSync(OUT_FILE, text, 'utf8')
process.stdout.write(text)
process.stdout.write(`已写入 ${OUT_FILE}\n`)
