// 实证12：复刻 probe7 扫掠（!h 判定），miss 时全套决胜诊断。
// probe10 抓不到 miss 是因为它的触发条件是 h && realP<0（rect 命中但 elementFromPoint 空白），
// 而 probe7 的 miss 是 !h（rect 都不覆盖视口中心）——两种状态，需要分别诊断。
// 诊断项：
//   1) dump 全部 .para[data-p] 的 {p, top, bottom, height}（DOM 序）——窗口是否覆盖 cy
//   2) checkVisibility({contentVisibilityAuto:true})——布局跳过段数
//   3) getClientRects().length——未布局段
//   4) 强制布局（读 pane.offsetHeight）后重测 !h 是否自愈
//   5) scrollTop 采样——排除补偿震荡
// 用法：npm run build 之后 `node .multi-agent/evidence/large-chapter-window-2026-11-02/raf-probe12.mjs`
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))))
const PORT = 50000 + Math.floor(Math.random() * 4000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const lib = await mkdtemp(join(tmpdir(), 'spbf-raf12-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-raf12-user-'))
const bookId = 'd_raf12'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const largeBody = Array.from({ length: 2600 }, (_, i) => `第${i + 1}段：${'短句正文用于测量大章节首屏与翻页耗时。'.repeat(2).slice(0, 22)}`).join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: 'raf12测试书', author: 't', tags: [], sourceUrl: 'https://e.com/r/', sourceHost: 'e.com',
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

  const result = await ev(`
    const pane = document.querySelector('.reader-content');
    const paneRect0 = pane.getBoundingClientRect();
    const cx = paneRect0.left + pane.clientWidth / 2;
    let miss = null;
    for (let run = 0; run < 12 && !miss; run += 1) {
      for (let f = 0.5; f <= 0.751 && !miss; f += 0.05) {
        const maxTop = pane.scrollHeight - pane.clientHeight;
        pane.scrollTop = f * maxTop;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !miss) {
          await new Promise((r) => setTimeout(r, 120));
          const cy = pane.getBoundingClientRect().top + pane.clientHeight / 2;
          const ps = [...pane.querySelectorAll('.para[data-p]')].map((n) => ({ p: Number(n.dataset.p), top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom }));
          const h = ps.find((s) => s.top <= cy && s.bottom >= cy);
          if (!h && ps.length) {
            // ============ 决胜诊断 ============
            const nodes = [...pane.querySelectorAll('.para[data-p]')];
            // 1) 每段 rect 明细 + content-visibility 状态 + getClientRects
            const detail = nodes.map((n) => {
              const r = n.getBoundingClientRect();
              let cv = false;
              try { cv = n.checkVisibility({ contentVisibilityAuto: true }) === false; } catch {}
              return { p: +n.dataset.p, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), cv, rects: n.getClientRects().length };
            });
            let skipped = 0;
            const skipSamples = [];
            for (const n of nodes) {
              let cv = false;
              try { cv = n.checkVisibility({ contentVisibilityAuto: true }) === false; } catch {}
              if (cv) { skipped += 1; if (skipSamples.length < 8) skipSamples.push(+n.dataset.p); }
            }
            const zeroRects = nodes.filter((n) => n.getClientRects().length === 0).map((n) => +n.dataset.p);
            const paneRect = pane.getBoundingClientRect();
            const gapTopEl = pane.querySelector('.reader-gap.top');
            const gapBotEl = pane.querySelector('.reader-gap:not(.top)');
            const before = {
              scrollTop: Math.round(pane.scrollTop), scrollHeight: Math.round(pane.scrollHeight),
              clientH: Math.round(pane.clientHeight), cy: Math.round(cy),
              minP: Math.min(...ps.map((s) => s.p)), maxP: Math.max(...ps.map((s) => s.p)),
              firstTop: Math.round(ps[0].top), lastBottom: Math.round(ps[ps.length - 1].bottom),
              gapTopH: gapTopEl ? Math.round(gapTopEl.getBoundingClientRect().height) : null,
              gapBotH: gapBotEl ? Math.round(gapBotEl.getBoundingClientRect().height) : null,
              elemAtCenter: (() => { const e = document.elementFromPoint(cx, cy); return e ? e.tagName + '.' + String(e.className).slice(0, 40) : 'null'; })(),
            };
            // 2) 强制布局后重测
            void pane.offsetHeight;
            await new Promise((r) => setTimeout(r, 30));
            const cy2 = pane.getBoundingClientRect().top + pane.clientHeight / 2;
            const psAfter = [...pane.querySelectorAll('.para[data-p]')].map((n) => ({ p: Number(n.dataset.p), top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom }));
            const hAfter = psAfter.find((s) => s.top <= cy2 && s.bottom >= cy2);
            // 3) scrollTop 采样
            const samples = [];
            const t0 = Date.now();
            while (Date.now() - t0 < 220) {
              await new Promise((r) => setTimeout(r, 20));
              samples.push(Math.round(pane.scrollTop));
            }
            miss = {
              run: run + 1, f: Math.round(f * 100),
              before, detail,
              skipped, skipSamples, zeroRectsCount: zeroRects.length, zeroRectsSamples: zeroRects.slice(0, 8),
              hAfter: hAfter ? hAfter.p : -1, realPAfterForce: (() => { const e = document.elementFromPoint(cx, cy2); return e && e.classList && e.classList.contains('para') && e.dataset && e.dataset.p != null ? Number(e.dataset.p) : -1; })(),
              scrollTopSamples: samples,
            };
          }
          if (h) break;
        }
      }
    }
    return miss;
  `)
  if (result) console.log(JSON.stringify(result, null, 2))
  else console.log('12 轮扫掠全部命中，未捕获 miss（!h）')
} catch (e) {
  console.log('ERR', String((e && e.stack) || e))
} finally {
  try { ws?.close() } catch {}
  killTree()
  await sleep(500)
  await rm(lib, { recursive: true, force: true }).catch(() => {})
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}
