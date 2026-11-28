import { describe, expect, it } from 'vitest'
import { extractBody } from './extract'

const rule = { host: 'x.example', body: '#content' }

describe('分段页残句', () => {
  it('切掉「点击下一页继续阅读」但保留同一段里的正文', () => {
    const novel = '他之所以如此判断，是因为这几日敌人一直按兵不动，像是在等什么消息。'.repeat(4)
    const html = `<html><body><div id="content">
      <p>“堂……第92章反应(第1/3页),点击下一页继续阅读。主，那我们现在怎么办？”</p>
      <p>${novel}</p>
    </div></body></html>`
    const r = extractBody(html, 'https://x.example/bi/1.html', rule)
    expect(r.ok).toBe(true)
    expect(r.body).not.toContain('第1/3页')
    expect(r.body).not.toContain('点击下一页')
    expect(r.body).toContain('堂……')
    expect(r.body).toContain('主，那我们现在怎么办？')
    expect(r.body).toContain(novel.slice(0, 20))
  })

  it('切掉「本章未完，请翻页」', () => {
    const novel = '海风从窗口灌进来，把桌上的纸吹得哗啦作响，他抬手按住。'.repeat(4)
    const html = `<html><body><div id="content">
      <p>${novel}</p>
      <p>他之所以如此判（本章未完，请翻页）</p>
    </div></body></html>`
    const r = extractBody(html, 'https://x.example/bi/2.html', rule)
    expect(r.ok).toBe(true)
    expect(r.body).not.toContain('本章未完')
    expect(r.body).not.toContain('请翻页')
    expect(r.body).toContain('他之所以如此判')
  })

  it('正文里的「下一页」若不含分页标记则保留，不误删剧情', () => {
    const novel = '他翻到下一页，发现那里什么都没有，只有一片空白。'.repeat(5)
    const html = `<html><body><div id="content"><p>${novel}</p></div></body></html>`
    const r = extractBody(html, 'https://x.example/bi/3.html', rule)
    expect(r.ok).toBe(true)
    expect(r.body).toContain('他翻到下一页')
  })
})