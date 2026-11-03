import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES } from '../shared/agentCapabilities'

/**
 * P6 的机器化验收：`docs/ipc-contract.md` 的「请求」列与能力清单的 `params.required`
 * 必须指向同一组必填字段。文档写 `{ a: T; b?: T }`，清单写 `required: ['a']`。
 *
 * 只比对两边都能结构化表达的频道：文档用文字描述的（`无`、`SettingsUpdate`、
 * 自由对象）与清单声明 `additionalProperties` 的草稿对象不参与，因为它们没有
 * 可枚举的字段集，比对只会制造噪声。
 */
interface DocRow {
  channel: string
  request: string
}

async function docRequestRows(): Promise<DocRow[]> {
  const source = (await readFile(new URL('../../docs/ipc-contract.md', import.meta.url), 'utf-8')).replace(/\r\n/g, '\n')
  const rows: DocRow[] = []
  for (const line of source.split('\n')) {
    const match = /^\|\s*`([\w.]+)`\s*\|\s*invoke\s*\|([^|]*)\|/.exec(line)
    if (!match) continue
    rows.push({ channel: match[1]!, request: match[2]!.trim().replace(/^`|`$/g, '') })
  }
  return rows
}

/** `{ bookId: string; progress?: unknown }` → `['bookId']`（只取非可选字段）。 */
function requiredFieldsOf(request: string): string[] | undefined {
  const shape = /^\{(.*)\}$/s.exec(request)
  if (!shape) return undefined
  const inner = shape[1]!.trim()
  if (!inner || inner.includes('|') || inner.startsWith('...')) return undefined
  const fields: string[] = []
  let depth = 0
  let current = ''
  const parts: string[] = []
  for (const char of inner) {
    if (char === '{' || char === '[' || char === '(') depth += 1
    if (char === '}' || char === ']' || char === ')') depth -= 1
    if ((char === ';' || char === ',') && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  for (const part of parts) {
    const name = /^\s*([A-Za-z_$][\w$]*)\s*(\?)?\s*:/.exec(part)
    if (name) {
      if (!name[2]) fields.push(name[1]!)
      continue
    }
    // 简写 `{ bookId, position: TtsPosition }`：只有标识符 = 必填。
    const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*(\?)?\s*$/.exec(part)
    if (shorthand && !shorthand[2]) fields.push(shorthand[1]!)
  }
  return fields
}

describe('能力清单 required 集合与 IPC 契约一致（P6）', () => {
  it('文档「请求」列的必填字段与清单 params.required 相同', async () => {
    const rows = new Map((await docRequestRows()).map((row) => [row.channel, row.request]))
    expect(rows.size, '文档里没有解析到 invoke 频道').toBeGreaterThan(100)

    const problems: string[] = []
    let compared = 0
    for (const capability of CAPABILITIES) {
      const request = rows.get(capability.channel)
      if (request === undefined) continue
      const docRequired = requiredFieldsOf(request)
      const manifestProperties = Object.keys(capability.params.properties)
      // 草稿对象 / 自由形状：清单没有可枚举字段，文档也用散文描述，跳过。
      if (!docRequired || manifestProperties.length === 0) continue
      compared += 1
      const manifestRequired = [...(capability.params.required ?? [])].sort()
      const docSorted = [...new Set(docRequired)].sort()
      if (JSON.stringify(docSorted) !== JSON.stringify(manifestRequired)) {
        problems.push(`${capability.channel}：文档必填 [${docSorted.join(', ')}]，清单 [${manifestRequired.join(', ')}]`)
      }
    }
    expect(compared, '实际参与比对的频道太少，解析规则可能失效').toBeGreaterThan(60)
    expect(problems).toEqual([])
  })
})
