import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  KERNEL_PORT_MAX,
  KERNEL_PORT_MIN,
  isPortListening,
  kernelBinaryPath,
  kernelConfigPath,
  kernelDownloadUrl,
  pickFreePort,
  startKernel,
  waitForKernel,
} from './proxyKernel'

/** 测试用临时目录：落在系统 temp 下，跑完删掉，别污染工作区。 */
const TEMP_DIRS: string[] = []
function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `spbf-kernel-${tag}-`))
  TEMP_DIRS.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

describe('kernelBinaryPath / kernelConfigPath', () => {
  it('内核与配置都放在 userData/proxy-kernel 下', () => {
    const base = 'C:\\Users\\x\\AppData\\Roaming\\spbf'
    expect(kernelConfigPath(base)).toContain('proxy-kernel')
    expect(kernelBinaryPath(base)).toContain('proxy-kernel')
    expect(kernelBinaryPath(base)).toMatch(/sing-box(\.exe)?$/)
  })
})

describe('pickFreePort', () => {
  it('返回第一个空闲端口', async () => {
    const port = await pickFreePort({
      min: 20801,
      max: 20805,
      isFree: async (p) => p === 20803,
    })
    expect(port).toBe(20803)
  })

  it('全被占用时抛错，而不是返回一个坏端口', async () => {
    await expect(
      pickFreePort({ min: 20801, max: 20803, isFree: async () => false }),
    ).rejects.toThrow(/没有空闲端口/)
  })

  it('默认区间在 20801–20899', () => {
    expect(KERNEL_PORT_MIN).toBe(20801)
    expect(KERNEL_PORT_MAX).toBe(20899)
  })
})

describe('waitForKernel', () => {
  it('端口起来就返回 true', async () => {
    let calls = 0
    const ok = await waitForKernel(1234, {
      timeoutMs: 500,
      intervalMs: 10,
      probe: async () => ++calls >= 3,
    })
    expect(ok).toBe(true)
    expect(calls).toBe(3)
  })

  it('超时返回 false，不会无限等', async () => {
    const ok = await waitForKernel(1234, {
      timeoutMs: 100,
      intervalMs: 10,
      probe: async () => false,
    })
    expect(ok).toBe(false)
  })
})

describe('startKernel', () => {
  function fakeChild() {
    const handlers: Record<string, Array<() => void>> = {}
    return {
      pid: 4242,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      kill: vi.fn(),
      once: (event: string, fn: () => void) => {
        ;(handlers[event] ??= []).push(fn)
      },
      emit: (event: string) => {
        for (const fn of handlers[event] ?? []) fn()
      },
    }
  }

  it('内核文件不存在时给出可操作的提示，不去 spawn', async () => {
    const spawnFn = vi.fn()
    const res = await startKernel(
      { userDataDir: '/tmp/x', config: {}, port: 20801 },
      { exists: () => false, spawnFn: spawnFn as never },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain('下载内核')
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('内核起来了就返回 handle，stop 可重复调用', async () => {
    const child = fakeChild()
    const res = await startKernel(
      { userDataDir: tempDir('a'), config: { a: 1 }, port: 20801 },
      {
        exists: () => true,
        spawnFn: (() => child) as never,
        waitFor: async () => true,
      },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.handle.pid).toBe(4242)
    expect(res.handle.port).toBe(20801)
    child.emit('exit')
    await res.handle.stop()
    await res.handle.stop()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('内核没把端口听起来时判失败，并把最后几行输出带出来', async () => {
    const child = fakeChild()
    const res = await startKernel(
      { userDataDir: tempDir('b'), config: {}, port: 20801 },
      {
        exists: () => true,
        spawnFn: (() => child) as never,
        waitFor: async () => false,
      },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/没能启动/)
    expect(child.kill).toHaveBeenCalled()
  })

  it('进程立刻退出也算失败（不进 handle）', async () => {
    const child = fakeChild()
    const res = await startKernel(
      { userDataDir: tempDir('c'), config: {}, port: 20801 },
      {
        exists: () => true,
        spawnFn: (() => child) as never,
        waitFor: async () => {
          child.emit('exit')
          return true
        },
      },
    )
    expect(res.ok).toBe(false)
  })
})

describe('kernelDownloadUrl', () => {
  it('指向官方 GitHub Release，不经过第三方镜像', () => {
    const url = kernelDownloadUrl('1.14.4')
    expect(url).toContain('github.com/SagerNet/sing-box/releases/download/v1.14.4/')
    expect(url).toContain('sing-box-1.14.4-')
  })
})

describe('isPortListening', () => {
  it('没在监听的端口返回 false', async () => {
    expect(await isPortListening(1, 200)).toBe(false)
  })
})
