import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importEpub } from './importEpub'
import { exportBook } from './exportBook'
import { loadBook, setLibraryPath } from './library'

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试书</dc:title>
    <dc:creator>测试作者</dc:creator>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1"><navLabel><text>第一章 启程</text></navLabel><content src="ch1.xhtml"/></navPoint>
    <navPoint id="n2"><navLabel><text>第二章 途中</text></navLabel><content src="ch2.xhtml"/></navPoint>
  </navMap>
</ncx>`

function xhtml(title: string, heading: string, paragraphs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
<body>
<h2>${heading}</h2>
${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}
</body>
</html>`
}

/** 造一个最小可用 epub：ch1 的 <head><title> 与 <h2> 故意同名，用来锁住标题重复这个回归。 */
async function makeEpub(path: string, ch1: string, ch2: string): Promise<void> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', CONTAINER)
  zip.file('OEBPS/content.opf', OPF)
  zip.file('OEBPS/toc.ncx', NCX)
  zip.file('OEBPS/ch1.xhtml', ch1)
  zip.file('OEBPS/ch2.xhtml', ch2)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
}

describe('importEpub', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-epub-'))
    await setLibraryPath(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('不把 <head><title> 的文本混进正文（章节标题只出现一次）', async () => {
    const src = join(dir, 'sample.epub')
    await makeEpub(
      src,
      xhtml('第一章 启程', '第一章 启程', [
        '清晨的雾还没有散尽，渡口只有一只空船，船舷上结着薄霜。',
        '少年把行李放下，数了数口袋里的铜钱，决定先过河。',
      ]),
      xhtml('第二章 途中', '第二章 途中', [
        '过了河，官道变得又窄又硬，车辙里积着隔夜的雨。',
        '路边茶棚的老板问他去哪儿，他说往北。',
      ]),
    )

    const { bookId } = await importEpub(src)
    const book = await loadBook(bookId)
    expect(book.importType).toBe('epub')
    expect(book.chapters).toHaveLength(2)

    const ch1 = JSON.parse(await readFile(join(dir, bookId, book.chapters[0].file), 'utf-8'))
    // 修复前这里是 2：一次来自 <head><title>，一次来自 <h2>。
    expect(ch1.body.match(/第一章 启程/g) ?? []).toHaveLength(1)
    expect(ch1.body).toContain('清晨的雾还没有散尽')
    expect(ch1.body).not.toContain('<title>')
    expect(ch1.body).not.toContain('<head>')
  })

  it('保留段落换行并解码实体', async () => {
    const src = join(dir, 'entities.epub')
    await makeEpub(
      src,
      xhtml('第一章', '第一章', ['甲&amp;乙 &lt;标注&gt;', '第二段 &quot;引用&quot; 与 &#39;撇号&#39;。']),
      xhtml('第二章', '第二章', ['另起一段，用来满足最少正文长度。']),
    )

    const { bookId } = await importEpub(src)
    const book = await loadBook(bookId)
    const ch1 = JSON.parse(await readFile(join(dir, bookId, book.chapters[0].file), 'utf-8'))

    expect(ch1.body).toContain('甲&乙 <标注>')
    expect(ch1.body).toContain('第二段 "引用" 与 \'撇号\'。')
    // 段落之间仍然分开，没有被压成一行。
    expect(ch1.body.split('\n').filter((line: string) => line.trim()).length).toBeGreaterThanOrEqual(3)
  })

  it('章节标题取自 toc，正文为空时不产出空章节', async () => {
    const src = join(dir, 'toc.epub')
    await makeEpub(
      src,
      xhtml('第一章 启程', '第一章 启程', ['正文甲，长度足够避免被判为插图页。']),
      xhtml('第二章 途中', '第二章 途中', ['正文乙，长度同样足够。']),
    )

    const { bookId } = await importEpub(src)
    const book = await loadBook(bookId)
    expect(book.chapters.map((c) => c.title)).toEqual(['第一章 启程', '第二章 途中'])
    expect(book.chapters.every((c) => c.status === 'ready')).toBe(true)
    expect(book.status).toBe('ready')
  })

  it('导入后再导出 txt/epub，不会把标题重复固化进产物', async () => {
    const src = join(dir, 'roundtrip.epub')
    // 正文里不写 <h2>：这样 body 里若出现标题，就一定来自 <head><title> 的污染。
    const plain = (title: string, body: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
<body><p>${body}</p></body>
</html>`
    await makeEpub(
      src,
      plain('第一章 启程', '正文甲，长度足够避免被判为插图页。'),
      plain('第二章 途中', '正文乙，长度同样足够。'),
    )
    const { bookId } = await importEpub(src)

    // 正文里不该出现标题：它只应存在于章节元数据中。
    const book = await loadBook(bookId)
    const ch1 = JSON.parse(await readFile(join(dir, bookId, book.chapters[0].file), 'utf-8'))
    expect(ch1.body).not.toContain('第一章 启程')

    const outDir = join(dir, 'out')
    // txt：标题只作为 `## 标题` 行出现一次。
    const txt = await exportBook(bookId, 'txt', outDir)
    expect(txt.ok).toBe(true)
    if (!txt.ok) return
    const text = await readFile(txt.path, 'utf-8')
    expect(text.match(/第一章 启程/g) ?? []).toHaveLength(1)
    expect(text.match(/第二章 途中/g) ?? []).toHaveLength(1)

    // epub：标题只应作为 <h1> 出现，正文段落里不能多出一个标题。
    const epub = await exportBook(bookId, 'epub', outDir)
    expect(epub.ok).toBe(true)
    if (!epub.ok) return
    const zip = await JSZip.loadAsync(await readFile(epub.path))
    const xhtml1 = await zip.file('OEBPS/ch0001.xhtml')?.async('string')
    expect(xhtml1).toBeTruthy()
    expect(xhtml1!.match(/<p>第一章 启程<\/p>/g) ?? []).toHaveLength(0)
    expect(xhtml1!.match(/<h1>第一章 启程<\/h1>/g) ?? []).toHaveLength(1)
  })
})
