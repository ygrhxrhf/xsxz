export function safeSmokeError(error: unknown): string
export function parseSmokeSse(body: ReadableStream<Uint8Array>): Promise<{
  chunks: number
  usage: { prompt_tokens: number; completion_tokens: number }
}>
export function runLiveSmoke(options?: {
  env?: Record<string, string>
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>
  log?: (line: string) => void
  errorLog?: (line: string) => void
}): Promise<number>
