// 阶段 1d：点「下载本书」→ 等预览抽屉出来 → 读预览内容与「确认下载这本书」按钮位置。
import fs from 'node:fs'
import { connect, READ_APP } from './_cdp-lib.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = {}
const dlBtn = await c.evaluate(`(() => {
  const b = [...document.querySelectorAll('.browser-actions button')].find((x) => (x.textContent||'').trim() === '下载本书');
  if (!b) return null; const r = b.getBoundingClientRect();
  return { cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2) };
})()`)
log.dlBtn = dlBtn
if (dlBtn) await c.click(dlBtn.cx, dlBtn.cy)
await sleep(6000)
log.preview = await c.evaluate(`(() => {
  const d = document.querySelector('.dl-progress');
  const confirm = [...document.querySelectorAll('.n-drawer button')].find((x) => (x.textContent||'').trim() === '确认下载这本书');
  const r = confirm ? confirm.getBoundingClientRect() : null;
  return {
    drawerText: d ? (d.innerText || '').replace(/\\\\s+/g,' ').slice(0, 500) : null,
    hasConfirm: !!confirm,
    confirmRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2) } : null,
    drawerTitles: [...document.querySelectorAll('.n-drawer-header__main')].map((x) => (x.textContent||'').trim()),
    body: (document.body.innerText||'').replace(/\\\\s+/g,' ').slice(0, 400),
  };
})()`)
fs.writeFileSync(`${EV}/_stage1d.json`, JSON.stringify(log, null, 2))
await c.shot(`${EV}/_t03-preview.png`)
console.log(JSON.stringify(log, null, 2).slice(0, 2200))
c.close()
