// 实证6：停在 f=75，逐秒快照 find/elementFromPoint/scrollTop/窗口/补偿，抓 find miss 瞬间。
// probe5 显示 f=75 在 120ms 轮询下能命中（find=1930 real=1930），
// 但 RUN3 主探针 f=75 5 秒 miss。差异可能在：主探针把 scrollTop 设为 f*maxTop 后，
// 迁窗补偿（el.scrollTop += ...）把 scrollTop 拉走，而主探针 while 循环每次重新读 maxTop（动态 scrollHeight）。
// 停在 f=75 不动，逐秒记录：scrollTop / scrollHeight / find 判定 / elementFromPoint / 窗口 bounds / 补偿是否在动。
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))))
const PORT = 48000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const lib = await mkdtemp(join(tmpdir(), 'spbf-raf6-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-raf6-user-'))
const bookId = 'd_raf6'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const largeBody = Array.from({ length: 2600 }, (_, i) => `第${i + 1}段：${'短句正文用于测量大章节首屏与翻页耗时。'.repeat(2).slice(0, 22)}`).join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: 'raf6测试书', author: 't', tags: [], sourceUrl: 'https://e.com/r/', sourceHost: 'e.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章（2600 段）', url: 'https://e.com/w/1.html', file: 'chapters/0001.json', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0, paragraphIndex: 0, paragraphOffset: 0, updatedAt: now },
}, null, 2), 'utf-8')
await writeFile(join(bookDir, 'chapters', '0001.json'), JSON.stringify({ title: '第一章（2600 段）', url: 'https://e.com/w/1.html', body: largeBody, status: 'ready' }), 'utf-8')
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: { dim: 0, fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll', hideSiteTail: true },
}, null, 2), 'utf-8')

const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv })
let out = ''
child.stdout.on('data', (c) => (out += String(c)))
child.stderr.on('data', (c) => (out += String(c)))
const killTree = () => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch { /* gone */ }
}
let ws
try {
  let target
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'))
      if (target) break
    } catch { /* not up */ }
    await sleep(300)
  }
  if (!target) throw new Error('no target: ' + out.slice(-1000))
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (!m.id) return
    const w = pending.get(m.id)
    if (!w) return
    pending.delete(m.id)
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result)
  }
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++
    pending.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (bodyText) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${bodyText} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result?.value
  }
  const waitFor = async (expr, timeout = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (await ev(`return (${expr});`)) return true
      await sleep(150)
    }
    return false
  }
  const click = (expr) => ev(`const el = ${expr}; if (!el) return 'none'; el.scrollIntoView(); el.click(); return 'ok';`)

  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitFor(`document.querySelector('.book-open-area')`, 12000)
  await click(`document.querySelector('.book-open-area')`)
  await waitFor(`document.querySelector('.reader-content')`, 15000)
  await waitFor(`(document.querySelector('.ch-title')?.textContent || '').includes('2600')`, 8000)

  await ev(`const pane = document.querySelector('.reader-content'); pane.scrollTop = 0.85 * (pane.scrollHeight - pane.clientHeight); return pane.scrollTop;`)
  await waitFor(`(() => { const ps=[...document.querySelectorAll('.para[data-p]')].map(n=>+n.dataset.p); return Math.max(...ps) >= 2000; })()`, 6000)
  await ev(`const pane = document.querySelector('.reader-content'); pane.scrollTop = 0.5 * (pane.scrollHeight - pane.clientHeight); return pane.scrollTop;`)
  await waitFor(`(() => { const ps=[...document.querySelectorAll('.para[data-p]')].map(n=>+n.dataset.p); return Math.min(...ps) <= 1300 && Math.max(...ps) >= 1300; })()`, 6000)

  // 停在 f=75：设一次 scrollTop，然后 8 秒逐秒快照，完全不动（模拟主探针但更快）
  const f = 0.75
  const base = await ev(`
    const pane = document.querySelector('.reader-content');
    pane.scrollTop = ${f} * (pane.scrollHeight - pane.clientHeight);
    return { set: Math.round(pane.scrollTop) };
  `)
  const snaps = []
  for (let i = 0; i < 12; i += 1) {
    await sleep(500)
    const s = await ev(`
      const pane = document.querySelector('.reader-content');
      const paneRect = pane.getBoundingClientRect();
      const cx = paneRect.left + pane.clientWidth / 2;
      const cy = paneRect.top + pane.clientHeight / 2;
      const e = document.elementFromPoint(cx, cy);
      const realP = e && e.classList && e.classList.contains('para') && e.dataset && e.dataset.p != null ? Number(e.dataset.p) : -1;
      const ps = [...pane.querySelectorAll('.para[data-p]')].map((n) => ({ p: Number(n.dataset.p), top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom }));
      const h = ps.find((s) => s.top <= cy && s.bottom >= cy);
      const ps2 = [...pane.querySelectorAll('.para[data-p]')].map((n) => +n.dataset.p);
      return {
        t: (${i + 1}) * 0.5,
        scrollTop: Math.round(pane.scrollTop), scrollHeight: Math.round(pane.scrollHeight),
        findHit: h ? h.p : -1, realHit: realP,
        elemAt: e ? e.tagName + '.' + String(e.className).slice(0, 30) : 'null',
        minP: ps2.length ? Math.min(...ps2) : -1, maxP: ps2.length ? Math.max(...ps2) : -1,
        firstTop: ps.length ? Math.round(ps[0].top) : null, lastBottom: ps.length ? Math.round(ps[ps.length - 1].bottom) : null,
        gapTop: pane.querySelector('.reader-gap.top')?.offsetHeight || 0,
        gapBot: pane.querySelector('.reader-gap:not(.top)')?.offsetHeight || 0,
      };
    `)
    snaps.push(s)
    console.log(JSON.stringify(s))
  }
  console.log('BASE', JSON.stringify(base))
} catch (e) {
  console.log('ERR', String((e && e.stack) || e))
} finally {
  try { ws?.close() } catch {}
  killTree()
  await sleep(500)
  await rm(lib, { recursive: true, force: true }).catch(() => {})
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}