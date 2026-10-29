// OP-14 第二步（严格版）：重启后先回书库，再重新打开这本书，第一眼确认顶栏仍在。
import fs from 'node:fs'
import { stateOf, sleep, EV, connect, pageWs } from './_readers.mjs'

const c = await connect(await pageWs())
const log = { commit: '2e7db64dbae0b317fd8b1e6d47e5b072f348e0c1', clicks: [], states: {} }
const geom = async (sel) => c.evaluate(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0; }) || els[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    hitOk: !!(hit && (hit === el || el.contains(hit))) };
})()`)

log.states.a_beforeLeave = await stateOf(c, { step: 'restart-font-panel-open' })

// 点左侧书脊离开阅读页
const spine = await geom('.reader-spine')
log.clicks.push({ name: 'reader-spine', ok: !!spine?.hitOk, info: spine })
if (spine?.hitOk) await c.click(spine.cx, spine.cy)
await sleep(1800)
log.states.b_library = await stateOf(c, { step: 'restart-back-to-library' })
await c.shot(`${EV}/_t07-restart-library.png`)

// 重新打开同一本书
const card = await c.evaluate(`(() => {
  const cards = [...document.querySelectorAll('.book-card')];
  const card = cards.find((x) => (x.querySelector('.book-title')?.textContent || '').trim() === '样例·站尾样书');
  if (!card) return null;
  const area = card.querySelector('.book-open-area'); const r = area.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + 50);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, hitOk: !!(hit && (hit === area || area.contains(hit))) };
})()`)
log.clicks.push({ name: 'book-open-area', ok: !!card?.hitOk, info: card })
if (card?.hitOk) await c.click(card.cx, card.cy)
await sleep(3000)

// 第一眼：不点任何东西，读顶栏
log.states.c_reopened = await stateOf(c, { step: 'restart-reopen-book-first-look' })
await c.shot(`${EV}/OP-14-restart.png`)

fs.writeFileSync(`${EV}/OP-14-step3-state.json`, JSON.stringify(log, null, 2))
const brief = (k) => { const s = log.states[k]; return { k, step: s.step, hiddenClass: s.toolbar.hiddenClass, ariaHidden: s.toolbar.ariaHidden, height: s.toolbar.height, visibility: s.toolbar.visibility, opacity: s.toolbar.opacity, rect: s.toolbar.rect, toolbarText: s.toolbar.innerText?.slice(0, 80), bottombarHidden: s.bottombarHidden, tailShown: s.tailParagraphRendered, api: s.apiReader, file: { hideSiteTail: s.file.hideSiteTail, hideReaderChrome: s.file.hideReaderChrome } } }
console.log(JSON.stringify({ clicks: log.clicks.map((x) => ({ name: x.name, ok: x.ok, text: x.info?.text })), seq: ['a_beforeLeave','b_library','c_reopened'].map(brief) }, null, 2))
c.close()
