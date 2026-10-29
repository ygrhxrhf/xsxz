// A 干净路径：书库「重试失败章」重新开一次真实下载 → 打开这本书进阅读页（不点正文）→ 真实点「取消」
// → 用户全程没点过中区（intent=untouched），顶栏应自动回到默认收起。
import fs from 'node:fs'
import { connect, READ_TOOLS, READ_APP } from './_cdp-lib.mjs'
import { clickVerified, dismissOverlays } from './_lib-click.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { clicks: [] }

await dismissOverlays(c, log.clicks)

// 1) 去书库
log.clicks.push({ step: 'nav-library', ...(await clickVerified(c, '.app-nav .nav-btn:nth-child(2)')) })
await sleep(1500)

// 2) 打开这本书的「更多」下拉，点「重试失败章」（真实用户入口）
const moreInfo = await c.evaluate(`(() => {
  const cards = [...document.querySelectorAll('.book-card')];
  const card = cards.find((x) => (x.querySelector('.book-title')?.textContent || '').trim() === '样例站点·示例书一');
  if (!card) return null;
  const tri = card.querySelector('.n-dropdown, button[aria-haspopup], .n-button');
  const all = [...card.querySelectorAll('button')].map((b) => ({ cls: b.className, text: (b.textContent||'').trim() }));
  const trigger = [...card.querySelectorAll('button')].find((b) => /更多/.test(b.getAttribute('aria-label') || '') || (b.textContent||'').trim() === '更多');
  if (!trigger) return { notFound: true, all };
  const r = trigger.getBoundingClientRect();
  const cx = Math.round(r.x + r.width/2), cy = Math.round(r.y + r.height/2);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, text: (trigger.textContent||'').trim(), hit: hit && (hit.tagName+'.'+(hit.className||'').toString().split(' ')[0]),
           hitOk: !!(hit && (hit === trigger || trigger.contains(hit))) };
})()`)
log.moreInfo = moreInfo
if (moreInfo && moreInfo.hitOk) await c.click(moreInfo.cx, moreInfo.cy)
await sleep(900)
log.menu = await c.evaluate(`(() => {
  const items = [...document.querySelectorAll('.n-dropdown-option')].map((x) => {
    const r = x.getBoundingClientRect();
    return { text: (x.textContent||'').trim(), cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2), disabled: x.className.includes('disabled') };
  });
  return items;
})()`)
const retry = (log.menu || []).find((m) => m.text === '重试失败章' && !m.disabled)
log.retry = retry
if (retry) await c.click(retry.cx, retry.cy)
await sleep(2500)
log.afterRetry = await c.evaluate(READ_APP)
await c.shot(`${EV}/_t06-retry-running.png`)

// 3) 打开这本正在下载的书，进入阅读页，**不点正文**
const openInfo = await c.evaluate(`(() => {
  const cards = [...document.querySelectorAll('.book-card')];
  const card = cards.find((x) => (x.querySelector('.book-title')?.textContent || '').trim() === '样例站点·示例书一');
  if (!card) return null;
  const area = card.querySelector('.book-open-area');
  const r = area.getBoundingClientRect();
  const cx = Math.round(r.x + r.width/2), cy = Math.round(r.y + 50);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, hit: hit && (hit.tagName+'.'+(hit.className||'').toString().split(' ')[0]),
           hitOk: !!(hit && (hit === area || area.contains(hit))) };
})()`)
log.openInfo = openInfo
if (openInfo?.hitOk) await c.click(openInfo.cx, openInfo.cy)
await sleep(2800)
log.entryNoClick = await c.evaluate(READ_TOOLS)
await c.shot(`${EV}/_t07-clean-running.png`)

// 4) 真实点「取消」
log.cancelClick = await clickVerified(c, '[data-reader-dl="cancel"]')
await sleep(2600)
log.afterCancel = await c.evaluate(READ_TOOLS)
log.appAfterCancel = await c.evaluate(READ_APP)
await c.shot(`${EV}/A-after-finish.png`)
await sleep(2600)
log.afterSettled = await c.evaluate(READ_TOOLS)
log.appSettled = await c.evaluate(READ_APP)

fs.writeFileSync(`${EV}/A-after-finish-clean-state.json`, JSON.stringify(log, null, 2))
const brief = (s) => s && ({ hiddenClass: s.hiddenClass, ariaHidden: s.ariaHidden, inert: s.inert, height: s.computed.height, opacity: s.computed.opacity,
  visibility: s.computed.visibility, transform: s.computed.transform, innerText: s.innerText, progress: s.progress?.text ?? null, cancel: s.cancel?.text ?? null })
console.log(JSON.stringify({
  clicks: log.clicks.map((x) => ({ step: x.step, ok: x.ok, reason: x.reason })),
  menu: log.menu, retry: log.retry, afterRetrySidebar: log.afterRetry.sidebarDl,
  openInfo: log.openInfo, cancelClick: { ok: log.cancelClick.ok, info: log.cancelClick.info },
  entryNoClick: brief(log.entryNoClick),
  afterCancel: brief(log.afterCancel),
  afterSettled: brief(log.afterSettled),
  sidebarAfter: log.appAfterCancel.sidebarDl, sidebarSettled: log.appSettled.sidebarDl,
  cards: log.appSettled.cards,
}, null, 2).slice(0, 3600))
c.close()
