// 用 screencast 抓本项目真实书籍的 quick 翻页逐帧：截图命令会阻塞渲染线程，抓不到 0.4s 中段。
// 先 `npm run build`，再 node .multi-agent/archive/probes/screencast-spbf-flip.mjs
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const outDir = join(tmpdir(), 'spbf-spbf-screencast')
await mkdir(outDir, { recursive: true })
const lib = await mkdtemp(join(tmpdir(), 'spbf-cast-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-cast-user-'))
const bookId = 'd_cast'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const body = Array.from({ length: 140 }, (_, i) =>
  `第${i + 1}段：这是逐帧对照用的长文。纸要能从右页卷到左页，中段才能看见整片纸张的弯曲与文字的跟随。`).join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '逐帧对照样书', author: '测试', tags: [],
  sourceUrl: 'https://example.com/cast/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章', url: 'https://example.com/cast/1.html', file: '0001.json', status: 'ready' }],
}, null, 2), 'utf-8')
await writeFile(join(bookDir, '0001.json'), JSON.stringify({ title: '第一章', url: 'https://example.com/cast/1.html', body, status: 'ready' }), 'utf-8')
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: { fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'screen', bookView: 'realbook' },
}, null, 2), 'utf-8')

const PORT = 47000 + Math.floor(Math.random() * 2000)
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
      const { data, sessionId } = message.params
      await writeFile(join(outDir, `frame-${String(frameIndex++).padStart(3, '0')}.jpg`), Buffer.from(data, 'base64'))
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
  await cdp('Page.bringToFront')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => { })
  const ev = async (bodyText) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${bodyText} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }
  const waitFor = async (expr, timeout = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      try { if (await ev(`return (${expr});`)) return true } catch { /* 重载中 */ }
      await sleep(250)
    }
    return false
  }
  const click = (expr) => ev(`const el = ${expr}; if (!el) return 'none'; el.click(); return 'ok';`)
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`)
  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'webgl'); return true;`)
  await cdp('Page.reload')
  await sleep(2000)
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitFor(`document.querySelector('.book-open-area')`)
  await click(`document.querySelector('.book-open-area')`)
  await waitFor(`document.querySelector('.real-book-webgl-stage')`)
  await sleep(6000)
  await ev(`document.querySelector('.real-book-dock')?.click(); await new Promise((r) => setTimeout(r, 300)); return true;`)
  // 先翻一次让字体分片/页表重排落定；第二次翻页才是稳定的动画。
  await click(`document.querySelector('.reader-bottombar [aria-label="下一页"]')`)
  await sleep(1800)
  // 慢动作：rAF 时间戳与 setTimeout 一起放慢 8 倍，screencast 才抓得到 0.4s 的各个相位。
  await ev(`
    const realRaf = window.requestAnimationFrame.bind(window);
    let base = null;
    window.requestAnimationFrame = (cb) => realRaf((t) => { if (base === null) base = t; cb(base + (t - base) * 0.125); });
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms * 8, ...args);
    return true;
  `)
  await cdp('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 })
  await click(`document.querySelector('.reader-bottombar [aria-label="下一页"]')`)
  await sleep(5200)
  await cdp('Page.stopScreencast')
  console.log(`抓到 ${frameIndex} 帧：${outDir}`)
} finally {
  try { ws?.close() } catch { /* 已关闭 */ }
  killTree()
}
