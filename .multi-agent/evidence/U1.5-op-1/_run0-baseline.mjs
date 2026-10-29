// 阶段 0：连本刀实例，读启动后默认页与阅读页顶栏默认收起状态（不点正文）。
import fs from 'node:fs'
import { connect, READ_TOOLS, READ_APP } from './_cdp-lib.mjs'

const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const ws = process.argv[2]
const c = await connect(ws)
const out = {}
out.app0 = await c.evaluate(READ_APP)
await c.shot(`${EV}/_t00-boot.png`)

// 点「阅读」nav（真实鼠标）
const navRect = await c.evaluate(`(() => {
  const b = [...document.querySelectorAll('.app-nav .nav-btn')].find((x) => (x.textContent||'').trim().includes('阅读'));
  if (!b) return null; const r = b.getBoundingClientRect();
  return { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2), hit: (document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)?.textContent||'').trim() };
})()`)
out.navReader = navRect
if (navRect) await c.click(navRect.cx, navRect.cy)
await new Promise((r) => setTimeout(r, 1200))
out.tools0 = await c.evaluate(READ_TOOLS)
out.app1 = await c.evaluate(READ_APP)
await c.shot(`${EV}/_t01-reader-baseline.png`)
fs.writeFileSync(`${EV}/_stage0.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2).slice(0, 2600))
c.close()
