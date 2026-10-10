import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildChapterApiScript,
  chapterIdHints,
  fillTemplate,
  findChapterApiCandidates,
  idParamName,
  joinApiPayload,
  pageApiTemplates,
  parseChapterApiPayload,
} from './chapterApi'
import { recoverBodyFromText } from './paywallUnlock'
import type { SiteRule } from '../shared/types'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../../fixtures', name), 'utf-8')

const PAGE = 'https://example.com/book/35.html'

describe('章节接口线索 — 章节 id', () => {
  it('从 URL 查询串、html 文件名、data 属性、脚本变量里挖 id', () => {
    expect(chapterIdHints('', 'https://example.com/read?cid=12345')).toEqual(['12345'])
    expect(chapterIdHints('', 'https://example.com/book/35.html')).toEqual(['35'])
    expect(chapterIdHints('<i data-cid="888"></i>', 'https://example.com/book/')).toEqual(['888'])
    expect(chapterIdHints('<script>var o={chapterId: 4321};</script>', 'https://example.com/x')).toEqual(['4321'])
  })

  it('挖不到 id 时返回空数组', () => {
    expect(chapterIdHints('<html><body>没有数字</body></html>', 'https://example.com/book/index.html')).toEqual([])
  })
})

describe('章节接口线索 — 页面里的接口模板', () => {
  it('抽出带章节关键词的接口路径并把数字换成占位符', () => {
    const html = '<script>fetch("/ajax/chapter?id=12345")</script>'
    expect(pageApiTemplates(html)).toContain('/ajax/chapter?id={id}')
  })

  it('没有章节关键词的接口不收', () => {
    const html = '<script>fetch("/api/user/profile")</script>'
    expect(pageApiTemplates(html)).toEqual([])
  })

  it('带变量拼接的模板不收（猜不出真实地址）', () => {
    const html = '<script>var u = "/ajax/chapter?cid=" + cid + "&t=" + ts;</script>'
    expect(pageApiTemplates(html)).toEqual([])
  })

  it('认页面里写过的 id 参数名', () => {
    expect(idParamName('<script>var cfg={"cid":"35"}</script>')).toBe('cid')
    expect(idParamName('<div id="content"><a data-chapterid="7">x</a></div>')).toBe('chapterid')
    expect(idParamName('<div id="content">正文</div>')).toBeNull()
  })
})

describe('章节接口线索 — 候选组装', () => {
  it('站点规则里的模板最优先，并支持占位符', () => {
    const rule: SiteRule = { host: 'example.com', chapterApi: '/api/novel/content?id={id}' }
    const candidates = findChapterApiCandidates(fixture('paywall-api.html'), PAGE, rule)
    expect(candidates[0].url).toBe('https://example.com/api/novel/content?id=35')
    expect(candidates[0].detail).toContain('chapterApi')
  })

  it('POST 只在同时配了请求体时才用', () => {
    const withBody: SiteRule = {
      host: 'example.com',
      chapterApi: '/api/chapter',
      chapterApiMethod: 'POST',
      chapterApiBody: '{"cid":"{id}"}',
    }
    const candidate = findChapterApiCandidates(fixture('paywall-api.html'), PAGE, withBody)[0]
    expect(candidate.method).toBe('POST')
    expect(candidate.body).toBe('{"cid":"35"}')

    const noBody: SiteRule = { host: 'example.com', chapterApi: '/api/chapter', chapterApiMethod: 'POST' }
    expect(findChapterApiCandidates(fixture('paywall-api.html'), PAGE, noBody)[0].method).toBe('GET')
  })

  it('页面线索：无占位符模板按站点自己的参数名补 id', () => {
    const candidates = findChapterApiCandidates(fixture('paywall-api.html'), PAGE, undefined)
    expect(candidates.map((c) => c.url)).toContain('https://example.com/ajax/chapter?cid=35')
  })

  it('没有 id 线索就不生成候选（不拿无参请求去打站点）', () => {
    const html = '<html><body><script>var cfg = {api: "/ajax/chapter"};</script></body></html>'
    expect(findChapterApiCandidates(html, 'https://example.com/read/index.html', undefined)).toEqual([])
  })

  it('跨域模板拒绝；候选数量受限', () => {
    const cross: SiteRule = { host: 'example.com', chapterApi: 'https://evil.example.net/ajax/chapter?id={id}' }
    const candidates = findChapterApiCandidates(fixture('paywall-api.html'), PAGE, cross)
    expect(candidates.some((c) => c.url.includes('evil.example.net'))).toBe(false)

    const many = `<script>fetch("/ajax/chapter?id=1");fetch("/ajax/content?id=2");fetch("/api/read?id=3")</script>`
    expect(findChapterApiCandidates(many, PAGE, undefined, 2).length).toBe(2)
  })

  it('占位符填不出来时返回 null', () => {
    expect(fillTemplate('/ajax/chapter?id={id}', [], PAGE)).toBeNull()
    expect(fillTemplate('/ajax/chapter?id={id}', ['35'], PAGE)).toBe('https://example.com/ajax/chapter?id=35')
    expect(fillTemplate('/read?u={url}&p={page}', [], PAGE)).toContain('page=1'.replace('page', 'p'))
  })
})

