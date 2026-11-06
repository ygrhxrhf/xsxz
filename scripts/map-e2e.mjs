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

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 36000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

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
  check('未配置 Key 时显示「未配置腾讯地图 Key」空态',
    await waitFor(`(document.querySelector('.book-map-overlay')?.textContent || '').includes('未配置腾讯地图 Key')`, 5000))
  check('左侧「书中原图」明确为空态',
    (await ev(`return document.querySelector('.book-map-original')?.textContent || '';`)).includes('尚未提供书中地图素材'))
  check('未配置 Key 时不会注入腾讯地图脚本', await ev(`return !document.querySelector('#spbf-tencent-map');`))

  // 关掉地图抽屉（找包含地图页的那个抽屉的关闭按钮）
  await ev(`
    const drawer = [...document.querySelectorAll('.n-drawer')].find((d) => d.querySelector('.book-map-page'));
    const close = drawer?.querySelector('.n-base-close');
    close?.click();
    return close ? 'ok' : 'none';
  `)
  check('关闭地图抽屉后地图页卸载', await waitFor(`!document.querySelector('.book-map-page')`, 8000))

  // 3) 顶部工具栏入口
  await click(`[...document.querySelectorAll('.tool-button')].find((b) => b.getAttribute('aria-label') === '书中地图')`)
  check('顶部工具栏入口同样打开书中地图页', await waitFor(`document.querySelector('.book-map-page')`, 8000))

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
