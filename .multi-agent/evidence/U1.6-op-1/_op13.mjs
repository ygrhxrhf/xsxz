// OP-13：关掉「净化」→ 点左侧书脊离开阅读页回书库 → 重新打开同一本书，看整段站尾是否可见。
import fs from 'node:fs'
import { stateOf, sleep, EV, connect, pageWs } from './_readers.mjs'

const c = await connect(await pageWs())
const log = { commit: '2e7db64dbae0b317fd8b1e6d47e5b072f348e0c1', clicks: [], states: {} }
const CENTER = { x: 666, y: 386 }

const geom = async (sel) => c.evaluate(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0; }) || els[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    hit: hit ? hit.tagName + '.' + (hit.className || '').toString().split(' ')[0] : null,
    hitOk: !!(hit && (hit === el || el.contains(hit))) };
})()`)

const clickSel = async (name, sel) => {
  const info = await geom(sel)
  if (!info || !info.hitOk) { log.clicks.push({ name, sel, ok: false, info }); return info }
  await c.click(info.cx, info.cy)
  log.clicks.push({ name, sel, ok: true, info })
  return info
}

const barHidden = () => c.evaluate(`document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden') === true`)
const panelOpen = () => c.evaluate(`!!document.querySelector('.bottom-panel')`)
const panelRect = () => c.evaluate(`(() => { const p = document.querySelector('.bottom-panel'); if (!p) return null; const r = p.getBoundingClientRect(); const s = getComputedStyle(p);
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), scrollTop: Math.round(p.scrollTop), scrollHeight: p.scrollHeight, clientHeight: p.clientHeight, overflowY: s.overflowY, visibility: s.visibility, opacity: s.opacity } })()`)

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

// 把目标开关滚到面板可视区内，并确认 elementFromPoint 真命中它
async function bringIntoView(label) {
  const trace = []
  for (let i = 0; i < 30; i++) {
    const g = await switchGeom(label)
    if (!g.found) { trace.push({ i, found: false }); await sleep(300); continue }
    if (g.inside && g.hitIsSwitch && g.cy > 0 && g.cy < 771) return { g, wheels: i, trace }
    const p = await panelRect()
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.h) || p.h <= 0) { trace.push({ i, p }); await sleep(300); continue }
    await c.wheel(Math.round(p.x + p.w / 2), Math.round(p.y + p.h / 2), 120)
    trace.push({ i, panelScrollTop: p.scrollTop, switchY: g.rect.y, inside: g.inside, hitIsSwitch: g.hitIsSwitch })
    await sleep(340)
  }
  return { g: await switchGeom(label), wheels: 30, trace }
}

// A) 首屏（未点任何东西）
log.states.t0_boot = await stateOf(c, { step: 'boot' })
await c.shot(`${EV}/_t00-boot.png`)

// B) 真实鼠标点正文中区唤出工具层
await c.click(CENTER.x, CENTER.y)
await sleep(900)
log.states.t1_revealed = await stateOf(c, { step: 'reveal-tools' })

// C) 点底栏胶囊「字体」
const fontClick = await clickSel('bottom-font', '.reader-bottombar .bottom-button[aria-label="字体"]')
await sleep(900)
log.panelRectBefore = await panelRect()
log.states.t2_fontPanel = await stateOf(c, { step: 'font-panel-open' })

// D) 滚到「净化」并真实点它（true → false）
const purgeTarget = await bringIntoView('净化')
log.purgeBefore = purgeTarget
await c.shot(`${EV}/_t01-font-panel-purge-row.png`)
await c.click(purgeTarget.g.cx, purgeTarget.g.cy)
await sleep(1200)
log.purgeAfterClick = await switchGeom('净化')
log.states.t3_purgeOff = await stateOf(c, { step: 'purge-off' })
await c.shot(`${EV}/OP-13-off.png`)

// E) 离开阅读页：真实点左侧书脊回书库
const spineClick = await clickSel('reader-spine', '.reader-spine')
await sleep(1800)
log.states.t4_library = await stateOf(c, { step: 'left-reader-to-library' })
log.libraryNav = await c.evaluate(`(() => ({ tab: [...document.querySelectorAll('.app-nav .nav-btn')].map((b) => ({ l: (b.textContent||'').trim(), active: b.className.includes('active') })), readerOnScreen: !!document.querySelector('.reader-spine') && document.querySelector('.reader-spine').getBoundingClientRect().width > 0 }))()`)
await c.shot(`${EV}/_t02-library.png`)

// F) 重新打开同一本书
const card = await c.evaluate(`(() => {
  const cards = [...document.querySelectorAll('.book-card')];
  const card = cards.find((x) => (x.querySelector('.book-title')?.textContent || '').trim() === '样例·站尾样书');
  if (!card) return null;
  const area = card.querySelector('.book-open-area');
  const r = area.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + 50);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, hitOk: !!(hit && (hit === area || area.contains(hit))), cardText: (card.innerText || '').replace(/\\s+/g, ' ').slice(0, 120) };
})()`)
log.reopenCard = card
if (card?.hitOk) await c.click(card.cx, card.cy)
await sleep(2800)
log.states.t5_reopen = await stateOf(c, { step: 'reopened-same-book' })
await c.shot(`${EV}/OP-13-reopen.png`)

// G) 只读核对：再唤出字体面板看「净化」开关仍是关的（不点开关）
if (await barHidden()) { await c.click(CENTER.x, CENTER.y); await sleep(900) }
if (!(await panelOpen())) { await clickSel('bottom-font-again', '.reader-bottombar .bottom-button[aria-label="字体"]'); await sleep(900) }
const purgeAfterReopen = await bringIntoView('净化')
log.purgeAfterReopen = purgeAfterReopen
log.states.t6_reopenPanel = await stateOf(c, { step: 'reopen-font-panel-readonly' })
await c.shot(`${EV}/_t03-reopen-font-panel.png`)

fs.writeFileSync(`${EV}/OP-13-state.json`, JSON.stringify(log, null, 2))
const brief = (k) => { const s = log.states[k]; return { k, step: s.step, hiddenClass: s.toolbar.hiddenClass, height: s.toolbar.height, visibility: s.toolbar.visibility, toolbarText: s.toolbar.innerText?.slice(0, 60), purgeChecked: s.switches.purge?.checkedByClass, alwaysShowChecked: s.switches.alwaysShow?.checkedByClass, tailShown: s.tailParagraphRendered, api: s.apiReader, file: { hideSiteTail: s.file.hideSiteTail, hideReaderChrome: s.file.hideReaderChrome }, paras: s.paras.map((p) => p.text.slice(0, 30)) } }
console.log(JSON.stringify({
  clicks: log.clicks.map((x) => ({ name: x.name, ok: x.ok, text: x.info?.text, hitOk: x.info?.hitOk })),
  panelRectBefore: log.panelRectBefore, purgeBefore: log.purgeBefore, purgeAfterClick: log.purgeAfterClick, purgeAfterReopen: log.purgeAfterReopen,
  libraryNav: log.libraryNav, reopenCard: log.reopenCard,
  seq: ['t0_boot','t1_revealed','t2_fontPanel','t3_purgeOff','t4_library','t5_reopen','t6_reopenPanel'].map(brief),
}, null, 2))
c.close()
