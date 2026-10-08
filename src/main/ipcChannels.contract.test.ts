import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function channelsOf(file: string, call: string): Promise<Set<string>> {
  const source = await readFile(new URL(file, import.meta.url), 'utf-8')
  const found = new Set<string>()
  const pattern = new RegExp(`${call}\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g')
  for (const match of source.matchAll(pattern)) found.add(match[1]!)
  return found
}

describe('preload ↔ main IPC channel alignment', () => {
  const invoked = channelsOf('../preload/index.ts', 'ipcRenderer\\.invoke')
  const handled = channelsOf('./index.ts', 'ipcMain\\.handle')
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
