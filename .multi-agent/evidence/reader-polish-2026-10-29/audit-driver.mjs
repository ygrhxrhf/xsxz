// 只读取证驱动：起真实 Electron，造夹具书（长目录/失败章/大章/下载书），用 CDP 驱动阅读页。
// 产物：同目录下 screenshot + result.json；不改产品代码、不改 src/scripts/package.json。
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import electronPath from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(dirname(dirname(here)))
const PORT = 37000 + Math.floor(Math.random() * 500)
const HOST = '127.0.0.1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const shots = []
const log = (...a) => console.log(...a)

function record(path, status, summary, detail = {}) {
  results.push({ path, status, summary, ...detail })
  log(`${status === 'ok' ? 'OK  ' : status === 'issue' ? 'ISSUE' : 'BLOCKED'}  ${path}  ${summary}`)
}

// ---------------------------------------------------------------- 夹具
const lib = await mkdtemp(join(tmpdir(), 'spbf-audit-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-audit-user-'))
const now = new Date().toISOString()
const pad4 = (n) => String(n).padStart(4, '0')
const para = (i, len = 62) => `第${i + 1}段：${'这是一段用来测量翻屏与吸附边界的正文，长度保持中等，方便计算段落高度。'.repeat(3).slice(0, len)}`
const normalBody = (n = 60) => Array.from({ length: n }, (_, i) => para(i)).join('\n\n')
const largeBody = (n = 2600) => Array.from({ length: n }, (_, i) => `第${i + 1}段：${'短句正文用于测量大章节首屏与翻页耗时。'.repeat(2).slice(0, 22)}`).join('\n\n')

async function writeBookA() {
  const bookId = 'd_aaaaaaaaaaaaaaaa'
  const dir = join(lib, bookId)
  await mkdir(join(dir, 'chapters'), { recursive: true })
  const chapters = []
  for (let n = 1; n <= 420; n += 1) {
    const id = `c${pad4(n)}`
    const title = n === 1 ? '第 1 章 开篇' : `第 ${n} 章 章节 ${n}`
    const failed = n === 211
    chapters.push({ id, index: n, title, url: `https://example.com/r/${n}.html`, file: `chapters/${pad4(n)}.json`, status: failed ? 'failed' : 'ready', ...(failed ? { failCode: 'NavFailed' } : {}) })
    if (failed) continue
    await writeFile(join(dir, 'chapters', `${pad4(n)}.json`), JSON.stringify({
      title, url: `https://example.com/r/${n}.html`, status: 'ready',
      body: n === 1 ? largeBody() : normalBody(),
    }), 'utf-8')
  }
  await writeFile(join(dir, 'book.json'), JSON.stringify({
    id: bookId, title: '长目录测试书', author: '夹具', tags: [],
    sourceUrl: 'https://example.com/r/', sourceHost: 'example.com',
    importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
    chapters,
    progress: { chapterId: 'c0200', scrollRatio: 0.2, updatedAt: now },
  }, null, 2), 'utf-8')
  return bookId
}

async function writeBookB() {
  const bookId = 'd_bbbbbbbbbbbbbbbb'
  const dir = join(lib, bookId)
  await mkdir(join(dir, 'chapters'), { recursive: true })
  const chapters = [
    { id: 'c0001', index: 1, title: '第一章 开端', url: `http://${HOST}:${PORT}/01.html`, file: 'chapters/0001.json', status: 'ready' },
    { id: 'c0002', index: 2, title: '第二章 断章', url: `http://${HOST}:${PORT}/02.html`, file: 'chapters/0002.json', status: 'failed', failCode: 'NavFailed' },
  ]
  for (const ch of chapters) {
    if (ch.status !== 'ready') continue
    await writeFile(join(dir, 'chapters', `${ch.file.replace('chapters/', '')}`), JSON.stringify({ title: ch.title, url: ch.url, status: 'ready', body: normalBody(30) }), 'utf-8')
  }
  await writeFile(join(dir, 'book.json'), JSON.stringify({
    id: bookId, title: '下载取消测试书', author: '夹具', tags: [],
    sourceUrl: `http://${HOST}:${PORT}/index.html`, sourceHost: `${HOST}:${PORT}`,
    importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
    chapters,
    progress: { chapterId: 'c0002', scrollRatio: 0, updatedAt: now },
  }, null, 2), 'utf-8')
  return bookId
}

const bookAId = await writeBookA()
const bookBId = await writeBookB()
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: { fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll', dim: 0, hideSiteTail: true },
}, null, 2), 'utf-8')
log(`夹具：library=${lib}\n      userData=${userData}`)

// ---------------------------------------------------------------- 本地站点（下载取证）
const catalogHtml = `<!doctype html><html><head><meta charset="utf-8"><title>夹具目录</title></head><body>
<h1>夹具目录</h1><div class="list"><a href="./01.html">第一章 开端</a><a href="./02.html">第二章 断章</a></div></body></html>`
const chapterHtml = (t) => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body>
<h1>${t}</h1><div id="content">${Array.from({ length: 8 }, (_, i) => `<p>第${i + 1}段：${'下载进度与取消的测试正文，这一段长度足够让提取器认为它是正文。'.repeat(3)}</p>`).join('')}</div></body></html>`
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url === '/index.html' || url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(catalogHtml)
    return
  }
  if (url === '/01.html' || url === '/02.html') {
    // 故意慢 2.5 秒，留出观察「下载中进度 + 取消」的窗口
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(chapterHtml(url === '/01.html' ? '第一章 开端' : '第二章 断章'))
    }, 2500)
    return
  }
  res.writeHead(404); res.end('not found')
})
await new Promise((r) => server.listen(PORT, HOST, r))
log(`本地站点：http://${HOST}:${PORT}/index.html`)

