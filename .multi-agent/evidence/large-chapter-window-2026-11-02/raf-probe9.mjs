// 实证9：复刻实证7 扫掠（120ms 轮询），miss 时 200ms 内每 20ms 采样 scrollTop/窗口，
// 判定「补偿-触发-再补偿」震荡 vs 单一稳定状态。若震荡则 scrollTop 会在窗口上下跳动。
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))))
const PORT = 56000 + Math.floor(Math.random() * 4000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const lib = await mkdtemp(join(tmpdir(), 'spbf-raf9-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-raf9-user-'))
const bookId = 'd_raf9'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const largeBody = Array.from({ length: 2600 }, (_, i) => `第${i + 1}段：${'短句正文用于测量大章节首屏与翻页耗时。'.repeat(2).slice(0, 22)}`).join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: 'raf9测试书', author: 't', tags: [], sourceUrl: 'https://e.com/r/', sourceHost: 'e.com',
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

  const captured = await ev(`
    const pane = document.querySelector('.reader-content');
    const paneRect0 = pane.getBoundingClientRect();
    const cx = paneRect0.left + pane.clientWidth / 2;
    const out = [];
    for (let run = 0; run < 5; run += 1) {
      let found = null;
      for (let f = 0.5; f <= 0.751; f += 0.05) {
        const maxTop = pane.scrollHeight - pane.clientHeight;
        pane.scrollTop = f * maxTop;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 120));
          const cy = pane.getBoundingClientRect().top + pane.clientHeight / 2;
          const e = document.elementFromPoint(cx, cy);
          const realP = e && e.classList && e.classList.contains('para') && e.dataset && e.dataset.p != null ? Number(e.dataset.p) : -1;
          const ps = [...pane.querySelectorAll('.para[data-p]')].map((n) => ({ p: Number(n.dataset.p), top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom }));
          const h = ps.find((s) => s.top <= cy && s.bottom >= cy);
          if (h && realP < 0 && !found) {
            // 决定性：200ms 内每 20ms 采样 scrollTop 与窗口
            const samples = [];
            const t0 = Date.now();
            while (Date.now() - t0 < 260) {
              const s = await new Promise((r) => setTimeout(() => r({
                dt: Date.now() - t0,
                st: Math.round(pane.scrollTop), sh: Math.round(pane.scrollHeight),
                minP: [...pane.querySelectorAll('.para[data-p]')].map((n) => +n.dataset.p).sort((a, b) => a - b)[0] ?? -1,
                maxP: [...pane.querySelectorAll('.para[data-p]')].map((n) => +n.dataset.p).sort((a, b) => a - b).at(-1) ?? -1,
              }), 20));
              samples.push(s);
            }
            const e2 = document.elementFromPoint(cx, pane.getBoundingClientRect().top + pane.clientHeight / 2);
            found = {
              run, f: Math.round(f * 100),
              scrollTopAtMiss: Math.round(pane.scrollTop),
              samples,
              finalElem: e2 ? e2.tagName + '.' + String(e2.className).slice(0, 30) : 'null',
            };
            break;
          }
          if (realP >= 0) break;
        }
      }
      out.push(found);
    }
    return out;
  `)
  for (const c of captured) {
    if (!c) { console.log('null (本 run 未捕获 miss)'); continue }
    console.log(`run=${c.run} f=${c.f} missScrollTop=${c.scrollTopAtMiss} finalElem=${c.finalElem}`)
    console.log('   samples:', c.samples.map((s) => `t=${s.dt} st=${s.st} sh=${s.sh} [${s.minP},${s.maxP}]`).join(' | '))
  }
} catch (e) {
  console.log('ERR', String((e && e.stack) || e))
} finally {
  try { ws?.close() } catch {}
  killTree()
  await sleep(500)
  await rm(lib, { recursive: true, force: true }).catch(() => {})
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}