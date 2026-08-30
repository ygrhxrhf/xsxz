import type { AiEvidenceChatMessage } from '@shared/types'

export function normalizeEvidenceChatHistory(messages: readonly unknown[]): AiEvidenceChatMessage[] {
  return messages
    .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === 'object' && !Array.isArray(message))
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .map((message) => message as unknown as AiEvidenceChatMessage)
}
