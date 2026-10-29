import { connect, pageWs, sleep } from './_readers.mjs'
const c = await connect(await pageWs())
const before = await c.evaluate(`(() => { const p = document.querySelector('.bottom-panel'); return p ? { top: p.scrollTop, rect: (() => { const r = p.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })() } : null })()`)
console.log('before', JSON.stringify(before))
try { await c.wheel(before.rect.x + 100, before.rect.y + 100, 120) } catch (e) { console.log('wheel-err', String(e).slice(0, 200)) }
await sleep(400)
const after = await c.evaluate(`(() => { const p = document.querySelector('.bottom-panel'); return p ? { top: p.scrollTop } : null })()`)
console.log('after', JSON.stringify(after))
const sw = await c.evaluate(`(() => {
  const rows = [...document.querySelectorAll('.bottom-panel .control-label')];
  const row = rows.find((r) => (r.textContent||'').replace(/\\s+/g,'').includes('净化'));
  const el = row && row.querySelector('.n-switch'); if (!el) return null;
  const r = el.getBoundingClientRect();
  return { y: Math.round(r.y), h: Math.round(r.height), checked: el.getAttribute('aria-checked') };
})()`)
console.log('switch', JSON.stringify(sw))
c.close()
