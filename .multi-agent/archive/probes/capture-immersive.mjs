// 真实书籍：沉浸式 chrome / 底栏「更多」/ 暗色目录抽屉 / 手机 20px 真机复核。
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'

const root = 'C:\\codes\\xsxz'
const PORT = 43000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shotDir = join(root, '.multi-agent', 'visual', 'immersive')
await mkdir(shotDir, { recursive: true })

const lib = await mkdtemp(join(tmpdir(), 'spbf-im-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-im-user-'))
const bookId = 'd_im'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const paras = []
for (let i = 0; i < 40; i += 1) {
  paras.push(`第${i + 1}段：这是一个用来核对沉浸式顶栏、底栏更多菜单与暗色目录的测试段落。段落要有自然的长度，让每一页都能排出完整的正文，字号、行距、页边距与断行都按参考站的书页来核对。`)
}
const body = paras.join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '智人之后（沉浸样书）', author: '版式测试', tags: [],
  sourceUrl: 'https://example.com/im/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [
    { id: 'c0001', index: 1, title: '第一章 沉浸', url: 'https://example.com/im/1.html', file: '0001.json', status: 'ready' },
    { id: 'c0002', index: 2, title: '第二章 暗色', url: 'https://example.com/im/2.html', file: '0002.json', status: 'ready' },
  ],
  progress: { chapterId: 'c0001', scrollRatio: 0 },
}, null, 2), 'utf-8')
for (const [file, title] of [['0001.json', '第一章 沉浸'], ['0002.json', '第二章 暗色']]) {
  await writeFile(join(bookDir, file), JSON.stringify({ title, url: `https://example.com/im/${file}`, body, status: 'ready' }), 'utf-8')
}
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
  const barBtn = (label) => `[...document.querySelectorAll('.reader-bottombar .rb-btn')].find((x)=>x.getAttribute('aria-label')==='${label}')`

  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'webgl'); return 'ok';`)
  await cdp('Page.reload'); await sleep(2500)
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitFor(`document.querySelector('.book-open-area')`, 12000)
  await click(`document.querySelector('.book-open-area')`)
  await waitFor(`document.querySelector('.real-book-stage')`, 15000)
  await sleep(2500)

  check('WebGL 舞台挂载', await ev(`return Boolean(document.querySelector('.real-book-webgl-stage canvas'));`))
  const chrome = await ev(`const t = document.querySelector('.reader-toolbar');
    return {
      realbook: t?.classList.contains('reader-toolbar-realbook'),
      height: t ? getComputedStyle(t).height : null,
      title: Boolean(document.querySelector('.reader-toolbar .reader-book-title')),
      searchEntry: Boolean(document.querySelector('.reader-toolbar [aria-label="搜索"]')),
      pageLabel: document.querySelector('.real-book-page-label')?.textContent ?? '',
      topBarVisible: (() => { const r = t?.getBoundingClientRect(); return r ? r.height > 2 : null })(),
    };`)
  check('真实书籍顶栏容器是零高度的隐藏锚点', chrome?.realbook && parseFloat(chrome?.height || '1') < 2, chrome)
  check('顶栏里没有应用标题与搜索入口', !chrome?.title && !chrome?.searchEntry)
  check('页码仍以隐藏文本存在', String(chrome?.pageLabel).includes('页'), chrome?.pageLabel)
  console.log(await shot('immersive-default.png'))

  await ev(`document.querySelector('.real-book-dock')?.click(); return 'ok';`)
  await sleep(500)
  check('底栏有「更多」按钮', await ev(`return Boolean(${barBtn('更多')});`))
  await click(barBtn('更多'))
  await sleep(600)
  const more = await ev(`const p = document.querySelector('.bottom-panel');
    return p ? { text: p.textContent, bg: getComputedStyle(p).backgroundColor, buttons: [...p.querySelectorAll('button')].map((b)=>b.textContent.trim()) } : null;`)
  check('更多菜单是暗色浮层', more?.bg?.startsWith('rgba(24, 28, 25'), more?.bg)
  for (const label of ['搜索', '标记', '书中地图', '朗读', 'AI', '字体 / 排版', '快捷键', '设置', '浏览', '书架']) {
    check(`更多菜单有「${label}」`, more?.buttons?.includes(label))
  }
  console.log(await shot('more-menu.png'))

  await ev(`const b=[...document.querySelectorAll('.bottom-panel button')].find((x)=>x.textContent.trim()==='字体 / 排版'); b?.click(); return 'ok';`)
  await sleep(700)
  const fontPanel = await ev(`const p = document.querySelector('.bottom-panel');
    return p ? { bg: getComputedStyle(p).backgroundColor, text: p.textContent.slice(0, 60) } : null;`)
  check('更多 → 字体 / 排版 打开字体面板', Boolean(fontPanel) && fontPanel.text.includes('阅读界面'), fontPanel?.text)
  check('字体面板也是暗色', fontPanel?.bg?.startsWith('rgba(24, 28, 25'), fontPanel?.bg)
  console.log(await shot('font-panel.png'))
  await ev(`document.querySelector('.reader-bottombar [aria-label="背景"]')?.click(); return 'ok';`)
  await sleep(300)
  await ev(`const b=[...document.querySelectorAll('.reader-bottombar .rb-btn')].find((x)=>x.getAttribute('aria-label')==='背景'); b?.click(); return 'ok';`)
  await sleep(300)

  // 朗读工具浮层：从更多进入，浮层应挂在右上角且是暗色。
  await click(barBtn('更多')); await sleep(400)
  await ev(`const b=[...document.querySelectorAll('.bottom-panel button')].find((x)=>x.textContent.trim()==='朗读'); b?.click(); return 'ok';`)
  await sleep(700)
  const tool = await ev(`const p = document.querySelector('.tool-panel');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { bg: getComputedStyle(p).backgroundColor, top: Math.round(r.top), right: Math.round(innerWidth - r.right) };`)
  check('朗读工具浮层出现且是暗色', Boolean(tool) && tool.bg.startsWith('rgba(24, 28, 25'), tool)
  check('工具浮层贴在右上角', tool && tool.top < 40 && tool.right < 60, tool)
  console.log(await shot('tts-panel.png'))
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'ok';`)
  await sleep(400)

  // 目录抽屉暗色（先展开底栏，避免 inert 的收起状态拦住点击）
  await ev(`document.querySelector('.real-book-dock')?.click(); return 'ok';`)
  await sleep(400)
  await click(barBtn('目录')); await sleep(900)
  const drawer = await ev(`const c = document.querySelector('.reader-drawer-realbook');
    if (!c) return null;
    const panel = c.closest('.n-drawer');
    const cs = getComputedStyle(panel || c);
    const tab = c.querySelector('.drawer-tab.active');
    const list = c.querySelector('.n-list');
    const input = c.querySelector('.n-input');
    return { bg: cs.backgroundColor, color: cs.color, tabBg: tab ? getComputedStyle(tab).backgroundColor : null,
      listBg: list ? getComputedStyle(list).backgroundColor : null,
      inputBg: input ? getComputedStyle(input).backgroundColor : null,
      inputColor: input ? getComputedStyle(input).color : null,
      text: c.textContent.slice(0, 30) };`)
  check('目录抽屉是暗色面板', Boolean(drawer) && drawer.bg.startsWith('rgba(24, 28, 25'), drawer)
  check('目录抽屉文字是奶油白', drawer?.color?.startsWith('rgba(244, 235, 211'), drawer?.color)
  check('当前页签是暗底烫金字', drawer?.tabBg?.startsWith('rgba(244, 235, 211'), drawer?.tabBg)
  check('目录列表与过滤框也是暗色', (drawer?.listBg?.startsWith('rgba(24, 28, 25') || drawer?.listBg === 'rgba(0, 0, 0, 0)') && !String(drawer?.inputBg).startsWith('rgb(255') && drawer?.inputColor?.startsWith('rgba(244, 235, 211'), { listBg: drawer?.listBg, inputBg: drawer?.inputBg, inputColor: drawer?.inputColor })
  console.log(await shot('catalog-dark.png'))
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'ok';`)
  await sleep(600)

  // 手机单页：390×844，固定 20px。
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(1600)
  const phone = await ev(`const s = document.querySelector('.real-book-stage');
    const pages = [...document.querySelectorAll('.real-book-webgl-text-page')];
    return {
      style: s?.getAttribute('style') ?? '',
      single: Boolean(document.querySelector('.real-book-webgl-stage')),
      visibleTextPages: pages.filter((p) => getComputedStyle(p).display !== 'none').length,
    };`)
  check('手机视口下真实书籍进入单页', Boolean(phone?.single) && phone?.visibleTextPages === 1, phone?.visibleTextPages)
  check('手机单页字号固定 20px', String(phone?.style).includes('--rb-font-size: 20px'), String(phone?.style).match(/--rb-font-size: [^;]+/)?.[0])
  console.log(await shot('phone-20px.png'))
  const dims = await ev(`const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const c = document.querySelector('.real-book-webgl-stage canvas');
    return { w: innerWidth, h: innerHeight, stage: r('.real-book-stage'), viewport: r('.real-book-viewport'), host: r('.real-book-webgl-stage'), canvas: c ? { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight } : null, body: r('.reader-body') };`)
  console.log('PHONE_DIMS', JSON.stringify(dims))
  await ev(`window.dispatchEvent(new Event('resize')); return 'ok';`)
  await sleep(2500)
  const dims2 = await ev(`const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const c = document.querySelector('.real-book-webgl-stage canvas');
    return { stage: r('.real-book-stage'), viewport: r('.real-book-viewport'), host: r('.real-book-webgl-stage'), canvas: c ? { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight } : null, body: r('.reader-body') };`)
  console.log('PHONE_DIMS2', JSON.stringify(dims2))
  console.log(await shot('phone-20px-2.png'))

  check('无渲染进程异常', errs.length === 0, errs.slice(0, 5))
} finally {
  try { ws?.close() } catch {}
  killTree()
  const failed = results.filter((r) => !r.ok)
  console.log(`结果：${results.length - failed.length} 项通过，${failed.length} 项失败`)
  process.exit(failed.length ? 1 : 0)
}
