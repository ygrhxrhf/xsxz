import { describe, expect, it } from 'vitest'
import { createJsonStringFieldSink, parseAiJsonObject } from './ai'

/** 把一串 SSE 文本帧依次喂给 sink，返回转发出去的字符与转发次数。 */
function feed(frames: string[], field = 'answer') {
  const emitted: string[] = []
  const sink = createJsonStringFieldSink(field, (chunk) => emitted.push(chunk))
  frames.forEach(sink)
  return { text: emitted.join(''), calls: emitted.length }
}

function sseFrames(chunks: string[]): string[] {
  return chunks.map((content) => JSON.stringify({ choices: [{ delta: { content } }] }))
}

describe('createJsonStringFieldSink', () => {
  it('streams only the answer field when keys and values are split across frames', () => {
    const full = '{"answer":"你好世界","citations":["qa-1-p2"]}'
    const frames = ['{', '"ans', 'wer":"', '你好', '世界', '","citations":["qa-1-p2"]}']
    expect(feed(frames).text).toBe('你好世界')
    expect(feed(frames).text).toBe(parseAiJsonObject(full).answer)
  })

  it('decodes every JSON escape inside the forwarded text', () => {
    const raw = '引号"反斜杠\\正斜杠/换行\n制表\t回车\r退格\b换页\f'
    const full = JSON.stringify({ answer: raw, citations: [] })
    expect(feed([full]).text).toBe(raw)
  })

  it('decodes a hand-written escaped forward slash', () => {
    expect(feed(['{"answer":"斜\\/杠","citations":[]}']).text).toBe('斜/杠')
  })

  it('holds a \\uXXXX escape until all four hex digits arrive, even across frames', () => {
    const full = '{"answer":"他说\\u4e2d完","citations":[]}'
    expect(parseAiJsonObject(full).answer).toBe('他说中完')
    const at = full.indexOf('\\u4e2')
    expect(feed([full.slice(0, at + 4), full.slice(at + 4)]).text).toBe('他说中完')
  })

  it('holds an incomplete backslash escape across frames without emitting the backslash', () => {
    const full = JSON.stringify({ answer: '他说"结束了"', citations: [] })
    const cut = full.indexOf('\\"') + 1
    expect(full[cut - 1]).toBe('\\')
    expect(feed([full.slice(0, cut), full.slice(cut)]).text).toBe('他说"结束了"')
  })

  it('recombines a surrogate pair split across frames into one character', () => {
    expect(feed(['{"answer":"笑\\ud83', 'd\\ude00","citations":[]}']).text).toBe('笑\u{1F600}')
  })

  it('stops forwarding at the closing quote so trailing fields never leak into the bubble', () => {
    expect(feed(['{"answer":"前半', '","citations":["qa-1-p0"]}']).text).toBe('前半')
  })

  it('ignores everything after the field is done', () => {
    const { text, calls } = feed(['{"answer":"完成"}', '{"answer":"第二段"}'])
    expect(text).toBe('完成')
    expect(calls).toBe(1)
  })

  it('forwards nothing and never throws when the model ignores JSON mode', () => {
    expect(feed(sseFrames(['## 本章要点\n', '主角去了码头。']))).toEqual({ text: '', calls: 0 })
  })

  it('forwards nothing when the field is absent or the stream stops before the value opens', () => {
    expect(feed(['{"citations":["qa-1-p0"]}']).text).toBe('')
    expect(feed(['{"answer"', ':']).text).toBe('')
    expect(feed(['{"answer":']).text).toBe('')
    expect(feed(['{"answer":null,']).text).toBe('')
    expect(feed([]).text).toBe('')
  })

  it('does not match a look-alike key that merely contains the field name', () => {
    const { text } = feed(['{"answers":["误导"],"answer":"真回答","citations":[]}'])
    expect(text).toBe('真回答')
  })

  it('tolerates whitespace and a fenced code block the way parseAiJsonObject does', () => {
    const full = '```json\n{\n  "answer" : "带空格的回答",\n  "citations": []\n}\n```'
    expect(feed([full]).text).toBe('带空格的回答')
  })

  it('keeps literal braces and quotes inside the string intact', () => {
    const raw = '他说："{不是 JSON}" 然后走了'
    expect(feed([JSON.stringify({ answer: raw, citations: [] })]).text).toBe(raw)
  })

  it('matches parseAiJsonObject on a realistic multi-frame answer', () => {
    const answer = '从已读内容看，顾清在码头交出玉印（第十三章）。她其实早已认出对方。\n下一段。'
    const full = JSON.stringify({ answer, citations: ['qa-13-p1', 'qa-14-p0'] })
    const characters = Array.from(full)
    const chunks: string[] = []
    for (let start = 0; start < characters.length; start += 7) {
      chunks.push(characters.slice(start, start + 7).join(''))
    }
    expect(feed(chunks).text).toBe(parseAiJsonObject(full).answer)
  })
})
