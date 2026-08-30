class SmokeError extends Error {
  constructor(code) { super(code); this.code = code }
}

function parseJsonSafely(text, code) {
  try { return JSON.parse(text) } catch { throw new SmokeError(code) }
}

function usageOk(usage) {
  return Boolean(usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens))
}

export function safeSmokeError(error) {
  if (error instanceof SmokeError) return error.code
  if (error && typeof error === 'object' && error.name === 'TimeoutError') return 'timeout'
  return 'transport failure'
}

export async function parseSmokeSse(body) {
  const reader = body?.getReader()
  if (!reader) throw new SmokeError('invalid stream response')
  const decoder = new TextDecoder()
  let pending = ''
  let chunks = 0
  let usage
  const consume = (line) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    const frame = parseJsonSafely(data, 'invalid stream frame')
    if (typeof frame?.choices?.[0]?.delta?.content === 'string' && frame.choices[0].delta.content) chunks += 1
    if (frame.usage) usage = frame.usage
  }
  while (true) {
    const { done, value } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() || ''
    lines.forEach(consume)
    if (done) break
  }
  if (pending) consume(pending)
  if (!chunks) throw new SmokeError('stream content missing')
  if (!usageOk(usage)) throw new SmokeError('stream usage missing')
  return { chunks, usage }
}

export async function runLiveSmoke({ env = process.env, fetchFn = fetch, log = console.log, errorLog = console.error } = {}) {
  const apiKey = env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) {
    log('SKIP: DEEPSEEK_API_KEY 未设置；live AI smoke 未联网。')
    return 0
  }
  const baseUrl = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const model = env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
  const endpoint = `${baseUrl}/chat/completions`
  const request = (body) => fetchFn(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, ...body }),
    signal: AbortSignal.timeout(120_000),
  })
  const requireOk = (response) => {
    if (!response.ok) throw new SmokeError(`HTTP ${response.status}`)
    return response
  }

  try {
    const plainResponse = requireOk(await request({
      messages: [{ role: 'user', content: '只回复“好”。' }], max_tokens: 16,
    }))
    const plain = parseJsonSafely(await plainResponse.text(), 'invalid non-stream response')
    if (typeof plain?.choices?.[0]?.message?.content !== 'string' || !plain.choices[0].message.content.trim()) {
      throw new SmokeError('invalid non-stream response')
    }
    if (!usageOk(plain.usage)) throw new SmokeError('non-stream usage missing')
    log(`PASS non-stream + usage: input=${plain.usage.prompt_tokens}, output=${plain.usage.completion_tokens}`)

    const structuredBody = {
      messages: [{ role: 'user', content: '只返回 JSON：{"ok":true}' }],
      response_format: { type: 'json_object' }, max_tokens: 32,
    }
    let jsonResponse = await request(structuredBody)
    if (jsonResponse.status === 400 || jsonResponse.status === 422) {
      await jsonResponse.body?.cancel().catch(() => {})
      const { response_format: _removed, ...fallbackBody } = structuredBody
      jsonResponse = await request(fallbackBody)
    }
    requireOk(jsonResponse)
    const structured = parseJsonSafely(await jsonResponse.text(), 'invalid structured response')
    const parsed = parseJsonSafely(structured?.choices?.[0]?.message?.content ?? '', 'invalid structured response')
    if (parsed?.ok !== true) throw new SmokeError('structured JSON mismatch')
    if (!usageOk(structured.usage)) throw new SmokeError('structured usage missing')
    log(`PASS structured JSON + usage: input=${structured.usage.prompt_tokens}, output=${structured.usage.completion_tokens}`)

    const streamResponse = requireOk(await request({
      messages: [{ role: 'user', content: '用不超过五个字回复“测试通过”。' }],
      stream: true, stream_options: { include_usage: true }, max_tokens: 32,
    }))
    const streamed = await parseSmokeSse(streamResponse.body)
    log(`PASS stream + usage: chunks=${streamed.chunks}, input=${streamed.usage.prompt_tokens}, output=${streamed.usage.completion_tokens}`)
    log('PASS: live AI smoke 完成；未读取书库，未输出请求正文或凭据。')
    return 0
  } catch (error) {
    errorLog(`FAIL: live AI smoke ${safeSmokeError(error)}`)
    return 1
  }
}
