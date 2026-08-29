import type { AiPrefs, AiProvider } from '../shared/types'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
export const DEEPSEEK_RECOMMENDED_MODEL = 'deepseek-v4-flash'
export const AI_CUSTOM_SERVICE_NOTICE = 'API Key 和你主动选择的正文内容将发送到此接口地址。请只使用你信任的服务。'

export function normalizeAiServiceOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    return url.origin === 'null' ? null : url.origin
  } catch {
    return null
  }
}

export function isOfficialDeepSeekUrl(value: string): boolean {
  try {
    return new URL(value.trim()).hostname.toLowerCase() === 'api.deepseek.com'
  } catch {
    return false
  }
}

export function inferAiProvider(baseUrl: string, storedProvider: AiProvider | undefined): AiProvider {
  if (storedProvider === 'custom') return 'custom'
  return isOfficialDeepSeekUrl(baseUrl) ? 'deepseek' : 'custom'
}

export function isLegacyDeepSeekModelName(value: string): boolean {
  return ['deepseek-chat', 'deepseek-reasoner'].includes(value.trim().toLowerCase())
}

export function customOriginNeedsConfirmation(
  provider: AiProvider,
  baseUrl: string,
  trustedOrigins: readonly string[],
): string | null {
  const origin = normalizeAiServiceOrigin(baseUrl)
  if (!origin) return null
  const usesCustomTransport = provider === 'custom' || !isOfficialDeepSeekUrl(baseUrl)
  return usesCustomTransport && !trustedOrigins.includes(origin) ? origin : null
}

export function trustCustomOrigin(ai: AiPrefs, origin: string): AiPrefs {
  return {
    ...ai,
    trustedCustomOrigins: [...new Set([...ai.trustedCustomOrigins, origin])],
  }
}
