// U1.3-op-1 真实操作采集：OP-8 / A / B。
// 只发 CDP 原生鼠标（mouseMoved / mousePressed / mouseReleased）与 mouseWheel。
// 不调用 Vue 组件方法，不读改组件状态变量，不写 DOM/class/style，不直接改 scrollTop，不 reload。
import { connect, READ_STATE } from './_cdp-lib.mjs'
import fs from 'node:fs'

const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = () => c.evaluate(READ_STATE)
const trace = []
const SHORT = 9, LONG = 13
const CENTER = { x: 666, y: 386 }
const RIGHT = { x: 960, y: 380 }

const brief = (s) => ({
  chapter: s.chapterTitle,
  scrollTop: s.pane.scrollTop, clientHeight: s.pane.clientHeight, scrollHeight: s.pane.scrollHeight,
  maxTop: s.pane.maxTop, viewportBottom: s.pane.scrollTop + s.pane.clientHeight,
  mode: s.modeActive, pageIndicator: s.pageIndicator,
  cutAtBottom: s.cutAtBottom.map((p) => ({ i: p.i, absTop: p.absTop, absBottom: p.absBottom, height: p.height, chars: p.chars, firstSentence: p.firstSentence })),
  alignAtTop: s.alignAtTop.map((p) => ({ i: p.i, absTop: p.absTop, firstSentence: p.firstSentence })),
})
const note = (tag, s, extra = {}) => { const b = { tag, at: new Date().toISOString(), ...brief(s), ...extra }; trace.push(b); console.log(tag, JSON.stringify(b)); return b }
const scrollNow = () => c.evaluate(`Math.round(document.querySelector('.reader-content').scrollTop)`)
const scrollFrac = () => c.evaluate(`document.querySelector('.reader-content').scrollTop`)
const settle = async (maxMs = 4000) => {
  const t0 = Date.now(); let prev = null
  while (Date.now() - t0 < maxMs) {
    const cur = await scrollNow()
    if (prev === cur) { await sleep(240); if (await scrollNow() === cur) return cur }
    prev = cur; await sleep(200)
  }
  return prev
}
const curve = async (awaitMs = 9000) => {
  const t0 = Date.now(); const samples = []; let prev = null; let stableSince = null
  while (Date.now() - t0 < awaitMs) {
    const cur = await scrollNow()
    samples.push({ t: Date.now() - t0, top: cur })
    if (prev === cur) { if (stableSince == null) stableSince = Date.now(); if (Date.now() - stableSince >= 900) break }
    else stableSince = null
    prev = cur; await sleep(120)
  }
  return { samples, final: prev }
}
const barHidden = () => c.evaluate(`document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden') === true`)
const btnCenter = (label) => c.evaluate(`(() => { const b=[...document.querySelectorAll('.bottom-button')].find(x=>x.getAttribute('aria-label')==='${label}'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:Math.round(r.width), h:Math.round(r.height)} })()`)
const modeInfo = () => c.evaluate(`(() => {
  const find=(t)=>[...document.querySelectorAll('.option-grid button')].find(x=>x.textContent.trim()===t)
  const info=(el)=>{ if(!el) return null; const r=el.getBoundingClientRect(); const cx=Math.round(r.x+r.width/2), cy=Math.round(r.y+r.height/2); const h=document.elementFromPoint(cx,cy); return { rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)], active: el.className.includes('active'), center:{cx,cy}, hitIsSelf: h===el, hitText:(h?.textContent||'').trim().slice(0,10) } }
  const p=document.querySelector('.bottom-panel'); const pr=p?.getBoundingClientRect()
  return { screen: info(find('屏幕翻页')), scroll: info(find('连续滚动')), panelPresent: !!p, panelRect: pr?[Math.round(pr.x),Math.round(pr.y),Math.round(pr.width),Math.round(pr.height)]:null }
})()`)
const hitAt = (x, y) => c.evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); return el ? el.tagName + '.' + String(el.className).slice(0, 34) + '|' + (el.textContent || '').trim().slice(0, 10) : null })()`)

// 真实鼠标点「字体」开面板（工具条收起时先用真实鼠标点中区显形），再用真实滚轮把两个阅读方式选项滚进可点区
const openFontAndReveal = async () => {
  const steps = []
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await barHidden()) { await c.click(CENTER.x, CENTER.y); await sleep(850); steps.push('center-click(reveal)'); continue }
    if (await c.evaluate(`!!document.querySelector('.bottom-panel')`)) break
    const b = await btnCenter('字体')
    await c.click(b.x, b.y); await sleep(950)
    steps.push(`font-click@${b.x},${b.y}`)
  }
  let w = 0
  let mi = await modeInfo()
  while (w < 14 && mi.panelRect && !(mi.screen?.hitIsSelf && mi.scroll?.hitIsSelf)) {
    await c.wheel(mi.panelRect[0] + mi.panelRect[2] / 2, mi.panelRect[1] + mi.panelRect[3] / 2, 120)
    w += 1; await sleep(340)
    mi = await modeInfo()
  }
  return { mi, wheelEvents: w, steps }
}
// 收起工具层（含字体面板）：真实鼠标点正文中区
const hideTools = async () => {
  const steps = []
  for (let i = 0; i < 3; i++) {
    if (await barHidden()) break
    await c.click(CENTER.x, CENTER.y); await sleep(850); steps.push('center-click(hide)')
  }
  return {
    barHidden: await barHidden(),
    panelPresent: await c.evaluate(`!!document.querySelector('.bottom-panel')`),
    hitAtRightThird: await hitAt(RIGHT.x, RIGHT.y),
    steps,
  }
}
// 一次「判定 → 截 before → 点右侧 → 采样 → 截 after」
const clickRightCapture = async (name, predicate) => {
  await settle(4500)
  const pre = await read()
  const preLong = pre.paras.find((p) => p.i === LONG)
  const preShort = pre.paras.find((p) => p.i === SHORT)
  const preCutShort = pre.cutAtBottom.find((p) => p.i === SHORT) || null
  const ctx = { pre, preLong, preShort, preCutShort }
  if (!predicate(ctx)) return { hit: false, ctx }
  fs.writeFileSync(`${name}-before-state.json`, JSON.stringify(pre, null, 2))
  await c.shot(`${name}-before.png`)
  const beforeHit = await hitAt(RIGHT.x, RIGHT.y)
  await c.click(RIGHT.x, RIGHT.y)
  const cv = await curve(10000)
  await settle(3500)
  const post = await read()
  fs.writeFileSync(`${name}-after-state.json`, JSON.stringify(post, null, 2))
  await c.shot(`${name}-after.png`)
  const postLong = post.paras.find((p) => p.i === LONG)
  const postShort = post.paras.find((p) => p.i === SHORT)
  const row = {
    name, clickAt: RIGHT, clickHitElement: beforeHit,
    preScrollTop: pre.pane.scrollTop, postScrollTop: post.pane.scrollTop,
    advanced: post.pane.scrollTop - pre.pane.scrollTop,
    scrollCurve: cv.samples.filter((_, i) => i % 3 === 0), curveFinal: cv.final,
    preCutShort, preShortPara: preShort ? { absTop: preShort.absTop, absBottom: preShort.absBottom, h: preShort.height } : null,
    postShortPara: postShort ? { absTop: postShort.absTop, absBottom: postShort.absBottom, viewTop: postShort.viewTop, h: postShort.height, firstSentence: postShort.firstSentence } : null,
    preLongPara: preLong ? { absTop: preLong.absTop, absBottom: preLong.absBottom, h: preLong.height } : null,
    postLongPara: postLong ? { absTop: postLong.absTop, absBottom: postLong.absBottom, h: postLong.height } : null,
    postAlignAtTop: post.alignAtTop.map((p) => p.i),
    longTextRemainingBelowViewport: postLong ? postLong.absBottom - (post.pane.scrollTop + post.pane.clientHeight) : null,
    preMode: pre.modeActive, postMode: post.modeActive,
  }
  return { hit: true, ctx, post, row }
}

// ================= 0 首帧 =================
let s = await read(); await c.shot('_t00-boot.png'); fs.writeFileSync('_t00-boot-state.json', JSON.stringify(s, null, 2)); note('boot', s)
note('boot-bar-state', s, { barHidden: await barHidden(), hitAtRightThird: await hitAt(RIGHT.x, RIGHT.y) })

// ================= 1 字体面板 → 真实点「屏幕翻页」 =================
const rv = await openFontAndReveal()
s = await read(); const miOpen = rv.mi
await c.shot('_t02-font-panel.png'); fs.writeFileSync('_t02-font-panel-state.json', JSON.stringify(s, null, 2))
note('font-panel-open', s, { wheelEvents: rv.wheelEvents, uiSteps: rv.steps, modeBtn: miOpen })
if (!miOpen.screen?.hitIsSelf) { console.log('FATAL: 「屏幕翻页」不可点'); c.close(); process.exit(2) }
const screenClickAt = miOpen.screen.center
await c.click(screenClickAt.cx, screenClickAt.cy); await sleep(1300); await settle()
s = await read(); const miOn = await modeInfo()
await c.shot('_t04-screen-mode.png'); fs.writeFileSync('_t04-screen-mode-state.json', JSON.stringify(s, null, 2))
note('clicked-screen-mode', s, { clickedAt: screenClickAt, modeBtn: miOn })
if (miOn.screen?.active !== true) { console.log('FATAL: 屏幕翻页未生效'); c.close(); process.exit(2) }
const closed = await hideTools()
s = await read(); await c.shot('_t05-panel-closed.png'); fs.writeFileSync('_t05-panel-closed-state.json', JSON.stringify(s, null, 2))
note('panel-closed', s, closed)
if (closed.barHidden === false) console.log('WARN: 工具条未收起')

// ================= 2 OP-8：屏底切断短段 → 点右侧一次 =================
let op8 = { hit: false }
for (let step = 1; step <= 8 && !op8.hit; step++) {
  const r = await clickRightCapture('OP-8', (x) => !!x.preCutShort)
  if (r.hit) { op8 = r; note('op8-captured', r.post, r.row); break }
  note(`op8-precheck-${step}`, r.pre, { skip: '本屏未切断短段，已点右侧继续', cutAtBottom: brief(r.pre).cutAtBottom })
}

// ================= 3 A：真实滚轮滚进超长段内部 → 点右侧一次 =================
let aRes = { hit: false }
{
  const entry = []
  for (let guard = 0; guard < 8; guard++) {
    const st = await c.evaluate(`(() => { const el=document.querySelector('.reader-content'); const n=el.querySelector('.para[data-p="${LONG}"]'); const pr=el.getBoundingClientRect(); const r=n.getBoundingClientRect(); const t=r.top-pr.top+el.scrollTop; return { scrollTop: Math.round(el.scrollTop), absTop: Math.round(t), absBottom: Math.round(t+r.height) } })()`)
    entry.push(st)
    if (st.scrollTop > st.absTop + 40 && st.scrollTop < st.absBottom - 100) break
    await c.wheel(CENTER.x, CENTER.y, 400); await sleep(1200)
  }
  await settle(5000)
  const again = await c.evaluate(`(() => { const el=document.querySelector('.reader-content'); const n=el.querySelector('.para[data-p="${LONG}"]'); const pr=el.getBoundingClientRect(); const r=n.getBoundingClientRect(); const t=r.top-pr.top+el.scrollTop; return { scrollTop: Math.round(el.scrollTop), absTop: Math.round(t), absBottom: Math.round(t+r.height) } })()`)
  entry.push({ settled: again })
  const r = await clickRightCapture('A', (x) => !!x.preLong && x.pre.pane.scrollTop > x.preLong.absTop + 20 && x.pre.pane.scrollTop < x.preLong.absBottom - 100)
  aRes = { ...r, entry }
  if (r.hit) note('a-captured', r.post, { ...r.row, wheelEntry: entry })
  else note('a-precheck-failed', r.pre, { wheelEntry: entry, preLongPara: r.preLong })
}

// ================= 4 B：真实鼠标切回「连续滚动」→ 真实滚轮 =================
let bWheel = [], bFinal = null, miBack = null, bClickAt = null, bQuick = null, bClosed = null
{
  const rv2 = await openFontAndReveal()
  s = await read(); note('panel-mode-again', s, { wheelEvents: rv2.wheelEvents, uiSteps: rv2.steps, modeBtn: rv2.mi })
  if (!rv2.mi.scroll?.hitIsSelf) { console.log('FATAL: 「连续滚动」不可点'); c.close(); process.exit(2) }
  bClickAt = rv2.mi.scroll.center
  await c.click(bClickAt.cx, bClickAt.cy); await sleep(900)
  miBack = await modeInfo()
  s = await read(); note('clicked-scroll-mode', s, { clickedAt: bClickAt, modeBtn: miBack })
  if (miBack.scroll?.active !== true) { console.log('FATAL: 连续滚动未生效') }
  bClosed = await hideTools()
  await settle(2500)
  s = await read(); note('B-panel-closed', s, bClosed)
  // 用真实滚轮把正文滚到章中部作为 B 起点
  for (let i = 0; i < 8; i++) {
    const cur = await scrollNow()
    if (cur >= 500 && cur <= 1000) break
    await c.wheel(CENTER.x, CENTER.y, cur > 1000 ? -120 : 120); await sleep(600); await settle(2200)
  }
  s = await read(); note('B-start-position', s)
  // 预热：首个合成 wheel 偶发被吞，预热 2 次，不计入 B 判定
  const warmups = []
  for (let w = 0; w < 2; w++) {
    const wp = await read()
    await c.wheel(CENTER.x, CENTER.y, 120); await sleep(700); await settle(2500)
    const wa = await read()
    warmups.push({ round: w + 1, deltaY: 120, before: wp.pane.scrollTop, after: wa.pane.scrollTop, moved: wa.pane.scrollTop - wp.pane.scrollTop })
    note(`B-warmup-${w + 1}`, wa, { note: '预热滚轮，不计入 B 判定', deltaY: 120, before: wp.pane.scrollTop, moved: wa.pane.scrollTop - wp.pane.scrollTop })
  }
  // 逐次滚轮：每次发完等稳定，记录位移与是否有段落顶对齐（吸附痕迹）
  for (let k = 0; k < 8; k++) {
    const pre = await read()
    await c.wheel(CENTER.x, CENTER.y, 120)
    await sleep(450); await settle(2500)
    const post = await read()
    const row = {
      step: k + 1, deltaY: 120,
      before: pre.pane.scrollTop, after: post.pane.scrollTop, moved: post.pane.scrollTop - pre.pane.scrollTop,
      alignedParaAtTop: post.alignAtTop.map((p) => p.i),
    }
    bWheel.push(row)
    note(`B-wheel-${k + 1}`, post, row)
  }
  // 快速连发滚轮：每 130ms 一发，采样曲线，观察是否出现"吸附跳段"
  const quickBefore = await scrollNow()
  const quickSamples = []
  const t0 = Date.now()
  for (let k = 0; k < 6; k++) {
    await c.wheel(CENTER.x, CENTER.y, 120)
    for (let j = 0; j < 3; j++) { await sleep(45); quickSamples.push({ t: Date.now() - t0, top: await scrollFrac() }) }
  }
  for (let j = 0; j < 10; j++) { await sleep(120); quickSamples.push({ t: Date.now() - t0, top: await scrollFrac() }) }
  await settle(3000)
  const quickAfter = await read()
  bQuick = { before: quickBefore, after: quickAfter.pane.scrollTop, samples: quickSamples.map((x) => ({ t: x.t, top: Math.round(x.top) })), finalAligned: quickAfter.alignAtTop.map((p) => p.i) }
  note('B-quick-wheel-series', quickAfter, { before: quickBefore, after: quickAfter.pane.scrollTop, samples: bQuick.samples })
  s = await read()
  fs.writeFileSync('B-after-state.json', JSON.stringify(s, null, 2)); await c.shot('B-after.png')
  bFinal = brief(s)
  const ax = await c.ax()
  fs.writeFileSync('_ax-buttons.txt', ax.filter((n) => n.role?.value === 'button' && n.name?.value).map((n) => n.name.value).join('\n'))
}

fs.writeFileSync('_trace.json', JSON.stringify(trace, null, 2))
fs.writeFileSync('_summary.json', JSON.stringify({ screenClickAt, closed, op8: op8.row ?? null, a: aRes.row ?? null, aEntry: aRes.entry, bClickAt, miBack, bClosed, bWheel, bQuick, bFinal }, null, 2))
console.log('\n=== OP-8 ===', JSON.stringify(op8.row ?? { hit: false }))
console.log('=== A ===', JSON.stringify(aRes.row ?? { hit: false }))
console.log('=== B ===', JSON.stringify(bWheel))
console.log('=== B quick ===', JSON.stringify(bQuick && { before: bQuick.before, after: bQuick.after, sampleCount: bQuick.samples.length }))
c.close()
