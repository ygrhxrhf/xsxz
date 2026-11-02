// 实证2：复刻扫掠中段卡住，hook rAF / scroll 事件，逐步定位窗口为何不迁。
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))))
const PORT = 42000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const lib = await mkdtemp(join(tmpdir(), 'spbf-raf2-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-raf2-user-'))
const bookId = 'd_raf2'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const largeBody = Array.from({ length: 2600 }, (_, i) => `第${i + 1}段：${'短句正文用于测量大章节首屏与翻页耗时。'.repeat(2).slice(0, 22)}`).join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: 'raf2测试书', author: 't', tags: [], sourceUrl: 'https://e.com/r/', sourceHost: 'e.com',
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

  // 挂上 rAF / scroll / 异常计数器
  await ev(`
    window.__stats = { raf: 0, scroll: 0, err: 0 };
    window.__origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => window.__origRaf((ts) => { window.__stats.raf += 1; try { cb(ts); } catch (e) { window.__stats.err += 1; window.__lastErr = String(e && e.stack || e); } });
    const pane = document.querySelector('.reader-content');
    pane.addEventListener('scroll', () => { window.__stats.scroll += 1; }, { passive: true });
    window.addEventListener('error', (e) => { window.__stats.err += 1; window.__lastErr = String(e.error && e.error.stack || e.message); });
    window.addEventListener('unhandledrejection', (e) => { window.__stats.err += 1; window.__lastErr = String(e.reason && e.reason.stack || e.reason); });
    return 'hooked';
  `)

  // 逐点扫掠，复刻主探针
  const sweep = await ev(`
    const pane = document.querySelector('.reader-content');
    const maxTop0 = pane.scrollHeight - pane.clientHeight;
    const results = [];
    for (let f = 0.5; f <= 0.751; f += 0.05) {
      const before = { ...window.__stats };
      pane.scrollTop = f * maxTop0;
      const deadline = Date.now() + 3000;
      let hit = -1;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 120));
        const ps = [...pane.querySelectorAll('.para[data-p]')].map((n) => ({ p: +n.dataset.p, top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom }));
        const cy = pane.getBoundingClientRect().top + pane.clientHeight / 2;
        const h = ps.find((s) => s.top <= cy && s.bottom >= cy);
        if (h) { hit = h.p; break; }
      }
      const ps2 = [...pane.querySelectorAll('.para[data-p]')].map((n) => +n.dataset.p);
      results.push({
        f: Math.round(f * 100),
        hit,
        raf: window.__stats.raf - before.raf,
        scroll: window.__stats.scroll - before.scroll,
        err: window.__stats.err - before.err,
        minP: ps2.length ? Math.min(...ps2) : -1,
        maxP: ps2.length ? Math.max(...ps2) : -1,
        scrollTop: Math.round(pane.scrollTop),
        scrollHeight: Math.round(pane.scrollHeight),
      });
      if (window.__stats.err - before.err > 0) results[results.length - 1].lastErr = window.__lastErr;
    }
    return results;
  `)
  console.log(JSON.stringify(sweep, null, 2))
} catch (e) {
  console.log('ERR', String((e && e.stack) || e))
} finally {
  try { ws?.close() } catch {}
  killTree()
  await sleep(500)
  await rm(lib, { recursive: true, force: true }).catch(() => {})
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}
