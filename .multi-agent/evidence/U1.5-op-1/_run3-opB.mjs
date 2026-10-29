// B：下载 running 期间，点正文中区仍能手动收起/展开工具，不被强制钉死。
import fs from 'node:fs'
import { connect, READ_TOOLS } from './_cdp-lib.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { steps: [] }

const centerClickPoint = async () => c.evaluate(`(() => {
  const el = document.querySelector('.reader-content');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // 中区中心：横向正中，纵向取视口中段（避开顶栏与底栏）
  const cx = Math.round(r.x + r.width / 2);
  const cy = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
           hit: hit ? hit.tagName + '.' + (hit.className||'').toString().split(' ')[0] : null,
           hitText: (hit?.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 40),
           insideContent: !!(hit && (hit === el || el.contains(hit))) };
})()`)

log.before = await c.evaluate(READ_TOOLS)
const p1 = await centerClickPoint()
log.centerPoint = p1
await c.click(p1.cx, p1.cy)
await sleep(900)
log.afterFirstClick = await c.evaluate(READ_TOOLS)
await c.shot(`${EV}/B-manual-toggle.png`)

// 收起后等几个进度 tick：确认不会被自动逻辑顶回来（不钉死 ≠ 强制展开）
await sleep(4200)
log.afterWaitCollapsed = await c.evaluate(READ_TOOLS)

// 再点一次中区：手动展开，进度与取消应再次出现
await c.click(p1.cx, p1.cy)
await sleep(900)
log.afterSecondClick = await c.evaluate(READ_TOOLS)
await c.shot(`${EV}/_b-expanded-again.png`)

await sleep(2000)
log.afterWaitExpanded = await c.evaluate(READ_TOOLS)

fs.writeFileSync(`${EV}/B-manual-toggle-state.json`, JSON.stringify(log, null, 2))
const brief = (s) => s && ({ hiddenClass: s.hiddenClass, ariaHidden: s.ariaHidden, height: s.computed.height, opacity: s.computed.opacity,
  visibility: s.computed.visibility, innerText: s.innerText, progress: s.progress?.text, cancel: s.cancel?.text, cancelHit: s.cancel?.hitIsSelf })
console.log(JSON.stringify({
  centerPoint: p1,
  before: brief(log.before),
  afterFirstClick: brief(log.afterFirstClick),
  afterWaitCollapsed: brief(log.afterWaitCollapsed),
  afterSecondClick: brief(log.afterSecondClick),
  afterWaitExpanded: brief(log.afterWaitExpanded),
}, null, 2))
c.close()
