// 与参考站对照飞行纸的观感：同一支脚本分别打开参考站（VITE 本地样例书）与本项目，
// 用 CDP 在拖页保持的各个位置截图，便于逐帧比对纸的卷曲形状与明暗。
//
// 参考站先起：`cd _ref_infinite_reader && VITE_BACKEND=local npm --prefix web run dev -- --port 5199`
// 用法：node .multi-agent/archive/probes/compare-ref-flip.mjs
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const outDir = join(tmpdir(), 'spbf-flip-compare')
await mkdir(outDir, { recursive: true })
const REF_URL = 'http://localhost:5199/?sample=zh&lang=zh-CN'

const userData = await mkdtemp(join(tmpdir(), 'spbf-compare-user-'))
const PORT = 45000 + Math.floor(Math.random() * 2000)
const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--window-size=1440,900'], { stdio: ['ignore', 'pipe', 'pipe'] })
const killTree = () => { try { if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGTERM') } catch { /* 已退出 */ } }
let ws
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
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
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
  const ev = async (bodyText) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${bodyText} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => { })
  await cdp('Page.navigate', { url: REF_URL })
  await sleep(6000)
  const shot = async (name) => {
    const data = await cdp('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(outDir, name), Buffer.from(data.data, 'base64'))
  }
  await shot('ref-initial.png')
  // 翻到有正文的摊开：标题页不翻，按右侧区点两下（参考站的三分区翻页）。
  const stage = await ev(`const el = document.querySelector('.reader-canvas, .reader-stage canvas, canvas'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height };`)
  if (stage) {
    const y = Math.round(stage.top + stage.height * 0.55)
    // 参考站：纸张命中区在画布中央，翻页靠右侧纸张点击（三分区在 DataFrame 内部）。
    const info = await ev(`const c = document.querySelector('.desk-canvas'); const r = c.getBoundingClientRect(); return { w: r.width, h: r.height };`)
    console.log('画布：', JSON.stringify(info))
    // 键盘右方向键是同一件事：参考站 reader 的键盘翻页（无选区时）。
    for (let i = 0; i < 6; i += 1) {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
      await sleep(900)
    }
    await shot('ref-body.png')
    // 拖住半程：参考站的 beginDrag 让纸跟手。纸张在屏幕中央，抓右页外缘。
    const dragX = Math.round(stage.left + stage.width * 0.645)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragX, y: Math.round(stage.top + stage.height * 0.48), button: 'none' })
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragX, y: Math.round(stage.top + stage.height * 0.48), button: 'left', clickCount: 1 })
    const distances = [24, 60, 110, 170, 240, 320, 420, 520]
    for (const [i, distance] of distances.entries()) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragX - distance, y: Math.round(stage.top + stage.height * 0.48), button: 'left', buttons: 1 })
      await sleep(120)
      await shot(`ref-drag-${String(i).padStart(2, '0')}-${distance}.png`)
    }
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragX - distances[distances.length - 1], y: Math.round(stage.top + stage.height * 0.48), button: 'left', clickCount: 1 })
    await sleep(1400)
    await shot('ref-drag-settled.png')
  }
  console.log('参考站截图：' + outDir)
} finally {
  try { ws?.close() } catch { /* 已关闭 */ }
  killTree()
}
