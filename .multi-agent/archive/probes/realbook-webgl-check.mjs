// 临时验证：真实 Electron 里强制启用 WebGL 真实书籍，检查 canvas、翻页和外观面板。
// 不修改仓库源码；运行：node .multi-agent/tmp/realbook-webgl-check.mjs
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const PORT = 39000 + Math.floor(Math.random() * 1000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shots = join(tmpdir(), 'spbf-realbook-webgl-shots')
await mkdir(shots, { recursive: true })
const lib = await mkdtemp(join(tmpdir(), 'spbf-rbwebgl-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-rbwebgl-user-'))
const bookId = 'd_rbwebgl'
const bookDir = join(lib, bookId)
await mkdir(bookDir, { recursive: true })
const now = new Date().toISOString()
const body = Array.from({ length: 30 }, (_, i) =>
  `第${i + 1}段：这是 WebGL 真实书籍的检查正文，长度足够排满一页，也方便观察纸面纹理、书脊厚度和翻页动画。`).join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: 'WebGL 真实书籍测试', author: '测试', tags: [],
  sourceUrl: 'https://example.com/rbwebgl/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章 WebGL', url: 'https://example.com/rbwebgl/1.html', file: '0001.json', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0, paragraphIndex: 0, paragraphOffset: 0 },
}, null, 2), 'utf-8')
await writeFile(join(bookDir, '0001.json'), JSON.stringify({
  title: '第一章 WebGL', url: 'https://example.com/rbwebgl/1.html', body, status: 'ready',
}, null, 2), 'utf-8')
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: {
    fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
    paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'screen',
    bookView: 'realbook', handwritingFont: 'kai', showInlineNotes: true,
  },
}, null, 2), 'utf-8')

const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--window-size=520,820'], { stdio: ['ignore', 'pipe', 'pipe'] })
let appOutput = ''
child.stdout.on('data', (chunk) => { appOutput += String(chunk) })
child.stderr.on('data', (chunk) => { appOutput += String(chunk) })
const stop = () => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch { /* 已退出 */ }
}

async function connect() {
  let target
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'))
      if (target) break
    } catch { /* 调试端口还没起来 */ }
    await sleep(300)
  }
  if (!target) throw new Error('没找到渲染页 CDP target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 1
  const pending = new Map()
  const consoleMessages = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.consoleAPICalled') {
      consoleMessages.push({ type: message.params.type, args: message.params.args?.map((a) => a.value ?? a.description ?? a.type) })
    }
    if (!message.id) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  }
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const next = id += 1
    pending.set(next, { resolve, reject })
    ws.send(JSON.stringify({ id: next, method, params }))
  })
  const ev = async (bodyText) => {
    const result = await cdp('Runtime.evaluate', { expression: `(async () => { ${bodyText} })()`, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }
  const waitFor = async (expr, timeout = 20000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      try { if (await ev(`return (${expr});`)) return true } catch { /* reloading */ }
      await sleep(200)
    }
    return false
  }
  const click = (expr) => ev(`const el = ${expr}; if (!el) return 'none'; el.click(); return 'ok';`)
  const shot = async (name) => {
    const png = await cdp('Page.captureScreenshot', { format: 'png' })
    const path = join(shots, name)
    await writeFile(path, Buffer.from(png.data, 'base64'))
    return path
  }
  return { cdp, ev, waitFor, click, shot, consoleMessages, targetId: target.targetId }
}

