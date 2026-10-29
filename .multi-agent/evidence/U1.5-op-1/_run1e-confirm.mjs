// 阶段 1e：真实点击「确认下载这本书」，随后立刻切到书库并打开这本书，进阅读页观察顶栏。
import fs from 'node:fs'
import { connect, READ_APP, READ_TOOLS } from './_cdp-lib.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = {}
const confirm = await c.evaluate(`(() => {
  const b = [...document.querySelectorAll('.n-drawer button')].find((x) => (x.textContent||'').trim() === '确认下载这本书');
  if (!b) return null; const r = b.getBoundingClientRect();
  return { cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2) };
})()`)
log.confirm = confirm
if (confirm) await c.click(confirm.cx, confirm.cy)
await sleep(2500)
log.afterConfirm = await c.evaluate(READ_APP)
fs.writeFileSync(`${EV}/_stage1e.json`, JSON.stringify(log, null, 2))
console.log(JSON.stringify(log, null, 2).slice(0, 1600))
c.close()
