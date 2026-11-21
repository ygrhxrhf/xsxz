// 用 CDP 的 screencast 抓参考站真实翻页的每一帧（截图命令会阻塞渲染线程，抓不到 0.4s 的中段）。
// 参考站先起：cd _ref_infinite_reader && VITE_BACKEND=local npm --prefix web run dev -- --port 5199
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const outDir = join(tmpdir(), 'spbf-ref-screencast')
await mkdir(outDir, { recursive: true })
const userData = await mkdtemp(join(tmpdir(), 'spbf-refcast-user-'))
const PORT = 46000 + Math.floor(Math.random() * 2000)
const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--window-size=1440,900'], { stdio: ['ignore', 'pipe', 'pipe'] })
const killTree = () => { try { if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGTERM') } catch { /* 已退出 */ } }
let ws
let frameIndex = 0
try {
  let target
  for (let i = 0; i < 200; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && String(t.url).startsWith('file:'))
      if (target) break
    } catch { /* 端口未起 */ }
    await sleep(300)
  }
  if (!target) throw new Error('没找到渲染页')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let nextId = 1
  const pending = new Map()
  ws.onmessage = async (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Page.screencastFrame') {
      const { data, sessionId, metadata } = message.params
      const path = join(outDir, `frame-${String(frameIndex++).padStart(3, '0')}.jpg`)
      await writeFile(path, Buffer.from(data, 'base64'))
      cdp('Page.screencastFrameAck', { sessionId }).catch(() => { })
      return
    }
    if (!message.id) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  }
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId += 1
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => { })
  const ev = async (bodyText) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${bodyText} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }
  await cdp('Page.navigate', { url: 'http://localhost:5199/?sample=zh&lang=zh-CN' })
  await sleep(6000)
  for (let i = 0; i < 6; i += 1) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await sleep(900)
  }
  await cdp('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await sleep(1200)
  await cdp('Page.stopScreencast')
  console.log(`抓到 ${frameIndex} 帧：${outDir}`)
} finally {
  try { ws?.close() } catch { /* 已关闭 */ }
  killTree()
}
