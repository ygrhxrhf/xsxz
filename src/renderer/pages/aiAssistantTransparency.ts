export function displayAiServiceOrigin(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '无效地址'
    return url.origin
  } catch {
    return '无效地址'
  }
}
