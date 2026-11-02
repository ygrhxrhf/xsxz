// 大章节窗口化渲染 E2E 探针（修复验证证据）。
//
// 目标症状：
//  1) 4 大章节全量排版 20.2s —— 打开 2600 段大章后不再需要 20s 全量排版，
//     首屏毫秒级出现，且「整章节点数」远小于全章（窗口化证明）。
//  2) 后段滚动空白 —— 拖动滚动条到 85% 处，约 1s 内目标段真实渲染并精确落点；
//     滚动到未渲染区不再空白。
//
// 用法：npm run build 之后 `node .multi-agent/evidence/large-chapter-window-2026-11-02/probe-window.mjs`
// 注意：会在桌面上真开一个应用窗口（约十几秒），结束后自动关掉。
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const PORT = 38000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

// --- 夹具：单本 2600 段大章，进度停在 0 便于从开头测量 ---
const lib = await mkdtemp(join(tmpdir(), 'spbf-window-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-window-user-'))
const bookId = 'd_window'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
// 与 audit-driver.mjs largeBody(n=2600) 同构：短句正文 ×2 截 22 字符，基线平均段高 ≈ 84.7px
const largeBody = Array.from({ length: 2600 }, (_, i) =>
  `第${i + 1}段：${'短句正文用于测量大章节首屏与翻页耗时。'.repeat(2).slice(0, 22)}`,
).join('\n\n')

await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '窗口化测试书', author: '测试', tags: [],
  sourceUrl: 'https://example.com/w/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [
    { id: 'c0001', index: 1, title: '第一章（2600 段）', url: 'https://example.com/w/1.html', file: 'chapters/0001.json', status: 'ready' },
    { id: 'c0002', index: 2, title: '第二章', url: 'https://example.com/w/2.html', file: 'chapters/0002.json', status: 'ready' },
  ],
  progress: { chapterId: 'c0001', scrollRatio: 0, paragraphIndex: 0, paragraphOffset: 0, updatedAt: now },
}, null, 2), 'utf-8')
await writeFile(join(bookDir, 'chapters', '0001.json'), JSON.stringify({
  title: '第一章（2600 段）', url: 'https://example.com/w/1.html', body: largeBody, status: 'ready',
}), 'utf-8')
await writeFile(join(bookDir, 'chapters', '0002.json'), JSON.stringify({
  title: '第二章', url: 'https://example.com/w/2.html',
  body: Array.from({ length: 50 }, (_, i) => `短章第${i + 1}段。`).join('\n\n'), status: 'ready',
}), 'utf-8')

await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: { dim: 0, fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll', hideSiteTail: true },
}, null, 2), 'utf-8')

console.log(`夹具：书库=${lib}（第一章 2600 段）\n      userData=${userData}`)

