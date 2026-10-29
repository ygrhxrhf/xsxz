// A 干净路径 步骤 2：点「更多操作」→ 点「重试失败章」→ 等真的跑起来。
import fs from 'node:fs'
import { connect, READ_APP } from './_cdp-lib.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = {}

const centerOf = async (expr) => c.evaluate(expr)
const more = await centerOf(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label')||'').startsWith('更多操作：《样例站点·示例书一》'));
  if (!b) return null; const r = b.getBoundingClientRect();
  const cx = Math.round(r.x+r.width/2), cy = Math.round(r.y+r.height/2);
  const hit = document.elementFromPoint(cx, cy);
  return { cx, cy, hit: hit && (hit.tagName+'.'+(hit.className||'').toString().split(' ')[0]), hitOk: !!(hit && (hit===b || b.contains(hit))) };
})()`)
log.more = more
if (more?.hitOk) await c.click(more.cx, more.cy)
await sleep(900)
log.menu = await c.evaluate(`[...document.querySelectorAll('.n-dropdown-option')].map((x) => {
  const r = x.getBoundingClientRect();
  return { text: (x.textContent||'').trim(), cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2),
           disabled: x.className.includes('disabled'), hit: (document.elementFromPoint(r.x+r.width/2, r.y+r.height/2)?.textContent||'').trim().slice(0,12) };
})`)
const retry = (log.menu||[]).find((m) => m.text === '重试失败章' && !m.disabled)
log.retry = retry
if (retry) await c.click(retry.cx, retry.cy)
await sleep(3000)
log.afterRetry = await c.evaluate(READ_APP)
await c.shot(`${EV}/_t06-retry-running.png`)
fs.writeFileSync(`${EV}/_stage5b.json`, JSON.stringify(log, null, 2))
console.log(JSON.stringify({ more: log.more, menu: log.menu, retry: log.retry, sidebar: log.afterRetry.sidebarDl, cards: log.afterRetry.cards }, null, 2).slice(0, 2200))
c.close()
