// 阅读器新特性端到端（护眼压暗遮罩 dim + 续读可见提示）。
//
// 为什么需要它：npm test 里的压暗/续读是 jsdom 契约与源码锁定，跑不到「真 Electron 里遮罩真的叠上去、
// 真的不吞点击、真的写盘、真的弹提示」。这里造一个含长正文与阅读进度的夹具书库，把 reader.dim 预置成 40，
// 用 --remote-debugging-port 起真实应用，CDP 点进阅读器逐项核对。
//
// 用法：npm run build 之后 `node scripts/reader-features-e2e.mjs`（npm run e2e:reader）
// 注意：会在桌面上真开一个应用窗口（约十几秒），结束后自动关掉。
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

// --- 夹具书库：一本两章、每章正文够长可滚，进度停在第二章中段 ---
const lib = await mkdtemp(join(tmpdir(), 'spbf-reader-e2e-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-reader-e2e-user-'))
const bookId = 'd_reader'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const body = (n) =>
  Array.from({ length: n }, (_, i) => `第${i + 1}段：这是用来撑出可滚动长度的正文内容，够长才能测出续读定位与压暗遮罩覆盖范围。`).join('\n\n')

await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '压暗测试书', author: '测试', tags: [],
  sourceUrl: 'https://example.com/r/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [
    { id: 'c0001', index: 1, title: '第一章', url: 'https://example.com/r/1.html', file: '0001', status: 'ready' },
    { id: 'c0002', index: 2, title: '第二章', url: 'https://example.com/r/2.html', file: '0002', status: 'ready' },
  ],
  progress: { chapterId: 'c0002', scrollRatio: 0.5, paragraphIndex: 20, paragraphOffset: 0, updatedAt: now },
}, null, 2), 'utf-8')
for (const [file, count] of [['0001', 30], ['0002', 40]]) {
  await writeFile(join(bookDir, 'chapters', `${file}.json`), JSON.stringify({
    title: file === '0001' ? '第一章' : '第二章',
    url: `https://example.com/r/${file === '0001' ? 1 : 2}.html`,
    body: body(count), status: 'ready',
  }), 'utf-8')
}

// settings.json：书库指向夹具，reader.dim 预置 40（验证「读盘 → 渲染」这条路径）
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: { dim: 40, fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll' },
}, null, 2), 'utf-8')

console.log(`夹具：书库=${lib}\n      userData=${userData}（reader.dim=40，进度停在第二章中段）`)