// ---------------------------------------------------------------- Electron
const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT + 1}`], { stdio: ['ignore', 'pipe', 'pipe'] })
let appOut = ''
child.stdout.on('data', (c) => { appOut += String(c) })
child.stderr.on('data', (c) => { appOut += String(c) })
const killTree = () => {
  try { if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGTERM') } catch { /* gone */ }
}

let ws
let cdp
const ev = async (body) => {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
  return r.result?.value
}
const waitFor = async (expr, timeout = 15000, interval = 120) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { if (await ev(`return (${expr});`)) return true } catch { /* page transitioning */ }
    await sleep(interval)
  }
  return false
}
const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = `${name}.png`
  await writeFile(join(here, file), Buffer.from(r.data, 'base64'))
  shots.push(file)
  return file
}
const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })
async function clickAt(x, y) {
  await mouse('mouseMoved', x, y, { button: 'none' })
  await mouse('mousePressed', x, y)
  await mouse('mouseReleased', x, y)
}
const KEY = { Space: [' ', 'Space', 32], PageDown: ['PageDown', 'PageDown', 34], PageUp: ['PageUp', 'PageUp', 33], Escape: ['Escape', 'Escape', 27], Tab: ['Tab', 'Tab', 9], ArrowRight: ['ArrowRight', 'ArrowRight', 39], ArrowLeft: ['ArrowLeft', 'ArrowLeft', 40], Home: ['Home', 'Home', 36], End: ['End', 'End', 35], Alt: ['Alt', 'AltLeft', 18], KeyI: ['i', 'KeyI', 73], KeyR: ['r', 'KeyR', 82], KeyA: ['a', 'KeyA', 65], KeyT: ['t', 'KeyT', 84] }
async function press(name) {
  const [key, code, vk] = KEY[name]
  await ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); return 1;`)
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}

async function closeOverlays() {
  let st = null
  for (let i = 0; i < 5; i += 1) {
    st = await ev(`return { panel:!!document.querySelector('.bottom-panel'), tool:!!document.querySelector('.tool-panel'), drawer:!!document.querySelector('.n-drawer'), sel:!!document.querySelector('.sel-popup') };`)
    if (!st.panel && !st.tool && !st.drawer && !st.sel) return st
    await press('Escape')
    await sleep(280)
  }
  return st
}

const metrics = () => ev(`const el=document.querySelector('.reader-content'); return el?{top:el.scrollTop,h:el.clientHeight,sh:el.scrollHeight}:null;`)

async function clickBottom(label) {
  const revealed = await ev(`return !document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden')`)
  if (!revealed) { await press('Alt'); await sleep(300) }
  await ev(`const b=[...document.querySelectorAll('.bottom-button')].find(x=>x.textContent.trim()==='${label}'); if(b){b.click();return 'ok'} return 'none'`)
  await waitFor(`document.querySelector('.bottom-panel')`, 4000)
}
async function clickPanelOption(label) {
  return ev(`const b=[...document.querySelectorAll('.bottom-panel button')].find(x=>x.textContent.trim()==='${label}'); if(!b)return 'none'; b.click(); return 'ok'`)
}
async function openCatalog() {
  await clickBottom('目录')
  await waitFor(`document.querySelector('.n-drawer') && document.querySelectorAll('.ch-item').length>0`, 6000)
}
async function filterCatalog(text) {
  await ev(`const i=document.querySelector('input[placeholder="过滤目录"]'); if(!i)return 'none';
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,${JSON.stringify(text)}); i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';`)
  await sleep(300)
}
async function clickCatalogTitle(text) {
  return ev(`const it=[...document.querySelectorAll('.ch-item')].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(!it)return 'none'; it.click(); return 'ok';`)
}
async function chapterTitle() {
  return ev(`return document.querySelector('.ch-title')?.textContent?.trim() || ''`)
}
async function goLibrary() {
  await ev(`document.querySelector('.reader-spine')?.click(); return 'ok'`)
  await waitFor(`document.querySelector('.book-open-area')`, 8000)
}
async function openBookCard(titleText) {
  await ev(`const cards=[...document.querySelectorAll('.book-open-area')]; const c=cards.find(x=>x.textContent.includes(${JSON.stringify(titleText)}))||cards[0]; if(c){c.click();return 'ok'} return 'none'`)
  await waitFor(`document.querySelector('.reader-content')`, 10000)
}
const spansOf = () => ev(`const el=document.querySelector('.reader-content'); if(!el)return [];
  const top0=el.getBoundingClientRect().top; const out=[];
  for (const n of el.querySelectorAll('.para[data-p]')) { const r=n.getBoundingClientRect(); if(r.height<=0)continue; out.push({p:Number(n.dataset.p), top:Math.round(r.top-top0+el.scrollTop), bottom:Math.round(r.top-top0+el.scrollTop+r.height)}); }
  return out;`)

