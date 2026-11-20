// 飞页正文跟随卷曲：真机复核（快翻连续帧 + 拖页保持帧 + 手动读 DOM 片段）。
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'

const root = 'C:\\codes\\xsxz'
const PORT = 39000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shotDir = join(root, '.multi-agent', 'visual', 'flyertext')
await mkdir(shotDir, { recursive: true })

const lib = await mkdtemp(join(tmpdir(), 'spbf-flyer-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-flyer-user-'))
const bookId = 'd_flyer'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const paras = []
for (let i = 0; i < 40; i += 1) {
  paras.push(`第${i + 1}段：这是一个用来对照参考站的测试段落。段落要有自然的长度，让每一页都能排出完整的正文，字号、行距、页边距与断行都按参考站的书页来核对。同一项技术，在不同的行业里往往同时扮演这三种角色。`)
}
const body = paras.join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '智人之后（排版样书）', author: '排版测试', tags: [],
  sourceUrl: 'https://example.com/flyer/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章 观感', url: 'https://example.com/flyer/1.html', file: '0001.json', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0, rest: undefined },
}, null, 2), 'utf-8')
await writeFile(join(bookDir, '0001.json'), JSON.stringify({
  title: '第一章 观感', url: 'https://example.com/flyer/1.html', body, status: 'ready',
}), 'utf-8')
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: {
    fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
    paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'screen',
    bookView: 'realbook',
  },
}, null, 2), 'utf-8')

const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (c) => { out += String(c) })
child.stderr.on('data', (c) => { out += String(c) })
const killTree = () => { try { if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill() } catch {} }

