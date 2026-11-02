import { describe, expect, it } from 'vitest'
import {
  buildSingBoxConfig,
  decodeSubscriptionBody,
  isAnnouncement,
  parseNodeUri,
  parseSubscription,
} from './subscription'

/** 取自用户真实订阅的四种协议样本（服务器地址已保留原样，均为分享链接格式）。 */
const VLESS_REALITY =
  'vless://8e218ea9-e8be-4217-96aa-3f266f5e8298@jp-14.481103.xyz:28477?mode=multi&security=reality&encryption=none&type=tcp&flow=xtls-rprx-vision&pbk=o_ZS03Ca0SghbuH_kZnITLchcwI0h3b7ptQjzRS6nh0&sid=f398ab86229a46c5&sni=www.lovelive-anime.jp&servername=www.lovelive-anime.jp&spx=%2F#%E6%97%A5%E6%9C%AC-Reality'

const HYSTERIA2 = 'hysteria2://pass123@us2-11.634570.xyz:36000?sni=us2-11.634570.xyz&insecure=0#%E7%BE%8E%E5%9B%BD2-Hysteria2'

const TUIC = 'tuic://uuid-abc:pass-def@us2-12.634570.xyz:36001?sni=www.bing.com&alpn=h3&congestion_control=bbr&udp-relay-mode=native&insecure=1#%E7%BE%8E%E5%9B%BD2-TUIC'

const ANYTLS = 'anytls://pass-anytls@us-9.149638.xyz:6443?sni=us-9.149638.xyz&insecure=0#%E7%BE%8E%E5%9B%BD-AnyTLS'

describe('decodeSubscriptionBody', () => {
  it('解开整份 base64 的订阅', () => {
    const plain = `${VLESS_REALITY}\n${HYSTERIA2}`
    const encoded = Buffer.from(plain, 'utf-8').toString('base64')
    expect(decodeSubscriptionBody(encoded)).toBe(plain)
  })

  it('明文链接列表原样返回', () => {
    expect(decodeSubscriptionBody(VLESS_REALITY)).toBe(VLESS_REALITY)
  })

  it('JSON 订阅原样返回（由调用方判为不支持，不误当 base64）', () => {
    const json = '{"outbounds":[]}'
    expect(decodeSubscriptionBody(json)).toBe(json)
  })

  it('空正文返回空串', () => {
    expect(decodeSubscriptionBody('')).toBe('')
    expect(decodeSubscriptionBody('   ')).toBe('')
  })

  it('不是 base64 的垃圾文本原样返回，不抛错', () => {
    const junk = '这不是订阅内容!!!'
    expect(decodeSubscriptionBody(junk)).toBe(junk)
  })
})

describe('parseNodeUri：vless', () => {
  it('解析 REALITY 节点，带上 pbk / sid / sni / flow', () => {
    const node = parseNodeUri(VLESS_REALITY)
    expect(node).not.toBeNull()
    expect(node!.protocol).toBe('vless')
    expect(node!.server).toBe('jp-14.481103.xyz')
    expect(node!.port).toBe(28477)
    expect(node!.name).toBe('日本-Reality')
    const tls = (node!.outbound as { tls: Record<string, unknown> }).tls
    expect(tls.enabled).toBe(true)
    expect(tls.server_name).toBe('www.lovelive-anime.jp')
    expect((tls.reality as Record<string, unknown>).public_key).toBe(
      'o_ZS03Ca0SghbuH_kZnITLchcwI0h3b7ptQjzRS6nh0',
    )
    expect((tls.reality as Record<string, unknown>).short_id).toBe('f398ab86229a46c5')
    expect((node!.outbound as Record<string, unknown>).flow).toBe('xtls-rprx-vision')
  })

  it('普通 TLS 节点不生成 reality 段', () => {
    const node = parseNodeUri(
      'vless://11111111-2222-3333-4444-555555555555@example.com:443?security=tls&sni=example.com&type=ws&path=%2Fws#%E6%99%AE%E9%80%9A',
    )
    const tls = (node!.outbound as { tls: Record<string, unknown> }).tls
    expect(tls.reality).toBeUndefined()
    expect((node!.outbound as { transport: Record<string, unknown> }).transport).toMatchObject({
      type: 'ws',
      path: '/ws',
    })
  })

  it('缺 uuid 视为无效', () => {
    expect(parseNodeUri('vless://@example.com:443?security=tls')).toBeNull()
  })
})

