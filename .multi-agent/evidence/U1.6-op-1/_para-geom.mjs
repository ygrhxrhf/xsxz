// 只读：正文段落几何与可见性（含整段站尾是否落在视口内、是否被 CSS 隐藏）。
import fs from 'node:fs'
import { connect, pageWs } from './_readers.mjs'
const c = await connect(await pageWs())
const out = await c.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('.reader-content .para')]
  const vh = innerHeight, vw = innerWidth
  return { viewport: { vw, vh }, paras: nodes.map((n) => {
    const r = n.getBoundingClientRect(); const s = getComputedStyle(n)
    return { p: n.getAttribute('data-p'), text: (n.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 70),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: r.bottom > 0 && r.top < vh && r.height > 0,
      display: s.display, visibility: s.visibility, opacity: s.opacity }
  }) }
})()`)
await c.shot('/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.6-op-1/_t08-paragraph-geom.png')
fs.writeFileSync('/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.6-op-1/_para-geom.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
c.close()
