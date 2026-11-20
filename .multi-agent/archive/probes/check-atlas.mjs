// 书中地图端到端：真起 Electron，从书库打开一本书，走完两个入口与空态/去设置。
//
// 为什么不只跑 jsdom：抽屉是 teleport 的、入口跨工具栏与标记抽屉、去设置要跨页面，
// 这几段只有真进程能证明。夹具书不含真实地图数据（不臆造坐标），且**不配置**腾讯地图 Key，
// 因此这里验证的是「无 Key 空态 + 入口接线 + 去设置落点」；有 Key 的联网底图需用户在设置里
// 自行填写后再验证，脚本不会读写任何密钥。
//
// 用法：npm run build 之后 `node scripts/map-e2e.mjs`（npm run e2e:map）
// 注意：会在桌面上真开一个应用窗口（约十几秒），结束后自动关掉。
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = 'C:/codes/xsxz'
const atlasShotDir = join(root, '.multi-agent', 'visual', 'atlas')
const PORT = 36000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

await mkdir(atlasShotDir, { recursive: true })
const lib = await mkdtemp(join(tmpdir(), 'spbf-map-e2e-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-map-e2e-user-'))
const bookId = 'd_map'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const body = Array.from({ length: 12 }, (_, i) =>
  `第${i + 1}段：这是一段用来撑开可滚动正文的测试文字。书里提到地图，但书中地图页的数据要由地图素材与坐标另行提供，测试不杜撰坐标。`).join('\n\n')

await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '地图测试书', author: '测试', tags: [],
  sourceUrl: 'https://example.com/map/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章 地图', url: 'https://example.com/map/1.html', file: '0001', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0, rest: undefined },
}, null, 2), 'utf-8')
await writeFile(join(bookDir, 'chapters', '0001.json'), JSON.stringify({
  title: '第一章 地图', url: 'https://example.com/map/1.html', body, status: 'ready',
}), 'utf-8')

// 只写阅读偏好与书库；故意不写 tencentMapKeyEnc。
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: {
    fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
    paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll',
  },
}, null, 2), 'utf-8')

