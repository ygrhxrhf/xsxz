/**
 * 订阅链接 → sing-box 配置。
 *
 * 用户手里往往只有一条订阅地址（base64 的分享链接列表），没有任何客户端。
 * 与其让人先装 v2rayN 再让本应用连它的本地端口，不如本应用直接内置代理内核：
 * 解析订阅、生成配置、拉起内核、把浏览与下载的会话指过去。用户只需要贴一条链接。
 *
 * 本文件只做纯转换（URI → 出站配置），不碰网络、不碰进程，方便单测。
 *
 * 支持四种协议：vless（含 REALITY）、hysteria2、tuic、anytls —— 这是常见机场
 * 订阅的事实标准。不认识的协议跳过并计数，不让一条坏链接毁掉整份订阅。
 */

/** sing-box 出站对象。字段名直接对应 sing-box 的 JSON schema。 */
export type SingBoxOutbound = Record<string, unknown>

export interface ParsedNode {
  /** 展示名，来自 URI 的 `#fragment`。 */
  name: string
  protocol: 'vless' | 'hysteria2' | 'tuic' | 'anytls'
  /** 服务端地址，别名节点用。 */
  server: string
  port: number
  outbound: SingBoxOutbound
}

export interface ParseSubscriptionResult {
  nodes: ParsedNode[]
  /** 被跳过的条目数（协议不支持或格式坏了）。 */
  skipped: number
  /** 跳过的原因摘要，最多几条，给界面提示用。 */
  reasons: string[]
}

const SUPPORTED = new Set(['vless', 'hysteria2', 'tuic', 'anytls'])

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 把 `?a=1&b=2` 拆成对象；重复键取第一个。 */
function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = safeDecode(eq >= 0 ? pair.slice(0, eq) : pair)
    const value = safeDecode(eq >= 0 ? pair.slice(eq + 1) : '')
    if (key && !(key in out)) out[key] = value
  }
  return out
}

/** `true` / `1` 都算真；缺省按给定默认值。 */
function boolParam(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === '1' || value.toLowerCase() === 'true'
}

/**
 * 订阅正文可能是 base64（整份编码），也可能是明文链接列表，还可能是 base64 的
 * JSON（sing-box / Clash 订阅）。这里统一还原成「一行一条 URI」的文本。
 *
 * 只解 base64，不解压：机场订阅不用压缩包，多解一层反而容易误伤正常文本。
 */
export function decodeSubscriptionBody(body: string): string {
  const raw = (body ?? '').trim()
  if (!raw) return ''
  // 已经是明文链接列表：直接给
  if (/^[a-z0-9+]+:\/\//im.test(raw)) return raw
  // 看起来像 JSON（Clash / sing-box 原生配置）：原样返回，由调用方判为不支持
  if (raw.startsWith('{') || raw.startsWith('[')) return raw
  const compact = raw.replace(/\s+/g, '')
  // base64 只认标准字符集与必要的 padding
  if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) return raw
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf-8')
    // 解出来必须真的像链接列表，否则当解码失败
    return /^[a-z0-9+]+:\/\//im.test(decoded) ? decoded : raw
  } catch {
    return raw
  }
}

