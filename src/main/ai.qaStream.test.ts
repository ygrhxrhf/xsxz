import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBookFromBootstrap, readChat, setLibraryPath, writeChat } from './library'
import { createJsonStringFieldSink, runAiTaskCompletion } from './ai'
import { executeEvidenceQaPipeline } from './aiEvidenceQa'

// official deepseek origin is what makes buildRequestBody send response_format json_object
const config = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k' }
const citation = {
  id: 'qa-c0001-p1', chapterId: 'c0001', chapterTitle: '第一章', paragraphIndex: 1,
  excerpt: '顾清在码头找到了旧账册。',
}
const encoder = new TextEncoder()

/** provider 在 JSON mode 下按 token 吐片段，所以每一帧都可能是半个键名或半个转义。 */
function sseStream(fragments: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      fragments.forEach((content) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`))
      })
      // include_usage 会把用量放在最后一帧，且不带正文增量
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 5 } })}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

/** 每次请求都要一条全新的流：ReadableStream 不能被消费两次。 */
function stubFetch(makeBody: () => ReadableStream<Uint8Array>, assertRequest?: (body: string) => void): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    if (init?.body !== undefined) assertRequest?.(init.body)
    return new Response(makeBody(), { status: 200 })
  }))
}

function streamAnswer(signal: AbortSignal, onChunk: (chunk: string) => void) {
  return (messages: Array<{ role: 'system' | 'user'; content: string }>) => runAiTaskCompletion(
    config, messages, { task: 'evidenceQa', stream: true, signal, onDelta: createJsonStringFieldSink('answer', onChunk) },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('evidence QA answer streaming', () => {
  it('streams only the decoded answer text while the JSON envelope stays out of the bubble', async () => {
    const answer = '她把玉印交了出去，随后离开码头。'
    stubFetch(() => sseStream([
      '{"ans', 'wer":"', '她把玉印', '交了出去，', '随后离开', '码头。', `","citations":["${citation.id}"]}`,
    ]), (body) => {
      expect(body).toContain('"stream":true')
      expect(body).toContain('"response_format":{"type":"json_object"}')
    })
    const chunks: string[] = []
    const completion = await streamAnswer(new AbortController().signal, (chunk) => chunks.push(chunk))(
      [{ role: 'user', content: 'q' }],
    )
    expect(chunks.join('')).toBe(answer)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.some((chunk) => chunk.includes('citations'))).toBe(false)
    expect(chunks.some((chunk) => chunk.includes('{'))).toBe(false)
    expect(completion.json).toMatchObject({ answer, citations: [citation.id] })
  })

  it('keeps the grounded pipeline unchanged: whitelisted citations and merged usage still win', async () => {
    stubFetch(() => sseStream([`{"answer":"在码头。","citations":["${citation.id}"]}`]))
    const chunks: string[] = []
    const result = await executeEvidenceQaPipeline({
      question: '账册在哪里？',
      taskInstruction: '只根据证据回答。',
      stopped: () => false,
      onStage: () => {},
      rewrite: async () => ({
        text: '{"corePhrase":"账册","keywords":["码头"]}',
        json: { corePhrase: '账册', keywords: ['码头'] }, usage: { inputTokens: 4, outputTokens: 3 }, truncated: false,
      }),
      search: async () => ({ citations: [citation], uptoChapterId: 'c0001', topScore: 0 }),
      answer: streamAnswer(new AbortController().signal, (chunk) => chunks.push(chunk)),
    })
    expect(result).toMatchObject({ kind: 'answer', text: '在码头。', citations: [citation] })
    expect(chunks).toEqual(['在码头。'])
    expect(result.kind === 'answer' ? result.usage : undefined).toMatchObject({ inputTokens: 12, outputTokens: 8 })
  })

  it('still rejects a citation outside the candidate whitelist even after the text streamed', async () => {
    stubFetch(() => sseStream(['{"answer":"前半', `","citations":["qa-9999-p0"]}`]))
    const streamed: string[] = []
    await expect(
      streamAnswer(new AbortController().signal, (chunk) => streamed.push(chunk))([{ role: 'user', content: 'q' }]),
    ).resolves.toBeTruthy()
    expect(streamed.join('')).toBe('前半')
    await expect(executeEvidenceQaPipeline({
      question: '账册在哪里？',
      taskInstruction: '',
      stopped: () => false,
      onStage: () => {},
      rewrite: async () => ({ text: '{}', json: {}, truncated: false }),
      search: async () => ({ citations: [citation], uptoChapterId: 'c0001', topScore: 0 }),
      answer: streamAnswer(new AbortController().signal, () => {}),
    })).rejects.toThrow('候选范围外')
  })

  it('keeps the streamed prefix when the user stops mid-answer, and persists it as a stopped turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spbf-qa-stop-'))
    try {
      await setLibraryPath(dir)
      await createBookFromBootstrap({
        bookId: 'd_stop', title: '测试小说', author: '', importType: 'download', chapterTitles: ['第一章'],
      })
      const controller = new AbortController()
      const streamed: string[] = []
      const frames = [
        'data: {"choices":[{"delta":{"content":"{\\"answer\\":\\"她把玉印"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"交了出去"}}]}\n\n',
      ]
      // controller.error() 会丢弃已入队的块，而真实 abort 是前面的帧已交付之后才断，所以逐帧 pull。
      let pulled = 0
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull(c) {
          if (pulled < frames.length) {
            c.enqueue(encoder.encode(frames[pulled]))
            pulled += 1
            return
          }
          controller.abort()
          c.error(new DOMException('Aborted', 'AbortError'))
        },
      }), { status: 200 })))
      await expect(streamAnswer(controller.signal, (chunk) => streamed.push(chunk))(
        [{ role: 'user', content: 'q' }],
      )).rejects.toThrow()
      expect(controller.signal.aborted).toBe(true)
      expect(streamed.join('')).toBe('她把玉印交了出去')

      // 这就是 index.ts finishStopped 的写入形状：部分回答必须留在气泡与 ai/chat.json 里。
      const partialMessages = [
        { role: 'user' as const, content: '账册在哪里？' },
        {
          role: 'assistant' as const, content: streamed.join(''), citations: [citation],
          uptoChapterId: 'c0001', stopped: true,
        },
      ]
      await writeChat('d_stop', partialMessages)
      await expect(readChat('d_stop')).resolves.toMatchObject({
        version: 2,
        messages: [
          { role: 'user', content: '账册在哪里？' },
          { role: 'assistant', content: '她把玉印交了出去', stopped: true, citations: [citation] },
        ],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('forwards nothing and fails exactly as before when the provider ignores JSON mode', async () => {
    stubFetch(() => sseStream(['## 本章要点\n', '主角去了码头。']))
    const chunks: string[] = []
    await expect(streamAnswer(new AbortController().signal, (chunk) => chunks.push(chunk))(
      [{ role: 'user', content: 'q' }],
    )).rejects.toThrow('结构化内容无法识别')
    expect(chunks).toEqual([])
  })
})
