// 阶段 1：真实用户路径 —— Esc 露出工具 → 点「浏览」→ 地址栏填本地站点目录页 → 下载本书 → 确认下载。
// 全程只发原生鼠标/键盘，不调组件方法、不写 DOM、不改组件状态。
import fs from 'node:fs'
import { connect, READ_TOOLS, READ_APP } from './_cdp-lib.mjs'

const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const URL = 'http://127.0.0.1:37855/book1/index.html'
const c = await connect(process.argv[2])
const log = {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const centerOf = (sel, extra = '') => c.evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent||'').trim().slice(0,40),
           hit: hit ? hit.tagName + '.' + (hit.className||'').toString().split(' ')[0] : null,
           hitText: (hit?.textContent||'').trim().slice(0,30) ${extra} };
})()`)

// 1) Esc 露出阅读页工具条（真实按键；不点正文）
await c.key('Escape', 'Escape', 27)
await sleep(700)
log.afterEsc = await c.evaluate(READ_TOOLS)

// 2) 点顶栏「浏览」
const browseBtn = await c.evaluate(`(() => {
  const b = [...document.querySelectorAll('.reader-toolbar button')].find((x) => (x.getAttribute('aria-label')||x.textContent||'').trim() === '浏览');
  if (!b) return null; const r = b.getBoundingClientRect();
  return { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) };
})()`)
log.browseBtn = browseBtn
if (browseBtn) await c.click(browseBtn.cx, browseBtn.cy)
await sleep(1200)
log.afterBrowseClick = await c.evaluate(READ_APP)

// 3) 地址栏输入站点目录页（真实键入 + 回车提交表单）
const addr = await centerOf('input[aria-label="网页地址"]')
log.addrRect = addr
if (addr) {
  await c.click(addr.cx, addr.cy)
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await c.typeText(URL)
  await c.key('Enter', 'Enter', 13)
}
await sleep(3500)
log.afterNavigate = await c.evaluate(READ_APP)
fs.writeFileSync(`${EV}/_stage1.json`, JSON.stringify(log, null, 2))
await c.shot(`${EV}/_t02-after-navigate.png`)
console.log(JSON.stringify(log, null, 2).slice(0, 2500))
c.close()
