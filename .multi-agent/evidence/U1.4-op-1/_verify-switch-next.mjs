// 换章后补证：真实鼠标显形工具层 → 开「字体」面板 → 只读 aria-checked + 截图。
import { connect, READ_U14, READ_SWITCHES } from './_cdp-lib.mjs'
import fs from 'node:fs'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sw = () => c.evaluate(READ_SWITCHES)
const CENTER = { x: 666, y: 386 }
const barHidden = () => c.evaluate(`document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden') === true`)
const fontBtn = async () => c.evaluate(`(() => { const b=[...document.querySelectorAll('.bottom-button')].find(x=>x.getAttribute('aria-label')==='字体'); if(!b) return null; const r=b.getBoundingClientRect(); return { cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2) } })()`)
const switchHit = async (label) => c.evaluate(`(() => {
  const l = [...document.querySelectorAll('.bottom-panel .control-label')].find((x) => (x.textContent||'').includes(${JSON.stringify(label)}))
  const el = l && l.querySelector('.n-switch'); if (!el) return { found: false }
  const r = el.getBoundingClientRect(); const p = document.querySelector('.bottom-panel').getBoundingClientRect()
  const cx = Math.round(r.x + r.width/2), cy = Math.round(r.y + r.height/2)
  const hit = document.elementFromPoint(cx, cy)
  return { found: true, cx, cy, inside: r.top >= p.top && r.bottom <= p.bottom, hitIsSwitch: hit === el || el.contains(hit), checked: el.getAttribute('aria-checked'), disabled: el.getAttribute('aria-disabled'), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
})()`)
const steps = []
for (let i = 0; i < 8; i++) {
  if (await barHidden()) { await c.click(CENTER.x, CENTER.y); await sleep(900); steps.push('center(reveal)'); continue }
  if (await c.evaluate(`!!document.querySelector('.bottom-panel')`)) break
  const b = await fontBtn(); await c.click(b.cx, b.cy); await sleep(950); steps.push(`font@${b.cx},${b.cy}`)
}
let n = 0
for (; n < 20; n++) {
  const h = await switchHit('本章显示原文')
  if (h.found && h.inside && h.hitIsSwitch) break
  const pr = (await sw()).panelRect; if (!pr) break
  await c.wheel(pr.x + pr.w / 2, pr.y + pr.h / 2, 120); await sleep(340)
}
const panelState = await sw()
const raw = await switchHit('本章显示原文')
const purge = await switchHit('净化')
const r = await c.evaluate(READ_U14)
await c.shot('_op11-next-switch-panel.png')
const out = { at: new Date().toISOString(), chapter: r.chapterTitle, steps, wheelEvents: n,
  panelRect: panelState.panelRect, panelVisible: panelState.switches.map((s) => ({ label: s.label, visibility: s.visibility, opacity: s.opacity })),
  rawSwitch: raw, purgeSwitch: purge, dataPOrder: r.dataPOrder, domHasTailSentence: r.domHasTailSentence,
  visibleTextOnScreen: r.visibleTextOnScreen }
fs.writeFileSync('_op11-next-switch-state.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify({ chapter: out.chapter, steps, wheelEvents: n, rawSwitch: raw, purgeSwitch: purge, panelRect: panelState.panelRect }, null, 2))
for (let i = 0; i < 3; i++) { if (await barHidden()) break; await c.click(CENTER.x, CENTER.y); await sleep(900) }
c.close()