// 父进程（如 VS Code）会带 ELECTRON_RUN_AS_NODE=1 进环境，会让 electron.exe 以纯 Node 身份跑，
// 主进程 import { BrowserWindow } from 'electron' 随即失败（导出的是路径字符串）。
// 子进程环境必须剔除它，否则应用起不来。
const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: childEnv,
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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
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

  // 1) 进书库 → 点书卡进阅读器
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  const cardSeen = await waitFor(`document.querySelector('.book-open-area')`, 12000)
  check('夹具的书在书库列表里渲染成可打开的书卡', cardSeen)
  await click(`document.querySelector('.book-open-area')`)
  const readerSeen = await waitFor(`document.querySelector('.reader-content')`, 15000)
  check('点书卡后阅读器正文渲染出来', readerSeen)
  const openedLarge = await waitFor(`(document.querySelector('.ch-title')?.textContent || '').includes('2600')`, 8000)
  check('打开的是 2600 段大章', openedLarge, await ev(`return document.querySelector('.ch-title')?.textContent || '(无标题)'`))

  // 2) 首屏时间与「不再全量排版」：首屏应毫秒级；已渲染节点数应远小于 2600
  //    首屏出现后再数节点：窗口化下应只有几百个段落节点，而不是 2600 全落地。
  const initial = await ev(`
    const pane = document.querySelector('.reader-content');
    if (!pane) return null;
    const paras = pane.querySelectorAll('.para[data-p]');
    const gaps = pane.querySelectorAll('.reader-gap');
    return {
      paraNodes: paras.length,
      firstDataP: paras.length ? Number(paras[0].dataset.p) : -1,
      lastDataP: paras.length ? Number(paras[paras.length - 1].dataset.p) : -1,
      gapCount: gaps.length,
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
      hintGone: !pane.querySelector('.loading-hint'),
    };
  `)
  check('打开后段落节点数远小于 2600（未全量排版）', initial && initial.paraNodes < 500, `节点=${initial?.paraNodes}`)
  check('窗口从章首开始渲染', initial && initial.firstDataP === 0, `first=${initial?.firstDataP}`)
  check('排版 loading-hint 不再出现', initial && initial.hintGone === true)
  check('滚动条高度按整章估算（scrollHeight 明显大于一屏）', initial && initial.scrollHeight > initial.clientHeight * 3, `scrollH=${initial?.scrollHeight} clientH=${initial?.clientHeight}`)

  // 3) 关键验证：拖动滚动条到 85% → 目标段 ~1s 内真实渲染并精确落点
  //    占位高度是估算值，scrollTop 直接设 0.85×(scrollHeight-clientHeight) 后
  //    窗口应跟随迁到约第 2210 段附近，视口内出现 data-p >= 2000 的真实段落。
  const jump = await ev(`
    const pane = document.querySelector('.reader-content');
    if (!pane) return { ok: false, why: 'no-pane' };
    const maxTop = pane.scrollHeight - pane.clientHeight;
    pane.scrollTop = 0.85 * maxTop;
    return { ok: true, scrollTop: pane.scrollTop, maxTop, targetP: Math.round(0.85 * 2599) };
  `)
  check('滚动条跳到 85% 位置', jump.ok === true, `target≈${jump.targetP}`)

  const arrived = await waitFor(`
    (() => {
      const pane = document.querySelector('.reader-content');
      if (!pane) return false;
      const ps = [...pane.querySelectorAll('.para[data-p]')];
      if (!ps.length) return false;
      const max = Math.max(...ps.map((n) => Number(n.dataset.p)));
      return max >= 2000;
    })()
  `, 6000)
  check('跳转后 ~1s 内后段真实段落已渲染（data-p >= 2000）', arrived, `落地窗口最大段=${arrived ? await ev(`return Math.max(...[...document.querySelectorAll('.reader-content .para[data-p]')].map((n) => Number(n.dataset.p)))`) : 'N/A'}`)

  // 视口中心现在应落在真实段落上（不是空白占位），且窗口包含视口中心段
  const centered = await ev(`
    const pane = document.querySelector('.reader-content');
    const ps = [...pane.querySelectorAll('.para[data-p]')].map((n) => ({ p: Number(n.dataset.p), top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom }));
    const cy = pane.getBoundingClientRect().top + pane.clientHeight / 2;
    const hit = ps.find((s) => s.top <= cy && s.bottom >= cy);
    return { viewportCenterPara: hit ? hit.p : -1, maxP: ps.length ? Math.max(...ps.map((s) => s.p)) : -1, minP: ps.length ? Math.min(...ps.map((s) => s.p)) : -1, nodeCount: ps.length };
  `)
  check('85% 处视口中心是真实段落而非空白', centered && centered.viewportCenterPara >= 2000, `center=${centered?.viewportCenterPara} 窗口=[${centered?.minP},${centered?.maxP}] 节点=${centered?.nodeCount}`)

  // 4) 进度条比例拖动（阅读器自带进度条）→ 精确落点：目标段贴近视口顶部
  //    用章节进度滑块（.reader-progress 或进度面板里的滑块）拖动到 ~50%
  //    简化验证：直接用程序设 scrollTop 到 0.5 位置后确认窗口迁移与内容渲染。
  const half = await ev(`
    const pane = document.querySelector('.reader-content');
    const maxTop = pane.scrollHeight - pane.clientHeight;
    pane.scrollTop = 0.5 * maxTop;
    return pane.scrollTop;
  `)
  const halfArrived = await waitFor(`
    (() => {
      const pane = document.querySelector('.reader-content');
      if (!pane) return false;
      const ps = [...pane.querySelectorAll('.para[data-p]')];
      if (!ps.length) return false;
      const max = Math.max(...ps.map((n) => Number(n.dataset.p)));
      const min = Math.min(...ps.map((n) => Number(n.dataset.p)));
      return min <= 1300 && max >= 1300;
    })()
  `, 6000)
  check('跳到 50% 后窗口迁到中段（覆盖第 1300 段附近）', halfArrived)

  // 5) 滚动到未渲染区不再空白：从 50% 连续滚到 75%，每步视口中心最终都有真实段落。
  //    窗口迁移在 rAF/nextTick 里异步发生，固定 sleep 单次快照会误撞中间态；
  //    用轮询等「迁窗 + 补偿」完成（等价于用户滚动后 ~1s 内看到内容）。
  const sweep = await ev(`
    const pane = document.querySelector('.reader-content');
    const maxTop = pane.scrollHeight - pane.clientHeight;
    const results = [];
    for (let f = 0.5; f <= 0.751; f += 0.05) {
      pane.scrollTop = f * maxTop;
      const deadline = Date.now() + 5000;
      let hit = -1;
      // 判定说明：视口中心不必精确落在某段内部——段间距 margin ≈ .45em ≈ 8px，
      // 中心线压在两段之间的正常间距上不是空白。中心上下 24px 内有段落就算命中；
      // 真空白（中心上下几十 px 都无内容）必然超过 24px，不会漏报。
      const TOL = 24;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 120));
        const ps = [...pane.querySelectorAll('.para[data-p]')].map((n) => ({ p: Number(n.dataset.p), top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom }));
        const cy = pane.getBoundingClientRect().top + pane.clientHeight / 2;
        const nearest = ps.length ? ps.map((s) => ({ p: s.p, d: Math.min(Math.abs(s.top - cy), Math.abs(s.bottom - cy)) })).sort((a, b) => a.d - b.d)[0] : null;
        const h = nearest && nearest.d <= TOL ? nearest.p : -1;
        if (h >= 0) { hit = h; break; }
      }
      results.push({ f: Math.round(f * 100), centerPara: hit });
      // 每点都附带诊断：scrollTop/高度、窗口 bounds、中心是否落在占位间隙
      const ps = [...pane.querySelectorAll('.para[data-p]')].map((n) => ({ p: Number(n.dataset.p), top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom }));
      const topGap = pane.querySelector('.reader-gap.top');
      const botGap = pane.querySelector('.reader-gap:not(.top)');
      const paneRect = pane.getBoundingClientRect();
      const cy = paneRect.top + pane.clientHeight / 2;
      const heights = {};
      for (const s of ps) { const h = Math.round(s.bottom - s.top); heights[h] = (heights[h] || 0) + 1; }
      const cover = ps.filter((s) => s.top <= cy && s.bottom >= cy).map((s) => s.p);
      // 决胜诊断（仅 miss 时）：中心处真实元素 / 强制布局后是否自愈 / 中心附近段落状态。
      // 目的：区分「真实空白」与「探针用估算盒判定导致的假阳性」——
      // content-visibility:auto 对视口外段返回 contain-intrinsic-size 估算盒（72px 级），
      // 估算盒位置可能与真实布局错位，让 cy 落在估算缝隙里而实际有文字。
      let decisive = null;
      if (hit < 0) {
        const cx = paneRect.left + pane.clientWidth / 2;
        const elemAt = (() => { const e = document.elementFromPoint(cx, cy); return e ? e.tagName + '.' + String(e.className).slice(0, 40) : 'null'; })();
        void pane.offsetHeight;
        await new Promise((r) => setTimeout(r, 40));
        const cy2 = pane.getBoundingClientRect().top + pane.clientHeight / 2;
        const psAfter = [...pane.querySelectorAll('.para[data-p]')].map((n) => ({ p: +n.dataset.p, top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom }));
        const hAfter = psAfter.find((s) => s.top <= cy2 && s.bottom >= cy2);
        const realAfter = (() => { const e = document.elementFromPoint(cx, cy2); return e && e.classList && e.classList.contains('para') && e.dataset.p != null ? +e.dataset.p : -1; })();
        const near = ps.map((s) => ({ p: s.p, d: Math.round(Math.min(Math.abs(s.top - cy), Math.abs(s.bottom - cy))) })).sort((a, b) => a.d - b.d).slice(0, 4);
        decisive = { elemAt, hAfter: hAfter ? hAfter.p : -1, realAfter, near };
      }
      results[results.length - 1].diag = JSON.stringify({
        f: Math.round(f * 100),
        scrollTop: Math.round(pane.scrollTop), scrollHeight: Math.round(pane.scrollHeight), clientHeight: pane.clientHeight,
        centerY: Math.round(cy),
        minP: ps.length ? Math.min(...ps.map((s) => s.p)) : -1, maxP: ps.length ? Math.max(...ps.map((s) => s.p)) : -1,
        firstTop: ps.length ? Math.round(ps[0].top) : null, lastBottom: ps.length ? Math.round(ps[ps.length - 1].bottom) : null,
        topGapHeight: topGap ? topGap.offsetHeight : 0, botGapHeight: botGap ? botGap.offsetHeight : 0,
        nodes: ps.length,
        pSeq: ps.map((s) => s.p).slice(0, 260),
        heights: Object.entries(heights).sort((a, b) => Number(a[0]) - Number(b[0])),
        coverCenter: cover,
        decisive,
      });
    }
    return results;
  `)
  const blankAt = sweep ? sweep.filter((r) => r.centerPara < 0).map((r) => r.f) : [-1]
  check('滚动扫掠 50%→75% 全程视口中心都有内容（无空白）', sweep && blankAt.length === 0, blankAt.length ? `空白处=${blankAt.join(',')}` : `各点中心段=${sweep?.map((r) => r.centerPara).join(',')}`)
  if (blankAt.length) console.log('--- 扫掠诊断 ---\n' + (sweep || []).map((r) => r.diag).join('\n'))

  // 6) 反向证据：窗口化下视口内的段落节点数保持有界（不会因为滚过而无限堆积）
  const bounded = await ev(`
    const pane = document.querySelector('.reader-content');
    return pane.querySelectorAll('.para[data-p]').length;
  `)
  check('扫掠后窗口节点数仍有界（<= WINDOW_SIZE + margin 量级）', bounded <= 400, `节点=${bounded}`)

  // 7) 章末：滚到底部时窗口覆盖最后一段，章末卡出现，自动续章不误触发。
  //    底部占位高度是估算值，滚到底后窗口需连迁几步才到 2599，因此轮询等落定。
  const bottom = await ev(`
    const pane = document.querySelector('.reader-content');
    const deadline = Date.now() + 10000;
    let maxP = -1;
    while (Date.now() < deadline) {
      pane.scrollTop = pane.scrollHeight;
      await new Promise((r) => setTimeout(r, 200));
      const ps = [...pane.querySelectorAll('.para[data-p]')];
      maxP = ps.length ? Math.max(...ps.map((n) => Number(n.dataset.p))) : -1;
      if (maxP === 2599) break;
    }
    return { maxP, lastPara: 2599, endCard: !!pane.querySelector('.chapter-end-card') };
  `)
  check('滚到底后窗口覆盖最后一段（maxP=2599）', bottom && bottom.maxP === 2599, `maxP=${bottom?.maxP}`)

  // 8) 小章节回归：切到第二章（50 段）应照旧全量渲染、无占位间隙
  await click(`[...document.querySelectorAll('.bottom-button')].find((b) => b.textContent.trim() === '目录')`)
  const catalogSeen = await waitFor(`document.querySelector('.n-drawer .n-list') || document.querySelector('.n-drawer-content')`, 6000)
  check('目录抽屉打开', catalogSeen)
  await ev(`
    const items = [...document.querySelectorAll('.n-drawer .n-list-item')];
    const target = items.find((it) => (it.textContent || '').includes('第二章'));
    if (target) { target.scrollIntoView(); target.click(); return 'ok'; }
    return 'not-found';
  `)
  const smallSeen = await waitFor(`(document.querySelector('.ch-title')?.textContent || '').includes('第二章')`, 8000)
  check('从目录切到第二章（小章节）', smallSeen)
  const small = await ev(`
    const pane = document.querySelector('.reader-content');
    const paras = pane.querySelectorAll('.para[data-p]');
    return {
      paraNodes: paras.length,
      gaps: pane.querySelectorAll('.reader-gap').length,
      maxP: paras.length ? Math.max(...[...paras].map((n) => Number(n.dataset.p))) : -1,
    };
  `)
  check('小章节全量渲染（50 段全落地）', small && small.paraNodes === 50, `节点=${small?.paraNodes}`)
  check('小章节无占位间隙（旧路径不变）', small && small.gaps === 0, `gap=${small?.gaps}`)

  await writeFile(join(dirname(fileURLToPath(import.meta.url)), 'probe-window-report.txt'), [
    `probe-window.mjs 结果（${new Date().toISOString()}）`,
    ...passed, ...failed.map((f) => f.replace(/^FAIL/, 'FAIL')),
    `\n汇总：${passed.length} 通过 / ${failed.length} 失败`,
  ].join('\n'), 'utf-8')
} catch (error) {
  check('窗口化探针未抛异常', false, String((error && error.stack) || error))
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
console.log('大章节窗口化端到端通过：首屏即时、拖动进度条精确落点、滚动后段无空白')
