// 诊断：重入后逐帧截图，看顶栏何时真正从像素上消失；同时读 document.visibilityState / hasFocus
import { connect, READ_STATE } from './_cdp-lib.mjs'
import fs from 'node:fs'
const c = await connect('ws://127.0.0.1:37482/devtools/page/D21CCF805C96AEC923114C7C61777D66')
const env = await c.evaluate(`({ vis: document.visibilityState, hidden: document.hidden, focus: document.hasFocus() })`)
console.log('ENV', JSON.stringify(env))
const st0 = await c.evaluate(READ_STATE)
console.log('start toolbar', JSON.stringify(st0.readerElements[0]))
// 展开 → 回书库 → 重入，然后在 t=0/300/800/1500/2500 各截图一张
await c.click(666, 386)
await new Promise(r => setTimeout(r, 900))
const spineR = await c.evaluate(`(() => { const r = document.querySelector('.reader-spine').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
await c.click(Math.round(spineR.x + spineR.w / 2), Math.round(spineR.y + spineR.h / 2))
await new Promise(r => setTimeout(r, 1100))
const card = (await c.evaluate(`(() => { const el = document.querySelector('.book-open-area'); const r = el.getBoundingClientRect(); return { label: el.getAttribute('aria-label'), x: r.x, y: r.y, w: r.width, h: r.height } })()`))
const cx = Math.round(card.x + card.w / 2), cy = Math.round(card.y + card.h / 2)
const t0 = Date.now()
await c.click(cx, cy)
const marks = []
for (const wait of [0, 300, 800, 1500, 2500, 4000]) {
  const target = t0 + wait
  const now = Date.now()
  if (target > now) await new Promise(r => setTimeout(r, target - now))
  const st = await c.evaluate(READ_STATE)
  const t = st.readerElements.find(e => e.class.includes('reader-toolbar'))
  await c.shot(`_probe-t${wait}.png`)
  marks.push({ wait, toolbar: [t.class, t.visibility, t.opacity, t.rect.height, t.ariaHidden], buttons: st.readerElements.filter(e => e.class === 'bottom-button').map(e => e.visibility) })
}
console.log(JSON.stringify(marks, null, 1))
fs.writeFileSync('_probe-throttle.json', JSON.stringify({ card: card.label, click: [cx, cy], env, marks }, null, 2))
c.close()
