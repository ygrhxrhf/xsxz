const PLATFORM_TOKEN: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
}

const FALLBACK_CHROME_VERSION = '140.0.0.0'

/**
 * Electron 默认 UA 带应用名和 Electron 版本，小说站普遍直接回拦截页，
 * 浏览 View 和下载 View 都发不出可用的请求。
 */
export function browseUserAgent(
  platform: NodeJS.Platform = process.platform,
  chromeVersion: string = process.versions.chrome || FALLBACK_CHROME_VERSION,
): string {
  const token = PLATFORM_TOKEN[platform] ?? 'X11; Linux x86_64'
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}
