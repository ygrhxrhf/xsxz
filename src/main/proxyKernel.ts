import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, Socket } from 'node:net'
import JSZip from 'jszip'

/**
 * 内置代理内核（sing-box）的启动与管理。
 *
 * 为什么不复用用户自装的 v2rayN：
 * 1. 用户往往只有一条订阅，没有客户端；
 * 2. 即使装了，还得手动选节点、确认本地端口，再把端口填进本应用；
 * 3. 订阅里的 hysteria2 / tuic / anytls 是 UDP 系协议，v2rayN 的支持视版本而定，
 *    而 sing-box 对四种协议都是原生的。
 *
 * 内核由本应用拉起、随应用退出，用户只需要贴一条订阅链接。
 *
 * 进程管理刻意简单：一个内核、一个 mixed 端口、退出时杀掉。不做热重载，
 * 换节点就重启内核（几百毫秒），比维护热重载状态机可靠得多。
 */

export const KERNEL_PORT_MIN = 20801
export const KERNEL_PORT_MAX = 20899

/** 内核可执行文件在 userData 下的相对位置。 */
export function kernelBinaryPath(userDataDir: string): string {
  return join(userDataDir, 'proxy-kernel', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box')
}

/** 内核配置文件路径。每次启动重写，因此放临时文件名即可。 */
export function kernelConfigPath(userDataDir: string): string {
  return join(userDataDir, 'proxy-kernel', 'config.json')
}

export interface KernelStartOptions {
  userDataDir: string
  config: Record<string, unknown>
  port: number
}

export interface KernelHandle {
  /** 内核进程 pid；拿不到时为 null。 */
  pid: number | null
  port: number
  /** 停止内核并清理临时文件。可重复调用。 */
  stop(): Promise<void>
}

export type KernelStartResult =
  | { ok: true; handle: KernelHandle }
  | { ok: false; message: string }

/** 从区间里挑一个没被占用的本地端口。 */
export async function pickFreePort(
  opts: { min?: number; max?: number; isFree?: (port: number) => Promise<boolean> } = {},
): Promise<number> {
  const min = opts.min ?? KERNEL_PORT_MIN
  const max = opts.max ?? KERNEL_PORT_MAX
  const isFree = opts.isFree ?? defaultIsFree
  for (let port = min; port <= max; port++) {
    if (await isFree(port)) return port
  }
  throw new Error(`本机没有空闲端口可用（已试 ${min}–${max}）`)
}

function defaultIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    const done = (value: boolean): void => {
      server.removeAllListeners()
      server.close(() => resolve(value))
    }
    server.once('error', () => done(false))
    server.once('listening', () => done(true))
    server.listen(port, '127.0.0.1')
  })
}

/** 端口上有没有东西在监听（用来判断内核是否已经起来）。 */
export function isPortListening(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, '127.0.0.1')
  })
}

/** 等内核把端口监听起来；超时说明配置有问题或内核没跑起来。 */
export async function waitForKernel(
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number; probe?: (port: number) => Promise<boolean> } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const intervalMs = opts.intervalMs ?? 150
  const probe = opts.probe ?? isPortListening
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(port)) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

/**
 * 启动内核。
 *
 * 先把配置写成临时文件再拉起进程——sing-box 只接受配置文件，不做命令行传参。
 * 内核的 stdout/stderr 收进环形缓冲，起不来时把最后几行还给用户，
 * 否则「点了没反应」是最难查的故障。
 */
