import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function channelsOf(file: string, call: string): Promise<Set<string>> {
  const source = await readFile(new URL(file, import.meta.url), 'utf-8')
  const found = new Set<string>()
  const pattern = new RegExp(`${call}\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g')
  for (const match of source.matchAll(pattern)) found.add(match[1]!)
  return found
}

/** 主进程的 handler 现在有两种写法：index.ts 的 ipcMain.handle 与 core 模块的 register。 */
async function mainHandlers(): Promise<Set<string>> {
  const found = new Set<string>()
  const walk = async (url: URL): Promise<void> => {
    const entries = await readdir(url, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.includes('.test.')) continue
      const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, url)
      if (entry.isDirectory()) {
        await walk(child)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      const source = await readFile(child, 'utf-8')
      for (const match of source.matchAll(/ipcMain\.handle\(\s*['"`]([^'"`]+)['"`]/g)) found.add(match[1]!)
      for (const match of source.matchAll(/\bregister\(\s*['"`]([^'"`]+)['"`]/g)) found.add(match[1]!)
    }
  }
  await walk(new URL('./', import.meta.url))
  return found
}

describe('preload ↔ main IPC channel alignment', () => {
  const invoked = channelsOf('../preload/index.ts', 'ipcRenderer\\.invoke')
  const handled = mainHandlers()
  const pushed = channelsOf('./index.ts', '\\.send')
  const listened = channelsOf('../preload/index.ts', '\\bon')

  it('has a main handler for every channel preload invokes', async () => {
    const handlers = await handled
    const missing = [...(await invoked)].filter((channel) => !handlers.has(channel)).sort()
    expect(missing).toEqual([])
    // guard against a broken regex silently passing this test
    expect(handlers.size).toBeGreaterThan(50)
  })

  it('has a preload listener for every channel main pushes', async () => {
    const senders = await pushed
    const listeners = await listened
    const orphans = [...senders].filter((channel) => !listeners.has(channel)).sort()
    expect(orphans).toEqual([])
    expect(senders.size).toBeGreaterThan(5)
  })
})
