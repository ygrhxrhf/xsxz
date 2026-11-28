// 章节导图全屏 / 缩放的端到端验证。
//
// 为什么需要它：npm test 里的 jsdom 只能证明状态机（全屏开关、缩放上下限、折行），证明不了
// 「真 Electron 里整块铺满窗口、节点文字真的没溢出框、适应窗口后整棵树真的落在视口里」。
// 这里造一本 40 段的长章夹具，用 --remote-debugging-port 起真实应用，走 书库 → 阅读器 → 抽屉 → 导图。
//
// 用法：npm run build 之后 `node scripts/mindmap-fullscreen-e2e.mjs`
// 注意：会在桌面上真开一个应用窗口（约十几秒），结束后自动关掉。
// 截图写到 SPBF_MINDMAP_SHOT_DIR（默认系统临时目录），失败时留着排查。
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 38000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

const shotDir = process.env.SPBF_MINDMAP_SHOT_DIR || join(tmpdir(), 'spbf-mindmap-shots')
await mkdir(shotDir, { recursive: true })

// --- 夹具：一本一章、40 段、每段 3 句的长章节（导图约 160+ 节点，抽屉里必然看不清）---
const lib = await mkdtemp(join(tmpdir(), 'spbf-mindmap-e2e-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-mindmap-e2e-user-'))
const bookId = 'd_mindmap'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const body = Array.from({ length: 40 }, (_, i) =>
  `第${i + 1}段：王林在恒岳派山门外第一次见到修行者的手段，心里既羡慕又发怵。他想起张虎说的那些话，忍不住回头看了一眼来时的山路。这一夜，他睡得很浅，梦里全是那道黄纸符箓飞起的影子。`,
).join('\n\n')

await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '导图测试书', author: '测试', tags: [],
  sourceUrl: 'https://example.com/m/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章 山门', url: 'https://example.com/m/1.html', file: 'chapters/0001.json', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0, paragraphIndex: 0, paragraphOffset: 0, updatedAt: now },
}, null, 2), 'utf-8')
await writeFile(join(bookDir, 'chapters', '0001.json'), JSON.stringify({
  title: '第一章 山门', url: 'https://example.com/m/1.html', body, status: 'ready',
}), 'utf-8')
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: { fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll' },
}, null, 2), 'utf-8')

console.log(`夹具：书库=${lib}\n      userData=${userData}\n      截图=${shotDir}`)

const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (chunk) => { out += String(chunk) })
child.stderr.on('data', (chunk) => { out += String(chunk) })

const killTree = () => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch { /* 已经退出了 */ }
}