/** vless：支持 REALITY（pbk/sid）与普通 TLS，传输层 tcp / ws / grpc。 */
function buildVless(uri: URL, params: Record<string, string>, name: string): SingBoxOutbound | null {
  const uuid = safeDecode(uri.username)
  if (!uuid) return null
  const tlsEnabled = params.security === 'tls' || params.security === 'reality'
  const outbound: SingBoxOutbound = {
    type: 'vless',
    tag: 'proxy',
    server: uri.hostname,
    server_port: Number(uri.port) || 443,
    uuid,
  }
  if (params.security === 'reality') {
    outbound.tls = {
      enabled: true,
      server_name: params.sni || params.servername || undefined,
      reality: {
        enabled: true,
        public_key: params.pbk ?? '',
        short_id: params.sid ?? '',
      },
      // sing-box 的 REALITY 客户端**强制**要求 uTLS：没有 utls 段会直接
      // FATAL "uTLS is required by reality client"。分享链接里常不带 fp，
      // 所以这里必须给默认指纹，不能因为缺参数就省略整个 utls。
      utls: { enabled: true, fingerprint: params.fp || 'chrome' },
    }
  } else if (tlsEnabled) {
    outbound.tls = { enabled: true, server_name: params.sni || params.servername || undefined }
  }

  const transport = params.type ?? 'tcp'
  if (transport === 'ws') {
    outbound.transport = {
      type: 'ws',
      path: params.path || '/',
      headers: params.host ? { Host: params.host } : undefined,
    }
  } else if (transport === 'grpc') {
    outbound.transport = { type: 'grpc', service_name: params.serviceName || '' }
  }
  // flow（xtls-rprx-vision）只在 reality 下有意义
  if (params.flow && params.security === 'reality') outbound.flow = params.flow
  return outbound
}

/** hysteria2：QUIC，salt/obfs 与带宽参数都是可选的。 */
function buildHysteria2(uri: URL, params: Record<string, string>): SingBoxOutbound | null {
  const password = safeDecode(uri.username || uri.password)
  if (!password) return null
  const outbound: SingBoxOutbound = {
    type: 'hysteria2',
    tag: 'proxy',
    server: uri.hostname,
    server_port: Number(uri.port) || 443,
    password,
  }
  outbound.tls = {
    enabled: true,
    server_name: params.sni || uri.hostname,
    insecure: boolParam(params.insecure, false),
  }
  if (params.obfs) {
    outbound.obfs = { type: params.obfs, password: params['obfs-password'] ?? '' }
  }
  if (params.down) outbound.down_mbps = Number(params.down) || undefined
  if (params.up) outbound.up_mbps = Number(params.up) || undefined
  return outbound
}

/** tuic：v5 用 uuid + password。 */
function buildTuic(uri: URL, params: Record<string, string>): SingBoxOutbound | null {
  const uuid = safeDecode(uri.username)
  const password = safeDecode(uri.password)
  if (!uuid) return null
  const outbound: SingBoxOutbound = {
    type: 'tuic',
    tag: 'proxy',
    server: uri.hostname,
    server_port: Number(uri.port) || 443,
    uuid,
    password: password || uuid,
    congestion_control: params.congestion_control || 'bbr',
  }
  if (params['udp-relay-mode']) outbound.udp_relay_mode = params['udp-relay-mode']
  outbound.tls = {
    enabled: true,
    server_name: params.sni || uri.hostname,
    insecure: boolParam(params.insecure, false),
    alpn: params.alpn ? params.alpn.split(',') : ['h3'],
  }
  return outbound
}

/** anytls：密码在 username 位；TLS 必开。 */
function buildAnytls(uri: URL, params: Record<string, string>): SingBoxOutbound | null {
  const password = safeDecode(uri.username || uri.password)
  if (!password) return null
  return {
    type: 'anytls',
    tag: 'proxy',
    server: uri.hostname,
    server_port: Number(uri.port) || 443,
    password,
    tls: {
      enabled: true,
      server_name: params.sni || uri.hostname,
      insecure: boolParam(params.insecure, false),
    },
  }
}

