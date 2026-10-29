// A 干净路径：下载 running 中，从书库打开这本书（不点正文）→ 真实点「取消」→ 顶栏应回到默认收起。
import fs from 'node:fs'
import { connect, READ_TOOLS, READ_APP } from './_cdp-lib.mjs'
import { clickVerified } from './_lib-click.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = {}

log.beforeEntry = await c.evaluate(READ_APP)

// 1) 点这本书的开书热区（坐标取卡片上部的封面，确保命中）
const openInfo = await c.evaluate(`(() => {
  const cards = [...document.querySelectorAll('.book-card')];
  const card = cards.find((x) => (x.querySelector('.book-title')?.textContent || '').trim() === '样例站点·示例书一');
  if (!card) return null;
  const area = card.querySelector('.book-open-area');
  const r = area.getBoundingClientRect();
  const cx = Math.round(r.x + r.width/2), cy = Math.round(r.y + 40);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
           hit: hit && (hit.tagName+'.'+(hit.className||'').toString().split(' ')[0]),
           hitOk: !!(hit && (hit === area || area.contains(hit))) };
})()`)
log.openInfo = openInfo
if (openInfo?.hitOk) await c.click(openInfo.cx, openInfo.cy)
await sleep(2800)

// 2) 进阅读页第一眼：不点正文，顶栏应自动露出「已下 / 取消」
log.entryNoClick = await c.evaluate(READ_TOOLS)
await c.shot(`${EV}/_t08-clean-running.png`)

// 3) 真实点「取消」
log.cancelClick = await clickVerified(c, '[data-reader-dl="cancel"]')
await sleep(2800)
log.afterCancel = await c.evaluate(READ_TOOLS)
log.appAfterCancel = await c.evaluate(READ_APP)
await c.shot(`${EV}/A-after-finish.png`)

// 4) 再等，确认不反弹
await sleep(3000)
log.settled = await c.evaluate(READ_TOOLS)
log.appSettled = await c.evaluate(READ_APP)

fs.writeFileSync(`${EV}/A-after-finish-clean-state.json`, JSON.stringify(log, null, 2))
const brief = (s) => s && ({ hiddenClass: s.hiddenClass, ariaHidden: s.ariaHidden, height: s.computed.height, opacity: s.computed.opacity,
  visibility: s.computed.visibility, transform: s.computed.transform, innerText: s.innerText,
  progress: s.progress?.text ?? null, cancel: s.cancel?.text ?? null })
console.log(JSON.stringify({
  openInfo: log.openInfo,
  entryNoClick: brief(log.entryNoClick),
  cancelClick: { ok: log.cancelClick.ok, hit: log.cancelClick.info?.hit, text: log.cancelClick.info?.text },
  afterCancel: brief(log.afterCancel),
  settled: brief(log.settled),
  sidebar: { after: log.appAfterCancel.sidebarDl, settled: log.appSettled.sidebarDl },
  cards: log.appSettled.cards,
}, null, 2).slice(0, 3000))
c.close()