const child = spawn(electronPath, [root, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
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
  // 传入函数体（内部用 return），包成 async IIFE 求值
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

  // 1) 进书库
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  const cardSeen = await waitFor(`document.querySelector('.book-open-area')`, 12000)
  check('夹具的书在书库列表里渲染成可打开的书卡', cardSeen)

  // 2) 点书卡进阅读器：进度在第二章 → 触发续读提示；dim=40 → 应叠压暗遮罩
  // 续读提示是会 3 秒自动消失的 toast，直接查 DOM 容易错过；先装一个 MutationObserver 记录它出现过。
  await ev(`
    window.__resumeToast = false;
    const grab = (root) => { for (const n of (root && root.querySelectorAll ? root.querySelectorAll('*') : [])) { if ((n.textContent || '').includes('已回到上次读到')) { window.__resumeToast = true; return } } };
    const mo = new MutationObserver((ms) => { for (const m of ms) for (const an of m.addedNodes) { if (an.nodeType === 1) { grab(an); grab(an) } } });
    mo.observe(document.body, { childList: true, subtree: true });
    return 'armed';
  `)
  await click(`document.querySelector('.book-open-area')`)
  const readerSeen = await waitFor(`document.querySelector('.reader-content')`, 15000)
  check('点书卡后阅读器正文渲染出来', readerSeen)

  // 续读定位确实跳到了第二章（进度落在非首章）
  const resumedChapter = await waitFor(`(document.querySelector('.ch-title')?.textContent || '').includes('第二章')`, 8000)
  check('打开书自动跳回上次所在章节（第二章）', resumedChapter, await ev(`return document.querySelector('.ch-title')?.textContent || '(无标题)'`))

  // 续读可见提示确实出现过（MutationObserver 记录 + 直接查 body 文本，双保险，不怕自动消失）
  const toastSeen = await waitFor(`window.__resumeToast === true || (document.body.innerText || '').includes('已回到上次读到')`, 6000)
  if (!toastSeen) {
    const diag = await ev(`
      return {
        resumeFlag: window.__resumeToast,
        msgCount: document.querySelectorAll('.n-message').length,
        msgTexts: [...document.querySelectorAll('.n-message__content')].map((x) => x.textContent).slice(0, 5),
        chTitle: document.querySelector('.ch-title')?.textContent,
        anyMsg: (document.querySelector('.n-message-container')?.innerText || '').slice(0, 120),
      };
    `)
    console.log('  [诊断] ' + JSON.stringify(diag))
  }
  check('跳回上次非起点位置时出现「已回到上次读到」提示', toastSeen)
  const dim = await ev(`
    const o = document.querySelector('.reader-dim');
    if (!o) return { present: false };
    const cs = getComputedStyle(o);
    return { present: true, opacity: cs.opacity, pe: cs.pointerEvents, zi: cs.zIndex };
  `)
  check('dim>0 时正文上叠了压暗遮罩 .reader-dim', dim.present === true)
  check('遮罩不透明度随 dim(40) 落到 0.4', dim.present && Math.abs(parseFloat(dim.opacity) - 0.4) < 0.01, `opacity=${dim.opacity}`)
  check('遮罩 pointer-events:none 不吞点击', dim.pe === 'none', `pointer-events=${dim.pe}`)
  check('遮罩 z-index 压在正文与导航之间(15)', dim.zi === '15', `z-index=${dim.zi}`)

  // 4) 不吞点击：正文中心点命中的不是遮罩（pointer-events:none 会让命中穿透到下层）
  const hit = await ev(`
    const stage = document.querySelector('.reader-body');
    if (!stage) return 'nostage';
    const r = stage.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!el) return 'null';
    return el.classList.contains('reader-dim') ? 'dim-blocked' : (el.className ? String(el.className) : el.tagName);
  `)
  check('压暗层中心点仍可命中下层正文（未拦截指针）', hit !== 'dim-blocked' && hit !== 'nostage' && hit !== 'null', `命中=${hit}`)

  // 恢复默认后压暗遮罩消失（v-if dim>0 生效）——已确认视图里 dim 归 0
  await click(`[...document.querySelectorAll('.bottom-button')].find((b) => b.textContent.trim() === '字体')`)
  await waitFor(`document.querySelector('.bottom-panel')`, 8000)
  await click(`[...document.querySelectorAll('.bottom-panel button')].find((b) => b.textContent.trim() === '恢复默认')`)
  const overlayGone = await waitFor(`!document.querySelector('.reader-dim')`, 6000)
  check('恢复默认后压暗遮罩消失（v-if dim>0 生效）', overlayGone)
  // 写盘是 300ms 防抖 + 串行链，轮询等它落盘，别用固定 sleep 猜时间
  let persisted = null
  const writeDeadline = Date.now() + 4000
  while (Date.now() < writeDeadline) {
    persisted = await readFile(join(userData, 'settings.json'), 'utf-8').then((raw) => JSON.parse(raw)).catch(() => null)
    if (persisted?.reader?.dim === 0) break
    await sleep(200)
  }
  check('恢复默认把 dim 写回 settings.json（读盘↔写盘闭环）', persisted?.reader?.dim === 0, `settings.reader.dim=${persisted?.reader?.dim}`)
} catch (error) {
  check('阅读器端到端流程未抛异常', false, String(error && error.stack || error))
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
console.log('阅读器新特性端到端通过：dim 压暗遮罩渲染/不吞点击/写盘闭环 + 续读可见提示')