/** 单条分享链接 → 节点。不支持的协议返回 null。 */
export function parseNodeUri(line: string): ParsedNode | null {
  const text = (line ?? '').trim()
  if (!text || text.startsWith('#')) return null
  const schemeMatch = /^([a-z0-9+]+):\/\//i.exec(text)
  if (!schemeMatch) return null
  const protocol = schemeMatch[1].toLowerCase()
  if (!SUPPORTED.has(protocol)) return null

  // 名字在 fragment 里，先摘掉，避免 URL 解析把特殊字符弄丢
  const hashAt = text.indexOf('#')
  const name = hashAt >= 0 ? safeDecode(text.slice(hashAt + 1)) || protocol : protocol
  const withoutHash = hashAt >= 0 ? text.slice(0, hashAt) : text

  let uri: URL
  try {
    uri = new URL(withoutHash)
  } catch {
    return null
  }
  // anytls / hysteria2 的密码可能含特殊字符，URL 解析后 hostname 为空就说明坏了
  if (!uri.hostname) return null
  const port = Number(uri.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null

  const params = parseQuery(uri.search.startsWith('?') ? uri.search.slice(1) : uri.search)
  let outbound: SingBoxOutbound | null = null
  switch (protocol) {
    case 'vless':
      outbound = buildVless(uri, params, name)
      break
    case 'hysteria2':
      outbound = buildHysteria2(uri, params)
      break
    case 'tuic':
      outbound = buildTuic(uri, params)
      break
    case 'anytls':
      outbound = buildAnytls(uri, params)
      break
  }
  if (!outbound) return null
  return {
    name: name.slice(0, 80),
    protocol: protocol as ParsedNode['protocol'],
    server: uri.hostname,
    port,
    outbound,
  }
}

/**
 * 整份订阅 → 节点列表。
 *
 * 公告行（机场常把「剩余流量」「到期时间」塞成节点）也走 URI 解析：它们通常带
 * 真实服务器地址但名字是公告，留着只是噪音。这里按名字过滤掉明显是公告的条目。
 */
export function parseSubscription(body: string): ParseSubscriptionResult {
  const text = decodeSubscriptionBody(body)
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const nodes: ParsedNode[] = []
  const reasons: string[] = []
  let skipped = 0

  for (const line of lines) {
    if (!/^[a-z0-9+]+:\/\//i.test(line)) {
      skipped++
      if (reasons.length < 3) reasons.push('跳过一行非链接内容')
      continue
    }
    const scheme = line.split('://')[0].toLowerCase()
    if (!SUPPORTED.has(scheme)) {
      skipped++
      if (reasons.length < 3) reasons.push(`不支持的协议：${scheme}`)
      continue
    }
    const node = parseNodeUri(line)
    if (!node) {
      skipped++
      if (reasons.length < 3) reasons.push(`链接格式无法解析：${scheme}`)
      continue
    }
    if (isAnnouncement(node.name)) {
      skipped++
      continue
    }
    nodes.push(node)
  }
  return { nodes, skipped, reasons }
}

/** 机场把公告塞成节点时的特征。 */
const ANNOUNCEMENT_HINTS = ['剩余流量', '到期', '套餐', '通知', '官网', '订阅', '过期', '重置']

export function isAnnouncement(name: string): boolean {
  const text = (name ?? '').trim()
  if (!text) return true
  return ANNOUNCEMENT_HINTS.some((hint) => text.includes(hint))
}

/**
 * 节点列表 → sing-box 完整配置。
 *
 * 本地只开两种入口：
 * - mixed 一个端口同时吃 HTTP 与 SOCKS（Chromium 两种都支持，用户不用选）；
 * - 只监听 127.0.0.1，不对外暴露。
 *
 * 日志走 warn：调试期要能看到错误，平时又不该刷屏。
 */
export function buildSingBoxConfig(
  nodes: ParsedNode[],
  options: { listenPort: number; selectedIndex?: number },
): Record<string, unknown> {
  const selected = nodes[options.selectedIndex ?? 0] ?? nodes[0]
  const outbounds: SingBoxOutbound[] = [{ type: 'direct', tag: 'direct' }]
  if (selected) {
    outbounds.unshift({ ...selected.outbound, tag: 'proxy' })
  }
  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: options.listenPort,
        // 不开 sniff：本应用只要 TCP 转发，嗅探会给每个连接多一次解析开销
      },
    ],
    outbounds,
    route: {
      // 单节点时直接全走它；direct 作为兜底排在后面
      final: selected ? 'proxy' : 'direct',
      auto_detect_interface: true,
    },
  }
}
