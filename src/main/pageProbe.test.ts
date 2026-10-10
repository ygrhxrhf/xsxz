import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAGE_PROBE_SCRIPT, PAGE_PROBE_SCRIPT_ID, mergePageProbe } from './pageProbe'
import { extractBody } from './extract'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../../fixtures', name), 'utf-8')

const TEASER =
  '石阶尽头的石门半开，门缝里透出一线昏黄的灯。林舟把伞收拢，抖落肩上的雪，抬脚踏进去时，脚下那块青砖发出一声闷响，像是从很深的地方传上来的回声。'

const FULL_TEXT = [
  '值夜弟子把灯提到胸前，照见石阶上那道极浅的刻痕。林舟蹲下去，用指腹顺着刻痕摸了一遍，摸到一个归字的下半截。',
  '他忽然想起师父说过，宗门里的旧人从不用剑刻字，用的是剑鞘上的铜钉，因为剑是留给自己出鞘的，不该拿来留言。',
  '他把伞收拢，伞骨上的雪落进铜钉留下的凹槽里，很快化成一条细线。台阶上的人看着他，没有说话，钟又响了一声。',
  '石壁上那圈细灰慢慢散了，散成一条极淡的痕迹，指向北墙外——那里是历代掌剑人闭关的地方，也是他师父最后待过的地方。',
  '长廊尽头传来钟声，一声，两声，第三声时他停住了。守夜的长老不会在丑时敲钟，除非山门外又来了人。',
  '他伸手去够灯芯，指尖一凉，才发现自己手心全是汗。灯焰重新压低，长廊里只剩下钟声和他自己的呼吸。',
].join('\n\n')

describe('页面内探测脚本', () => {
  it('脚本盯的是 outerHTML 拿不到的三样东西', () => {
    expect(PAGE_PROBE_SCRIPT).toContain('shadowRoot')
    expect(PAGE_PROBE_SCRIPT).toContain('contentDocument')
    expect(PAGE_PROBE_SCRIPT).toContain('Object.keys(window)')
    expect(PAGE_PROBE_SCRIPT).toContain('JSON.stringify(out)')
    // 模板字面量会打断外层字符串拼接，脚本里不允许出现
    expect(PAGE_PROBE_SCRIPT).not.toContain('${')
  })

  it('只回纯文本数组，不把 JSON 结构当正文', () => {
    expect(PAGE_PROBE_SCRIPT).toContain("typeof text !== 'string'")
    expect(PAGE_PROBE_SCRIPT).toContain('out.shadow')
    expect(PAGE_PROBE_SCRIPT).toContain('out.frames')
    expect(PAGE_PROBE_SCRIPT).toContain('out.state')
  })
})

describe('探测结果并回 HTML', () => {
  it('插入到 </body> 之前，并保持 JSON 可解析', () => {
    const html = '<html><body><div>正文试读</div></body></html>'
    const probe = JSON.stringify({ shadow: [FULL_TEXT], frames: [], state: [] })
    const merged = mergePageProbe(html, probe)
    expect(merged).toContain(`id="${PAGE_PROBE_SCRIPT_ID}"`)
    expect(merged.indexOf(PAGE_PROBE_SCRIPT_ID)).toBeLessThan(merged.indexOf('</body>'))
    const marker = 'application/json">'
    const raw = merged.slice(merged.indexOf(marker) + marker.length)
    const json = raw.slice(0, raw.indexOf('</script>'))
    expect(JSON.parse(json).shadow[0]).toBe(FULL_TEXT)
  })

  it('把 < 转义掉，避免提前闭合脚本', () => {
    const probe = JSON.stringify({ shadow: ['</script><p>不要逃出来</p>'], frames: [], state: [] })
    const merged = mergePageProbe('<html><body></body></html>', probe)
    const inner = merged.slice(merged.indexOf('application/json">') + 'application/json">'.length)
    const json = inner.slice(0, inner.indexOf('</script>'))
    expect(json).not.toContain('</script>')
    expect(JSON.parse(json).shadow[0]).toContain('</script>')
  })

  it('没有探测结果时原样返回', () => {
    const html = '<html><body><p>正常章节</p></body></html>'
    expect(mergePageProbe(html, '')).toBe(html)
    expect(mergePageProbe(html, '{}')).toBe(html)
    expect(mergePageProbe(html, '不是 JSON')).toBe(html)
    expect(mergePageProbe(html, JSON.stringify({ shadow: [], frames: [], state: [] }))).toBe(html)
  })

  it('没有 body 时追加到末尾', () => {
    const merged = mergePageProbe('<div>片段</div>', JSON.stringify({ shadow: ['x'.repeat(80)], frames: [], state: [] }))
    expect(merged.startsWith('<div>片段</div>')).toBe(true)
    expect(merged).toContain(PAGE_PROBE_SCRIPT_ID)
  })
})

describe('探测 + 解锁整条链路', () => {
  it('正文只在 window 数据里时也能被解锁（SPA 付费墙）', () => {
    const wall = `<!DOCTYPE html><html><head><title>第三十三章 夜行 - 某小说网</title></head><body>
      <div id="content"><p>${TEASER}</p>
      <p>——本章剩余内容需要付费阅读，购买本章或开通会员后可解锁后续章节。</p></div>
      </body></html>`
    const probe = JSON.stringify({ shadow: [], frames: [], state: [FULL_TEXT] })
    const result = extractBody(mergePageProbe(wall, probe), 'https://example.com/book/33.html')
    expect(result.ok).toBe(true)
    expect(result.unlockedBy).toBe('embeddedJson')
    expect(result.body).toContain('剑鞘上的铜钉')
  })

  it('Shadow DOM 里的正文同样能解锁', () => {
    const wall = `<!DOCTYPE html><html><head><title>第三十四章 铜钉</title></head><body>
      <div id="content"><p>${TEASER}</p><p>购买本章后可解锁后续章节。</p></div>
      </body></html>`
    const probe = JSON.stringify({ shadow: [`<div>${FULL_TEXT}</div>`], frames: [], state: [] })
    const result = extractBody(mergePageProbe(wall, probe), 'https://example.com/book/34.html')
    expect(result.ok).toBe(true)
    expect(result.body).toContain('剑鞘上的铜钉')
  })

  it('探测结果里只有噪声时仍按付费墙处理', () => {
    const wall = fixture('paywall-vip.html')
    const probe = JSON.stringify({ shadow: [], frames: ['<html><body>广告招商 QQ 群 1234567890</body></html>'], state: [] })
    const result = extractBody(mergePageProbe(wall, probe), 'https://example.com/book/3.html')
    expect(result.ok).toBe(false)
    expect(result.failCode).toBe('Paywall')
  })
})
