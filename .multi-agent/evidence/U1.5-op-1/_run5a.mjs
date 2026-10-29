// A 干净路径 步骤 1：回到书库（点顶栏「书架」），读卡片与「更多」下拉入口。
import fs from 'node:fs'
import { connect, READ_APP, READ_TOOLS } from './_cdp-lib.mjs'
import { clickVerified } from './_lib-click.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { clicks: [] }
log.before = await c.evaluate(READ_TOOLS)
// 顶栏「书架」按钮 → 回书库
log.clicks.push({ step: 'shelf', ...(await clickVerified(c, '.reader-toolbar button[aria-label="书架"]')) })
await sleep(1800)
log.app = await c.evaluate(READ_APP)
log.cardButtons = await c.evaluate(`(() => {
  const cards = [...document.querySelectorAll('.book-card')];
  const card = cards.find((x) => (x.querySelector('.book-title')?.textContent || '').trim() === '样例站点·示例书一');
  if (!card) return null;
  return [...card.querySelectorAll('button')].map((b) => {
    const r = b.getBoundingClientRect();
    return { cls: b.className.split(' ').slice(0,2).join('.'), text: (b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,20),
             aria: b.getAttribute('aria-label'), cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
  });
})()`)
fs.writeFileSync(`${EV}/_stage5a.json`, JSON.stringify(log, null, 2))
console.log(JSON.stringify({ clicks: log.clicks, nav: log.app.nav, cardButtons: log.cardButtons }, null, 2).slice(0, 2200))
c.close()
