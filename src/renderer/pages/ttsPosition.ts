import type { TtsPosition } from '../../shared/types'

/** 正文变更检测用稳定指纹；语音缓存另用 SHA-256。 */
export function ttsBodyHash(body: string): string {
  let hash = 2166136261
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function validTtsPosition(position: TtsPosition | null, chapterId: string, body: string): boolean {
  if (!position || position.chapterId !== chapterId || position.bodyHash !== ttsBodyHash(body)) return false
  const count = body.split(/\n{2,}/).filter(Boolean).length
  return position.paragraphIndex >= 0 && position.paragraphIndex < count
}
