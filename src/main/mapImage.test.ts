import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bookDir, createBookFromBootstrap, setLibraryPath } from './library'
import { getMapImage, mapImageExtension, setMapImage } from './mapImage'

describe('mapImage 文件类型', () => {
  it('接受 jpg / jpeg / png / webp，大小写不敏感', () => {
    expect(mapImageExtension('C:\\maps\\city.JPG')).toBe('jpg')
    expect(mapImageExtension('/tmp/city.jpeg')).toBe('jpeg')
    expect(mapImageExtension('/tmp/city.png')).toBe('png')
    expect(mapImageExtension('/tmp/city.WebP')).toBe('webp')
  })

  it('拒绝其它格式与没有后缀的路径', () => {
    expect(mapImageExtension('/tmp/map.gif')).toBeNull()
    expect(mapImageExtension('/tmp/map.svg')).toBeNull()
    expect(mapImageExtension('/tmp/map')).toBeNull()
    expect(mapImageExtension('')).toBeNull()
  })
})

describe('mapImage 落盘', () => {
  let lib = ''
  let source = ''

  beforeEach(async () => {
    lib = await mkdtemp(join(tmpdir(), 'spbf-map-image-lib-'))
    source = await mkdtemp(join(tmpdir(), 'spbf-map-image-src-'))
    await setLibraryPath(lib)
    await createBookFromBootstrap({ bookId: 'd_map', title: '地图', author: '', importType: 'txt', chapterTitles: ['第一章'] })
  })

  afterEach(async () => {
    await rm(lib, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  })

  const has = async (file: string) => access(file).then(() => true, () => false)

  it('保存到 map/original.<ext>，换格式时清掉旧文件', async () => {
    const png = join(source, 'city.png')
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const saved = await setMapImage('d_map', png)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.url).toContain('/d_map/map/original.png')
    expect(await has(join(bookDir('d_map'), 'map', 'original.png'))).toBe(true)
    expect(await getMapImage('d_map')).toBe(saved.url)

    const jpg = join(source, 'city.jpg')
    await writeFile(jpg, Buffer.from([0xff, 0xd8, 0xff]))
    const replaced = await setMapImage('d_map', jpg)
    expect(replaced.ok).toBe(true)
    expect(await has(join(bookDir('d_map'), 'map', 'original.jpg'))).toBe(true)
    expect(await has(join(bookDir('d_map'), 'map', 'original.png'))).toBe(false)
  })

  it('拒绝不支持的格式与超过 8MB 的图片', async () => {
    const gif = join(source, 'map.gif')
    await writeFile(gif, Buffer.from('GIF89a'))
    expect(await setMapImage('d_map', gif)).toEqual({ ok: false, message: '仅支持 jpg、png、webp' })

    const huge = join(source, 'huge.png')
    await writeFile(huge, Buffer.alloc(8 * 1024 * 1024 + 1))
    expect(await setMapImage('d_map', huge)).toEqual({ ok: false, message: '地图图片不能超过 8MB' })
  })
})
