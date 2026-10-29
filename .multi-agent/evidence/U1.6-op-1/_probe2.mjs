import { connect, pageWs } from './_readers.mjs'
const c = await connect(await pageWs())
const r = await c.evaluate(`(() => {
  const bar = document.querySelector('.reader-bottombar');
  const b = [...document.querySelectorAll('.bottom-button')].map((x) => ({ label: x.getAttribute('aria-label'), rect: (() => { const q = x.getBoundingClientRect(); return { x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height) } })() }));
  const barR = bar ? bar.getBoundingClientRect() : null;
  return { viewport: { w: innerWidth, h: innerHeight }, barHidden: bar?.classList.contains('reader-tools-hidden'), barRect: barR && { x: Math.round(barR.x), y: Math.round(barR.y), w: Math.round(barR.width), h: Math.round(barR.height) }, buttons: b, panel: !!document.querySelector('.bottom-panel') };
})()`)
console.log(JSON.stringify(r, null, 2))
c.close()
