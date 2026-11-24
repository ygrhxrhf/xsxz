import { expect, it } from 'vitest'
import { extractBody } from './extract'

it('站点面包屑与字号控件不该混进正文', () => {
  const novel = '杨夙枫静静地听着，仿佛入定了一般，只有眼皮轻轻的跳了跳。'.repeat(6)
  const html = `<html><body>
    <div id="content">
      <p>笔趣阁 &gt; 江山如此多枭\n加入书架 手机阅读</p>
      <p>字体：\n大\n中\n小\n护眼\n关灯</p>
      <p>第1章 死亡圣旨（上）</p>
      <p>${novel}</p>
    </div>
  </body></html>`
  const r = extractBody(html, 'https://x.example/bi/1.html', { host: 'x.example', body: '#content' })
  expect(r.ok).toBe(true)
  expect(r.body).not.toContain('加入书架 手机阅读')
  expect(r.body).not.toContain('护眼')
  expect(r.body).toContain('杨夙枫静静地听着')
})
