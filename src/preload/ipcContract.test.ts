import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const INVOKE = /ipcRenderer\.invoke\(\s*(["'])([\w.]+)\1/g
const LISTEN = /\bon\(\s*(["'])([\w.]+)\1/g
const HANDLE = /ipcMain\.handle\(\s*(["'])([\w.]+)\1/g
const SEND = /\.send\(\s*(["'])([\w.]+)\1/g
const DOC_ROW = /^\|\s*`([\w.]+)`\s*\|\s*(invoke|主→渲染)/gm

function names(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[2])
}

/** `const api = {` 里的分组与方法名（两空格一组、四空格一方法）。 */
function preloadShape(source: string): Record<string, string[]> {
  const groups: Record<string, string[]> = {}
  let current: string | null = null
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const opened = /^  (\w+): \{$/.exec(line)
    if (opened) {
      current = opened[1]
      groups[current] = []
      continue
    }
    if (/^  \},$/.test(line)) {
      current = null
      continue
    }
    if (!current) continue
    const method = /^    (\w+):/.exec(line)
    if (method) groups[current].push(method[1])
  }
  return groups
}

/** 文档「preload 白名单形状」代码块里的 `group: { a, b }` 列表。 */
function docShape(source: string): Record<string, string[]> {
  // 本机检出为 CRLF：围栏后是 \r\n，先把行尾归一，再匹配 ```ts 代码块。
  const block = /## preload 白名单形状[\s\S]*?```ts\n([\s\S]*?)```/.exec(source.replace(/\r\n/g, '\n'))
  expect(block, 'ipc-contract.md 缺少 preload 白名单形状代码块').not.toBeNull()
  const groups: Record<string, string[]> = {}
  for (const line of block![1].split('\n')) {
    const entry = /^  (\w+): \{([^}]*)\},?$/.exec(line)
    if (!entry) continue
    groups[entry[1]] = entry[2]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  }
  return groups
}

function sorted(groups: Record<string, string[]>): [string, string[]][] {
  return Object.entries(groups)
    .map(([group, methods]) => [group, [...methods].sort()] as [string, string[]])
    .sort((a, b) => a[0].localeCompare(b[0]))
}

async function mainSource(): Promise<string> {
  const dir = new URL('../main/', import.meta.url)
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
  return (await Promise.all(files.map((f) => readFile(new URL(f, dir), 'utf-8')))).join('\n')
}

const preload = () => readFile(new URL('./index.ts', import.meta.url), 'utf-8')
const doc = () => readFile(new URL('../../docs/ipc-contract.md', import.meta.url), 'utf-8')

describe('IPC 契约与实现一致', () => {
  it('文档的 preload 白名单形状与真实 preload 逐组一致', async () => {
    const [api, contract] = await Promise.all([preload(), doc()])
    expect(sorted(docShape(contract))).toEqual(sorted(preloadShape(api)))
  })

  it('preload 每条 invoke 频道都有主进程 handler', async () => {
    const [api, main] = await Promise.all([preload(), mainSource()])
    const handlers = new Set(names(main, HANDLE))
    expect(names(api, INVOKE).filter((channel) => !handlers.has(channel))).toEqual([])
  })

  it('主进程每个 handler 都被 preload 暴露，没有无人调用的频道', async () => {
    const [api, main] = await Promise.all([preload(), mainSource()])
    const invoked = new Set(names(api, INVOKE))
    expect(names(main, HANDLE).filter((channel) => !invoked.has(channel))).toEqual([])
  })

  it('preload 每条 on* 频道都有主进程发送方', async () => {
    const [api, main] = await Promise.all([preload(), mainSource()])
    const sent = new Set(names(main, SEND))
    expect(names(api, LISTEN).filter((channel) => !sent.has(channel))).toEqual([])
  })

  it('文档频道的 invoke/推送 与 preload 白名单双向一致', async () => {
    const [api, contract] = await Promise.all([preload(), doc()])
    const rows = [...contract.matchAll(DOC_ROW)].map((match) => [match[1], match[2]] as const)
    const invoked = new Set(names(api, INVOKE))
    const listened = new Set(names(api, LISTEN))
    expect(
      rows
        .filter(([channel, kind]) => (kind === 'invoke' ? !invoked.has(channel) : !listened.has(channel)))
        .map(([channel]) => channel),
    ).toEqual([])
    const documented = new Set(rows.map(([channel]) => channel))
    expect([...invoked, ...listened].filter((channel) => !documented.has(channel))).toEqual([])
  })
})