describe('页面上下文请求脚本', () => {
  it('带 cookie、XHR 头，并用页面自己的 fetch', () => {
    const script = buildChapterApiScript([{ url: 'https://example.com/ajax/chapter?cid=35', method: 'GET', detail: 'x' }])
    expect(script).toContain("credentials: 'include'")
    expect(script).toContain("'X-Requested-With': 'XMLHttpRequest'")
    expect(script).toContain('await fetch(r.url, init)')
    expect(script).not.toContain('${')
  })

  it('候选以 JSON 形式内联，可被解析回来', () => {
    const candidate = { url: 'https://example.com/a?x=1', method: 'POST' as const, body: '{"id":1}', detail: 'd' }
    const script = buildChapterApiScript([candidate])
    const raw = script.slice(script.indexOf('var reqs = ') + 'var reqs = '.length, script.indexOf(';\n  var out'))
    expect(JSON.parse(raw)).toEqual([{ url: candidate.url, method: 'POST', body: '{"id":1}' }])
  })

  it('响应解析：坏 JSON、非数组都当空结果', () => {
    expect(parseChapterApiPayload('不是 JSON')).toEqual([])
    expect(parseChapterApiPayload('{"a":1}')).toEqual([])
    expect(parseChapterApiPayload('[{"url":"u","status":200,"text":"正文"}]')).toEqual([
      { url: 'u', status: 200, text: '正文', error: undefined },
    ])
  })

  it('多个响应拼成一份待扫描文本', () => {
    expect(joinApiPayload([{ url: 'a', text: '甲' }, { url: 'b', text: '' }, { url: 'c', text: '乙' }])).toBe('甲\n\n乙')
  })
})

describe('接口响应里的正文恢复', () => {
  const fullText = [
    '旧桥那头的灯笼忽然矮了一截，像是被谁按住了灯杆。林舟停住脚，听见桥下冰面裂开的声音，很轻，却一下一下，跟心跳对不上。',
    '他把伞横在身前，慢慢退后半步。那人终于回头，斗笠下露出一道旧疤，从眉骨一直划到下颌。三年不见，这道疤倒是没变。',
    '“你来得比我想的快。”那人说。林舟没有答，只把袖中的信捏紧了些，信纸被汗浸得发软，边角上那枚作废的门印已经模糊。',
    '桥下又裂了一声。这一次两人都没有动，灯笼的光在水面上晃了两下，照出一条从桥墩底下伸出来、细得像线的东西。',
    '林舟把伞往前递了半尺，伞尖挑住那根线，轻轻一带，水里浮起一只铁环。铁环上刻着两个字，被冰水泡得发白，仍能认出是师门的旧款。',
    '那人看着铁环，忽然笑了一声，笑声在空荡的河面上散开。他把灯笼递过来，火苗在两人之间晃了晃，照见桥板上新刻的一行小字。',
  ].join('\n\n')

  it('JSON 接口响应里的字段能被抽出来', () => {
    const payload = JSON.stringify({ code: 0, data: { cid: 35, content: fullText, title: '第三十五章 旧桥' } })
    const recovered = recoverBodyFromText(payload, '', { method: 'api', detail: '章节接口 页面线索' })
    expect(recovered?.body).toContain('斗笠下露出一道旧疤')
    expect(recovered?.method).toBe('api')
  })

  it('接口返回 HTML 片段同样能恢复', () => {
    const payload = `<div class="content"><p>${fullText.replace(/\n\n/g, '</p><p>')}</p></div>`
    const recovered = recoverBodyFromText(payload, '', { method: 'api', detail: '章节接口' })
    expect(recovered?.body).toContain('斗笠下露出一道旧疤')
  })

  it('接口只回了导航时不给正文', () => {
    const recovered = recoverBodyFromText(JSON.stringify({ data: { content: '请开通会员后阅读' } }), '', { method: 'api' })
    expect(recovered).toBeNull()
  })
})
