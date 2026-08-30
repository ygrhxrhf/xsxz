const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
if (!apiKey) {
  console.log('SKIP: DEEPSEEK_API_KEY 未设置；live AI smoke 未联网。')
  process.exit(0)
}

const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
const endpoint = `${baseUrl}/chat/completions`

async function request(body) {
  const signal = AbortSignal.timeout(120_000)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, ...body }),
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response
}

function usageOk(usage) {
  return Boolean(usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens))
}

try {
  const plainResponse = await request({
    messages: [{ role: 'user', content: '只回复“好”。' }], max_tokens: 16,
  })
  const plain = await plainResponse.json()
  const plainText = plain?.choices?.[0]?.message?.content
  if (typeof plainText !== 'string' || !plainText.trim()) throw new Error('non-stream content missing')
  if (!usageOk(plain.usage)) throw new Error('non-stream usage missing')
  console.log(`PASS non-stream + usage: input=${plain.usage.prompt_tokens}, output=${plain.usage.completion_tokens}`)

  const jsonResponse = await request({
    messages: [{ role: 'user', content: '只返回 JSON：{"ok":true}' }],
    response_format: { type: 'json_object' }, max_tokens: 32,
  })
  const structured = await jsonResponse.json()
  const jsonText = structured?.choices?.[0]?.message?.content
  const parsed = JSON.parse(jsonText)
  if (parsed?.ok !== true) throw new Error('structured JSON mismatch')
  if (!usageOk(structured.usage)) throw new Error('structured usage missing')
  console.log(`PASS structured JSON + usage: input=${structured.usage.prompt_tokens}, output=${structured.usage.completion_tokens}`)

  const streamResponse = await request({
    messages: [{ role: 'user', content: '用不超过五个字回复“测试通过”。' }],
    stream: true,
    stream_options: { include_usage: true }, max_tokens: 32,
  })
  const reader = streamResponse.body?.getReader()
  if (!reader) throw new Error('stream body missing')
  const decoder = new TextDecoder()
  let pending = ''
  let chunks = 0
  let streamUsage
  while (true) {
    const { done, value } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      const frame = JSON.parse(data)
      if (typeof frame?.choices?.[0]?.delta?.content === 'string' && frame.choices[0].delta.content) chunks += 1
      if (frame.usage) streamUsage = frame.usage
    }
    if (done) break
  }
  if (!chunks) throw new Error('stream content missing')
  if (!usageOk(streamUsage)) throw new Error('stream usage missing')
  console.log(`PASS stream + usage: chunks=${chunks}, input=${streamUsage.prompt_tokens}, output=${streamUsage.completion_tokens}`)
  console.log('PASS: live AI smoke 完成；未读取书库，未输出请求正文或凭据。')
} catch (error) {
  console.error(`FAIL: live AI smoke ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
