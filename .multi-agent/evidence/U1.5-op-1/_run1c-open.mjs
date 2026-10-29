// 阶段 1c：地址栏已有本地站点地址 → 点「打开」按钮提交表单，等网页真正打开。
import fs from 'node:fs'
import { connect, READ_APP } from './_cdp-lib.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = { addrValue: await c.evaluate(`(document.querySelector('input[aria-label="网页地址"]')?.value ?? null)`) }
const openBtn = await c.evaluate(`(() => {
  const b = document.querySelector('.browser-open-button');
  if (!b) return null; const r = b.getBoundingClientRect();
  const cx = Math.round(r.x+r.width/2), cy = Math.round(r.y+r.height/2);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, text: (b.textContent||'').trim(), hit: hit && (hit.tagName + '.' + (hit.className||'').toString().split(' ')[0]) };
})()`)
log.openBtn = openBtn
if (openBtn) await c.click(openBtn.cx, openBtn.cy)
await sleep(4500)
log.afterOpen = await c.evaluate(READ_APP)
// 下载本书按钮的可用状态（只读）
log.downloadBtn = await c.evaluate(`(() => {
  const b = [...document.querySelectorAll('.browser-actions button')].find((x) => (x.textContent||'').trim() === '下载本书');
  if (!b) return null; const r = b.getBoundingClientRect();
  return { text: (b.textContent||'').trim(), disabled: b.disabled || b.classList.contains('n-button--disabled'),
           rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
           cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2) };
})()`)
fs.writeFileSync(`${EV}/_stage1c.json`, JSON.stringify(log, null, 2))
await c.shot(`${EV}/_t02-after-navigate.png`)
console.log(JSON.stringify(log, null, 2).slice(0, 2000))
c.close()
