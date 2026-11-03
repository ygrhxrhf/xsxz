const PLATFORM_TOKEN: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
}

const FALLBACK_CHROME_VERSION = '140.0.0.0'

/**
 * 浏览 / 下载会话的 UA 策略。
 *
 * **历史与现状**（2026-11-03 实测后改写）：
 * 原先这里默认把 UA 覆盖成「纯 Chrome」，理由是「Electron 默认 UA 会被小说站拦」。
 * 那个结论是在 Electron 43 / Chromium 150 上得到的，而且当时本机网络本身不通，
 * 把网络失败误判成了 UA 问题。
 *
 * 升到 Electron 45（Chromium 156）后逐个变量重测，结论反过来了：
 *
 * | UA | 结果 |
 * |---|---|
 * | **原生**（含 `Electron/45.2.1`、`Chrome/156.0.8078.75`） | alicesw 正常；uaa001 的 Cloudflare 挑战**能过**，拿到 `cf_clearance` |
 * | **覆盖成** `Chrome/156.0.0.0` | alicesw 正常；uaa001 **过不了**，卡在挑战页 |
 *
 * 原因：覆盖后的 UA 自称纯 Chrome，但 `navigator.userAgentData` 等指纹仍暴露
 * Chromium 的真实版本与 Electron 标记。这种「UA 与指纹不一致」在 Cloudflare 眼里
 * 就是伪装，反而判得更严。**如实暴露 Electron 标记是最稳的**。
 *
 * 所以默认**不覆盖**会话 UA，直接用 Chromium 自己的串。
 */

/**
 * 拼一个不带 Electron 标记的 Chrome UA。
 *
 * **不要默认使用**：实测它会让 Cloudflare 挑战过不去（见上方表格）。
 * 仅当遇到「只读 UA 字符串、不校验指纹」的站点、且确认默认 UA 被它拦时才用。
 */
export function browseUserAgent(
  platform: NodeJS.Platform = process.platform,
  chromeVersion: string = process.versions.chrome || FALLBACK_CHROME_VERSION,
): string {
  const token = PLATFORM_TOKEN[platform] ?? 'X11; Linux x86_64'
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

/**
 * 会话应该用的 UA。
 *
 * 返回空串表示「不覆盖」，即保留 Chromium 自带的完整 UA：
 * `... Chrome/156.0.8078.75 Electron/45.2.1 Safari/537.36`。
 *
 * 为什么不返回原生串而是空串：`session.setUserAgent('')` 的语义是「恢复默认」，
 * 而手工拼串会丢掉 `Electron/` 段与完整补丁版本号，正好制造出上面说的指纹不一致。
 */
export function sessionUserAgent(): string {
  return ''
}
