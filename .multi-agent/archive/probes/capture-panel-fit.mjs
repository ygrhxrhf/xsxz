// 真实书籍：外观浮层暗色 + 适应屏幕（0 键）真机复核。
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'

const root = 'C:\\codes\\xsxz'
const PORT = 41000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shotDir = join(root, '.multi-agent', 'visual', 'panelfit')
await mkdir(shotDir, { recursive: true })

const lib = await mkdtemp(join(tmpdir(), 'spbf-pf-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-pf-user-'))
const bookId = 'd_pf'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const paras = []
for (let i = 0; i < 40; i += 1) {
  paras.push(`第${i + 1}段：这是一个用来核对底栏浮层与整书适配的测试段落。段落要有自然的长度，让每一页都能排出完整的正文，字号、行距、页边距与断行都按参考站的书页来核对。`)
}
const body = paras.join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '智人之后（浮层样书）', author: '版式测试', tags: [],
  sourceUrl: 'https://example.com/pf/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章 浮层', url: 'https://example.com/pf/1.html', file: '0001.json', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0 },
}, null, 2), 'utf-8')
await writeFile(join(bookDir, '0001.json'), JSON.stringify({
  title: '第一章 浮层', url: 'https://example.com/pf/1.html', body, status: 'ready',
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
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`) }
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
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text)
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

  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'webgl'); return 'ok';`)
  await cdp('Page.reload'); await sleep(2500)
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitFor(`document.querySelector('.book-open-area')`, 12000)
  await click(`document.querySelector('.book-open-area')`)
  await waitFor(`document.querySelector('.real-book-stage')`, 15000)
  await sleep(2500)

  check('WebGL 舞台挂载', await ev(`return Boolean(document.querySelector('.real-book-webgl-stage canvas'));`))

  // 展开底栏，打开「背景」浮层。
  await ev(`document.querySelector('.real-book-dock')?.click(); return 'ok';`)
  await sleep(500)
  const barOpen = await ev(`return document.querySelector('.reader-bottombar')?.getAttribute('aria-hidden') === 'false';`)
  check('点底边横条展开图标带', barOpen)
  await ev(`document.querySelector('.reader-bottombar [aria-label="背景"]')?.click(); return 'ok';`)
  await sleep(700)

  const panel = await ev(`const p = document.querySelector('.reader-bottombar.is-realbook .bottom-panel');
    if (!p) return null;
    const cs = getComputedStyle(p);
    const btn = p.querySelector('.option-grid button:not(.active)') || p.querySelector('.option-grid button');
    const bcs = btn ? getComputedStyle(btn) : null;
    const label = p.querySelector('.control-label');
    return {
      bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor,
      btnBg: bcs?.backgroundColor, btnColor: bcs?.color, btnBorder: bcs?.borderTopColor,
      labelColor: label ? getComputedStyle(label).color : null,
      text: p.textContent.slice(0, 40),
    };`)
  check('浮层挂在真实书籍底栏内', Boolean(panel), panel?.text)
  check('浮层是暗色底', panel?.bg?.startsWith('rgba(24, 28, 25'), panel?.bg)
  check('浮层字色是奶油白', panel?.color?.startsWith('rgba(244, 235, 211'), panel?.color)
  check('未选中的选项按钮是暗底浅字', panel?.btnBg?.startsWith('rgba(244, 235, 211') && panel?.btnColor?.startsWith('rgba(244, 235, 211'), { btnBg: panel?.btnBg, btnColor: panel?.btnColor, btnBorder: panel?.btnBorder })
  check('说明文字降一档仍可读', panel?.labelColor?.startsWith('rgba(244, 235, 211'), panel?.labelColor)
  console.log(await shot('panel-dark.png'))
  console.log(await shot('panel-dark-detail.png', { x: 900, y: 240, width: 620, height: 470, scale: 2 }))

  // 适应屏幕：放大两次，再按 0。
  const clickBtn = (label) => ev(`const b=[...document.querySelectorAll('.reader-bottombar .rb-btn')].find((x)=>x.getAttribute('aria-label')==='${label}'); b?.click(); return b?'ok':'none';`)
  const zoomLabel = () => ev(`return document.querySelector('.rb-zoom')?.textContent ?? '';`)
  check('底栏有「适应屏幕」按钮', (await ev(`return Boolean([...document.querySelectorAll('.reader-bottombar .rb-btn')].find((x)=>x.getAttribute('aria-label')==='适应屏幕'));`)))
  await ev(`document.querySelector('.reader-bottombar [aria-label="背景"]')?.click(); return 'ok';`)
  await sleep(350)
  check('背景浮层可收起', (await ev(`return !document.querySelector('.bottom-panel');`)))
  await clickBtn('放大'); await clickBtn('放大')
  await sleep(400)
  const zoomed = await zoomLabel()
  check('放大两次后倍率大于 100%', parseFloat(zoomed) > 100, zoomed)
  console.log(await shot('zoom-in.png'))
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })); return 'ok';`)
  await sleep(500)
  const fitted = await zoomLabel()
  check('按 0 回到整书适配（100%）', fitted === '100%', fitted)
  console.log(await shot('zoom-fit.png'))
  await clickBtn('放大')
  await sleep(300)
  await clickBtn('适应屏幕')
  await sleep(500)
  const fittedBtn = await zoomLabel()
  check('点「适应屏幕」按钮同样回 100%', fittedBtn === '100%', fittedBtn)
  console.log(await shot('zoom-fit-button.png'))

  check('无渲染进程异常', errs.length === 0, errs.slice(0, 5))
} finally {
  try { ws?.close() } catch {}
  killTree()
  const failed = results.filter((r) => !r.ok)
  console.log(`结果：${results.length - failed.length} 项通过，${failed.length} 项失败`)
  process.exit(failed.length ? 1 : 0)
}
