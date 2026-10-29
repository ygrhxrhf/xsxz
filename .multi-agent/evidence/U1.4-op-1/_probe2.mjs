import { connect } from './_cdp-lib.mjs'
const c = await connect(process.argv[2])
const r = await c.evaluate(`(() => {
  const vis = (el) => { if (!el) return null; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return { display: s.display, w: Math.round(r.width), h: Math.round(r.height) } }
  const readerRoot = document.querySelector('.reader-page, .reader-root, [class*="reader"]')
  return {
    title: document.title,
    readerDisplay: vis(document.querySelector('.reader-page') || document.querySelector('[class*="reader"]')),
    libPage: vis(document.querySelector('.library-page')),
    readerContentSize: vis(document.querySelector('.reader-content')),
    hotzones: [...document.querySelectorAll('.chapter-hotzone')].map((b) => { const r = b.getBoundingClientRect(); return { cls: b.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), disabled: b.disabled } }),
    spine: (() => { const b = document.querySelector('.reader-spine'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
    navs: [...document.querySelectorAll('.nav-btn')].map((b) => ({ t: b.textContent.trim(), active: b.className.includes('active') })),
    bodyHead: (document.body.innerText || '').slice(0, 300),
  }
})()`)
console.log(JSON.stringify(r, null, 2))
await c.shot('_probe2.png')
c.close()