let ws
try {
  let target
  for (let i = 0; i < 200; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && String(t.url).startsWith('file:'))
      if (target) break
    } catch {}
    await sleep(300)
  }
  if (!target) throw new Error('no target\n' + out.slice(-2000))
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let nextId = 1
  const pending = new Map()
  const errs = []
  const frames = []
  let screencastAt = 0
  let screencastOn = false
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text)
    if (m.method === 'Page.screencastFrame' && screencastOn) {
      const { data, sessionId, metadata } = m.params
      const t = screencastAt ? Math.round(metadata.timestamp * 1000 - screencastAt) : 0
      const file = `flip-${String(frames.length).padStart(2, '0')}-${t}ms.png`
      frames.push(file)
      void writeFile(join(shotDir, file), Buffer.from(data, 'base64'))
      void cdp('Page.screencastFrameAck', { sessionId }).catch(() => {})
    }
    if (!m.id) return
    const w = pending.get(m.id); if (!w) return
    pending.delete(m.id)
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result)
  }
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId += 1
    pending.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await cdp('Runtime.enable'); await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1536, height: 714, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.bringToFront')
  const ev = async (body) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }
  const waitFor = async (expr, timeout = 20000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) { if (await ev(`return (${expr});`)) return true; await sleep(150) }
    return false
  }
  const click = (expr) => ev(`const el = ${expr}; if (!el) return 'none'; el.scrollIntoView(); el.click(); return 'ok';`)
  const shot = async (name, clip) => {
    const r = await cdp('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' })
    await writeFile(join(shotDir, name), Buffer.from(r.data, 'base64'))
    return name
  }
  const flipTextInfo = () => ev(`
    const els = [...document.querySelectorAll('.real-book-flip-line')];
    const visible = els.filter((el) => el.style.display !== 'none');
    const rects = visible.map((el) => el.getBoundingClientRect());
    const bounds = rects.length
      ? { left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)), right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) }
      : null;
    const transformed = visible.filter((el) => /matrix3d/.test(el.style.transform)).length;
    const faces = visible.reduce((acc, el) => { const k = el.dataset.face || '?'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    const firstText = visible.find((el) => el.textContent.length > 3)?.textContent || '';
    return {
      total: els.length,
      visible: visible.length,
      transformed,
      faces,
      firstText,
      bounds,
      sample: visible.slice(0, 4).map((el) => ({ text: el.textContent, transform: el.style.transform.slice(0, 70), rect: el.getBoundingClientRect().toJSON() })),
      hiddenStatic: [...document.querySelectorAll('.real-book-webgl-text-page')].map((el) => el.style.display),
      label: document.querySelector('.real-book-page-label')?.textContent,
    };
  `)

  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'webgl'); return 'ok';`)
  await cdp('Page.reload'); await sleep(2500)
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitFor(`document.querySelector('.book-open-area')`, 12000)
  await click(`document.querySelector('.book-open-area')`)
  await waitFor(`document.querySelector('.real-book-stage')`, 15000)
  await sleep(2500)

  console.log('INFO', JSON.stringify(await ev(`return {
    webgl: Boolean(document.querySelector('.real-book-webgl-stage canvas')),
    flipLayer: Boolean(document.querySelector('.real-book-webgl-flip-text')),
    label: document.querySelector('.real-book-page-label')?.textContent,
    fontsReady: document.fonts.check('22px "LXGW WenKai Screen"', '智人之后'),
  };`)))

  // 1) 快翻：0.4s 行程的连续帧（screencast）。
  screencastAt = Date.now()
  screencastOn = true
  await cdp('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1536, maxHeight: 714 })
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return 'ok';`)
  await sleep(900)
  screencastOn = false
  await cdp('Page.stopScreencast')
  console.log('FRAMES', frames.join(','))
  await sleep(1200)

  // 2) 拖页保持：纸停在卷曲中途，字应当贴着纸面。
  const rect = await ev(`const r=document.querySelector('.real-book-webgl-hit')?.getBoundingClientRect(); return r ? { left:r.left, top:r.top, width:r.width, height:r.height } : null;`)
  const y = Math.round(rect.top + rect.height / 2)
  const edgeX = Math.round(rect.left + rect.width - 10)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edgeX, y, button: 'none' })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: edgeX, y, button: 'left', clickCount: 1 })
  for (let step = 1; step <= 3; step += 1) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edgeX - step * 36, y, button: 'left', buttons: 1 })
    await sleep(60)
  }
  await sleep(250)
  console.log('HOLD1', JSON.stringify(await flipTextInfo()))
  console.log(await shot('hold-1.png'))
  console.log(await shot('hold-1-detail.png', { x: 520, y: 120, width: 620, height: 470, scale: 2 }))
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edgeX - 6 * 36, y, button: 'left', buttons: 1 })
  await sleep(250)
  console.log('HOLD2', JSON.stringify(await flipTextInfo()))
  console.log(await shot('hold-2.png'))
  console.log(await shot('hold-2-detail.png', { x: 420, y: 120, width: 720, height: 470, scale: 2 }))
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: edgeX - 6 * 36, y, button: 'left', clickCount: 1 })
  await sleep(1000)
  console.log('AFTER', JSON.stringify(await flipTextInfo()))
  console.log(await shot('after-forward.png'))

  // 3) 往回翻：左页掀回去。快翻连续帧 + 拖页保持。
  screencastAt = Date.now()
  screencastOn = true
  frames.length = 0
  await cdp('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1536, maxHeight: 714 })
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); return 'ok';`)
  await sleep(900)
  screencastOn = false
  await cdp('Page.stopScreencast')
  console.log('BACKFRAMES', frames.join(','))
  await sleep(1200)

  const leftX = Math.round(rect.left + 10)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: leftX, y, button: 'none' })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: leftX, y, button: 'left', clickCount: 1 })
  // 起手只有一点点翻起：左页的字应当还是原来这一页。
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: leftX + 16, y, button: 'left', buttons: 1 })
  await sleep(250)
  console.log('BACKSTART', JSON.stringify(await flipTextInfo()))
  console.log(await shot('hold-back-start.png'))
  for (let step = 1; step <= 3; step += 1) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: leftX + 16 + step * 36, y, button: 'left', buttons: 1 })
    await sleep(60)
  }
  await sleep(250)
  console.log('BACKHOLD', JSON.stringify(await flipTextInfo()))
  console.log(await shot('hold-back-1.png'))
  console.log(await shot('hold-back-1-detail.png', { x: 400, y: 120, width: 720, height: 470, scale: 2 }))
  // 拖到接近落定：纸背已经翻过去，右页的位置应当已经是上一张右页。
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: leftX + 290, y, button: 'left', buttons: 1 })
  await sleep(250)
  console.log('BACKLATE', JSON.stringify(await flipTextInfo()))
  console.log(await shot('hold-back-late.png'))
  console.log(await shot('hold-back-late-detail.png', { x: 300, y: 120, width: 780, height: 470, scale: 2 }))
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: leftX + 290, y, button: 'left', clickCount: 1 })
  await sleep(1000)

  console.log('ERRORS', JSON.stringify(errs.slice(0, 8)))
} finally {
  try { ws?.close() } catch {}
  killTree()
}
