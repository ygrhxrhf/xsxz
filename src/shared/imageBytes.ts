/**
 * 图片字节 → 尺寸/扩展名。
 *
 * 只读文件头，不解码整张图，导入/下载时拿它做「这张图能不能进书页」的判断。
 * 纯函数，主进程与测试环境都能用。
 */

interface ImageBytesInfo {
  width: number
  height: number
  /** 推荐扩展名（含点），与真实字节一致 */
  ext: '.jpg' | '.png' | '.webp' | '.gif'
}

const JPEG = '.jpg'
const PNG = '.png'
const WEBP = '.webp'
const GIF = '.gif'

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return Array.from(data.slice(offset, offset + length)).map((b) => String.fromCharCode(b)).join('')
}

export function imageBytesInfo(data: Uint8Array): ImageBytesInfo | null {
  if (!data || data.length < 12) return null
  const view = viewOf(data)
  if (data[0] === 0x89 && ascii(data, 1, 3) === 'PNG' && data.length > 24) {
    return { width: view.getUint32(16), height: view.getUint32(20), ext: PNG }
  }
  if (ascii(data, 0, 3) === 'GIF' && data.length > 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true), ext: GIF }
  }
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') {
    const chunk = ascii(data, 12, 4)
    if (chunk === 'VP8X' && data.length > 30) {
      return {
        width: 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16)),
        height: 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16)),
        ext: WEBP,
      }
    }
    if (chunk === 'VP8L' && data.length > 25) {
      const b = data
      return {
        width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!),
        height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! >> 6) & 0x03)),
        ext: WEBP,
      }
    }
    if (chunk === 'VP8 ' && data.length > 30) {
      const width = (data[26]! | (data[27]! << 8)) & 0x3fff
      const height = (data[28]! | (data[29]! << 8)) & 0x3fff
      if (width && height) return { width, height, ext: WEBP }
    }
    return null
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    const view2 = viewOf(data)
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue }
      const marker = data[offset + 1]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view2.getUint16(offset + 5), width: view2.getUint16(offset + 7), ext: JPEG }
      }
      const length = view2.getUint16(offset + 2)
      if (length < 2) break
      offset += 2 + length
    }
  }
  return null
}