describe('parseNodeUri：hysteria2 / tuic / anytls', () => {
  it('hysteria2 带上密码与 TLS', () => {
    const node = parseNodeUri(HYSTERIA2)!
    expect(node.protocol).toBe('hysteria2')
    expect((node.outbound as Record<string, unknown>).password).toBe('pass123')
    expect((node.outbound as { tls: Record<string, unknown> }).tls.server_name).toBe('us2-11.634570.xyz')
    expect((node.outbound as { tls: Record<string, unknown> }).tls.insecure).toBe(false)
  })

  it('hysteria2 认 insecure=1', () => {
    const node = parseNodeUri('hysteria2://p@h.com:443?insecure=1&sni=x.com#n')!
    expect((node.outbound as { tls: Record<string, unknown> }).tls.insecure).toBe(true)
  })

  it('tuic 取 uuid + password，保留 alpn 与拥塞控制', () => {
    const node = parseNodeUri(TUIC)!
    expect(node.protocol).toBe('tuic')
    const ob = node.outbound as Record<string, unknown>
    expect(ob.uuid).toBe('uuid-abc')
    expect(ob.password).toBe('pass-def')
    expect(ob.congestion_control).toBe('bbr')
    expect(ob.udp_relay_mode).toBe('native')
    expect((ob.tls as Record<string, unknown>).alpn).toEqual(['h3'])
    expect((ob.tls as Record<string, unknown>).insecure).toBe(true)
  })

  it('tuic 缺 password 时用 uuid 兜底', () => {
    const node = parseNodeUri('tuic://only-uuid@h.com:443?sni=h.com#n')!
    expect((node.outbound as Record<string, unknown>).password).toBe('only-uuid')
  })

  it('anytls 用 username 当密码', () => {
    const node = parseNodeUri(ANYTLS)!
    expect(node.protocol).toBe('anytls')
    expect((node.outbound as Record<string, unknown>).password).toBe('pass-anytls')
  })

  it('不支持的协议返回 null', () => {
    expect(parseNodeUri('ss://abc@h.com:8388#n')).toBeNull()
    expect(parseNodeUri('trojan://p@h.com:443#n')).toBeNull()
  })

  it('坏链接不抛错，返回 null', () => {
    expect(parseNodeUri('vless://')).toBeNull()
    expect(parseNodeUri('not a uri')).toBeNull()
    expect(parseNodeUri('')).toBeNull()
    expect(parseNodeUri('vless://uuid@host:99999#x')).toBeNull()
  })
})

describe('isAnnouncement', () => {
  it('认出机场塞成节点的公告', () => {
    expect(isAnnouncement('剩余流量：98.97 GB')).toBe(true)
    expect(isAnnouncement('距离下次重置剩余：30 天')).toBe(true)
    expect(isAnnouncement('套餐到期：2026-12-02')).toBe(true)
    expect(isAnnouncement('📢通知：订阅域名被墙')).toBe(true)
  })

  it('正常节点名不算公告', () => {
    expect(isAnnouncement('日本-Reality')).toBe(false)
    expect(isAnnouncement('美国2-大陆优化-Hysteria2 [倍率1.0x]')).toBe(false)
  })

  it('空名算公告（无意义条目）', () => {
    expect(isAnnouncement('')).toBe(true)
    expect(isAnnouncement('   ')).toBe(true)
  })
})

describe('parseSubscription', () => {
  it('混合订阅里只留支持的协议，跳过公告与未知协议', () => {
    const body = [
      'anytls://p@us-9.149638.xyz:6443?sni=a&insecure=0#剩余流量：98.97 GB',
      VLESS_REALITY,
      HYSTERIA2,
      TUIC,
      ANYTLS,
      'ss://abc@h.com:8388#不支持的节点',
      '随便一行垃圾',
    ].join('\n')
    const result = parseSubscription(body)
    expect(result.nodes).toHaveLength(4)
    expect(result.nodes.map((n) => n.protocol)).toEqual(['vless', 'hysteria2', 'tuic', 'anytls'])
    expect(result.skipped).toBeGreaterThanOrEqual(3)
    expect(result.reasons.some((r) => r.includes('ss'))).toBe(true)
  })

  it('base64 订阅也能解析', () => {
    const body = Buffer.from(`${VLESS_REALITY}\n${ANYTLS}`, 'utf-8').toString('base64')
    expect(parseSubscription(body).nodes).toHaveLength(2)
  })

  it('全是不支持的协议时节点为空，但给出原因', () => {
    const result = parseSubscription('ss://a@b:1#x\nsocks://c@d:2#y')
    expect(result.nodes).toHaveLength(0)
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it('空正文不抛错', () => {
    expect(parseSubscription('')).toMatchObject({ nodes: [], skipped: 0 })
  })
})

describe('buildSingBoxConfig', () => {
  const nodes = parseSubscription([VLESS_REALITY, ANYTLS].join('\n')).nodes

  it('只监听 127.0.0.1，用 mixed 端口同时吃 HTTP 与 SOCKS', () => {
    const config = buildSingBoxConfig(nodes, { listenPort: 20800 })
    const inbound = (config.inbounds as Array<Record<string, unknown>>)[0]
    expect(inbound.type).toBe('mixed')
    expect(inbound.listen).toBe('127.0.0.1')
    expect(inbound.listen_port).toBe(20800)
  })

  it('选中的节点是 proxy，direct 作为兜底', () => {
    const config = buildSingBoxConfig(nodes, { listenPort: 20800, selectedIndex: 0 })
    const outbounds = config.outbounds as Array<Record<string, unknown>>
    expect(outbounds.map((o) => o.tag)).toEqual(['proxy', 'direct'])
    expect(outbounds[0].type).toBe('vless')
    expect((config.route as Record<string, unknown>).final).toBe('proxy')
  })

  it('换一个节点，出站跟着换', () => {
    const config = buildSingBoxConfig(nodes, { listenPort: 20800, selectedIndex: 1 })
    const outbounds = config.outbounds as Array<Record<string, unknown>>
    expect(outbounds[0].type).toBe('anytls')
  })

  it('没有节点时退回全直连，不生成坏配置', () => {
    const config = buildSingBoxConfig([], { listenPort: 20800 })
    expect((config.route as Record<string, unknown>).final).toBe('direct')
    expect((config.outbounds as Array<Record<string, unknown>>).map((o) => o.tag)).toEqual(['direct'])
  })

  it('索引越界时退回第一个节点', () => {
    const config = buildSingBoxConfig(nodes, { listenPort: 20800, selectedIndex: 99 })
    expect((config.outbounds as Array<Record<string, unknown>>)[0].type).toBe('vless')
  })
})
