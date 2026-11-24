import { describe, expect, it } from 'vitest'
import { extractBrowseReadingPage } from './browseReading'
import { catalogDetect } from './extract'

const toc = `<!doctype html><html><head><title>江山如此多枭_笔趣阁</title></head><body>
<h1>江山如此多枭</h1>
<div class="info">作者：南海十四郎 已完结 78万字</div>
<div id="intro">陆风——蓝羽军将领，格格美人，西门子施密特——发明了无线电报，开辟了即时通讯的新纪元。</div>
<div id="list"><dl>
<dt>《江山如此多枭》最新章节</dt>
<dd><a href="/bl/44270/781.html">第781章 娜塔莉日记⑤（大结局）</a></dd>
<dd><a href="/bl/44270/780.html">第780章 不是我不给你机会（4）</a></dd>
<dt>《江山如此多枭》正文卷</dt>
<dd><a href="/bl/44270/1.html">第1章 楔子</a></dd>
<dd><a href="/bl/44270/2.html">第2章 出发</a></dd>
<dd><a href="/bl/44270/3.html">第3章 海上</a></dd>
<dd><a href="/bl/44270/4.html">第4章 风暴</a></dd>
<dd><a href="/bl/44270/5.html">第5章 靠岸</a></dd>
</dl></div>
</body></html>`

const chapter = `<!doctype html><html><head><title>第3章 海上_江山如此多枭_笔趣阁</title></head><body>
<div class="bookname"><h1>第3章 海上</h1></div>
<div id="content"><p>${'海水在船舷下翻涌，浪头一个接一个压过来。'.repeat(20)}</p></div>
<div class="bottem"><a href="/bl/44270/2.html">上一章</a><a href="/bl/44270/">目录</a><a href="/bl/44270/4.html">下一章</a></div>
</body></html>`

describe('书页（目录页）不该被当成章节读', () => {
  it('在目录页上明确拒绝并给出 isCatalog', () => {
    const r = extractBrowseReadingPage(toc, 'https://www.biqubee.com/bl_44270/', undefined, catalogDetect)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.isCatalog).toBe(true)
      expect(r.message).toContain('书页')
    }
  })

  it('正常章节页照旧能读', () => {
    const r = extractBrowseReadingPage(chapter, 'https://www.biqubee.com/bl_44270/3.html', undefined, catalogDetect)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.page.title).toContain('海上')
  })
})
