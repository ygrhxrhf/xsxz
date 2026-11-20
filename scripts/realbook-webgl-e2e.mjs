// 真实书籍 WebGL 渲染层的真机回归。
//
// 为什么必须有这条：真实书籍默认走 WebGL（Three.js 书体、布料飞页、纸质 shader），
// CSS 3D 回退只覆盖 DOM 文本那套几何。WebGL 这条路径的画布、命中区、飞页正文、
// 合上/打开、窄屏卷页都只能在真实 Electron 窗口里验，单测和 jsdom 都碰不到。
//
// 用法：先 `npm run build`，再 `node scripts/realbook-webgl-e2e.mjs`。
// 会在桌面上开一个应用窗口（约一分钟），结束后自动关闭。脚本不读写任何密钥。
//
// 覆盖的回归点：
//   1. WebGL 画布挂载、命中区投影、DOM 文本层、选字工具条
//   2. 正/反向翻页页码推进、合上/打开、背景外观面板
//   3. 拖页保持时飞页正文片段贴面（matrix3d + 正反面）
//   4. 沉浸式 chrome：顶栏零高度、底栏更多菜单
//   5. 窄屏单页模式
//   6. 全程无渲染进程异常
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 41000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

const lib = await mkdtemp(join(tmpdir(), 'spbf-rbwebgl-e2e-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-rbwebgl-e2e-user-'))
const shotDir = join(tmpdir(), 'spbf-rbwebgl-e2e-shots')
await mkdir(shotDir, { recursive: true })
const bookId = 'd_rbwebgl_e2e'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
// 段落要够长：既排得满一页，也让翻页时飞页正文有内容可贴。
const body = Array.from({ length: 60 }, (_, i) =>
  `第${i + 1}段：这是真实书籍 WebGL 回归用的正文。句子要有足够长度，让版面能排满一页以上，翻页时才有整页的字跟着纸一起弯，而不是空白纸在翻。这里再补一些内容，确保每一段都自然折到三行以上。`).join('\n\n')

await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: 'WebGL 回归样书', author: '测试', tags: [],
  sourceUrl: 'https://example.com/rbwebgl-e2e/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [
    { id: 'c0001', index: 1, title: '第一章 渲染', url: 'https://example.com/rbwebgl-e2e/1.html', file: '0001.json', status: 'ready' },
    { id: 'c0002', index: 2, title: '第二章 翻页', url: 'https://example.com/rbwebgl-e2e/2.html', file: '0002.json', status: 'ready' },
  ],
  progress: { chapterId: 'c0001', scrollRatio: 0, rest: undefined },
}, null, 2), 'utf-8')
for (const [file, title] of [['0001.json', '第一章 渲染'], ['0002.json', '第二章 翻页']]) {
  await writeFile(join(bookDir, file), JSON.stringify({
    title, url: `https://example.com/rbwebgl-e2e/${file}`, body, status: 'ready',
  }), 'utf-8')
}
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: {
    fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
    paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'screen',
    bookView: 'realbook',
  },
}, null, 2), 'utf-8')

console.log(`夹具：书库=${lib}\n      userData=${userData}\n      截图=${shotDir}`)

const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--window-size=1440,900'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appOutput = ''
child.stdout.on('data', (chunk) => { appOutput += String(chunk) })
child.stderr.on('data', (chunk) => { appOutput += String(chunk) })

const killTree = () => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch { /* 已经退出了 */ }
}

