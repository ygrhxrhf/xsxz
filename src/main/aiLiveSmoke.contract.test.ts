import { describe, expect, it, vi } from 'vitest'
import { parseSmokeSse, runLiveSmoke, safeSmokeError } from '../../scripts/ai-live-smoke-lib.mjs'

function textResponse(status: number, value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    body: { cancel: async () => {} },
  } as unknown as Response
}

function streamBody(parts: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      parts.forEach((part) => controller.enqueue(encoder.encode(part)))
      controller.close()
    },
  })
}

const usage = { prompt_tokens: 2, completion_tokens: 1 }
const plain = { choices: [{ message: { content: '好' } }], usage }
const structured = { choices: [{ message: { content: '{"ok":true}' } }], usage }

describe('live AI smoke safety behavior', () => {
  it('skips before fetch when the key is absent', async () => {
    const fetchFn = vi.fn()
    const logs: string[] = []
    await expect(runLiveSmoke({ env: {}, fetchFn, log: (line) => logs.push(line) })).resolves.toBe(0)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(logs).toEqual(['SKIP: DEEPSEEK_API_KEY 未设置；live AI smoke 未联网。'])
  })

  it('maps malformed response content to a fixed category without leaking sentinels or credentials', async () => {
    const outputs: string[] = []
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(textResponse(200, plain))
      .mockResolvedValueOnce(textResponse(200, 'SECRET_RESPONSE_REASONING'))
    const code = await runLiveSmoke({
      env: { DEEPSEEK_API_KEY: 'SECRET_KEY' }, fetchFn,
      log: (line) => outputs.push(line), errorLog: (line) => outputs.push(line),
    })
    expect(code).toBe(1)
    expect(outputs.join('\n')).toContain('invalid structured response')
    expect(outputs.join('\n')).not.toContain('SECRET_RESPONSE_REASONING')
    expect(outputs.join('\n')).not.toContain('SECRET_KEY')
    expect(outputs.join('\n')).not.toContain('Authorization')
    expect(safeSmokeError(new SyntaxError('SECRET_RESPONSE'))).toBe('transport failure')
  })

  it('parses chunked CRLF SSE and consumes a final usage frame without a newline', async () => {
    const body = streamBody([
      'data: {"choices":[{"delta":{"content":"测"}}]}\r',
      '\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    ])
    await expect(parseSmokeSse(body)).resolves.toEqual({
      chunks: 1, usage: { prompt_tokens: 3, completion_tokens: 2 },
    })
  })

  it('retries structured JSON once without response_format on 400 and completes all modes', async () => {
    const stream = streamBody([
      'data: {"choices":[{"delta":{"content":"通过"}}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n',
      'data: [DONE]\n',
    ])
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(textResponse(200, plain))
      .mockResolvedValueOnce(textResponse(400, 'unsupported'))
      .mockResolvedValueOnce(textResponse(200, structured))
      .mockResolvedValueOnce({ ok: true, status: 200, body: stream } as Response)
    const logs: string[] = []
    await expect(runLiveSmoke({
      env: { DEEPSEEK_API_KEY: 'key' }, fetchFn, log: (line) => logs.push(line), errorLog: (line) => logs.push(line),
    })).resolves.toBe(0)
    expect(fetchFn).toHaveBeenCalledTimes(4)
    const firstStructured = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body))
    const fallbackStructured = JSON.parse(String(fetchFn.mock.calls[2]?.[1]?.body))
    expect(firstStructured.response_format).toEqual({ type: 'json_object' })
    expect(fallbackStructured.response_format).toBeUndefined()
    expect(logs.at(-1)).toContain('未读取书库，未输出请求正文或凭据')
  })
})
