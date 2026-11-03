import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  CAPABILITIES_BY_CHANNEL,
  CORE_CAPABILITIES,
  EXPOSED_CAPABILITIES,
  HIDDEN_CAPABILITIES,
  toToolName,
} from '../shared/agentCapabilities'

/**
 * P0 的三方契约：主进程真实注册的频道 ↔ 能力清单 ↔ 设计文档 §4 表格。
 * 频道有增删时三处一起改，否则这里会红——这是清单作为单一真源的唯一保障。
 */

const HANDLE = /(?:ipcMain\.handle|register)\(\s*(["'])([\w.]+)\1/g

/** 递归收集 main 下的非测试源码：书库域已抽到 src/main/ipc/。 */
async function collectSources(dir: URL): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const sources: string[] = []
  for (const entry of entries) {
    if (entry.name.includes('.test.')) continue
    const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, dir)
    if (entry.isDirectory()) sources.push(...(await collectSources(child)))
    else if (entry.name.endsWith('.ts')) sources.push(await readFile(child, 'utf-8'))
  }
  return sources
}

async function handlerChannels(): Promise<string[]> {
  const sources = await collectSources(new URL('./', import.meta.url))
  return sources.flatMap((source) => [...source.matchAll(HANDLE)].map((match) => match[2]))
}

interface DocRow {
  channel: string
  tool: string
  confirm: string
}

async function docRows(): Promise<DocRow[]> {
  const source = (
    await readFile(new URL('../../docs/agent-integration-design.md', import.meta.url), 'utf-8')
  ).replace(/\r\n/g, '\n')
  const start = source.indexOf('## 4.')
  const end = source.indexOf('### 4.13')
  expect(start, '设计文档缺少 §4 能力清单').toBeGreaterThanOrEqual(0)
  expect(end, '设计文档缺少 §4.13').toBeGreaterThan(start)
  const rows: DocRow[] = []
  for (const line of source.slice(start, end).split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length < 7) continue
    const channel = /^`([a-zA-Z]+\.[a-zA-Z]+)`$/.exec(cells[1])?.[1]
    if (!channel) continue
    rows.push({ channel, tool: cells[2].replace(/`/g, ''), confirm: cells[4] })
  }
  return rows
}

/** 文档的确认列用短标记，清单用语义值。 */
const CONFIRM_LABEL: Record<string, string> = { '—': 'none', dry: 'dry-run', tok: 'token' }

/**
 * 令牌不等于破坏性的唯一例外（设计 §5.3 已记录）：`download.confirm` 消费
 * `download.preview` 发放的一次性令牌，本身是把书下载入书库，分级仍是 write。
 */
const TOKEN_WITHOUT_DESTRUCTIVE: ReadonlySet<string> = new Set(['download.confirm'])

describe('agent capability manifest', () => {
  it('覆盖主进程每个 handler，且没有重复或多余条目', async () => {
    const handlers = await handlerChannels()
    const channels = CAPABILITIES.map((capability) => capability.channel)

    expect(new Set(channels).size, '清单里有重复频道').toBe(channels.length)
    expect(channels.length, '清单条数与 handler 数不一致').toBe(new Set(handlers).size)
    expect(channels.filter((channel) => !handlers.includes(channel)), '清单登记了不存在的频道').toEqual([])
    expect(
      [...new Set(handlers)].filter((channel) => !CAPABILITIES_BY_CHANNEL.has(channel)),
      '有 handler 未登记进清单',
    ).toEqual([])
  })

  it('工具名唯一、合法，并与频道名一一对应', () => {
    const tools = EXPOSED_CAPABILITIES.map((capability) => capability.tool!)
    expect(new Set(tools).size, '工具名重复').toBe(tools.length)
    for (const capability of EXPOSED_CAPABILITIES) {
      expect(capability.tool, `${capability.channel} 的工具名不合法`).toMatch(/^[a-z0-9_]{1,64}$/)
      expect(capability.tool, `${capability.channel} 的工具名与推导规则不一致`).toBe(
        toToolName(capability.channel),
      )
    }
    for (const capability of HIDDEN_CAPABILITIES) {
      expect(capability.tool, `${capability.channel} 不暴露时 tool 应为 null`).toBeNull()
    }
    expect(EXPOSED_CAPABILITIES.length + HIDDEN_CAPABILITIES.length).toBe(CAPABILITIES.length)
  })

  it('只有原生对话框与纯呈现频道不暴露', () => {
    expect(HIDDEN_CAPABILITIES.map((capability) => capability.channel).sort()).toEqual([
      'browse.setBounds',
      'browse.setVisible',
      'browse.zoom',
      'dialog.openDirectory',
      'dialog.openFile',
      'dialog.openZip',
      'library.pickCoverFile',
    ])
    expect(HIDDEN_CAPABILITIES.length).toBe(7)
  })

  it('分级、确认与默认工具集自洽', () => {
    for (const capability of CAPABILITIES) {
      expect(capability.title.length, `${capability.channel} 缺标题`).toBeGreaterThan(0)
      expect(capability.description.length, `${capability.channel} 缺说明`).toBeGreaterThan(0)
      expect(capability.result.length, `${capability.channel} 缺返回摘要`).toBeGreaterThan(0)
      expect(capability.params.type, `${capability.channel} 参数必须是对象`).toBe('object')

      if (capability.tier === 'read') {
        expect(capability.confirm, `${capability.channel} 是只读，不该要求确认`).toBe('none')
      }
      // 令牌默认意味着破坏性；唯一的例外是 download.confirm——它消费
      // download.preview 发放的一次性令牌（设计 §5.3 已记录），分级仍是写入。
      // 例外用白名单固定，其余频道仍按严格规则断言。
      if (TOKEN_WITHOUT_DESTRUCTIVE.has(capability.channel)) {
        expect(capability.confirm, `${capability.channel} 应使用预览令牌`).toBe('token')
        expect(capability.tier, `${capability.channel} 是令牌例外，分级应为 write`).toBe('write')
      } else if (capability.confirm === 'token') {
        expect(capability.tier, `${capability.channel} 要令牌就必须是破坏性分级`).toBe('destructive')
      }
      if (capability.tool === null) {
        expect(capability.coreToolset, `${capability.channel} 不暴露就不能进 core`).toBe(false)
      }
    }

    const coreChannels = new Set(CORE_CAPABILITIES.map((capability) => capability.channel))
    for (const channel of coreChannels) {
      expect(CAPABILITIES_BY_CHANNEL.get(channel)?.tool, `${channel} 进 core 但没暴露`).not.toBeNull()
    }
  })

  it('参数声明完整：required 只引用已声明的字段，字段都带说明', () => {
    for (const capability of CAPABILITIES) {
      const properties = capability.params.properties
      for (const [name, property] of Object.entries(properties)) {
        expect(property.description, `${capability.channel}.${name} 缺字段说明`).toBeTruthy()
      }
      for (const name of capability.params.required ?? []) {
        expect(Object.prototype.hasOwnProperty.call(properties, name), `${capability.channel}.${name} 声明了 required 但没定义`).toBe(true)
      }
      expect(new Set(capability.params.required ?? []).size).toBe((capability.params.required ?? []).length)
    }
  })

  it('与设计文档 §4 表格逐行一致（频道、工具名、确认方式）', async () => {
    const rows = await docRows()
    const byChannel = new Map(rows.map((row) => [row.channel, row]))

    expect(rows.length, '文档 §4 行数与清单条数不一致').toBe(CAPABILITIES.length)
    expect(new Set(rows.map((row) => row.channel)).size, '文档 §4 有重复频道').toBe(rows.length)

    const problems: string[] = []
    for (const capability of CAPABILITIES) {
      const row = byChannel.get(capability.channel)
      if (!row) {
        problems.push(`文档缺少 ${capability.channel}`)
        continue
      }
      const expectedTool = capability.tool ?? '—'
      if (row.tool !== expectedTool) {
        problems.push(`${capability.channel} 工具名：文档 ${row.tool}，清单 ${expectedTool}`)
      }
      const expectedConfirm = CONFIRM_LABEL[row.confirm]
      if (expectedConfirm !== capability.confirm) {
        problems.push(`${capability.channel} 确认方式：文档 ${row.confirm}，清单 ${capability.confirm}`)
      }
    }
    expect(problems).toEqual([])
  })
})