let ws
try {
  let target
  let seen = []
  for (let i = 0; i < 200; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      seen = list.map((t) => `${t.type}:${String(t.url).slice(0, 60)}`)
      target = list.find((t) => t.type === 'page' && String(t.url).startsWith('file:'))
      if (target) break
    } catch { /* 调试端口还没起来 */ }
    await sleep(300)
  }
  if (!target) throw new Error('没找到渲染页 CDP target，应用可能没起窗口：\n' + appOutput.slice(-2000) + '\n见过的 target：' + JSON.stringify(seen))

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let nextId = 1
  const pending = new Map()
  const exceptions = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params?.exceptionDetails?.exception?.description
        || message.params?.exceptionDetails?.text || '未知异常')
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
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Page.bringToFront')
  const ev = async (bodyText) => {
    const result = await cdp('Runtime.evaluate', { expression: `(async () => { ${bodyText} })()`, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }
  const waitFor = async (expr, timeout = 25000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      try { if (await ev(`return (${expr});`)) return true } catch { /* 页面正在重载 */ }
      await sleep(250)
    }
    return false
  }
  const click = (expr) => ev(`const el = ${expr}; if (!el) return 'none'; el.click(); return 'ok';`)
  const shot = async (name) => {
    const png = await cdp('Page.captureScreenshot', { format: 'png' })
    const path = join(shotDir, name)
    await writeFile(path, Buffer.from(png.data, 'base64'))
    return path
  }
  const openBook = async () => {
    await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
    await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
    await waitFor(`document.querySelector('.book-open-area')`, 12000)
    await click(`document.querySelector('.book-open-area')`)
    await waitFor(`document.querySelector('.real-book-webgl-stage')`, 25000)
    await sleep(1600)
  }
  // 底栏默认收在底边横条后面，先展开再点里面的按钮。
  const expandDock = async () => {
    await ev(`document.querySelector('.real-book-dock')?.click(); await new Promise((r) => setTimeout(r, 250)); return true;`)
  }
  // 飞页正文片段：拖住半程时应当有可见片段、贴面矩阵、正反面分配。
  const flipTextInfo = () => ev(`
    const els = [...document.querySelectorAll('.real-book-flip-line')];
    const visible = els.filter((el) => el.style.display !== 'none');
    return {
      total: els.length,
      visible: visible.length,
      transformed: visible.filter((el) => /matrix3d/.test(el.style.transform)).length,
      faces: visible.reduce((acc, el) => { const k = el.dataset.face || '?'; acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
      firstText: visible.find((el) => el.textContent.length > 3)?.textContent || '',
    };
  `)

  // 显式选 WebGL，重载让 Reader 在 setup 时读到该偏好。
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'webgl'); return true;`)
  await cdp('Page.reload')
  await sleep(1800)
  await openBook()

  const capability = await ev(`const c = document.createElement('canvas'); return { webgl2: !!c.getContext('webgl2'), webgl: !!c.getContext('webgl') };`)
  const fallback = await ev(`return document.querySelector('.real-book-webgl-fallback')?.textContent || '';`)
  check('环境具备 WebGL 且未走 CSS 3D 回退', (capability.webgl2 || capability.webgl) && !fallback, JSON.stringify({ capability, fallback }))

  const initial = await ev(`return {
    stage: Boolean(document.querySelector('[data-renderer="webgl"]')),
    canvas: Boolean(document.querySelector('.real-book-webgl-canvas')),
    canvasSize: (() => { const c = document.querySelector('.real-book-webgl-canvas'); return c ? [c.width, c.height] : null; })(),
    hit: (() => { const r = document.querySelector('.real-book-webgl-hit')?.getBoundingClientRect(); return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null; })(),
    label: document.querySelector('.real-book-page-label')?.textContent || '',
    paras: document.querySelectorAll('.real-book-text-para[data-p]').length,
    lines: document.querySelectorAll('.real-book-text-line').length,
    textPages: document.querySelectorAll('.real-book-webgl-text-page').length,
  };`)
  check('WebGL 画布挂载', initial.stage && initial.canvas && initial.canvasSize?.[0] > 0, JSON.stringify(initial))
  check('书体命中区域已投影', Array.isArray(initial.hit) && initial.hit[2] > 100 && initial.hit[3] > 100, JSON.stringify(initial.hit))
  check('透明文本层挂 data-p 且有正文行', initial.paras > 0 && initial.lines > 0 && initial.textPages > 0, JSON.stringify(initial))
  await shot('webgl-initial.png')

  // 选字：走真实选区 + 命中层的 mouseup，工具条应出现。
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
  await sleep(300)
  const selPopup = await ev(`return { popup: Boolean(document.querySelector('.sel-popup')), text: document.querySelector('.sel-popup')?.textContent || '' };`)
  check('WebGL 选字工具条', selPopup.popup, JSON.stringify(selPopup))
  await ev(`window.getSelection()?.removeAllRanges(); return true;`)

  // 沉浸式 chrome：真实书籍不摆应用顶栏，页码仍留隐藏文本。
  const chrome = await ev(`const t = document.querySelector('.reader-toolbar');
    return {
      realbook: t?.classList.contains('reader-toolbar-realbook'),
      height: t ? getComputedStyle(t).height : null,
      title: Boolean(document.querySelector('.reader-toolbar .reader-book-title')),
      searchEntry: Boolean(document.querySelector('.reader-toolbar [aria-label="搜索"]')),
      pageLabel: document.querySelector('.real-book-page-label')?.textContent ?? '',
    };`)
  check('真实书籍顶栏容器是零高度的隐藏锚点', chrome?.realbook && parseFloat(chrome?.height || '1') < 2, JSON.stringify(chrome))
  check('顶栏里没有应用标题与搜索入口', !chrome?.title && !chrome?.searchEntry, JSON.stringify(chrome))

  await expandDock()
  const beforeLabel = await ev(`return document.querySelector('.real-book-page-label')?.textContent || '';`)
  await click(`document.querySelector('.reader-bottombar [aria-label="下一页"]')`)
  await sleep(1500)
  const afterLabel = await ev(`return { label: document.querySelector('.real-book-page-label')?.textContent || '', canvas: Boolean(document.querySelector('.real-book-webgl-canvas')) };`)
  check('WebGL 翻页后页码推进', afterLabel.canvas && afterLabel.label !== beforeLabel, JSON.stringify({ beforeLabel, afterLabel }))
  await shot('webgl-next.png')

  await click(`document.querySelector('.reader-bottombar [aria-label="上一页"]')`)
  await sleep(1500)
  const backLabel = await ev(`return document.querySelector('.real-book-page-label')?.textContent || '';`)
  // 总页数会在字体分片加载后重排（例如 3 → 5），所以只比当前页号，不比整串。
  const pageNumberOf = (text) => Number(/第\s*(\d+)/.exec(text || '')?.[1] ?? Number.NaN)
  check('反向翻页落定回到原页', pageNumberOf(backLabel) === pageNumberOf(beforeLabel), JSON.stringify({ beforeLabel, backLabel }))

  // 合上 / 打开：按钮态与画布都应跟着切换。
  await click(`document.querySelector('.reader-bottombar [aria-label="合上书籍"]')`)
  await sleep(1200)
  const closed = await ev(`return {
    canvas: Boolean(document.querySelector('.real-book-webgl-canvas')),
    openButton: Boolean(document.querySelector('.reader-bottombar [aria-label="打开书籍"]')),
  };`)
  check('WebGL 合上书籍', closed.canvas && closed.openButton, JSON.stringify(closed))
  await shot('webgl-closed.png')
  await click(`document.querySelector('.reader-bottombar [aria-label="打开书籍"]')`)
  await sleep(1200)

  // 背景面板：WebGL 外观项（桌面 / 衬纸 / 视角）都在，切换后仍渲染。
  await click(`document.querySelector('.reader-bottombar [aria-label="背景"]')`)
  await sleep(400)
  const panel = await ev(`return {
    webglActive: [...document.querySelectorAll('.bottom-panel button')].some((b) => b.textContent.trim() === 'WebGL 3D' && b.classList.contains('active')),
    desk: [...document.querySelectorAll('.bottom-panel button')].filter((b) => /胡桃木|亚麻|石墨|鼠尾草|石灰岩/.test(b.textContent)).length,
    endpaper: [...document.querySelectorAll('.bottom-panel button')].filter((b) => /象牙白|沙色|板岩|勃艮第红/.test(b.textContent)).length,
    pitch: [...document.querySelectorAll('.bottom-panel button')].filter((b) => /平视|默认|斜视/.test(b.textContent)).length,
  };`)
  check('背景面板显示 WebGL/桌面/衬纸/视角选项', panel.webglActive && panel.desk >= 5 && panel.endpaper >= 4 && panel.pitch >= 3, JSON.stringify(panel))
  await click(`[...document.querySelectorAll('.bottom-panel button')].find((b) => b.textContent.trim() === '石墨')`)
  await click(`[...document.querySelectorAll('.bottom-panel button')].find((b) => b.textContent.trim() === '板岩')`)
  await click(`[...document.querySelectorAll('.bottom-panel button')].find((b) => b.textContent.trim() === '斜视')`)
  await sleep(800)
  await shot('webgl-appearance.png')

  // 拖页保持：纸停在卷曲中途，正文片段必须贴着纸面（matrix3d）且有正反面分配。
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`)
  await sleep(400)
  await expandDock()
  const hitRect = await ev(`const r = document.querySelector('.real-book-webgl-hit')?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;`)
  if (!hitRect) {
    check('拖页保持时飞页正文贴面', false, '没有命中区')
  } else {
    const y = Math.round(hitRect.top + hitRect.height / 2)
    const edgeX = Math.round(hitRect.left + hitRect.width - 10)
    const labelBeforeDrag = await ev(`return document.querySelector('.real-book-page-label')?.textContent || '';`)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edgeX, y, button: 'none' })
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: edgeX, y, button: 'left', clickCount: 1 })
    // 拖页要走过起拖阈值后飞页 DOM 才会出现；分几步拖，任一次采样命中即可。
    let hold = null
    for (let step = 1; step <= 9 && !hold; step += 1) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edgeX - step * 40, y, button: 'left', buttons: 1 })
      await sleep(90)
      const sample = await flipTextInfo()
      if (sample.visible > 0 && sample.transformed > 0) hold = sample
    }
    // 继续拖过约六成页宽再松手，让这一翻按「落定」提交而不是弹回取消。
    for (let step = 7; step <= 9; step += 1) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edgeX - step * 40, y, button: 'left', buttons: 1 })
      await sleep(90)
    }
    await sleep(250)
    const holdFinal = hold ?? (await flipTextInfo())
    check('拖页保持时飞页正文贴面', holdFinal.visible > 0 && holdFinal.transformed > 0 && Object.keys(holdFinal.faces).length > 0, JSON.stringify(holdFinal))
    await shot('webgl-drag-hold.png')
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: edgeX - 360, y, button: 'left', clickCount: 1 })
    // 落定要等飞页 DOM 清空，不能按固定时长猜。
    let settled = null
    for (let i = 0; i < 30 && !settled; i += 1) {
      await sleep(250)
      const sample = await flipTextInfo()
      if (sample.visible === 0) settled = sample
    }
    const settledFinal = settled ?? (await flipTextInfo())
    const settledLabel = await ev(`return document.querySelector('.real-book-page-label')?.textContent || '';`)
    check('落定后飞页正文清空且页码推进', settledFinal.visible === 0 && pageNumberOf(settledLabel) !== pageNumberOf(labelBeforeDrag), JSON.stringify({ settled: settledFinal, settledLabel, labelBeforeDrag }))
  }

  // 底栏「更多」：暗色浮层，入口齐全。
  await expandDock()
  await click(`document.querySelector('.reader-bottombar [aria-label="更多"]')`)
  await sleep(500)
  const more = await ev(`const p = document.querySelector('.bottom-panel');
    return p ? { bg: getComputedStyle(p).backgroundColor, buttons: [...p.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null;`)
  check('更多菜单是暗色浮层', more?.bg?.startsWith('rgba(24, 28, 25'), more?.bg)
  for (const label of ['搜索', '标记', '书中地图', '朗读', 'AI', '字体 / 排版', '快捷键', '设置', '浏览', '书架']) {
    check(`更多菜单有「${label}」`, more?.buttons?.includes(label), JSON.stringify(more?.buttons))
  }
  await shot('webgl-more.png')
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`)
  await sleep(400)

  // 窄屏单页：强制进入后仍是 WebGL 画布，且只有一页文本层可见。
  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'webgl'); localStorage.setItem('spore:reader-realbook-phone:v1', '1'); return true;`)
  await cdp('Page.reload')
  await sleep(1800)
  await openBook()
  const phone = await ev(`return {
    canvas: Boolean(document.querySelector('.real-book-webgl-canvas')),
    hit: (() => { const r = document.querySelector('.real-book-webgl-hit')?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null; })(),
    visibleTextPages: [...document.querySelectorAll('.real-book-webgl-text-page')].filter((el) => el.style.display !== 'none').length,
    paras: document.querySelectorAll('.real-book-text-para[data-p]').length,
    label: document.querySelector('.real-book-page-label')?.textContent || '',
  };`)
  check('窄屏单页模式', phone.canvas && phone.hit?.[0] > 200 && phone.hit?.[1] > 200 && phone.visibleTextPages === 1, JSON.stringify(phone))
  await shot('webgl-phone.png')

  check('全程无渲染进程异常', exceptions.length === 0, exceptions.slice(0, 5).join(' | '))
} catch (error) {
  console.error('E2E ERROR', error)
  console.error(appOutput.slice(-2000))
  process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* 已关闭 */ }
  killTree()
  // Electron 退出后仍可能有一两秒持有 profile 里的 db 句柄，立刻删会 EBUSY。
  await sleep(800)
  await rm(lib, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

console.log(`\n${passed.length} 项通过，${failed.length} 项失败`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const line of failed) console.log('  ' + line)
}
process.exit(failed.length > 0 ? 1 : 0)
