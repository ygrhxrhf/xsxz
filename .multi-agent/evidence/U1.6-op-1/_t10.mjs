// 追加：把工具层收起，复现 OP-13「重开书第一眼（无工具栏）」条件，同一时刻抓段落几何与截图。
import fs from 'node:fs'
import { stateOf, sleep, EV, connect, pageWs } from './_readers.mjs'
const c = await connect(await pageWs())
const CENTER = { x: 666, y: 386 }
const barHidden = () => c.evaluate(`document.querySelector('.reader-toolbar')?.classList.contains('reader-tools-hidden') === true`)
if (!(await barHidden())) { await c.click(CENTER.x, CENTER.y); await sleep(1000) }
const out = {
  at: new Date().toISOString(),
  state: await stateOf(c, { step: 'no-toolbar-tail-visible' }),
  paras: await c.evaluate(`(() => { const vh = innerHeight; return [...document.querySelectorAll('.reader-content .para')].map((n) => { const r = n.getBoundingClientRect(); return { p: n.getAttribute('data-p'), text: (n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), inViewport: r.bottom > 0 && r.top < vh && r.height > 0 } }) })()`),
  shot: await c.shot(`${EV}/_t10-tail-no-toolbar.png`),
}
fs.writeFileSync(`${EV}/_t10-state.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify({ toolbarHidden: out.state.toolbar.hiddenClass, h: out.state.toolbar.height, file: out.state.file, paras: out.paras }, null, 2))
c.close()
