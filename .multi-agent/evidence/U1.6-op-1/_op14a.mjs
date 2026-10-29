// OP-14 第一步：字体面板里真实点开「工具一直显示」，记录开关与落盘值。
import fs from 'node:fs'
import { stateOf, sleep, EV, connect, pageWs } from './_readers.mjs'

const c = await connect(await pageWs())
const log = { commit: '2e7db64dbae0b317fd8b1e6d47e5b072f348e0c1', clicks: [], states: {} }
const CENTER = { x: 666, y: 386 }

const panelRect = () => c.evaluate(`(() => { const p = document.querySelector('.bottom-panel'); if (!p) return null; const r = p.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), scrollTop: Math.round(p.scrollTop), scrollHeight: p.scrollHeight, clientHeight: p.clientHeight } })()`)
const barHidden = () => c.evaluate(`document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden') === true`)
const panelOpen = () => c.evaluate(`!!document.querySelector('.bottom-panel')`)

const switchGeom = async (label) => c.evaluate(`(() => {
  const rows = [...document.querySelectorAll('.bottom-panel .control-label')];
  const row = rows.find((r) => (r.textContent || '').replace(/\\s+/g, '').includes(${JSON.stringify(label)}));
  const el = row && row.querySelector('.n-switch');
  if (!el) return { found: false };
  const r = el.getBoundingClientRect(); const p = document.querySelector('.bottom-panel').getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return { found: true, cx, cy, inside: r.top >= p.top && r.bottom <= p.bottom, hitIsSwitch: !!(hit && (hit === el || el.contains(hit))),
    checked: el.getAttribute('aria-checked'), className: el.className,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
})()`)

async function bringIntoView(label) {
  const trace = []
  for (let i = 0; i < 30; i++) {
    const g = await switchGeom(label)
    if (g.found && g.inside && g.hitIsSwitch && g.cy > 0 && g.cy < 771) return { g, wheels: i, trace }
    const p = await panelRect()
    if (!p) return { g, wheels: i, trace, panel: null }
    await c.wheel(p.x + p.w / 2, p.y + p.h / 2, 120)
    trace.push({ i, panelScrollTop: p.scrollTop, switchY: g.rect?.y, inside: g.inside, hitIsSwitch: g.hitIsSwitch })
    await sleep(340)
  }
  return { g: await switchGeom(label), wheels: 30, trace }
}

// 确保工具层与字体面板都在
if (await barHidden()) { await c.click(CENTER.x, CENTER.y); await sleep(900); log.clicks.push({ name: 'center-reveal', ok: true }) }
if (!(await panelOpen())) {
  const b = await c.evaluate(`(() => { const b=[...document.querySelectorAll('.reader-bottombar .bottom-button')].find(x=>x.getAttribute('aria-label')==='字体'); const r=b.getBoundingClientRect(); const cx=Math.round(r.x+r.width/2), cy=Math.round(r.y+r.height/2); const hit=document.elementFromPoint(cx,cy); return { cx, cy, hitOk: !!(hit && (hit===b || b.contains(hit))), hit: hit && hit.className } })()`)
  if (b.hitOk) { await c.click(b.cx, b.cy); log.clicks.push({ name: 'bottom-font', ok: true, at: [b.cx, b.cy] }) }
  await sleep(900)
}
log.states.before = await stateOf(c, { step: 'before-enable-always-show' })

const target = await bringIntoView('工具一直显示')
log.target = target
await c.shot(`${EV}/_t04-always-row.png`)
if (target.g?.found && target.g.hitIsSwitch) {
  await c.click(target.g.cx, target.g.cy)
  log.clicks.push({ name: 'always-show-switch', ok: true, at: [target.g.cx, target.g.cy], before: target.g.checked })
} else {
  log.clicks.push({ name: 'always-show-switch', ok: false, target })
}
await sleep(1400)
log.afterSwitch = await switchGeom('工具一直显示')
log.states.after = await stateOf(c, { step: 'always-show-on' })
await c.shot(`${EV}/OP-14-on.png`)

fs.writeFileSync(`${EV}/OP-14-step1-state.json`, JSON.stringify(log, null, 2))
const s = log.states.after
console.log(JSON.stringify({
  clicks: log.clicks, target: { check: target.g?.checked, cy: target.g?.cy, wheels: target.wheels, trace: target.trace },
  afterSwitch: log.afterSwitch,
  toolbar: { hiddenClass: s.toolbar.hiddenClass, height: s.toolbar.height, visibility: s.toolbar.visibility, opacity: s.toolbar.opacity, text: s.toolbar.innerText?.slice(0, 80) },
  switches: { purge: s.switches.purge?.checkedByClass, always: s.switches.alwaysShow?.checkedByClass },
  api: s.apiReader, file: { hideSiteTail: s.file.hideSiteTail, hideReaderChrome: s.file.hideReaderChrome },
  tailShown: s.tailParagraphRendered,
}, null, 2))
c.close()