const report = (label, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
let app
try {
  app = await connect()
  const { ev, waitFor, click, shot, consoleMessages } = app
  await app.cdp('Runtime.enable')
  const glCheck = await ev(`const c = document.createElement('canvas'); return { webgl2: !!c.getContext('webgl2'), webgl: !!c.getContext('webgl') };`)
  report('WebGL 能力探测', glCheck.webgl2 || glCheck.webgl, JSON.stringify(glCheck))
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await ev(`localStorage.removeItem('spore:reader-realbook-renderer:v1'); return localStorage.getItem('spore:reader-realbook-renderer:v1');`)
  // Reader 在 App 启动时就已挂载（v-show），必须重载让它在 setup 时读到 WebGL 偏好。
  await ev(`location.reload(); return true;`)
  await sleep(1500)
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  const stored = await ev(`return { key: localStorage.getItem('spore:reader-realbook-renderer:v1'), webgl2: typeof WebGL2RenderingContext !== 'undefined', canvas: !!document.createElement('canvas').getContext('webgl2') };`)
  // 未显式选过渲染层时不会写 localStorage，默认由能力探测决定；这里只记录不清算。
  console.log(`      渲染层偏好键：${JSON.stringify(stored)}`)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitFor(`document.querySelector('.book-open-area')`, 12000)
  await click(`document.querySelector('.book-open-area')`)
  const mounted = await waitFor(`document.querySelector('[data-renderer="webgl"] .real-book-webgl-canvas')`, 25000)
  await sleep(1800)
  const initial = await ev(`return {
    stage: Boolean(document.querySelector('[data-renderer="webgl"]')),
    canvas: Boolean(document.querySelector('.real-book-webgl-canvas')),
    canvasSize: (() => { const c = document.querySelector('.real-book-webgl-canvas'); return c ? [c.width, c.height] : null; })(),
    fallback: document.querySelector('.real-book-webgl-fallback')?.textContent || '',
    hit: (() => { const r = document.querySelector('.real-book-webgl-hit')?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null; })(),
    label: document.querySelector('.real-book-page-label')?.textContent || '',
    body: document.body.innerText.slice(0, 100),
  };`)
  report('WebGL 画布挂载', mounted && initial.canvas && initial.canvasSize?.[0] > 0, JSON.stringify(initial))
  report('书体命中区域已投影', Array.isArray(initial.hit) && initial.hit[2] > 100 && initial.hit[3] > 100, JSON.stringify(initial.hit))
  const initialShot = await shot('webgl-initial.png')
  console.log(`      截图：${initialShot}`)
  const textLayer = await ev(`return {
    paras: document.querySelectorAll('.real-book-text-para[data-p]').length,
    lines: document.querySelectorAll('.real-book-text-line').length,
    textPage: Boolean(document.querySelector('.real-book-webgl-text-page')),
    firstText: document.querySelector('.real-book-text-line')?.textContent || '',
  };`)
  report('透明文本层挂 data-p', textLayer.paras > 0 && textLayer.lines > 0, JSON.stringify(textLayer))
  await ev(`const para = document.querySelector('.real-book-text-para[data-p]');
    const node = para?.querySelector('.real-book-text-line')?.firstChild;
    if (!node) return 'no-text';
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(2, node.textContent.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.querySelector('.real-book-webgl-hit')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return sel.toString();`)
  await sleep(250)
  const selPopup = await ev(`return { popup: Boolean(document.querySelector('.sel-popup')), text: document.querySelector('.sel-popup')?.textContent || '' };`)
  report('WebGL 选字工具条', selPopup.popup, JSON.stringify(selPopup))


  // 展开底栏并翻页
  await ev(`document.querySelector('.real-book-dock')?.click(); await new Promise((r) => setTimeout(r, 250)); return true;`)
  const before = await ev(`return document.querySelector('.real-book-page-label')?.textContent || '';`)
  await click(`document.querySelector('.reader-bottombar [aria-label="下一页"]')`)
  for (const [index, delay] of [330, 250, 250, 250].entries()) {
    await sleep(delay)
    const frameShot = await shot(`webgl-flip-${index}.png`)
    console.log(`      翻页帧 ${index}：${frameShot}`)
  }
  await sleep(1500)
  const after = await ev(`return { label: document.querySelector('.real-book-page-label')?.textContent || '', canvas: Boolean(document.querySelector('.real-book-webgl-canvas')) };`)
  report('WebGL 翻页后页码推进', after.canvas && after.label !== before, JSON.stringify({ before, after }))
  const nextShot = await shot('webgl-next.png')
  console.log(`      截图：${nextShot}`)

  // 反向翻页：确认布料层在 direction = -1 时同样贴着中缝、不会飞出版面
  await click(`document.querySelector('.reader-bottombar [aria-label="上一页"]')`)
  for (const [index, delay] of [420, 300].entries()) {
    await sleep(delay)
    const backShot = await shot(`webgl-flip-back-${index}.png`)
    console.log(`      反向翻页帧 ${index}：${backShot}`)
  }
  await sleep(1400)
  const backLabel = await ev(`return document.querySelector('.real-book-page-label')?.textContent || '';`)
  report('反向翻页落定回到原页', backLabel.startsWith('第 1 '), JSON.stringify({ before, backLabel }))

  // 合上 / 打开
  await click(`document.querySelector('.reader-bottombar [aria-label="合上书籍"]')`)
  await sleep(1000)
  const closed = await ev(`return {
    canvas: Boolean(document.querySelector('.real-book-webgl-canvas')),
    openButton: Boolean(document.querySelector('.reader-bottombar [aria-label="打开书籍"]')),
    buttons: [...document.querySelectorAll('.reader-bottombar button')].map((b) => b.getAttribute('aria-label') || b.title || b.textContent.trim()).filter(Boolean),
  };`)
  report('WebGL 合上书籍', closed.canvas && closed.openButton, JSON.stringify(closed))
  const closedShot = await shot('webgl-closed.png')
  console.log(`      截图：${closedShot}`)
  await click(`document.querySelector('.reader-bottombar [aria-label="打开书籍"]')`)
  await sleep(900)

  // 背景面板里的 WebGL 外观项
  await ev(`document.querySelector('.reader-bottombar .bottom-button[aria-label="背景"]')?.click(); await new Promise((r) => setTimeout(r, 250)); return true;`)
  const panel = await ev(`return {
    webglActive: [...document.querySelectorAll('.bottom-panel button')].some((b) => b.textContent.trim() === 'WebGL 3D' && b.classList.contains('active')),
    desk: [...document.querySelectorAll('.bottom-panel button')].filter((b) => /胡桃木|亚麻|石墨|鼠尾草|石灰岩/.test(b.textContent)).length,
    endpaper: [...document.querySelectorAll('.bottom-panel button')].filter((b) => /象牙白|沙色|板岩|勃艮第红/.test(b.textContent)).length,
    pitch: [...document.querySelectorAll('.bottom-panel button')].filter((b) => /平视|默认|斜视/.test(b.textContent)).length,
    endpaperLabels: [...document.querySelectorAll('.bottom-panel button')].map((b) => b.textContent.trim()).filter((text) => /象牙白|沙色|板岩|鼠尾草|勃艮第红/.test(text)),
  };`)
  report('背景面板显示 WebGL/桌面/衬纸/视角选项', panel.webglActive && panel.desk >= 5 && panel.endpaperLabels.length >= 5 && panel.pitch >= 3, JSON.stringify(panel))
  await click(`[...document.querySelectorAll('.bottom-panel button')].find((b) => b.textContent.trim() === '石墨')`)
  await click(`[...document.querySelectorAll('.bottom-panel button')].find((b) => b.textContent.trim() === '板岩')`)
  await click(`[...document.querySelectorAll('.bottom-panel button')].find((b) => b.textContent.trim() === '斜视')`)
  await sleep(800)
  const panelShot = await shot('webgl-appearance.png')
  console.log(`      截图：${panelShot}`)
  // 窄屏单页模式：用 ?phone 强制进入
  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'webgl'); localStorage.setItem('spore:reader-realbook-phone:v1', '1'); location.reload(); return true;`)
  await sleep(1800)
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitFor(`document.querySelector('.book-open-area')`, 12000)
  await click(`document.querySelector('.book-open-area')`)
  await waitFor(`document.querySelector('[data-renderer="webgl"] .real-book-webgl-canvas')`, 25000)
  await sleep(1500)
  const phoneState = await ev(`return {
    inner: [innerWidth, innerHeight],
    canvas: Boolean(document.querySelector('.real-book-webgl-canvas')),
    hit: (() => { const r = document.querySelector('.real-book-webgl-hit')?.getBoundingClientRect(); return r ? [r.width, r.height] : null; })(),
    leftText: document.querySelectorAll('.real-book-webgl-text-page:not([style*="display: none"])').length,
    paras: document.querySelectorAll('.real-book-text-para[data-p]').length,
    label: document.querySelector('.real-book-page-label')?.textContent || '',
  };`)
  report('窄屏单页模式', phoneState.canvas && phoneState.hit && phoneState.hit[0] > 200 && phoneState.hit[1] > 200 && phoneState.leftText === 1, JSON.stringify(phoneState))
  const phoneShot = await shot('webgl-phone.png')
  console.log(`      截图：${phoneShot}`)
  console.log(`      应用日志尾部：${appOutput.slice(-2000).replace(/\s+/g, ' ')}`)
  console.log(`      渲染进程控制台：${JSON.stringify(consoleMessages.slice(-20))}`)
} catch (error) {
  console.error('CHECK ERROR', error)
  console.error(appOutput.slice(-2000))
  process.exitCode = 1
} finally {
  stop()
}
