// 追加核对：当前实例上再走一次「离开阅读页 → 重开同一本书」，同一时刻抓 DOM 文字与视口几何 + 截图。
import fs from 'node:fs'
import { stateOf, sleep, EV, connect, pageWs } from './_readers.mjs'
const c = await connect(await pageWs())
const log = { clicks: [], shots: [] }
const geom = async (sel) => c.evaluate(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0; }) || els[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, hitOk: !!(hit && (hit === el || el.contains(hit))), text: (el.textContent || '').trim().slice(0, 20) };
})()`)
const vp = () => c.evaluate(`(() => {
  const vh = innerHeight
  return [...document.querySelectorAll('.reader-content .para')].map((n) => {
    const r = n.getBoundingClientRect()
    return { p: n.getAttribute('data-p'), text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      y: Math.round(r.y), h: Math.round(r.height), inViewport: r.bottom > 0 && r.top < vh && r.height > 0 }
  })
})()`)

const spine = await geom('.reader-spine')
log.clicks.push({ name: 'reader-spine', ok: !!spine?.hitOk })
if (spine?.hitOk) await c.click(spine.cx, spine.cy)
await sleep(1800)
const card = await c.evaluate(`(() => {
  const cards = [...document.querySelectorAll('.book-card')];
  const card = cards.find((x) => (x.querySelector('.book-title')?.textContent || '').trim() === '样例·站尾样书');
  if (!card) return null;
  const area = card.querySelector('.book-open-area'); const r = area.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + 50);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, hitOk: !!(hit && (hit === area || area.contains(hit))) };
})()`)
log.clicks.push({ name: 'book-open-area', ok: !!card?.hitOk })
if (card?.hitOk) await c.click(card.cx, card.cy)
await sleep(3000)
log.state = await stateOf(c, { step: 'confirm-reopen' })
log.viewportParas = await vp()
log.shot = await c.shot(`${EV}/_t09-confirm-reopen.png`)
fs.writeFileSync(`${EV}/_confirm-state.json`, JSON.stringify(log, null, 2))
console.log(JSON.stringify({ clicks: log.clicks, toolbar: { hidden: log.state.toolbar.hiddenClass, h: log.state.toolbar.height, vis: log.state.toolbar.visibility, text: log.state.toolbar.innerText?.slice(0, 60) }, switches: { purge: log.state.switches.purge?.checkedByClass, always: log.state.switches.alwaysShow?.checkedByClass }, file: log.state.file, viewportParas: log.viewportParas }, null, 2))
c.close()
