import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = 'C:/codes/xsxz'
const electronPath = 'C:/codes/xsxz/node_modules/electron/dist/electron.exe'
const PORT = 43800 + Math.floor(Math.random() * 400)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const lib = await mkdtemp(join(tmpdir(), 'spbf-dbgd-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-dbgd-user-'))
const bookId = 'd_dbgd'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const body = Array.from({ length: 60 }, (_, i) => `第${i + 1}段：拖页调试正文，长度足够排满一页并折成多行。`).join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '拖页调试书', author: '测试', tags: [], sourceUrl: 'https://example.com/d/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章', url: 'https://example.com/d/1.html', file: '0001.json', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0 },
}), 'utf-8')
await writeFile(join(bookDir, '0001.json'), JSON.stringify({ title: '第一章', url: 'https://example.com/d/1.html', body, status: 'ready' }), 'utf-8')
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: { fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'screen', bookView: 'realbook' },
}), 'utf-8')

const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--window-size=1440,900'], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (c) => { out += c })
child.stderr.on('data', (c) => { out += c })
const kill = () => { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }

let ws
try {
  let target
  for (let i = 0; i < 160; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && String(t.url).startsWith('file:'))
      if (target) break
    } catch {}
    await sleep(300)
  }
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 1
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (!m.id) return
    const w = pending.get(m.id); if (!w) return
    pending.delete(m.id)
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result)
  }
  const cdp = (method, params = {}) => new Promise((res, rej) => { const n = id += 1; pending.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params })) })
  const ev = async (bodyText) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${bodyText} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }
  const waitFor = async (expr, timeout = 25000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) { try { if (await ev(`return (${expr});`)) return true } catch {} await sleep(250) }
    return false
  }
  const state = (label) => ev(`
    const lines = [...document.querySelectorAll('.real-book-flip-line')];
    return {
      label: document.querySelector('.real-book-page-label')?.textContent || '',
      lines: lines.length,
      visible: lines.filter((el) => el.style.display !== 'none').length,
      layer: Boolean(document.querySelector('.real-book-webgl-flip-text')),
      layerChildren: document.querySelector('.real-book-webgl-flip-text')?.childElementCount ?? -1,
      rightText: [...document.querySelectorAll('.real-book-webgl-text-page')].map((el) => getComputedStyle(el).display),
      stageClass: document.querySelector('.real-book-webgl-stage')?.className,
      dragging: document.querySelector('.real-book-webgl-stage')?.dataset?.drag ?? '',
    };
  `)
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'webgl'); return true;`)
  await cdp('Page.reload')
  await sleep(1800)
  await cdp('Page.bringToFront')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await ev(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')?.click(); return true;`)
  await waitFor(`document.querySelector('.book-open-area')`, 12000)
  await ev(`document.querySelector('.book-open-area')?.click(); return true;`)
  await waitFor(`document.querySelector('.real-book-webgl-stage')`, 15000)
  await sleep(4500)
  console.log('OPEN     ', JSON.stringify(await state()))
  await ev(`document.querySelector('.real-book-dock')?.click(); return true;`)
  await sleep(400)
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true;`)
  await sleep(1600)
  console.log('AFTERFB  ', JSON.stringify(await state()))
  const rect = await ev(`const r = document.querySelector('.real-book-webgl-hit')?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;`)
  console.log('RECT     ', JSON.stringify(rect))
  const y = Math.round(rect.top + rect.height / 2)
  const edgeX = Math.round(rect.left + rect.width - 10)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edgeX, y, button: 'none' })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: edgeX, y, button: 'left', clickCount: 1 })
  for (let step = 1; step <= 6; step += 1) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edgeX - step * 36, y, button: 'left', buttons: 1 })
    await sleep(60)
    console.log(`STEP ${step}   `, JSON.stringify(await state()))
  }
  await sleep(250)
  console.log('HOLD     ', JSON.stringify(await state()))
} catch (e) {
  console.log('DBG ERROR', e.message)
} finally {
  try { ws?.close() } catch {}
  kill()
}