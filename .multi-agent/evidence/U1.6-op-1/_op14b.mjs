// OP-14 第二步：重启后（同一 userData 目录）打开同一本书，确认顶栏仍在。
import fs from 'node:fs'
import { stateOf, sleep, EV, connect, pageWs } from './_readers.mjs'

const c = await connect(await pageWs())
const log = { commit: '2e7db64dbae0b317fd8b1e6d47e5b072f348e0c1', clicks: [], states: {} }
const CENTER = { x: 666, y: 386 }
const barHidden = () => c.evaluate(`document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden') === true`)

// 1) 重启后第一眼（App 会按上次进度自动进阅读页）
log.states.boot = await stateOf(c, { step: 'after-restart-boot' })
await c.shot(`${EV}/_t05-restart-boot.png`)

// 2) 若不在阅读页/没书，就从书库打开同一本
const needOpen = await c.evaluate(`(() => {
  const spine = document.querySelector('.reader-spine');
  const visible = !!(spine && spine.getBoundingClientRect().width > 0);
  return { readerVisible: visible, bookTitle: (document.querySelector('.reader-book-title')?.textContent || '').trim() };
})()`)
log.entry = needOpen
if (!needOpen.readerVisible) {
  const card = await c.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.book-card')];
    const card = cards.find((x) => (x.querySelector('.book-title')?.textContent || '').trim() === '样例·站尾样书');
    if (!card) return null;
    const area = card.querySelector('.book-open-area'); const r = area.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + 50);
    const hit = document.elementFromPoint(cx, cy);
    return { cx, cy, hitOk: !!(hit && (hit === area || area.contains(hit))) };
  })()`)
  log.openCard = card
  if (card?.hitOk) await c.click(card.cx, card.cy)
  await sleep(2800)
}

// 3) 重启后开书的第一眼读数（不点任何东西）
log.states.reopened = await stateOf(c, { step: 'after-restart-reopen-book' })
await c.shot(`${EV}/OP-14-restart.png`)

// 4) 只读核对：字体面板两个开关的状态（不点开关）
if (await barHidden()) { log.states.hiddenBeforePanel = await stateOf(c, { step: 'toolbar-hidden-before-panel' }) }
const b = await c.evaluate(`(() => { const btn=[...document.querySelectorAll('.reader-bottombar .bottom-button')].find(x=>x.getAttribute('aria-label')==='字体'); if(!btn) return null; const r=btn.getBoundingClientRect(); const cx=Math.round(r.x+r.width/2), cy=Math.round(r.y+r.height/2); const hit=document.elementFromPoint(cx,cy); return { cx, cy, hitOk: !!(hit && (hit===btn || btn.contains(hit))), barHidden: document.querySelector('.reader-bottombar').classList.contains('reader-tools-hidden') } })()`)
log.fontButton = b
if (b && b.hitOk && !b.barHidden) { await c.click(b.cx, b.cy); await sleep(900) }
log.states.panel = await stateOf(c, { step: 'after-restart-font-panel-readonly' })
await c.shot(`${EV}/_t06-restart-font-panel.png`)

fs.writeFileSync(`${EV}/OP-14-step2-state.json`, JSON.stringify(log, null, 2))
const brief = (k) => { const s = log.states[k]; if (!s) return null; return { k, step: s.step, hiddenClass: s.toolbar.hiddenClass, ariaHidden: s.toolbar.ariaHidden, height: s.toolbar.height, visibility: s.toolbar.visibility, opacity: s.toolbar.opacity, toolbarText: s.toolbar.innerText?.slice(0, 80), bottombarHidden: s.bottombarHidden, purge: s.switches.purge?.checkedByClass, always: s.switches.alwaysShow?.checkedByClass, tailShown: s.tailParagraphRendered, api: s.apiReader, file: { hideSiteTail: s.file.hideSiteTail, hideReaderChrome: s.file.hideReaderChrome }, paras: s.paras.map((p) => p.text.slice(0, 26)) } }
console.log(JSON.stringify({ entry: log.entry, openCard: log.openCard, fontButton: log.fontButton, seq: ['boot','reopened','hiddenBeforePanel','panel'].map(brief).filter(Boolean) }, null, 2))
c.close()
