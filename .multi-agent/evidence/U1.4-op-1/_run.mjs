// U1.4-op-1 真实操作采集：OP-9 / OP-10 / OP-11。
// 只发 CDP 原生鼠标（mouseMoved / mousePressed / mouseReleased）与 mouseWheel。
// 不调用 Vue 组件方法，不读改组件状态变量，不写 DOM/class/style，不直接改 scrollTop，不 reload。
import { connect, READ_U14, READ_SWITCHES } from './_cdp-lib.mjs'
import fs from 'node:fs'

const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = () => c.evaluate(READ_U14)
const sw = () => c.evaluate(READ_SWITCHES)
const trace = []
const note = (tag, obj) => { trace.push({ tag, at: new Date().toISOString(), ...obj }); console.log('##', tag, JSON.stringify(obj).slice(0, 900)) }
const hitAt = (x, y) => c.evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); return el ? el.tagName + '.' + String(el.className).slice(0, 40) + '|' + (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 22) : null })()`)
const CENTER = { x: 666, y: 386 }

// ---- 只读文件 hash：证明「本章显示原文」没有写盘、章节文件未改 ----
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
const FILES = [
  '/tmp/U1.4-op-1/userData/settings.json',
  '/tmp/U1.4-op-1/library/index.json',
  '/tmp/U1.4-op-1/library/sample_u14/book.json',
  '/tmp/U1.4-op-1/library/sample_u14/chapters/0001.json',
  '/tmp/U1.4-op-1/library/sample_u14/chapters/0002.json',
  '/tmp/U1.4-op-1/library/sample_u14/reading-frontier.json',
]
const hashAll = (tag) => {
  const out = { tag, at: new Date().toISOString(), files: {} }
  for (const f of FILES) {
    try {
      const buf = nodeFs.readFileSync(f)
      const st = nodeFs.statSync(f)
      out.files[f] = { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, mtimeMs: st.mtimeMs }
    } catch (e) { out.files[f] = { error: String(e && e.message) } }
  }
  fs.writeFileSync(`_hash-${tag}.json`, JSON.stringify(out, null, 2))
  console.log('## hash', tag, JSON.stringify(Object.fromEntries(Object.entries(out.files).map(([k, v]) => [k.replace('/tmp/U1.4-op-1/', ''), v.sha256 ? v.sha256.slice(0, 12) : v.error]))))
  return out
}
const hashes = {}


// 真实鼠标点正文中区：显形 / 收起工具层（唯一允许的显隐途径）
const centerClick = async () => { await c.click(CENTER.x, CENTER.y); await sleep(900) }

const fontBtn = async () => c.evaluate(`(() => { const b=[...document.querySelectorAll('.bottom-button')].find(x=>x.getAttribute('aria-label')==='字体'); if(!b) return null; const r=b.getBoundingClientRect(); return { cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2), w: Math.round(r.width), h: Math.round(r.height), inView: r.top>=0 && r.bottom<=innerHeight } })()`)

// 真实鼠标把「字体」面板打开（工具条收起时先点中区显形）
const openFont = async () => {
  const steps = []
  for (let i = 0; i < 6; i++) {
    const s0 = await sw()
    if (s0.panelPresent) break
    if (s0.bottombarRect?.hidden) { await centerClick(); steps.push('center(reveal)'); continue }
    const b = await fontBtn()
    if (!b) { await sleep(400); continue }
    await c.click(b.cx, b.cy); await sleep(950)
    steps.push(`font@${b.cx},${b.cy}`)
  }
  return { steps, state: await sw() }
}
// 开关中心点是否真的能点到开关本身（面板 overflow 裁剪会让 rect 在视口内但其实被裁掉）
const switchHit = async (label) => c.evaluate(`(() => {
  const l = [...document.querySelectorAll('.bottom-panel .control-label')].find((x) => (x.textContent||'').includes(${JSON.stringify(label)}))
  if (!l) return { found: false }
  const el = l.querySelector('.n-switch')
  if (!el) return { found: false }
  const r = el.getBoundingClientRect()
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2)
  const hit = document.elementFromPoint(cx, cy)
  const own = hit === el || el.contains(hit)
  const p = document.querySelector('.bottom-panel').getBoundingClientRect()
  return { found: true, cx, cy, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    insidePanelBox: r.top >= p.top && r.bottom <= p.bottom,
    panelRect: { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) },
    hitTag: hit ? hit.tagName + '.' + String(hit.className).slice(0, 30) : null, hitIsSwitch: own }
})()`)
// 真实滚轮把目标开关滚进面板真正可点的位置（以 elementFromPoint 命中为准）
const revealSwitch = async (match) => {
  let n = 0
  let h = await switchHit(match)
  while (n < 20 && !(h.found && h.hitIsSwitch && h.insidePanelBox)) {
    const pr = h.panelRect || (await sw()).panelRect
    if (!pr) break
    await c.wheel(pr.x + pr.w / 2, pr.y + pr.h / 2, 120)
    n += 1; await sleep(340)
    h = await switchHit(match)
  }
  return { wheelEvents: n, hit: h, state: await sw() }
}
const hideTools = async () => {
  const steps = []
  for (let i = 0; i < 3; i++) {
    const s = await sw()
    if (s.bottombarRect?.hidden) break
    await centerClick(); steps.push('center(hide)')
  }
  return { steps, state: await sw() }
}

// 段落读数摘要：屏幕上可见段的 p 下标与文字
const visible = (s) => s.paraOnScreen.map((p) => ({ p: p.p, y: p.rect.y, h: p.rect.h, text: p.text }))

// ================= t0 首帧 =================
hashes.t0 = hashAll('t0-boot')
let s = await read()
await c.shot('_t00-boot.png'); fs.writeFileSync('_t00-boot-state.json', JSON.stringify(s, null, 2))
note('boot', { chapter: s.chapterTitle, viewport: s.viewport, paraCount: s.paraCount, dataPOrder: s.dataPOrder, visible: visible(s), domHasTail: s.domHasTailSentence, domHasKeep: s.domHasKeepSentence })

// ================= OP-9 / OP-10：清屏截图（工具层收起） =================
let h = await hideTools()
note('op9-tools-hidden', { steps: h.steps, bottombar: h.state.bottombarRect })
s = await read()
fs.writeFileSync('OP-9-state.json', JSON.stringify(s, null, 2))
await c.shot('OP-9.png')
const op9 = {
  chapter: s.chapterTitle, viewport: s.viewport, pane: s.pane,
  dataPOrder: s.dataPOrder, paraCount: s.paraCount,
  visibleOnScreen: visible(s),
  visibleTextOnScreen: s.visibleTextOnScreen,
  domHasTailSentence: s.domHasTailSentence,
  domHasAnyExampleDomain: s.domHasAnyExampleDomain,
  domHasKeepSentence: s.domHasKeepSentence,
  tailParaPresentInDom: s.paras.some((p) => p.p === 1),
}
note('OP-9', op9)

s = await read()
fs.writeFileSync('OP-10-state.json', JSON.stringify(s, null, 2))
await c.shot('OP-10.png')
const keep = s.paras.find((p) => p.text.includes('请收藏这封信'))
const op10 = {
  chapter: s.chapterTitle,
  keepPara: keep ? { p: keep.p, rect: keep.rect, visibleArea: keep.visibleArea, display: keep.display, visibility: keep.visibility, opacity: keep.opacity, coveredByOther: keep.coveredByOther, onScreen: keep.onScreen, text: keep.text } : null,
  visibleOnScreen: visible(s),
  visibleTextOnScreen: s.visibleTextOnScreen,
}
note('OP-10', op10)

// ================= OP-11 前半：真实鼠标点「本章显示原文」 =================
const fo = await openFont()
note('font-panel-open', { steps: fo.steps, panelRect: fo.state.panelRect, switches: fo.state.switches })
if (!fo.state.panelPresent) { console.log('FATAL: 字体面板打不开'); c.close(); process.exit(2) }
const rs = await revealSwitch('本章显示原文')
note('switch-revealed', { wheelEvents: rs.wheelEvents, hit: rs.hit, panelRect: rs.state.panelRect, switches: rs.state.switches })
if (!rs.hit.found || !rs.hit.hitIsSwitch) { console.log('FATAL: 「本章显示原文」点不到'); c.close(); process.exit(3) }
const target = rs.state.switches.find((x) => x.label.includes('本章显示原文'))
const purge = rs.state.switches.find((x) => x.label.includes('净化'))
const clickAt = { x: rs.hit.cx, y: rs.hit.cy }
const hitBefore = await hitAt(clickAt.x, clickAt.y)
const preSwitchState = { raw: target.checked, purge: purge?.checked }
hashes.beforeSwitch = hashAll('before-switch')
await c.click(clickAt.x, clickAt.y)
await sleep(1100)
const afterSwitch = await sw()
const afterTarget = afterSwitch.switches.find((x) => x.label.includes('本章显示原文'))
hashes.afterSwitch = hashAll('after-switch')
note('switch-clicked', { clickAt, hitBefore, preSwitchState, postSwitchState: { raw: afterTarget?.checked, purge: afterSwitch.switches.find((x) => x.label.includes('净化'))?.checked } })

// 收起工具层，让整句回到纯正文画面
const h2 = await hideTools()
note('op11-tools-hidden', { steps: h2.steps, bottombar: h2.state.bottombarRect })
s = await read()
fs.writeFileSync('OP-11-raw-state.json', JSON.stringify(s, null, 2))
await c.shot('OP-11-raw.png')
const tail1 = s.paras.find((p) => p.p === 1)
const op11raw = {
  chapter: s.chapterTitle,
  switchBeforeClick: preSwitchState, clickAt, hitBefore,
  switchAfterClick: { raw: afterTarget?.checked, purge: afterSwitch.switches.find((x) => x.label.includes('净化'))?.checked },
  tailPara1: tail1 ? { p: tail1.p, rect: tail1.rect, visibleArea: tail1.visibleArea, display: tail1.display, visibility: tail1.visibility, opacity: tail1.opacity, coveredByOther: tail1.coveredByOther, onScreen: tail1.onScreen, text: tail1.text } : null,
  domHasTailSentence: s.domHasTailSentence,
  domHasAnyExampleDomain: s.domHasAnyExampleDomain,
  dataPOrder: s.dataPOrder,
  visibleOnScreen: visible(s),
  visibleTextOnScreen: s.visibleTextOnScreen,
}
note('OP-11-raw', op11raw)

// ================= OP-11 后半：真实鼠标点右侧「下一章」热区 =================
const hot = await c.evaluate(`(() => { const b=document.querySelector('.chapter-hotzone.right'); if(!b) return null; const r=b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), disabled: b.disabled, title: b.title } })()`)
const hotClick = { x: 1270, y: 400 }
const hitHot = await hitAt(hotClick.x, hotClick.y)
note('hotzone', { hot, hotClick, hitHot })
if (!hitHot || !hitHot.includes('chapter-hotzone')) { console.log('FATAL: 下一章热区不可点'); c.close(); process.exit(4) }
await c.click(hotClick.x, hotClick.y)
// 等章节切换：章标题变化 + 正文稳定
let nextS = null
for (let i = 0; i < 40; i++) {
  await sleep(400)
  const cur = await read()
  if (cur.chapterTitle && cur.chapterTitle !== s.chapterTitle && cur.paraCount > 0) { nextS = cur; break }
}
await sleep(1200)
s = nextS ?? await read()
hashes.afterChapterChange = hashAll('after-chapter-change')
// 换章后工具层可能显形，先如实记录，再判断画面
note('after-next-chapter', { chapter: s.chapterTitle, dataPOrder: s.dataPOrder, visible: visible(s), domHasTail: s.domHasTailSentence, bottombarHidden: (await sw()).bottombarRect?.hidden })
const h3 = await hideTools()
note('next-tools-hidden', { steps: h3.steps, bottombar: h3.state.bottombarRect })
s = await read()
fs.writeFileSync('OP-11-next-chapter-state.json', JSON.stringify(s, null, 2))
await c.shot('OP-11-next-chapter.png')
const tail2 = s.paras.find((p) => p.p === 1)
const sw2 = await sw()
const purge2 = sw2.switches.find((x) => x.label.includes('净化'))
const raw2 = sw2.switches.find((x) => x.label.includes('本章显示原文'))
const op11next = {
  chapter: s.chapterTitle,
  tailPara1: tail2 ? { p: tail2.p, rect: tail2.rect, visibleArea: tail2.visibleArea, onScreen: tail2.onScreen, text: tail2.text } : null,
  domHasTailSentence: s.domHasTailSentence,
  domHasAnyExampleDomain: s.domHasAnyExampleDomain,
  dataPOrder: s.dataPOrder,
  visibleOnScreen: visible(s),
  visibleTextOnScreen: s.visibleTextOnScreen,
  switchStateAfterChapterChange: { panelPresent: sw2.panelPresent, raw: raw2?.checked ?? 'panel-closed', purge: purge2?.checked ?? 'panel-closed' },
}
note('OP-11-next-chapter', op11next)

hashes.final = hashAll('final')
fs.writeFileSync('_hashes.json', JSON.stringify(hashes, null, 2))
fs.writeFileSync('_trace.json', JSON.stringify(trace, null, 2))
fs.writeFileSync('_summary.json', JSON.stringify({
  op9, op10, op11raw, op11next,
  switchClicks: { clickAt, hitBefore, before: preSwitchState, after: { raw: afterTarget?.checked } },
  hotzoneClick: { hot, hotClick, hitHot },
}, null, 2))
c.close()
console.log('DONE')
