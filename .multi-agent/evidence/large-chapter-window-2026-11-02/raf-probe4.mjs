// 实证4：扫掠时「视口中心像素上到底有什么」。
// 动机：RUN3 复现 hit=-1 时，diag 的段落 rect（firstTop=-7569..lastBottom=8795）明明覆盖 cy=369，
// 但循环内 find 5 秒 miss。怀疑 `.large-chapter .para { content-visibility: auto }` 让视口外段落布局被跳过，
// getBoundingClientRect 返回的是 contain-intrinsic-size 的估算占位 rect（非真实布局）。
// 决定性判据：elementFromPoint(视口中心) 命中的元素 —— 真实渲染的 .para[data-p]？还是占位间隙/空白？
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))))
const PORT = 46000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const lib = await mkdtemp(join(tmpdir(), 'spbf-raf4-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-raf4-user-'))
const bookId = 'd_raf4'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const largeBody = Array.from({ length: 2600 }, (_, i) => `第${i + 1}段：${'短句正文用于测量大章节首屏与翻页耗时。'.repeat(2).slice(0, 22)}`).join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: 'raf4测试书', author: 't', tags: [], sourceUrl: 'https://e.com/r/', sourceHost: 'e.com',
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

  // 85% 跳
  await ev(`const pane = document.querySelector('.reader-content'); pane.scrollTop = 0.85 * (pane.scrollHeight - pane.clientHeight); return pane.scrollTop;`)
  await waitFor(`(() => { const ps=[...document.querySelectorAll('.para[data-p]')].map(n=>+n.dataset.p); return Math.max(...ps) >= 2000; })()`, 6000)
  // 50% 跳
  await ev(`const pane = document.querySelector('.reader-content'); pane.scrollTop = 0.5 * (pane.scrollHeight - pane.clientHeight); return pane.scrollTop;`)
  await waitFor(`(() => { const ps=[...document.querySelectorAll('.para[data-p]')].map(n=>+n.dataset.p); return Math.min(...ps) <= 1300 && Math.max(...ps) >= 1300; })()`, 6000)

  const sweep = await ev(`
    const pane = document.querySelector('.reader-content');
    const paneRect0 = pane.getBoundingClientRect();
    const cx = paneRect0.left + pane.clientWidth / 2;
    const results = [];
    for (let f = 0.5; f <= 0.751; f += 0.05) {
      const maxTop = pane.scrollHeight - pane.clientHeight;
      const setTop = f * maxTop;
      pane.scrollTop = setTop;
      const deadline = Date.now() + 5000;
      let findHit = -1;        // 估算 rect 判定（原探针逻辑）
      let realHit = -1;        // elementFromPoint 判定（真实渲染）
      let realElem = '';
      const probes = [];
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 120));
        const cy = pane.getBoundingClientRect().top + pane.clientHeight / 2;
        const e = document.elementFromPoint(cx, cy);
        const realP = e && e.classList && e.classList.contains('para') && e.dataset && e.dataset.p != null ? Number(e.dataset.p) : -1;
        const ps = [...pane.querySelectorAll('.para[data-p]')].map((n) => ({ p: Number(n.dataset.p), top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom }));
        const h = ps.find((s) => s.top <= cy && s.bottom >= cy);
        if (h && findHit < 0) findHit = h.p;
        if (realP >= 0 && realHit < 0) realHit = realP;
        if (realElem.length < 200) {
          realElem += JSON.stringify({
            t: Math.round((Date.now() - deadline + 5000) / 120), f: Math.round(f * 100),
            elem: e ? e.tagName + '.' + (e.className || '').toString().slice(0, 40) : 'null',
            p: realP,
            findHitNow: h ? h.p : -1,
            scrollTop: Math.round(pane.scrollTop), scrollHeight: Math.round(pane.scrollHeight),
          }) + '\\n';
        }
        if (h && realP >= 0) break;
        if (!h && realP >= 0) break;  // find miss 但 elementFromPoint 命中 —— 决定性分歧点
      }
      // 结束后采样：估算段区高 vs 真实渲染段区高
      const ps2 = [...pane.querySelectorAll('.para[data-p]')].map((n) => ({ p: Number(n.dataset.p), r: n.getBoundingClientRect() }));
      const cy2 = pane.getBoundingClientRect().top + pane.clientHeight / 2;
      const gapTop = pane.querySelector('.reader-gap.top');
      const gapBot = pane.querySelector('.reader-gap:not(.top)');
      results.push({
        f: Math.round(f * 100), setTop: Math.round(setTop), findHit, realHit,
        scrollTop: Math.round(pane.scrollTop), scrollHeight: Math.round(pane.scrollHeight),
        maxP: ps2.length ? Math.max(...ps2.map((s) => s.p)) : -1, minP: ps2.length ? Math.min(...ps2.map((s) => s.p)) : -1,
        spanHeight: ps2.length ? Math.round(ps2[ps2.length - 1].r.bottom - ps2[0].r.top) : 0,
        avgSpan: ps2.length ? Math.round((ps2[ps2.length - 1].r.bottom - ps2[0].r.top) / ps2.length) : 0,
        topGap: gapTop ? gapTop.offsetHeight : 0, botGap: gapBot ? gapBot.offsetHeight : 0,
        cy: Math.round(cy2),
        firstTop: ps2.length ? Math.round(ps2[0].r.top) : null, lastBottom: ps2.length ? Math.round(ps2[ps2.length - 1].r.bottom) : null,
        probes: realElem,
      });
    }
    return results;
  `)
  for (const r of sweep) {
    const status = r.findHit >= 0 ? 'findOK' : 'findMISS'
    const status2 = r.realHit >= 0 ? 'realOK' : 'realMISS'
    console.log(`f=${r.f} ${status}/${status2} setTop=${r.setTop} -> scrollTop=${r.scrollTop} scrollH=${r.scrollHeight} window=[${r.minP},${r.maxP}] avgSpan=${r.avgSpan}px topGap=${r.topGap} botGap=${r.botGap} cy=${r.cy} firstTop=${r.firstTop} lastBottom=${r.lastBottom}`)
    if (r.findHit < 0 || r.realHit < 0) console.log(r.probes)
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
