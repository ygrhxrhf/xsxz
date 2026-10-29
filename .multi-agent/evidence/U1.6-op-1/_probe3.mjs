import { connect, pageWs, sleep } from './_readers.mjs'
const c = await connect(await pageWs())
// 唤出工具层并开字体面板
const st = await c.evaluate(`(() => { const b = document.querySelector('.reader-bottombar'); const btn = [...document.querySelectorAll('.bottom-button')].find(x=>x.getAttribute('aria-label')==='字体'); const r = btn.getBoundingClientRect(); return { barHidden: b.classList.contains('reader-tools-hidden'), cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2), hit: (document.elementFromPoint(r.x+r.width/2, r.y+r.height/2)||{}).className } })()`)
console.log('btn', JSON.stringify(st))
if (st.barHidden) { await c.click(666, 386); await sleep(900) }
await c.click(st.cx, st.cy)
await sleep(1000)
const out = await c.evaluate(`(() => {
  const p = document.querySelector('.bottom-panel');
  if (!p) return { noPanel: true, bodyHas: (document.body.innerText||'').slice(0,200) };
  const r = p.getBoundingClientRect(); const s = getComputedStyle(p);
  const rows = [...p.querySelectorAll('.control-label')].map((x) => (x.textContent||'').replace(/\\s+/g,' ').trim().slice(0,26));
  const rowsGeom = [...p.querySelectorAll('.control-label')].slice(0,6).map((x) => { const q = x.getBoundingClientRect(); return { t: (x.textContent||'').replace(/\\s+/g,' ').trim().slice(0,18), y: Math.round(q.y), h: Math.round(q.height) } });
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, scrollTop: p.scrollTop, scrollHeight: p.scrollHeight, clientHeight: p.clientHeight, overflow: s.overflowY, rows, rowsGeom, text: (p.innerText||'').replace(/\\s+/g,' ').slice(0,300) };
})()`)
console.log(JSON.stringify(out, null, 2))
c.close()