try {
  // 连接 CDP
  let target
  for (let i = 0; i < 100; i += 1) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json(); target = list.find((t) => t.type === 'page' && t.url.startsWith('file:')); if (target) break } catch { /* not up */ }
    await sleep(300)
  }
  if (!target) throw new Error('没有 CDP target：' + appOut.slice(-1500))
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (!m.id) return; const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
  cdp = (method, params = {}) => new Promise((res, rej) => { const id = nextId += 1; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
  await cdp('Page.enable')

  // ------------------------------------------------------------ P1 入口与工具显隐
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x)=>x.textContent==='书库')`, 25000)
  await ev(`[...document.querySelectorAll('.nav-btn')].find(b=>b.querySelector('.nav-label')?.textContent==='书库')?.click(); return 'ok';`)
  await waitFor(`document.querySelector('.book-open-area')`, 10000)
  await openBookCard('长目录测试书')
  await waitFor(`document.querySelector('.reader-content .para')`, 10000)
  const entry = await ev(`return { title: document.querySelector('.ch-title')?.textContent?.trim(), toolbarHidden: document.querySelector('.reader-toolbar')?.classList.contains('reader-tools-hidden'), bottombarHidden: document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden'), at: document.querySelector('.reader-content')?.scrollTop, mode: [...document.querySelectorAll('.bottom-panel button.active')].map(x=>x.textContent) };`)
  const shot1 = await shot('01-reader-entry')
  record('入口与默认收起', entry.title === '第 200 章 章节 200' && entry.toolbarHidden && entry.bottombarHidden ? 'ok' : 'issue', `进入《长目录测试书》第 200 章，顶栏/底栏默认收起=${entry.toolbarHidden && entry.bottombarHidden}`, { entry, evidence: [shot1] })

  const contentRect = await ev(`const r=document.querySelector('.reader-content').getBoundingClientRect(); return {left:r.left, top:r.top, w:r.width, h:r.height};`)
  await clickAt(contentRect.left + contentRect.w / 2, contentRect.top + contentRect.h / 2)
  await sleep(300)
  const revealed = await ev(`return { toolbar: !document.querySelector('.reader-toolbar')?.classList.contains('reader-tools-hidden'), bottom: !document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden') }`)
  const shot2 = await shot('02-tools-revealed')
  record('正文中区唤出工具', revealed.toolbar && revealed.bottom ? 'ok' : 'issue', `点中区后顶栏=${revealed.toolbar}，底栏=${revealed.bottom}`, { evidence: [shot2] })
  await clickAt(contentRect.left + contentRect.w / 2, contentRect.top + contentRect.h / 2)
  await sleep(250)
  const hiddenAgain = await ev(`return document.querySelector('.reader-toolbar')?.classList.contains('reader-tools-hidden')`)

  // ------------------------------------------------------------ P2 连续滚动翻屏 + 键盘
  await clickBottom('字体')
  await clickPanelOption('连续滚动')
  await sleep(300)
  const modeScroll = await ev(`return [...document.querySelectorAll('.bottom-panel button.active')].map(x=>x.textContent.trim())`)
  await closeOverlays(); await sleep(200)
  const beforeScroll = await metrics()
  await press('PageDown')
  await sleep(800)
  const afterScroll = await metrics()
  await sleep(500)
  const stableScroll = await metrics()
  const delta = afterScroll.top - beforeScroll.top
  const ratio = delta / beforeScroll.h
  const cont = { beforeScroll, afterScroll, stableScroll, delta, ratio, snapped: Math.abs(stableScroll.top - afterScroll.top) > 1, modes: modeScroll }
  const shot3 = await shot('03-scroll-pagedown')
  record('连续滚动 PageDown 不吸附', Math.abs(ratio - 0.9) < 0.03 && !cont.snapped ? 'ok' : 'issue', `PageDown 前进 ${Math.round(ratio * 100)}% 屏高，800ms 后是否又动了=${cont.snapped}`, { cont, evidence: [shot3] })

  const beforeEnd = await metrics()
  await press('End'); await sleep(1200)
  const afterEnd = await metrics()
  const endOk = Math.abs(afterEnd.top - (afterEnd.sh - afterEnd.h)) < 3
  await press('Home'); await sleep(1200)
  const afterHome = await metrics()
  record('Home/End 到章首章末', endOk && afterHome.top < 3 ? 'ok' : 'issue', `End 到底=${endOk}，Home 回顶 scrollTop=${afterHome.top}`, { beforeEnd, afterEnd, afterHome })

  // ------------------------------------------------------------ P3 屏幕翻页段落吸附
  await clickBottom('字体')
  await clickPanelOption('屏幕翻页')
  await sleep(300)
  await closeOverlays(); await sleep(250)
  const modeScreen = await ev(`return [...document.querySelectorAll('.bottom-panel button.active')].map(x=>x.textContent.trim())`)
  await ev(`const el=document.querySelector('.reader-content'); el.scrollTop=0; return 'ok';`)
  await sleep(300)
  const flips = []
  for (let i = 0; i < 5; i += 1) {
    const before = await metrics()
    const spans = await spansOf()
    const bottomEdge = before.top + before.h
    const straddle = spans.find((s) => s.top < bottomEdge && s.bottom > bottomEdge)
    const expected = straddle ? (straddle.bottom - straddle.top <= before.h ? straddle.top : Math.min(before.top + before.h, before.sh - before.h)) : null
    const beforeIdx = spans.find((s) => s.bottom > before.top + 1)?.p ?? 0
    await press('PageDown')
    await sleep(750)
    const after = await metrics()
    const spansAfter = await spansOf()
    const firstVisible = spansAfter.find((s) => s.bottom > after.top + 2)
    const cutPara = straddle ? spansAfter.find((s) => s.p === straddle.p) : null
    flips.push({ beforeTop: before.top, expected, afterTop: after.top, straddlePara: straddle?.p, firstVisiblePara: firstVisible?.p, straddleFullyVisible: cutPara ? cutPara.bottom - after.top <= after.h + 2 : null, beforeIdx, aligned: expected !== null ? Math.abs(after.top - expected) <= 3 : null })
  }
  const badFlips = flips.filter((f) => f.aligned === false || f.straddleFullyVisible === false)
  const shot4 = await shot('04-screen-page-snap')
  record('屏幕翻页段落吸附（5 次连续翻页）', badFlips.length === 0 ? 'ok' : 'issue', `5 次翻页中 ${badFlips.length} 次未对齐段首或切断段未完整显示`, { flips, badFlips, modes: modeScreen, evidence: [shot4] })
  // 回翻一页
  await press('PageUp'); await sleep(1000)
  const back = await metrics()
  record('屏幕翻页回翻', Math.abs(back.top - flips.at(-1).beforeTop) <= 3 ? 'ok' : 'unsure', `回翻后 scrollTop=${back.top}，翻页前=${flips.at(-1).beforeTop}`, { back })

  // ------------------------------------------------------------ P4 进度条拖拽（正常 + 失败章）
  const track = await ev(`const r=document.querySelector('.reader-progress-track').getBoundingClientRect(); return {left:r.left, top:r.top, w:r.width, h:r.height};`)
  const dx = track.left + track.w * 0.2
  const dy = track.top + track.h / 2
  const targetX = track.left + track.w * 0.85
  await mouse('mousePressed', dx, dy, { buttons: 1 })
  for (let i = 1; i <= 8; i += 1) { await mouse('mouseMoved', dx + (targetX - dx) * i / 8, dy, { buttons: 1 }); await sleep(40) }
  await sleep(200)
  const dragHint = await ev(`return { hint: document.querySelector('.reader-progress-scrub-hint')?.innerText?.replace(/\\n/g,' · ') || '', preview: document.querySelector('.scrub-preview')?.style.width || '' };`)
  const shot5 = await shot('05-progress-drag-85')
  await mouse('mouseReleased', targetX, dy, { buttons: 1 })
  await sleep(900)
  const jumpTitle = await chapterTitle()
  const jumpMetrics = await metrics()
  const shot6 = await shot('06-progress-jump')
  record('进度条拖拽松手跳章且落章首', dragHint.hint.includes('第 358 章') && jumpTitle.startsWith('第 358 章') && jumpMetrics.top < 3 ? 'ok' : 'issue', `拖动提示「${dragHint.hint}」，松手到「${jumpTitle}」，scrollTop=${jumpMetrics.top}`, { dragHint, jumpTitle, jumpMetrics, evidence: [shot5, shot6] })

  // 拖到失败章（第 211 章）：ratio ∈ [210/420, 211/420)
  const failX = track.left + track.w * (210.5 / 420)
  await mouse('mousePressed', track.left + track.w * 0.5, dy, { buttons: 1 })
  await mouse('mouseMoved', failX, dy, { buttons: 1 })
  await sleep(200)
  const failHint = await ev(`return document.querySelector('.reader-progress-scrub-hint')?.innerText?.replace(/\\n/g,' · ') || ''`)
  await mouse('mouseReleased', failX, dy, { buttons: 1 })
  await sleep(1500)
  const failUi = await ev(`return { title: document.querySelector('.ch-title')?.textContent?.trim(), error: document.querySelector('.chapter-error')?.textContent?.trim() || '', hint: document.querySelector('.chapter-hint')?.textContent?.trim() || '', retry: !![...document.querySelectorAll('button')].find(b=>b.textContent.includes('重试失败章')), browse: !![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='去浏览页'), top: document.querySelector('.reader-content')?.scrollTop }`)
  const shot7 = await shot('07-failed-chapter')
  record('拖到失败章停在该章并显示失败说明/重试', failHint.includes('第 211 章') && failUi.title?.startsWith('第 211 章') && failUi.error && failUi.retry ? 'ok' : 'issue', `提示「${failHint}」；正文区失败说明「${failUi.error}」；重试按钮=${failUi.retry}`, { failUi, evidence: [shot7] })

  // 点重试失败章（Book A 无本地目录，预期给出明确失败提示，不空转）
  const retryStartedAt = Date.now()
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('重试失败章'))?.click(); return 'ok';`)
  await sleep(2500)
  const retryToast = await ev(`return [...document.querySelectorAll('.n-message__content')].map(x=>x.textContent).join(' | ')`)
  const shotRetry = await shot('07b-failed-chapter-retry-toast')
  record('失败章重试按钮给出可读反馈', retryToast.length > 0 ? 'ok' : 'issue', `${Date.now() - retryStartedAt}ms 后提示「${retryToast}」`, { retryToast, elapsedMs: Date.now() - retryStartedAt, evidence: [shotRetry] })

  // ------------------------------------------------------------ P5 长目录
  await clickBottom('目录')
  const catOpenAt = Date.now()
  await waitFor(`document.querySelector('.n-drawer') && document.querySelectorAll('.ch-item').length>0`, 6000)
  const catInfo = await ev(`const items=document.querySelectorAll('.ch-item'); const current=[...items].find(x=>x.classList.contains('active')); const drawerContent=[...document.querySelectorAll('.n-drawer-body-content-wrapper')][0]; return { count: items.length, currentVisible: current ? (()=>{const r=current.getBoundingClientRect(); const d=drawerContent?.getBoundingClientRect(); return r.top>=d.top && r.bottom<=d.bottom})() : null, currentText: current?.textContent?.trim() || '', listScroll: drawerContent?.scrollTop ?? null };`)
  const shot8 = await shot('08-catalog-open')
  record('长目录打开/定位当前章', catInfo.count === 420 && catInfo.currentVisible ? 'ok' : 'issue', `目录 ${catInfo.count} 项，当前章「${catInfo.currentText}」是否滚到可见=${catInfo.currentVisible}，打开耗时 ${catOpenAt ? Date.now() - catOpenAt : '?'}ms`, { catInfo, evidence: [shot8] })
  await filterCatalog('第 350 章')
  const filtered = await ev(`return [...document.querySelectorAll('.ch-item')].map(x=>x.textContent.trim())`)
  const jumpAt = Date.now()
  await clickCatalogTitle('第 350 章')
  await waitFor(`(document.querySelector('.ch-title')?.textContent||'').includes('第 350 章')`, 6000)
  const jumpMs = Date.now() - jumpAt
  const shot9 = await shot('09-catalog-filter-jump')
  record('长目录过滤与跳转', filtered.length >= 1 && (await chapterTitle()).startsWith('第 350 章') ? 'ok' : 'issue', `过滤后 ${filtered.length} 项；跳转第 350 章耗时 ${jumpMs}ms`, { filtered: filtered.slice(0, 3), jumpMs, evidence: [shot9] })

  // ------------------------------------------------------------ P6 字体/背景面板与焦点
  await clickBottom('背景')
  await clickPanelOption('夜间')
  await sleep(400)
  const night = await ev(`const body=document.querySelector('.reader-body'); const content=document.querySelector('.reader-content'); return { bodyBg:getComputedStyle(body).backgroundColor, contentBg:getComputedStyle(content).backgroundColor, color:getComputedStyle(content).color };`)
  const shot10 = await shot('10-night-theme')
  record('背景面板切夜间即时生效', /rgb\((2[0-9]|3[0-9])/.test(night.bodyBg) || /rgb\((2[0-9]|3[0-9])/.test(night.contentBg) ? 'ok' : 'unsure', `夜间正文背景 ${night.contentBg}，文字 ${night.color}`, { night, evidence: [shot10] })
  await clickPanelOption('纸白')
  await sleep(200)

  // 字号滑块获得焦点后按 ArrowRight：应当只调字号，不应跳章
  await clickBottom('字体')
  const sliderFocus = await ev(`const s=[...document.querySelectorAll('.bottom-panel .n-slider')][0]; if(!s)return null;
    const h=s.querySelector('[tabindex="0"]')||s.querySelector('.n-slider-handle-wrapper')||s; h.focus();
    return { tag:h.tagName, cls:String(h.className), role:h.getAttribute('role'), active:document.activeElement===h };`)
  const titleBeforeSlider = await chapterTitle()
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await sleep(700)
  const afterSlider = await ev(`return { title: document.querySelector('.ch-title')?.textContent?.trim(), fontSizeLabel: [...document.querySelectorAll('.control-label')].find(x=>x.textContent.includes('字号'))?.textContent?.trim() || '' }`)
  const shot11 = await shot('11-slider-arrow-key')
  record('字号滑块键盘操作不应误跳章', afterSlider.title === titleBeforeSlider ? 'ok' : 'issue', `焦点在 ${sliderFocus?.cls}；按 → 前章节「${titleBeforeSlider}」，按后「${afterSlider.title}」，字号标签「${afterSlider.fontSizeLabel}」`, { sliderFocus, titleBeforeSlider, afterSlider, evidence: [shot11] })
  await closeOverlays(); await sleep(200)

  // Tab 焦点顺序（工具收起时）
  await closeOverlays(); await sleep(300)
  const toolsNowHidden = await ev(`return document.querySelector('.reader-toolbar')?.classList.contains('reader-tools-hidden')`)
  const tabStops = []
  for (let i = 0; i < 10; i += 1) {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await sleep(120)
    tabStops.push(await ev(`const a=document.activeElement; return { tag:a?.tagName, cls:String(a?.className||''), label:a?.getAttribute?.('aria-label')||a?.textContent?.trim()?.slice(0,20)||'', inHiddenToolbar: !!a?.closest?.('.reader-tools-hidden') };`))
  }
  const focusIntoHidden = tabStops.filter((t) => t.inHiddenToolbar)
  record('工具收起时 Tab 不应进入不可见工具条', toolsNowHidden && focusIntoHidden.length === 0 ? 'ok' : 'issue', `工具收起=${toolsNowHidden}；10 次 Tab 落入隐藏工具条=${focusIntoHidden.length}`, { tabStops, evidence: [] })

  // ------------------------------------------------------------ P7 划线批注
  await openCatalog(); await filterCatalog('第 220 章'); await sleep(300); await clickCatalogTitle('第 220 章')
  await waitFor(`(document.querySelector('.ch-title')?.textContent||'').includes('第 220 章')`, 5000)
  await sleep(400)
  const selInfo = await ev(`const p=document.querySelectorAll('.reader-content .para')[3]; if(!p)return null;
    const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT); let node=null;
    while(walker.nextNode()){ const t=walker.currentNode; if(t.nodeValue && t.nodeValue.trim().length>=8){ node=t; break } }
    if(!node)return null;
    const r=document.createRange(); r.setStart(node,2); r.setEnd(node,Math.min(node.length,Math.max(3,node.length-2)));
    const s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
    const rect=p.getBoundingClientRect();
    p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:rect.left+30,clientY:rect.top+rect.height/2,button:0}));
    return { text:s.toString(), hasParaBtn: !!p.querySelector('.para-tts-start') };`)
  await sleep(400)
  const popup = await ev(`return { shown: !!document.querySelector('.sel-popup'), buttons:[...document.querySelectorAll('.sel-popup button')].map(b=>b.textContent.trim()) }`)
  const shot12 = await shot('12-selection-popup')
  record('选中正文出选区工具条', popup.shown && popup.buttons.length >= 5 ? 'ok' : 'issue', `工具条按钮：${popup.buttons.join('/')}`, { selInfo, popup, evidence: [shot12] })
  const hlBefore = await ev(`return document.querySelectorAll('.hl-mark').length`)
  await ev(`[...document.querySelectorAll('.sel-popup button')].find(b=>b.textContent.trim()==='划线')?.click(); return 'ok';`)
  await sleep(800)
  const hlAfter = await ev(`return { marks: document.querySelectorAll('.hl-mark').length, toast:[...document.querySelectorAll('.n-message__content')].map(x=>x.textContent).join('|') }`)
  const annFile = await readFile(join(lib, bookAId, 'annotations.json'), 'utf-8').then((x) => JSON.parse(x)).catch(() => null)
  const shot13 = await shot('13-highlight-applied')
  record('划线落盘并即时渲染', hlAfter.marks > hlBefore && Array.isArray(annFile) && annFile.length > 0 ? 'ok' : 'issue', `高亮 ${hlBefore}→${hlAfter.marks}，annotations.json 条数=${Array.isArray(annFile) ? annFile.length : 'n/a'}，提示「${hlAfter.toast}」`, { hlAfter, annFile, evidence: [shot13] })
  // 标记抽屉
  await ev(`[...document.querySelectorAll('.tool-button')].find(b=>b.getAttribute('aria-label')==='标记')?.click(); return 'ok';`)
  await sleep(600)
  const marksUi = await ev(`return { drawer: !!document.querySelector('.n-drawer'), rows: document.querySelectorAll('.mark-row').length }`)
  const shot14 = await shot('14-marks-drawer')
  record('标记抽屉能看到刚写的划线', marksUi.rows >= 1 ? 'ok' : 'issue', `标记列表 ${marksUi.rows} 行`, { marksUi, evidence: [shot14] })
  await closeOverlays(); await sleep(400)

  // ------------------------------------------------------------ P8 听书
  await press('KeyR'); await sleep(500)
  const ttsPanel = await ev(`return { open: !!document.querySelector('.tool-panel'), text: (document.querySelector('.tool-panel')?.innerText||'').slice(0,200), supported: !(document.querySelector('.tool-panel')?.innerText||'').includes('当前环境不支持朗读') }`)
  let ttsState = null
  if (ttsPanel.supported) {
    await ev(`[...document.querySelectorAll('.tool-panel button')].find(b=>b.textContent.trim()==='从本章开头播放')?.click(); return 'ok';`)
    await waitFor(`document.querySelector('.para-speaking')`, 6000)
    await sleep(1200)
    ttsState = await ev(`return { speaking: !!document.querySelector('.para-speaking'), status:[...document.querySelectorAll('.tool-panel .control-label')].map(x=>x.textContent.trim()).find(t=>t.includes('本章第'))||'', errors:[...document.querySelectorAll('.tool-panel [role="alert"]')].map(x=>x.textContent.trim()) };`)
    const shot15 = await shot('15-tts-speaking')
    record('听书播放与段高亮', ttsState.speaking ? 'ok' : 'issue', `段高亮=${ttsState.speaking}，状态「${ttsState.status||'无'}」`, { ttsPanel, ttsState, evidence: [shot15] })
    await ev(`[...document.querySelectorAll('.tool-panel button')].find(b=>b.textContent.trim()==='停止')?.click(); return 'ok';`)
    await sleep(1000)
    const ttsFiles = await readdir(join(lib, bookAId)).catch(() => [])
    const posFile = ttsFiles.find((f) => f.includes('tts'))
    const posRaw = posFile ? await readFile(join(lib, bookAId, posFile), 'utf-8').catch(() => '') : ''
    record('听书位置落盘', posFile && posRaw.includes('c0220') ? 'ok' : ttsState.speaking ? 'issue' : 'unsure', `书目录文件：${ttsFiles.join(',')}；位置内容 ${posRaw.slice(0, 120)}`, { posFile, posRaw })
  } else {
    record('听书', 'blocked', `朗读面板显示「当前环境不支持朗读」`, { ttsPanel })
  }
  await closeOverlays(); await sleep(300)

  // ------------------------------------------------------------ P9 AI 抽屉
  const aiOpenAt = Date.now()
  await press('KeyI')
  const aiShown = await waitFor(`document.querySelector('.n-drawer') && (document.querySelector('.n-drawer')?.innerText||'').length>0`, 6000)
  const aiMs = Date.now() - aiOpenAt
  const aiInfo = await ev(`const d=[...document.querySelectorAll('.n-drawer')].find(x=>x.innerText.includes('AI')||x.innerText.includes('前情')); return { open: !!d, text:(d?.innerText||'').slice(0,220), hasGoSettings: !!(d?.innerText||'').includes('设置') };`)
  const shot16 = await shot('16-ai-drawer')
  record('AI 抽屉打开', aiShown ? 'ok' : 'issue', `打开耗时 ${aiMs}ms；未配置 key 时的提示：「${aiInfo.text.replace(/\n/g, ' / ').slice(0, 120)}」`, { aiInfo, aiMs, evidence: [shot16] })
  const sumBtn = await ev(`const b=[...document.querySelectorAll('.n-drawer button')].find(x=>x.textContent.includes('生成本章摘要')); return b?'found':'none'`)
  if (sumBtn === 'found') {
    const sumStart = Date.now()
    await ev(`[...document.querySelectorAll('.n-drawer button')].find(x=>x.textContent.includes('生成本章摘要'))?.click(); return 'ok';`)
    await waitFor(`[...document.querySelectorAll('.n-message__content')].length>0 || !!document.querySelector('.ai-assistant-status')`, 8000, 100)
    const sumState = await ev(`return { messages:[...document.querySelectorAll('.n-message__content')].map(x=>x.textContent).join('|'), stage: document.querySelector('.ai-assistant-status')?.textContent?.trim()||'', drawerLoading: document.querySelectorAll('.n-drawer .n-base-loading').length, drawerOpen: !!document.querySelector('.n-drawer') };`)
    record('AI 未配置 key 时摘要失败可感知且不卡住', (sumState.messages.length > 0 || sumState.stage.length > 0) && sumState.drawerLoading === 0 ? 'ok' : 'issue', `${Date.now() - sumStart}ms 后提示「${sumState.messages || sumState.stage}」，抽屉内 loading=${sumState.drawerLoading}`, { sumState })
  }
  await closeOverlays(); await sleep(400)
  const aiClosed = await ev(`return document.querySelectorAll('.n-drawer').length`)
  record('Esc 关闭 AI 抽屉', aiClosed === 0 ? 'ok' : 'issue', `Esc 后仍存在抽屉 ${aiClosed} 个`, { aiClosed })

  // ------------------------------------------------------------ P10 大章节首屏与翻页耗时
  await openCatalog(); await filterCatalog('开篇'); await sleep(300); await clickCatalogTitle('第 1 章')
  const largeStart = Date.now()
  const largeOpenOk = await waitFor(`(document.querySelector('.ch-title')?.textContent||'').includes('开篇')`, 12000, 80)
  await waitFor(`document.querySelector('.reader-content .para')`, 15000, 80)
  const firstParaSeen = Date.now() - largeStart
  let allRenderedMs = null
  const allStart = Date.now()
  const allRendered = await waitFor(`document.querySelectorAll('.reader-content .para').length >= 2600 && !document.querySelector('.loading-hint')`, 25000, 200)
  if (allRendered) allRenderedMs = Date.now() - allStart
  const largeInfo = await ev(`const el=document.querySelector('.reader-content'); return { paras: document.querySelectorAll('.para').length, scrollHeight: el?.scrollHeight, clientHeight: el?.clientHeight, largeClass: el?.classList.contains('large-chapter'), rendered: document.querySelector('.loading-hint')?.textContent || '' };`)
  const shot17 = await shot('17-large-chapter')
  record('大章节（2600 段 / 约 6 万字）首屏与全量排版', largeOpenOk && allRendered ? 'ok' : 'issue', `打开成功=${largeOpenOk}；首屏段落可见 ${firstParaSeen}ms；剩余段落全部排版完成 ${allRenderedMs}ms；段落 ${largeInfo.paras}；scrollHeight=${largeInfo.scrollHeight}`, { largeOpenOk, firstParaSeen, allRenderedMs, largeInfo, evidence: [shot17] })
  if (largeInfo.paras >= 2600) {
    await clickBottom('字体'); await clickPanelOption('屏幕翻页'); await closeOverlays(); await sleep(200)
    await ev(`const el=document.querySelector('.reader-content'); el.scrollTop=0;
      window.__turn={t0:0,ms:null}; if(!el.__turnHooked){ el.__turnHooked=true; el.addEventListener('scroll',()=>{ if(!window.__turn.t0) return; clearTimeout(window.__turn.timer); window.__turn.timer=setTimeout(()=>{window.__turn.ms=performance.now()-window.__turn.t0},150) },{passive:true}) }
      window.__turn.t0=performance.now(); return 'ok'`)
    await press('PageDown')
    await sleep(450)
    const turn = await ev(`return { ms: window.__turn.ms === null ? null : Math.round(window.__turn.ms), top: document.querySelector('.reader-content').scrollTop }`)
    record('大章节单次翻页耗时', turn.ms !== null && turn.ms < 700 ? 'ok' : 'issue', `大章 PageDown 从按键到滚动停稳约 ${turn.ms}ms（页面内计时，含 smooth 动画），scrollTop=${turn.top}`, { turn })
    await clickBottom('字体'); await clickPanelOption('连续滚动'); await closeOverlays(); await sleep(200)
  }

  // ------------------------------------------------------------ P11 字号变化后重开恢复
  await openCatalog(); await filterCatalog('第 220 章'); await sleep(300); await clickCatalogTitle('第 220 章')
  await waitFor(`(document.querySelector('.ch-title')?.textContent||'').includes('第 220 章')`, 5000)
  await sleep(400)
  await ev(`const el=document.querySelector('.reader-content'); el.scrollTop = (el.scrollHeight-el.clientHeight)*0.45; return 'ok';`)
  await sleep(1200)
  const restoreBefore = await ev(`const el=document.querySelector('.reader-content'); const top0=el.getBoundingClientRect().top; const spans=[...el.querySelectorAll('.para')].map(n=>{const r=n.getBoundingClientRect(); return {p:Number(n.dataset.p), top:r.top-top0+el.scrollTop, bottom:r.top-top0+el.scrollTop+r.height}}); const first=spans.find(s=>s.bottom>el.scrollTop+2); return { ratio: el.scrollTop/(el.scrollHeight-el.clientHeight), para: first?.p, top: el.scrollTop, font:[...document.querySelectorAll('.control-label')].find(x=>x.textContent.includes('字号'))?.textContent||'' };`)
  await clickBottom('字体')
  const fontSizeRail = await ev(`const s=[...document.querySelectorAll('.bottom-panel .n-slider')][0]; if(!s)return null; const r=s.getBoundingClientRect(); return {left:r.left,top:r.top,w:r.width,h:r.height};`)
  if (fontSizeRail) await clickAt(fontSizeRail.left + fontSizeRail.w * 0.7, fontSizeRail.top + fontSizeRail.h / 2)
  await sleep(300); await press('Escape')
  await sleep(1200)
  await goLibrary(); await openBookCard('长目录测试书')
  await waitFor(`(document.querySelector('.ch-title')?.textContent||'').includes('第 220 章')`, 10000)
  await sleep(1200)
  const restoreAfter = await ev(`const el=document.querySelector('.reader-content'); const top0=el.getBoundingClientRect().top; const spans=[...el.querySelectorAll('.para')].map(n=>{const r=n.getBoundingClientRect(); return {p:Number(n.dataset.p), top:r.top-top0+el.scrollTop, bottom:r.top-top0+el.scrollTop+r.height}}); const first=spans.find(s=>s.bottom>el.scrollTop+2); return { ratio: el.scrollTop/(el.scrollHeight-el.clientHeight), para: first?.p, top: el.scrollTop };`)
  const paraDelta = Math.abs((restoreAfter.para ?? -1) - (restoreBefore.para ?? -2))
  const shot18 = await shot('18-restore-after-font')
  if (!restoreBefore || !restoreAfter || !Number.isFinite(restoreBefore.ratio) || !Number.isFinite(restoreAfter.ratio)) {
    record('换字体后重开书位置恢复', 'blocked', `未能取到重开前后位置（重开前=${JSON.stringify(restoreBefore)}，重开后=${JSON.stringify(restoreAfter)}）`, { restoreBefore, restoreAfter, evidence: [shot18] })
  } else {
    record('换字体后重开书位置恢复', paraDelta <= 1 ? 'ok' : 'issue', `重开前首段 #${restoreBefore.para}（比例 ${restoreBefore.ratio.toFixed(3)}），重开后 #${restoreAfter.para}（比例 ${restoreAfter.ratio.toFixed(3)}），段落偏差 ${paraDelta}`, { restoreBefore, restoreAfter, paraDelta, evidence: [shot18] })
  }

  // ------------------------------------------------------------ P12 下载进行中的进度与取消
  await goLibrary()
  await openBookCard('下载取消测试书')
  await sleep(600)
  const dlChapter = await ev(`return { title: document.querySelector('.ch-title')?.textContent?.trim(), error: document.querySelector('.chapter-error')?.textContent?.trim()||'', retry: !![...document.querySelectorAll('button')].find(b=>b.textContent.includes('重试失败章')) }`)
  const shot19 = await shot('19-download-book-failed-chapter')
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('重试失败章'))?.click(); return 'ok';`)
  const dlWait = await waitFor(`document.querySelector('[data-reader-dl="progress"]')`, 12000, 150)
  let dlInfo = null
  if (dlWait) {
    dlInfo = await ev(`return { text: document.querySelector('[data-reader-dl="progress"]')?.textContent?.trim(), cancel: !!document.querySelector('[data-reader-dl="cancel"]'), toolbarHidden: document.querySelector('.reader-toolbar')?.classList.contains('reader-tools-hidden') };`)
    const shot20 = await shot('20-download-running')
    record('下载进行中常显进度与取消', dlInfo.text && dlInfo.cancel ? 'ok' : 'issue', `顶栏「${dlInfo.text}」，取消按钮=${dlInfo.cancel}，工具条是否收起=${dlInfo.toolbarHidden}`, { dlChapter, dlInfo, evidence: [shot19, shot20] })
    const cancelAt = Date.now()
    await ev(`document.querySelector('[data-reader-dl="cancel"]')?.click(); return 'ok';`)
    const gone = await waitFor(`!document.querySelector('[data-reader-dl="progress"]')`, 8000, 120)
    await sleep(600)
    const afterCancel = await ev(`return { toolbarHidden: document.querySelector('.reader-toolbar')?.classList.contains('reader-tools-hidden'), progress: !!document.querySelector('[data-reader-dl="progress"]') };`)
    const shot21 = await shot('21-download-cancelled')
    record('取消下载后进度条消失并回默认收起', gone && !afterCancel.progress ? 'ok' : 'issue', `${Date.now() - cancelAt}ms 内进度条消失；之后顶栏收起=${afterCancel.toolbarHidden}`, { gone, afterCancel, evidence: [shot21] })
  } else {
    const msg = await ev(`return [...document.querySelectorAll('.n-message__content')].map(x=>x.textContent).join('|')`)
    record('下载进行中的进度显示与取消', 'blocked', `点重试后 12s 内未出现下载进度 UI；提示「${msg}」`, { dlChapter, msg })
  }

  await writeFile(join(here, 'result.json'), JSON.stringify({ results, shots, appOutTail: appOut.slice(-3000) }, null, 2), 'utf-8')
} catch (error) {
  record('驱动异常', 'blocked', String(error && error.stack || error))
  await writeFile(join(here, 'result.json'), JSON.stringify({ results, shots, appOutTail: appOut.slice(-3000) }, null, 2), 'utf-8')
} finally {
  try { ws?.close() } catch { /* noop */ }
  killTree()
  server.close()
  await sleep(1500)
}

log(`\n结果：${results.filter((r) => r.status === 'ok').length} 正常 / ${results.filter((r) => r.status === 'issue').length} 问题 / ${results.filter((r) => r.status === 'blocked').length} 未能取证`)
log(`截图：${shots.join(',')}`)
