// 本地 mock OpenAI 兼容服务：用于体验 AI 四项能力的通路（不联网、不用真 Key）。
import http from 'node:http'

function pickContent(prompt) {
  // 清正文：把站点声明与广告行剔掉，其余原样返回
  if (/清正文|清理|导航|广告/.test(prompt) && prompt.length > 200) {
    const lines = prompt.split('\n').filter((l) => !/本站所有小说|广告位招租|联系站长|转载作品/.test(l))
    return lines.join('\n').trim()
  }
  if (/翻译/.test(prompt)) return '【译文】A broken scripture, half a scroll, and rain that never stopped.'
  if (/摘要|前情|概括/.test(prompt)) return '沈砚在破庙醒来，得到半卷残经，随后卷入一场旧案。'
  if (/证据|引用|问题|聊书|提问/.test(prompt)) return JSON.stringify({ answer: '沈砚手中的半卷残经是关键线索。', citations: [] })
  return '这是本地 mock 服务的回答。'
}

http
  .createServer(async (req, res) => {
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
      return
    }
    let body = ''
    for await (const c of req) body += c
    let parsed = {}
    try {
      parsed = JSON.parse(body || '{}')
    } catch {}
    const prompt = (parsed.messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
    const content = pickContent(prompt)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        model: parsed.model || 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    )
  })
  .listen(18080, '127.0.0.1', () => console.log('mock-ai on 18080'))
