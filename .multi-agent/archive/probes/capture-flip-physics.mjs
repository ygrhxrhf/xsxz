// 飞页物理（参考站 LeafSim PBD）的观感复核：进入真实书籍，点下一页，在 quick 翻页的
// 0.4s 里连续截图，看纸是否先卷起纸角、中段鼓、再平躺落下；并记录翻页期间 rAF 帧间隔。
//
// 用法：先 `npm run build`，再 `node .multi-agent/archive/probes/capture-flip-physics.mjs`
// 截图输出到临时目录（最后打印路径）。脚本不读写任何密钥。
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const PORT = 43000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const lib = await mkdtemp(join(tmpdir(), 'spbf-flipphys-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-flipphys-user-'))
const shotDir = join(tmpdir(), 'spbf-flip-physics-shots')
await mkdir(shotDir, { recursive: true })
const bookId = 'd_flipphys'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const body = Array.from({ length: 120 }, (_, i) =>
  `第${i + 1}段：这是飞页物理复核用的长文。它要能排满很多页，连翻才会让纸从右页一直卷到左页。`).join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '飞页物理样书', author: '测试', tags: [],
  sourceUrl: 'https://example.com/flipphys/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章', url: 'https://example.com/flipphys/1.html', file: '0001.json', status: 'ready' }],
}, null, 2), 'utf-8')
await writeFile(join(bookDir, '0001.json'), JSON.stringify({
  title: '第一章', url: 'https://example.com/flipphys/1.html', body, status: 'ready',
}), 'utf-8')
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: {
    fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
    paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'screen',
    bookView: 'realbook',
  },
}, null, 2), 'utf-8')
console.log(`夹具：${lib}\n截图：${shotDir}`)

const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--window-size=1440,900'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
const killTree = () => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch { /* 已退出 */ }
}
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
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.bringToFront')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  const ev = async (bodyText) => {
    const result = await cdp('Runtime.evaluate', { expression: `(async () => { ${bodyText} })()`, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }
  const waitFor = async (expr, timeout = 20000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      if (await ev(`return (${expr});`)) return true
      await sleep(150)
    }
    throw new Error('等待超时：' + expr)
  }
  const shot = async (name) => {
    const data = await cdp('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(shotDir, name), Buffer.from(data.data, 'base64'))
  }
  const click = (expr) => ev(`const el = ${expr}; if (!el) return 'none'; el.click(); return 'ok';`)
  const waitForOpt = async (expr, timeout = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      try { if (await ev(`return (${expr});`)) return true } catch { /* 页面正在重载 */ }
      await sleep(250)
    }
    return false
  }
  await waitForOpt(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`)
  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'webgl'); return true;`)
  await cdp('Page.reload')
  await sleep(2000)
  await waitForOpt(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitForOpt(`document.querySelector('.book-open-area')`)
  await click(`document.querySelector('.book-open-area')`)
  await waitForOpt(`document.querySelector('.real-book-webgl-stage')`)
  await sleep(2500)

  // 采样：每帧记录一张纸的最大抬升（用 canvas 像素做不到，改用 rAF 帧间隔与页码）。
  await ev(`window.__flipFrames = []; let last = 0; const tick = (t) => { if (last) window.__flipFrames.push(t - last); last = t; if (window.__flipFrames.length < 400) requestAnimationFrame(tick) }; requestAnimationFrame(tick); return true;`)

  await ev(`document.querySelector('.real-book-dock')?.click(); await new Promise((r) => setTimeout(r, 250)); return true;`)
  const hit = await ev(`const r = document.querySelector('.real-book-webgl-hit')?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;`)
  const x = Math.round(hit.left + hit.width * 0.9)
  const y = Math.round(hit.top + hit.height / 2)
  // 自动翻一页，抓 quick 0.4s 的中段（截图之间约 45ms）。
  // 自动翻页走底栏按钮：书页区域的点按由 Reader 的三分区接管，渲染层复核只量纸。
  // 探针在 rAF 里采：后台窗口的 rAF 会被节流，脚本改用 setInterval 采样，采样本身不影响帧率。
  await ev(`window.__flipTrace = []; window.__flipTraceTimer = setInterval(() => { const st = window.__rbSceneProbe?.(); if (st) window.__flipTrace.push({ t: performance.now(), ...st }); }, 16); return true;`)
  // 书页区域的点按由 Reader 的三分区接管；走「下一页」按钮，再抓后续的拖页。
  await ev(`document.querySelector('.real-book-dock')?.click(); await new Promise((r) => setTimeout(r, 350)); return true;`)
  await click(`document.querySelector('.reader-bottombar [aria-label="下一页"]')`)
  // 截图会阻塞渲染线程：先纯采样 1.2s 看 quick 的整个行程，再单独抓终帧。
  await sleep(1200)
  await ev(`clearInterval(window.__flipTraceTimer); return true;`)
  await shot('flip-auto-settled.png')
  // 往回翻一页再回到同一摊开，供后续拖页复核。
  await click(`document.querySelector('.reader-bottombar [aria-label="上一页"]')`)
  await sleep(1200)

  // 拖页保持：每个位置都能停住，截图才抓得到真正的中间纸形。
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  const distances = [24, 60, 110, 170, 240, 320, 420, 520]
  for (const [i, distance] of distances.entries()) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - distance, y, button: 'left', buttons: 1 })
    await sleep(90)
    await shot(`flip-drag-${String(i).padStart(2, '0')}-${distance}.png`)
  }
  // 松手取消：纸弹回，页面不变；随后再点一次自动翻，抓 quick 尾段。
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - distances[distances.length - 1], y, button: 'left', clickCount: 1 })
  await sleep(700)
  await shot('flip-release-cancel.png')
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(300)
  await shot('flip-quick-late.png')
  await sleep(900)
  await shot('flip-settled.png')

  const trace = await ev(`return window.__flipTrace || [];`)
  const t0 = trace[0]?.t ?? 0
  for (const row of trace.filter((_, index) => index % 6 === 0)) {
    console.log(`t=${(row.t - t0).toFixed(0)}ms phi=${row.phi.toFixed(2)} mode=${row.mode} flex=${row.flex.toFixed(2)} landing=${row.landing.toFixed(2)} tipX=${row.tipX.toFixed(2)} midX=${row.midX.toFixed(2)} rootX=${row.rootX.toFixed(2)} tipZ=${row.tipZ.toFixed(2)} progress=${row.progress.toFixed(2)}`)
  }
  if (!trace.length) console.log('（探针没记录到飞行纸）')
  const debug = await ev(`return {
    nextButton: Boolean(document.querySelector('.reader-bottombar [aria-label="下一页"]')),
    dockOpen: document.querySelector('.real-book-dock')?.className ?? '',
    label: document.querySelector('.real-book-page-label')?.textContent ?? '',
    flips: window.__rbSceneProbeAll?.() ?? [],
  };`)
  console.log('click 后：', JSON.stringify(debug))
  const frames = await ev(`return window.__flipFrames || [];`)
  const interval = frames.slice(5).sort((a, b) => a - b)
  const median = interval[Math.floor(interval.length / 2)] ?? 0
  const worst = interval[interval.length - 1] ?? 0
  console.log(`帧间隔中位数 ${median.toFixed(1)}ms，最长 ${worst.toFixed(1) }ms（共 ${frames.length} 帧）`)
  const label = await ev(`return document.querySelector('.real-book-page-label')?.textContent || '';`)
  console.log(`页码：${label}`)
  console.log('截图已写入 ' + shotDir)
} finally {
  try { ws?.close() } catch { /* 已关闭 */ }
  killTree()
}