export async function startKernel(
  options: KernelStartOptions,
  deps: {
    exists?: (path: string) => boolean
    spawnFn?: typeof spawn
    waitFor?: (port: number) => Promise<boolean>
  } = {},
): Promise<KernelStartResult> {
  const binary = kernelBinaryPath(options.userDataDir)
  const exists = deps.exists ?? existsSync
  if (!exists(binary)) {
    return {
      ok: false,
      message: `还没有内置代理内核。请在「网络代理」里点「下载内核」（约 32MB），或把 sing-box 手动放到 ${binary}`,
    }
  }

  const configPath = kernelConfigPath(options.userDataDir)
  try {
    await mkdir(join(options.userDataDir, 'proxy-kernel'), { recursive: true })
    await writeFile(configPath, JSON.stringify(options.config, null, 2), 'utf-8')
  } catch (e) {
    return { ok: false, message: `写入内核配置失败：${e instanceof Error ? e.message : String(e)}` }
  }

  const spawnFn = deps.spawnFn ?? spawn
  let child: ChildProcess
  try {
    child = spawnFn(binary, ['run', '-c', configPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    return { ok: false, message: `启动内核失败：${e instanceof Error ? e.message : String(e)}` }
  }

  const tail: string[] = []
  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
      const text = line.trim()
      if (!text) continue
      tail.push(text)
      if (tail.length > 20) tail.shift()
    }
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  let exited = false
  child.once('exit', () => {
    exited = true
  })

  const waitFor = deps.waitFor ?? ((port: number) => waitForKernel(port))
  const ready = await waitFor(options.port)
  if (!ready || exited) {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
    const detail = tail.slice(-3).join(' / ')
    return {
      ok: false,
      message: detail ? `内核没能启动：${detail}` : '内核没能启动，请检查订阅的节点是否可用',
    }
  }

  let stopped = false
  return {
    ok: true,
    handle: {
      pid: child.pid ?? null,
      port: options.port,
      async stop() {
        if (stopped) return
        stopped = true
        try {
          child.kill()
        } catch {
          /* 已退出 */
        }
        // 等进程真的退出，避免下次启动撞端口
        await new Promise<void>((resolve) => {
          if (exited) return resolve()
          const timer = setTimeout(resolve, 2000)
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
        await rm(configPath, { force: true }).catch(() => {})
      },
    },
  }
}

/**
 * 内核下载地址。
 *
 * 只从官方 GitHub Release 取——代理内核是整条链路的信任根，不从第三方镜像拿，
 * 哪怕镜像更快。下载慢的问题交给用户自己的网络条件解决。
 */
/** 应用内置的 sing-box 版本。升级时只改这一处，界面与文档都从这里取。 */
export const KERNEL_VERSION = '1.14.4'

export function kernelDownloadUrl(version = KERNEL_VERSION): string {
  const asset =
    process.platform === 'win32'
      ? `sing-box-${version}-windows-amd64.zip`
      : process.platform === 'darwin'
        ? `sing-box-${version}-darwin-arm64.tar.gz`
        : `sing-box-${version}-linux-amd64.tar.gz`
  return `https://github.com/SagerNet/sing-box/releases/download/v${version}/${asset}`
}

/**
 * 低于这个大小的一律当作坏包。
 *
 * 真实内核约 80MB，压缩包约 32MB；设一个下限是为了拦住「下载到半截」
 * 或「拿 HTML 错误页当压缩包」的情况，不是完整性校验。
 */
export const KERNEL_MIN_BYTES = 1_000_000

/** 内核可执行文件是否已经在 userData 下（手动放的也算）。 */
export function kernelInstalled(userDataDir: string): boolean {
  return existsSync(kernelBinaryPath(userDataDir))
}

export interface KernelInstallResult {
  ok: boolean
  message?: string
  /** 安装后的可执行文件路径；成功时有值。 */
  binaryPath?: string
  /** 安装的版本。 */
  version?: string
}

export interface KernelInstallOptions {
  userDataDir: string
  /** 缺省用 KERNEL_VERSION。 */
  version?: string
  /** 已存在时是否重新下载覆盖。 */
  force?: boolean
  /** 下载实现；测试注入。生产走官方 GitHub Release。 */
  download?: (url: string) => Promise<Uint8Array>
}

/**
 * 下载并安装内置内核。
 *
 * 用户只有一条订阅链接时，不该再被要求「自己去 GitHub 下个 exe 放进某个目录」。
 * 这里把下载 → 解压 → 落盘做成一步：只认官方 Release，不改文件名，
 * 写临时文件再 rename，避免半截文件被下次启动当成可用内核。
 *
 * 目前只做 Windows 的 zip；其它平台返回可读的提示，由本人手动安装。
 */
export async function installKernel(options: KernelInstallOptions): Promise<KernelInstallResult> {
  const version = options.version ?? KERNEL_VERSION
  const binary = kernelBinaryPath(options.userDataDir)
  if (!options.force && existsSync(binary)) {
    return { ok: true, message: '内置内核已就位', binaryPath: binary, version }
  }

  // 非 Windows 的官方包是 tar.gz；自动安装只做 Windows 的 zip。
  // 注入 download 是测试入口，跳过平台判断，便于在任何 CI 上验证解压逻辑。
  if (process.platform !== 'win32' && !options.download) {
    return {
      ok: false,
      message: `自动安装目前只支持 Windows。请手动下载 ${kernelDownloadUrl(version)} 并放到 ${binary}`,
    }
  }

  let zipBytes: Uint8Array
  try {
    zipBytes = await (options.download ?? downloadBytes)(kernelDownloadUrl(version))
  } catch (e) {
    return { ok: false, message: `内核下载失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (zipBytes.byteLength < KERNEL_MIN_BYTES) {
    return { ok: false, message: `下载的内核包不完整（只有 ${zipBytes.byteLength} 字节），请重试` }
  }

  let archive: JSZip
  try {
    archive = await JSZip.loadAsync(zipBytes)
  } catch {
    return { ok: false, message: '内核压缩包无法解压，请重试' }
  }
  const entry = Object.values(archive.files).find(
    (file) => !file.dir && /(^|\/)sing-box\.exe$/i.test(file.name),
  )
  if (!entry) return { ok: false, message: '内核压缩包里没有 sing-box.exe' }

  let exeBytes: Uint8Array
  try {
    exeBytes = await entry.async('uint8array')
  } catch (e) {
    return { ok: false, message: `解压内核失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (exeBytes.byteLength < KERNEL_MIN_BYTES) {
    return { ok: false, message: '解压出的 sing-box.exe 不完整，请重试' }
  }

  const dir = join(options.userDataDir, 'proxy-kernel')
  const tempPath = `${binary}.download`
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(tempPath, exeBytes)
    // rename 覆盖旧文件：内核没在跑时才允许走到这里（调用方负责先停内核）。
    await rename(tempPath, binary)
  } catch (e) {
    await rm(tempPath, { force: true }).catch(() => {})
    return { ok: false, message: `写入内核失败：${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, message: `内核 ${version} 已安装`, binaryPath: binary, version }
}

/** 官方 Release 下载；跟随重定向（GitHub 会跳 release-assets）。 */
async function downloadBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'spbf/0.1' },
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
