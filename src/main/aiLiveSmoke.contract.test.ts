import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('live AI smoke safety contract', () => {
  it('skips before network without a key and never prints credentials or response content', async () => {
    const source = await readFile(new URL('../../scripts/ai-live-smoke.mjs', import.meta.url), 'utf-8')
    const keyCheck = source.indexOf('if (!apiKey)')
    const firstFetch = source.indexOf('fetch(endpoint')
    expect(keyCheck).toBeGreaterThan(0)
    expect(keyCheck).toBeLessThan(firstFetch)
    expect(source).toContain("console.log('SKIP: DEEPSEEK_API_KEY 未设置；live AI smoke 未联网。')")
    expect(source).toContain('process.exit(0)')
    expect(source).not.toMatch(/console\.(?:log|error)\([^\n]*(?:apiKey|Authorization|plainText|jsonText)/)
    expect(source).not.toContain('readChat(')
    expect(source).not.toContain('readChapter(')
    expect(source).not.toContain('libraryPath')
  })

  it('covers non-stream, structured JSON, stream, and usage checks with short synthetic prompts', async () => {
    const source = await readFile(new URL('../../scripts/ai-live-smoke.mjs', import.meta.url), 'utf-8')
    expect(source).toContain('PASS non-stream + usage')
    expect(source).toContain('response_format: { type: \'json_object\' }')
    expect(source).toContain('PASS structured JSON + usage')
    expect(source).toContain('stream: true')
    expect(source).toContain('PASS stream + usage')
    expect(source).toContain('stream_options: { include_usage: true }')
  })
})