let ws
try {
  let target
  // 冷启动（首次跑 Electron）实测要 15~20 秒才建窗口，轮询放宽到 60 秒。
  for (let i = 0; i < 200; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await response.json()
      target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'))
      if (target) break
    } catch { /* 调试端口还没起来 */ }
    await sleep(300)
  }
  if (!target) throw new Error('没找到渲染页 CDP target，应用可能没起窗口：\n' + out.slice(-2000))

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
  const ev = async (bodyText) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${bodyText} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }
  const waitFor = async (expr, timeout = 15000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      if (await ev(`return (${expr});`)) return true
      await sleep(150)
    }
    return false
  }
  const click = (expr) => ev(`const el = ${expr}; if (!el) return 'none'; el.scrollIntoView(); el.click(); return 'ok';`)
  const shot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' })
    const file = join(shotDir, name)
    await writeFile(file, Buffer.from(r.data, 'base64'))
    return file
  }
  const pressKey = (key) => ev(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
    return 'ok';
  `)

  // 1) 书库 → 阅读器
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitFor(`document.querySelector('.book-open-area')`, 12000)
  await click(`document.querySelector('.book-open-area')`)
  check('阅读器正文渲染', await waitFor(`document.querySelector('.reader-content')`, 15000))

  // 2) 抽屉 → 导图
  await click(`document.querySelector('.bottom-button[aria-label="目录"]')`)
  await waitFor(`document.querySelector('[data-drawer-tab="mindmap"]')`, 8000)
  await click(`document.querySelector('[data-drawer-tab="mindmap"]')`)
  check('导图画布渲染', await waitFor(`document.querySelector('.reader-mindmap-viewport svg[role="tree"]')`, 10000))
  await sleep(600)

  const drawerState = await ev(`
    const view = document.querySelector('.reader-mindmap-viewport');
    const zoom = document.querySelector('.reader-mindmap-zoom')?.textContent?.trim() || '';
    return { zoom, w: view?.clientWidth || 0, h: view?.clientHeight || 0, nodes: document.querySelectorAll('[role="treeitem"]').length };
  `)
  check('抽屉里的导图节点规模足够大（≥100 节点）', drawerState.nodes >= 100, `${drawerState.nodes} 个节点`)
  await shot('01-drawer.png')

  // 3) 全屏
  const toggled = await click(`document.querySelector('.reader-mindmap-fullscreen-toggle')`)
  check('工具栏有全屏按钮', toggled === 'ok')
  const fs = await waitFor(`document.querySelector('.reader-mindmap.is-fullscreen')?.parentElement === document.body`, 5000)
  check('全屏后导图 Teleport 到 body 并带上 is-fullscreen', fs)
  await sleep(500)

  const fullState = await ev(`
    const sec = document.querySelector('.reader-mindmap.is-fullscreen');
    const view = document.querySelector('.reader-mindmap-viewport');
    if (!sec || !view) return null;
    const r = sec.getBoundingClientRect();
    return {
      covers: Math.abs(r.width - window.innerWidth) < 2 && Math.abs(r.height - window.innerHeight) < 2,
      viewW: view.clientWidth, viewH: view.clientHeight,
      position: getComputedStyle(sec).position,
      zoom: document.querySelector('.reader-mindmap-zoom')?.textContent?.trim() || '',
      overflow: document.documentElement.style.overflow,
    };
  `)
  check('全屏块铺满整个窗口', fullState?.covers === true, fullState ? `${Math.round(fullState.viewW)}×${Math.round(fullState.viewH)} 画布` : '没拿到布局')
  check('全屏用的是 fixed 定位', fullState?.position === 'fixed')
  check('全屏时锁住页面滚动', fullState?.overflow === 'hidden')
  await shot('02-fullscreen-fit.png')

  // 4) 放大到 100%：文字行数与溢出
  await click(`document.querySelector('[aria-label="重置缩放"]')`)
  await sleep(300)
  const zoomText = await ev(`return document.querySelector('.reader-mindmap-zoom')?.textContent?.trim() || '';`)
  check('「重置缩放」回到 100%', zoomText === '100%', zoomText)

  const overflow = await ev(`
    const groups = [...document.querySelectorAll('.reader-mindmap-node')];
    let worst = 0, lines = 0, checked = 0;
    for (const g of groups.slice(0, 80)) {
      const rect = g.querySelector('rect');
      const texts = [...g.querySelectorAll('.reader-mindmap-label')];
      if (!rect || !texts.length) continue;
      checked += 1;
      const w = Number(rect.getAttribute('width'));
      const h = Number(rect.getAttribute('height'));
      lines += texts.length;
      for (const t of texts) {
        const box = t.getBBox();
        worst = Math.max(worst, box.x + box.width - (w - 6));
        worst = Math.max(worst, box.y + box.height - (h - 2));
      }
    }
    return { worst, checked, lines, multiLine: document.querySelectorAll('.reader-mindmap-node .reader-mindmap-label:nth-of-type(2)').length };
  `)
  check('节点文字没有超出节点框', overflow.worst <= 0.5, `最大溢出 ${overflow.worst.toFixed(2)}px，样本 ${overflow.checked} 个`)
  check('长标签真的折成多行', overflow.lines > overflow.checked, `${overflow.lines} 行 / ${overflow.checked} 个节点`)
  await shot('03-fullscreen-100.png')

  // 5) 适应窗口：整张画布落在视口里
  await click(`document.querySelector('[aria-label="适应窗口"]')`)
  await sleep(400)
  const fitState = await ev(`
    const view = document.querySelector('.reader-mindmap-viewport');
    const stage = document.querySelector('.reader-mindmap-stage');
    if (!view || !stage) return null;
    const v = view.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    return {
      inside: s.left >= v.left - 1 && s.top >= v.top - 1 && s.right <= v.right + 1 && s.bottom <= v.bottom + 1,
      zoom: document.querySelector('.reader-mindmap-zoom')?.textContent?.trim() || '',
      view: [Math.round(v.left), Math.round(v.top), Math.round(v.right), Math.round(v.bottom)],
      stage: [Math.round(s.left), Math.round(s.top), Math.round(s.right), Math.round(s.bottom)],
      size: [Math.round(stage.offsetWidth), Math.round(stage.offsetHeight)],
    };
  `)
  check('「适应窗口」把整棵树装进视口', fitState?.inside === true, `缩放到 ${fitState?.zoom}，视口 ${fitState?.view}，画布 ${fitState?.stage}，内容 ${fitState?.size}`)
  await shot('04-fullscreen-refit.png')

  // 6) Esc 退出全屏
  await pressKey('Escape')
  const exited = await waitFor(`!document.querySelector('.reader-mindmap.is-fullscreen')`, 4000)
  check('Esc 退出全屏', exited)
  const backIn = await waitFor(`Boolean(document.querySelector('.reader-mindmap')?.closest('.n-drawer'))`, 4000)
  check('退出后导图回到抽屉里', backIn)
  await sleep(200)
  const backInDrawer = await ev(`
    const sec = document.querySelector('.reader-mindmap');
    return { inDrawer: Boolean(sec?.closest('.n-drawer')), overflow: document.documentElement.style.overflow };
  `)
  check('退出后恢复页面滚动', backInDrawer.overflow === '')
  const unpressed = await waitFor(`document.querySelector('.reader-mindmap-fullscreen-toggle')?.getAttribute('aria-pressed') === 'false'`, 3000)
  check('全屏按钮回到未按下状态', unpressed)
  await shot('05-back-in-drawer.png')
} catch (error) {
  check('导图全屏端到端流程未抛异常', false, String(error && error.stack || error))
} finally {
  try { ws?.close() } catch { /* noop */ }
  killTree()
  await sleep(500)
  await rm(lib, { recursive: true, force: true }).catch(() => {})
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n结果：${passed.length} 项通过，${failed.length} 项失败`)
if (failed.length) {
  console.log('--- 应用输出（尾部，Windows GUI 可能不往父进程 stdout 写，仅供参考）---')
  console.log(out.slice(-2000))
  process.exit(1)
}
console.log('导图全屏端到端通过：全屏铺满 / 100% 不溢出 / 适应窗口 / Esc 退出')
