// OP-12：下载 running 中，从书库打开这本书进阅读页——不点正文，读顶栏是否自动露出「已下 x / y 章」与「取消」。
import fs from 'node:fs'
import { connect, READ_APP, READ_TOOLS } from './_cdp-lib.mjs'
import { clickVerified, dismissOverlays } from './_lib-click.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { clicks: [], samples: [] }

await dismissOverlays(c, log.clicks)

// 1) 点导航「书库」
log.clicks.push({ step: 'nav-library', ...(await clickVerified(c, '.app-nav .nav-btn:nth-child(2)')) })
await sleep(1500)
log.library = await c.evaluate(READ_APP)
await c.shot(`${EV}/_t04-library-downloading.png`)

// 2) 点【正在下载那本】的开书热区（点书卡封面上部，避开可能的下拉菜单按钮）
const openInfo = await c.evaluate(`(() => {
  const cards = [...document.querySelectorAll('.book-card')];
  const card = cards.find((x) => (x.querySelector('.book-title')?.textContent || '').trim() === '样例站点·示例书一');
  if (!card) return null;
  const area = card.querySelector('.book-open-area');
  const r = area.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + 50);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
           hit: hit ? hit.tagName + '.' + (hit.className||'').toString().split(' ')[0] : null,
           hitOk: !!(hit && (hit === area || area.contains(hit))),
           cardText: (card.innerText||'').replace(/\\s+/g,' ').slice(0,200) };
})()`)
log.openInfo = openInfo
if (openInfo?.hitOk) await c.click(openInfo.cx, openInfo.cy)
await sleep(3000)

// 3) 不碰正文：进阅读页后的第一眼读数
log.entryNoClick = await c.evaluate(READ_TOOLS)
log.appReader = await c.evaluate(READ_APP)
await c.shot(`${EV}/OP-12-running.png`)

// 4) 连续采样（仍旧不点正文），记录「已下」数字在走、取消了仍在
for (let i = 0; i < 3; i++) {
  await sleep(1800)
  log.samples.push(await c.evaluate(READ_TOOLS))
}
await c.shot(`${EV}/_t05-running-later.png`)
fs.writeFileSync(`${EV}/OP-12-running-state.json`, JSON.stringify(log, null, 2))
console.log(JSON.stringify({
  clicks: log.clicks,
  openInfo: log.openInfo && { hitOk: log.openInfo.hitOk, cardText: log.openInfo.cardText },
  nav: log.appReader.nav,
  entry: { hiddenClass: log.entryNoClick.hiddenClass, ariaHidden: log.entryNoClick.ariaHidden, computed: log.entryNoClick.computed,
           rect: log.entryNoClick.rect, innerText: log.entryNoClick.innerText,
           progress: log.entryNoClick.progress, cancel: log.entryNoClick.cancel },
  samples: log.samples.map((s) => ({ hiddenClass: s.hiddenClass, height: s.computed.height, opacity: s.computed.opacity,
           innerText: s.innerText, progressText: s.progress?.text, cancelText: s.cancel?.text, cancelHit: s.cancel?.hitIsSelf, progressHit: s.progress?.hitIsSelf })),
}, null, 2).slice(0, 4000))
c.close()
