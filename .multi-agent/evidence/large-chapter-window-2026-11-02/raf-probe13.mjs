// 回归验证探针：睡眠模式（定时停止 UI）、压暗遮罩、目录抽屉、翻页。
// 针对大章迁窗修复 e02995a 的手动回归证据——修复只动 recenterWindowTo，
// 这四个功能路径应无回归。
// 用法：npm run build 之后 `node .multi-agent/evidence/large-chapter-window-2026-11-02/raf-probe13.mjs`
//
// 回归结果（2026-11-02，Windows，HEAD=e02995a）：9 项通过 / 0 项失败
//   - 背景面板含「屏幕压暗」滑块
//   - 压暗遮罩 dim=50 → opacity=0.5、pointer-events:none、aria-hidden=true
//   - 朗读面板有「定时停止」下拉且可切 10 分钟
//   - 目录抽屉打开 / 关闭
//   - 可切到屏幕翻页模式；空格翻页 scrollTop 前移（delta=139 @ clientH=690）
//   - 翻页后大章窗口节点有界（nodes=240，240/2600 段）
//
// 本轮修正过的探针缺陷：
//   1) 空格吞键根因一：字体面板开着（activeBottomPanel!==null → anyDrawerOpen()=true）
//      → resolveReaderKey 返回 null。修正：翻页前先收起字体面板。
//   2) 空格吞键根因二（真正拦路）：目录抽屉关闭按钮选择器落空，showDrawer 仍为 true
//      → anyDrawerOpen() 恒真吞掉空格。修正：关闭按钮失败则再点底部「目录」按钮
//      toggle（真实用户路径），并断言 .n-drawer 已卸载后再翻页。
//   3) smooth 滚动是异步动画：改为轮询等 scrollTop 前移（≤2.5s），不再固定 sleep。
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))))
const PORT = 51000 + Math.floor(Math.random() * 4000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const lib = await mkdtemp(join(tmpdir(), 'spbf-reg-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-reg-user-'))
const bookId = 'd_reg'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const largeBody = Array.from({ length: 2600 }, (_, i) => `第${i + 1}段：${'短句正文用于测量大章节首屏与翻页耗时。'.repeat(2).slice(0, 22)}`).join('\n\n')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '回归测试书', author: 't', tags: [], sourceUrl: 'https://e.com/r/', sourceHost: 'e.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章（2600 段）', url: 'https://e.com/w/1.html', file: 'chapters/0001.json', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0, paragraphIndex: 0, paragraphOffset: 0, updatedAt: now },
}, null, 2), 'utf-8')
await writeFile(join(bookDir, 'chapters', '0001.json'), JSON.stringify({ title: '第一章（2600 段）', url: 'https://e.com/w/1.html', body: largeBody, status: 'ready' }), 'utf-8')
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: { dim: 50, fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium', paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll', hideSiteTail: true },
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
const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
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

  // 1) 压暗遮罩：背景面板里有「屏幕压暗」滑块；遮罩样式规则（opacity + pointer-events）
  await click(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '背景')`)
  const dimPanel = await ev(`
    const hasDim = !![...document.querySelectorAll('.control-label')].some((l) => l.textContent.includes('屏幕压暗'));
    const hasSlider = !!document.querySelector('.n-slider');
    return { hasDim, hasSlider };
  `)
  check('背景面板打开且含屏幕压暗滑块', dimPanel.hasDim && dimPanel.hasSlider, `hasDim=${dimPanel.hasDim} slider=${dimPanel.hasSlider}`)
  const dimCss = await ev(`
    const el = document.querySelector('.reader-dim');
    const cs = el ? getComputedStyle(el) : null;
    const sheets = [...document.styleSheets];
    let ruleText = '';
    for (const s of sheets) {
      try { for (const r of s.cssRules) { if (r.selectorText && String(r.selectorText).includes('.reader-dim')) ruleText += r.cssText; } } catch {}
    }
    return { element: !!el, opacity: cs ? cs.opacity : null, pe: cs ? cs.pointerEvents : null, ariaHidden: el ? el.getAttribute('aria-hidden') : null, ruleLen: ruleText.length };
  `)
  check('压暗遮罩元素渲染（dim=50）且 pointer-events:none + aria-hidden', dimCss.element && dimCss.opacity === '0.5' && dimCss.pe === 'none' && dimCss.ariaHidden === 'true', `opacity=${dimCss.opacity} pe=${dimCss.pe}`)

  // 2) 睡眠模式（定时停止 UI）：朗读面板里有「定时停止」select，可切 10 分钟
  await click(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '朗读' || b.getAttribute('aria-label') === '朗读')`)
  const sleepSeen = await waitFor(`[...document.querySelectorAll('select')].some((s) => s.getAttribute('aria-label') === '定时停止')`, 6000)
  check('朗读面板有「定时停止」下拉', sleepSeen)
  if (sleepSeen) {
    const sleepSet = await ev(`
      const sel = [...document.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === '定时停止');
      if (!sel) return 'no-select';
      sel.value = '10';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    `)
    check('「定时停止」可切到 10 分钟', sleepSet === '10', `value=${sleepSet}`)
  }

  // 3) 目录抽屉
  await click(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '目录' || b.getAttribute('aria-label') === '目录')`)
  const catalogSeen = await waitFor(`document.querySelector('.n-drawer') !== null`, 6000)
  check('目录抽屉打开', catalogSeen)
  // 关闭：优先点抽屉头部关闭按钮；失败则再点底部「目录」按钮 toggle——
  // toggleBottomPanel('catalog') 在 activeBottomPanel==='catalog' 时置 null 且 showDrawer=false，
  // 是用户真实操作路径，比猜 naive-ui 内部类名可靠。
  await click(`document.querySelector('.n-drawer .n-drawer-header__close') || document.querySelector('.n-drawer .n-drawer-header button')`)
  let drawerClosed = await waitFor(`document.querySelector('.n-drawer') === null`, 3000)
  if (!drawerClosed) {
    await click(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '目录' || b.getAttribute('aria-label') === '目录')`)
    drawerClosed = await waitFor(`document.querySelector('.n-drawer') === null`, 3000)
  }
  check('目录抽屉已关闭', drawerClosed)

  // 4) 翻页：字体面板里切到屏幕翻页模式，空格翻一屏，scrollTop 应对齐整页且窗口迁窗正常
  await click(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '字体')`)
  await sleep(400)
  const modeSwitch = await ev(`
    const btns = [...document.querySelectorAll('button')].filter((b) => ['连续滚动', '屏幕翻页'].includes(b.textContent.trim()));
    if (!btns.length) return 'no-mode';
    const target = btns.find((b) => b.textContent.trim() === '屏幕翻页');
    if (target) { target.click(); return 'clicked'; }
    return 'not-found';
  `)
  check('可切换到屏幕翻页模式', modeSwitch === 'clicked', modeSwitch)
  await sleep(600)
  // 关键：收起字体面板。面板打开时 activeBottomPanel !== null → anyDrawerOpen() 为 true，
  // resolveReaderKey 对空格返回 null（仅 Escape 放行），空格 keydown 会被吞掉、pageByScreen 不执行。
  await click(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '字体')`)
  await waitFor(`document.querySelector('.bottom-panel') === null`, 4000)
  await sleep(300)
  const diag = await ev(`
    // 诊断：空格 keydown 是否到达 window、readingMode 是否 screen、scrollTop 初始值
    let reachedWindow = false;
    const probe = (e) => { if (e.key === ' ') reachedWindow = true; };
    window.addEventListener('keydown', probe);
    const pane = document.querySelector('.reader-content');
    const before = pane.scrollTop;
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    window.removeEventListener('keydown', probe);
    const after = pane.scrollTop;
    const modeEl = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '屏幕翻页');
    return {
      reachedWindow, before: Math.round(before), after: Math.round(after),
      screenActive: modeEl ? modeEl.className.includes('active') : null,
      bottomPanelPresent: !!document.querySelector('.bottom-panel'),
      anyDrawer: !!document.querySelector('.n-drawer'),
      activeBottomPanelText: (document.querySelector('.bottom-panel .control-label') || {}).textContent || null,
      scrollH: Math.round(pane.scrollHeight), clientH: Math.round(pane.clientHeight),
      paraCount: pane.querySelectorAll('.para[data-p]').length,
    };
  `)
  console.log('诊断翻页:', JSON.stringify(diag))
  const pageTurn = await ev(`
    const pane = document.querySelector('.reader-content');
    const before = pane.scrollTop;
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    // smooth 滚动是异步动画，轮询等 scrollTop 真正前移（最多 2.5s）
    const t0 = Date.now();
    while (Date.now() - t0 < 2500 && pane.scrollTop <= before + 5) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const after = pane.scrollTop;
    return { before: Math.round(before), after: Math.round(after), delta: Math.round(after - before), clientH: Math.round(pane.clientHeight) };
  `)
  check('翻页后 scrollTop 前移', pageTurn.after > pageTurn.before, `delta=${pageTurn.delta} clientH=${pageTurn.clientH}`)

  // 5) 翻页后大章窗口仍在有界范围（迁窗补偿未破坏）
  const bounded = await ev(`
    const pane = document.querySelector('.reader-content');
    const ps = [...pane.querySelectorAll('.para[data-p]')].map((n) => +n.dataset.p);
    return { nodes: ps.length, minP: ps.length ? Math.min(...ps) : -1, maxP: ps.length ? Math.max(...ps) : -1 };
  `)
  check('翻页后大章窗口节点有界', bounded.nodes > 0 && bounded.nodes <= 400, `nodes=${bounded.nodes} min=${bounded.minP} max=${bounded.maxP}`)

  console.log(`\n结果：${passed.length} 项通过，${failed.length} 项失败`)
} catch (e) {
  console.log('ERR', String((e && e.stack) || e))
} finally {
  try { ws?.close() } catch {}
  killTree()
  await sleep(500)
  await rm(lib, { recursive: true, force: true }).catch(() => {})
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}
