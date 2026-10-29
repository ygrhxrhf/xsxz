// 阶段 1b：书库页 → 点「浏览」→ 地址栏输入本地站点目录页 → 回车打开。
import fs from 'node:fs'
import { connect, READ_APP } from './_cdp-lib.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const URL = 'http://127.0.0.1:37855/book1/index.html'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = {}

const navBtn = await c.evaluate(`(() => {
  const b = [...document.querySelectorAll('.app-nav .nav-btn')].find((x) => (x.textContent||'').trim().includes('浏览'));
  if (!b) return null; const r = b.getBoundingClientRect();
  const cx = Math.round(r.x+r.width/2), cy = Math.round(r.y+r.height/2);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, hit: hit && (hit.tagName + '.' + (hit.className||'').toString().split(' ')[0]) };
})()`)
log.navBtn = navBtn
if (navBtn) await c.click(navBtn.cx, navBtn.cy)
await sleep(1500)
log.afterNav = await c.evaluate(READ_APP)

const addr = await c.evaluate(`(() => {
  const el = document.querySelector('input[aria-label="网页地址"]');
  if (!el) return null; const r = el.getBoundingClientRect();
  const cx = Math.round(r.x+r.width/2), cy = Math.round(r.y+r.height/2);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0,
           hit: hit && (hit.tagName + '.' + (hit.className||'').toString().split(' ')[0]) };
})()`)
log.addr = addr
if (addr && addr.visible) {
  await c.click(addr.cx, addr.cy)
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.typeText(URL)
  await c.key('Enter', 'Enter', 13)
  await sleep(4000)
}
log.addrValue = await c.evaluate(`(document.querySelector('input[aria-label="网页地址"]')?.value ?? null)`)
log.afterNav2 = await c.evaluate(READ_APP)
fs.writeFileSync(`${EV}/_stage1b.json`, JSON.stringify(log, null, 2))
await c.shot(`${EV}/_t02-after-navigate.png`)
console.log(JSON.stringify({ navBtn: log.navBtn, addr: log.addr, addrValue: log.addrValue, nav: log.afterNav2.nav, head: log.afterNav2.bodyHead.slice(0, 260) }, null, 2))
c.close()
