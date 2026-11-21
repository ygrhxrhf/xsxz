/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/cover.ts，Apache-2.0。已修改：文件改名并内联 hash/rng，接入 spbf。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */
import * as THREE from 'three'
function hash(str: string) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function rng(seed: number) {
  let a = seed || 1
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface CoverSet {
  outer: THREE.Texture
  outerBump: THREE.Texture
  inner: THREE.Texture
  cloth: THREE.Color
  glossy: boolean
  /** representative colour of the cover, used for the closed-book spine / sticky glue shadows */
  accent: string
}

const CW = 1024
const CH = 1486
const PALETTE = ['#1f3b2e', '#5a1f27', '#1d2c4a', '#4a3322', '#2f2a44', '#3b4a3a', '#6b3a1e']

function tex(canvas: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(canvas)
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  t.needsUpdate = true
  return t
}

function weave(c: CanvasRenderingContext2D, w: number, h: number, alpha: number, seed: number) {
  const r = rng(seed)
  c.save()
  c.globalAlpha = alpha
  for (let y = 0; y < h; y += 3) {
    c.fillStyle = r() > 0.5 ? '#000' : '#fff'
    c.fillRect(0, y, w, 1)
  }
  for (let x = 0; x < w; x += 3) {
    c.fillStyle = r() > 0.5 ? '#000' : '#fff'
    c.fillRect(x, 0, 1, h)
  }
  c.restore()
}

function groove(c: CanvasRenderingContext2D, x: number, h: number, alpha: number) {
  const g = c.createLinearGradient(x - 14, 0, x + 14, 0)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(0.45, `rgba(0,0,0,${alpha})`)
  g.addColorStop(0.55, `rgba(255,255,255,${alpha * 0.18})`)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  c.fillStyle = g
  c.fillRect(x - 14, 0, 28, h)
}

export function makeCover(title: string, author: string, bmp: ImageBitmap | null, family: string): CoverSet {
  const seed = hash(title)
  const base = PALETTE[seed % PALETTE.length]

  // ----- outer face. Drawn as seen from above on a closed book (spine at the left edge).
  const outer = document.createElement('canvas')
  outer.width = CW
  outer.height = CH
  const c = outer.getContext('2d')!
  const bump = document.createElement('canvas')
  bump.width = CW
  bump.height = CH
  const b = bump.getContext('2d')!
  b.fillStyle = '#808080'
  b.fillRect(0, 0, CW, CH)
  let clothColor = new THREE.Color(base)

  if (bmp) {
    const s = Math.max(CW / bmp.width, CH / bmp.height)
    const w = bmp.width * s
    const h = bmp.height * s
    c.drawImage(bmp, (CW - w) / 2, (CH - h) / 2, w, h)
    const px = document.createElement('canvas')
    px.width = px.height = 1
    px.getContext('2d')!.drawImage(bmp, 0, 0, 1, 1)
    const d = px.getContext('2d')!.getImageData(0, 0, 1, 1).data
    clothColor = new THREE.Color(`rgb(${d[0]},${d[1]},${d[2]})`).multiplyScalar(0.55)
  } else {
    c.fillStyle = base
    c.fillRect(0, 0, CW, CH)
    const g = c.createRadialGradient(CW * 0.4, CH * 0.35, 80, CW / 2, CH / 2, CH * 0.8)
    g.addColorStop(0, 'rgba(255,255,255,0.10)')
    g.addColorStop(1, 'rgba(0,0,0,0.28)')
    c.fillStyle = g
    c.fillRect(0, 0, CW, CH)
    // blind-stamped frame
    c.strokeStyle = 'rgba(214,176,98,0.85)'
    c.lineWidth = 5
    c.strokeRect(86, 96, CW - 152, CH - 192)
    c.lineWidth = 2
    c.strokeRect(104, 114, CW - 188, CH - 228)
    b.strokeStyle = '#fff'
    b.lineWidth = 5
    b.strokeRect(86, 96, CW - 152, CH - 192)
    // title
    const gold = c.createLinearGradient(0, 400, 0, 760)
    gold.addColorStop(0, '#f6dd9a')
    gold.addColorStop(0.5, '#c79a42')
    gold.addColorStop(1, '#8e6420')
    c.fillStyle = gold
    b.fillStyle = '#fff'
    c.textAlign = b.textAlign = 'center'
    const maxW = CW - 300
    let size = 86
    const words = title.split(' ')
    const wrap = (sz: number) => {
      c.font = `540 ${sz}px ${family}`
      const lines: string[] = []
      let cur = ''
      for (const w of words) {
        const t = cur ? cur + ' ' + w : w
        if (c.measureText(t).width > maxW && cur) {
          lines.push(cur)
          cur = w
        } else cur = t
      }
      lines.push(cur)
      return lines
    }
    let lines = wrap(size)
    while (lines.length > 4 && size > 46) lines = wrap((size -= 6))
    let y = CH * 0.36 - ((lines.length - 1) * size * 1.15) / 2
    for (const l of lines) {
      c.font = b.font = `540 ${size}px ${family}`
      c.fillText(l, CW / 2 + 20, y)
      b.fillText(l, CW / 2 + 20, y)
      y += size * 1.15
    }
    c.font = b.font = `italic 440 40px ${family}`
    c.fillText(author, CW / 2 + 20, CH * 0.72)
    b.fillText(author, CW / 2 + 20, CH * 0.72)
    weave(c, CW, CH, 0.16, seed)
    weave(b, CW, CH, 0.4, seed + 1)
  }
  // hinge groove, edge wear
  groove(c, 66, CH, 0.55)
  groove(b, 66, CH, 0.9)
  const wear = c.createLinearGradient(0, 0, CW, 0)
  wear.addColorStop(0, 'rgba(0,0,0,0.18)')
  wear.addColorStop(0.03, 'rgba(0,0,0,0)')
  wear.addColorStop(0.97, 'rgba(0,0,0,0)')
  wear.addColorStop(1, 'rgba(255,255,255,0.08)')
  c.fillStyle = wear
  c.fillRect(0, 0, CW, CH)

  // ----- inner face: neutral, uncoated paper. The board material supplies the selected tint.
  const inner = document.createElement('canvas')
  inner.width = 768
  inner.height = 1114
  const i = inner.getContext('2d')!
  const r = rng(1709)
  i.fillStyle = '#f7f7f7'
  i.fillRect(0, 0, 768, 1114)
  // Short fibers stay subtle at reading distance and disappear cleanly into the mipmaps.
  for (let k = 0; k < 36000; k++) {
    i.fillStyle = r() > 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.1)'
    i.fillRect(r() * 768, r() * 1114, 0.5 + r(), 1 + r() * 2)
  }
  groove(i, 50, 1114, 0.18)
  const vg = i.createLinearGradient(0, 0, 768, 0)
  vg.addColorStop(0, 'rgba(0,0,0,0.08)')
  vg.addColorStop(0.06, 'rgba(0,0,0,0)')
  i.fillStyle = vg
  i.fillRect(0, 0, 768, 1114)

  const outerTex = tex(outer)
  const innerTex = tex(inner)
  const bumpTex = tex(bump, false)
  return {
    outer: outerTex,
    outerBump: bumpTex,
    inner: innerTex,
    cloth: clothColor,
    glossy: !!bmp,
    accent: '#' + clothColor.getHexString(),
  }
}