console.log(`夹具：书库=${lib}\n      userData=${userData}（未配置腾讯地图 Key）`)

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
  for (let i = 0; i < 80; i += 1) {
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

  // 1) 书库 → 打开夹具书
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  check('书库渲染出夹具书卡', await waitFor(`document.querySelector('.book-open-area')`, 12000))
  await click(`document.querySelector('.book-open-area')`)
  check('打开书后阅读器正文出现', await waitFor(`document.querySelector('.reader-content')`, 15000))

  // 2) 标记抽屉入口：打开标记 → 点「书中地图」
  await click(`[...document.querySelectorAll('.tool-button')].find((b) => b.getAttribute('aria-label') === '标记')`)
  // 必须在标记抽屉内部找按钮：设置页也常驻 DOM（v-show），那里同样有「书中地图」导航项。
  const marksEntry = await waitFor(
    `(() => { const d = [...document.querySelectorAll('.n-drawer')].find((x) => (x.textContent || '').includes('给本章加书签') || (x.textContent || '').includes('移除本章书签') || (x.textContent || '').includes('还没有标记')); return Boolean(d && [...d.querySelectorAll('button')].some((b) => b.textContent.trim() === '书中地图')); })()`,
    8000,
  )
  check('标记抽屉里有「书中地图」入口', marksEntry)
  const marksClicked = await ev(`
    const d = [...document.querySelectorAll('.n-drawer')].find((x) => (x.textContent || '').includes('给本章加书签') || (x.textContent || '').includes('移除本章书签') || (x.textContent || '').includes('还没有标记'));
    const btn = d ? [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '书中地图') : null;
    if (!btn) return 'none';
    btn.click();
    return 'ok';
  `)
  check('点击标记抽屉里的入口', marksClicked === 'ok', `click=${marksClicked}`)
  check('标记抽屉入口打开书中地图页', await waitFor(`document.querySelector('.book-map-page')`, 8000))
  await click(`[...document.querySelectorAll('.book-map-toolbar button')].find((x) => x.textContent.includes('3D 全球地形'))`)
  check('切到 3D 全球地形视图', await waitFor(`document.querySelector('.atlas-viewport')`, 8000))
  await sleep(7000)
  const atlasState = await ev(`return {
    canvas: Boolean(document.querySelector('.atlas-map-canvas canvas')),
    status: document.querySelector('.atlas-map-status')?.textContent || '',
    caption: document.querySelector('.atlas-map-caption')?.textContent || '',
    notice: document.querySelector('.atlas-map-notice')?.textContent || '',
  };`)
  check('3D 地图画布已创建', atlasState.canvas, JSON.stringify(atlasState))
  const atlasPng = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(atlasShotDir, 'atlas-3d.png'), Buffer.from(atlasPng.data, 'base64'))
  check('未配置 Key 时显示「未配置腾讯地图 Key」空态',
    await waitFor(`(document.querySelector('.book-map-overlay')?.textContent || '').includes('未配置腾讯地图 Key')`, 5000))
  check('左侧「书中原图」明确为空态',
    (await ev(`return document.querySelector('.book-map-original')?.textContent || '';`)).includes('尚未选择书中地图图片'))
  await mkdir(join(bookDir, 'map'), { recursive: true })
  await writeFile(join(bookDir, 'map', 'original.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lKmH1wAAAABJRU5ErkJggg==', 'base64'))
  await mkdir(join(bookDir, 'ai'), { recursive: true })
  await writeFile(join(bookDir, 'ai', 'places.json'), JSON.stringify({ version: 1, places: [
    { id: 'p-paris', name: '巴黎', aliases: [], kind: 'city', chapterId: 'c0001', chapterTitle: '第一章 地图', paragraphIndex: 0, paragraphOffset: 0, excerpt: '巴黎', geocodeStatus: 'resolved', location: { latitude: 48.858092, longitude: 2.352992 } },
    { id: 'p-berlin', name: '柏林', aliases: [], kind: 'city', chapterId: 'c0001', chapterTitle: '第一章 地图', paragraphIndex: 0, paragraphOffset: 0, excerpt: '柏林', geocodeStatus: 'resolved', location: { latitude: 52.523764, longitude: 13.399603 } },
  ] }))
  check('未配置 Key 时不会注入腾讯地图脚本', await ev(`return !document.querySelector('#spbf-tencent-map');`))

  // 关掉地图抽屉（找包含地图页的那个抽屉的关闭按钮）
  await ev(`
    const drawer = [...document.querySelectorAll('.n-drawer')].find((d) => d.querySelector('.book-map-page'));
    const close = drawer?.querySelector('.n-base-close');
    close?.click();
    return close ? 'ok' : 'none';
  `)
  check('关闭地图抽屉后地图页卸载', await waitFor(`!document.querySelector('.book-map-page')`, 8000))
  const dock = await ev(`return {
    exists: Boolean(document.querySelector('[data-atlas-dock]')),
    imageDisabled: document.querySelectorAll('.atlas-dock-trigger')[0]?.disabled,
    textDisabled: document.querySelectorAll('.atlas-dock-trigger')[1]?.disabled,
  };`)
  check('阅读器左下角出现地图胶囊', dock.exists && dock.textDisabled === false, JSON.stringify(dock))
  await click(`document.querySelectorAll('.atlas-dock-trigger')[1]`)
  check('点文字地点那一半打开迷你面板', await waitFor(`document.querySelector('.atlas-dock-panel')`, 6000))
  check('迷你面板里是地图画布', await waitFor(`document.querySelector('.atlas-dock-panel canvas') || document.querySelector('.atlas-dock-panel .atlas-viewport')`, 8000))
  await sleep(4000)
  const dockPng = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(atlasShotDir, 'atlas-dock.png'), Buffer.from(dockPng.data, 'base64'))
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); const p = document.querySelector('.atlas-dock-panel'); p?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`)
  check('Esc 关闭面板', await waitFor(`!document.querySelector('.atlas-dock-panel')`, 4000))

  // 3) 顶部工具栏入口
  await click(`[...document.querySelectorAll('.tool-button')].find((b) => b.getAttribute('aria-label') === '书中地图')`)
  check('顶部工具栏入口同样打开书中地图页', await waitFor(`document.querySelector('.book-map-page')`, 8000))
  check('原图重新打开后进入识别流程', await waitFor(`(() => { const t = [...document.querySelectorAll('.book-map-empty, .book-map-budget')].map((x) => x.textContent || '').join('|'); return t.includes('未收录') || t.includes('识别'); })()`, 10000))
  const recognized = await ev(`return {
    unmatched: [...document.querySelectorAll('.book-map-empty')].some((x) => (x.textContent || '').includes('未收录')),
    pins: document.querySelectorAll('.book-map-atlas-pin').length,
    recognized: document.querySelector('.book-map-recognized')?.textContent || '',
  };`)
  check('未收录地图不画地点标记', recognized.unmatched && recognized.pins === 0, JSON.stringify(recognized))
  check('已定位地名汇总成左侧地点', await waitFor(`[...document.querySelectorAll('.book-map-atlas-place')].some((x) => x.textContent.trim() === '巴黎')`, 8000))
  await click(`[...document.querySelectorAll('.book-map-recognized button')].find((x) => x.textContent.includes('查看文字地点地图'))`)
  check('打开文字地点 3D 地图', await waitFor(`document.querySelector('.atlas-viewport')`, 8000))
  const textOptions = await ev(`return [...document.querySelectorAll('.book-map-atlas-select option')].map((x) => x.textContent.trim());`)
  check('3D 区域选择里有文字地点地图', textOptions.some((text) => text.includes('书中文字地点')), JSON.stringify(textOptions))
  check('文字地点画在地图上', await waitFor(`document.querySelectorAll('.atlas-marker').length >= 2`, 12000))
  const markerState = await ev(`const m = document.querySelector('.atlas-marker'); if (!m) return null; m.click(); await new Promise((r) => setTimeout(r, 600)); return { selected: m.classList.contains('selected'), count: document.querySelectorAll('.atlas-marker').length };`)
  check('点选文字地点会选中标记', markerState && markerState.selected === true, JSON.stringify(markerState))
  const textPng = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(atlasShotDir, 'atlas-text-places.png'), Buffer.from(textPng.data, 'base64'))
  await sleep(9000)
  const textPng2 = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(atlasShotDir, 'atlas-text-places-loaded.png'), Buffer.from(textPng2.data, 'base64'))
  const recogPng = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(atlasShotDir, 'atlas-recognize.png'), Buffer.from(recogPng.data, 'base64'))

  // 4) 去设置：空态按钮跳到设置页的「书中地图」分区
  await click(`document.querySelector('.book-map-overlay button')`)
  check('空态「去设置填写 Key」切到设置页', await waitFor(`document.querySelector('.settings-page')`, 12000))
  const mapNav = `[...document.querySelectorAll('.settings-nav-item')].find((b) => b.textContent.trim() === '书中地图')`
  check('设置页有「书中地图」分区', await ev(`return Boolean(${mapNav});`))
  await click(mapNav)
  check('书中地图分区显示 Key 输入与未配置提示', await waitFor(
    `(() => { const c = [...document.querySelectorAll('.settings-card')].find((x) => (x.textContent || '').includes('腾讯地图 Key') && getComputedStyle(x).display !== 'none'); return Boolean(c); })()`,
    8000,
  ))
} catch (error) {
  check('书中地图端到端流程未抛异常', false, String((error && error.stack) || error))
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
console.log('书中地图端到端通过：两个入口、无 Key 空态、不加载脚本、去设置落点')
