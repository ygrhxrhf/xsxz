// 真实鼠标点左侧「上一章」热区回到第一章，再只读抓 AX 文本与段落几何（补 OP-9 的无障碍证据）。
import { connect, READ_U14 } from './_cdp-lib.mjs'
import fs from 'node:fs'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = () => c.evaluate(READ_U14)
const hot = await c.evaluate(`(() => { const b=document.querySelector('.chapter-hotzone.left'); if(!b) return null; const r=b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), disabled: b.disabled, title: b.title } })()`)
const clickAt = { x: Math.round(hot.x + hot.w / 2), y: 400 }
const hit = await c.evaluate(`(() => { const el=document.elementFromPoint(${clickAt.x},${clickAt.y}); return el ? el.tagName+'.'+String(el.className).slice(0,40)+'|'+(el.getAttribute('aria-label')||'') : null })()`)
const before = await read()
await c.click(clickAt.x, clickAt.y)
let after = null
for (let i = 0; i < 40; i++) { await sleep(400); const cur = await read(); if (cur.chapterTitle && cur.chapterTitle !== before.chapterTitle) { after = cur; break } }
await sleep(1500)
after = after ?? await read()
const nodes = await c.ax()
const lines = nodes.filter((n) => ['button','switch','StaticText'].includes(n.role?.value) && (n.name?.value || '').trim())
  .map((n) => `${n.role.value}\t${(n.name.value||'').replace(/\s+/g,' ').slice(0,90)}`)
fs.writeFileSync('_ax-chapter1.txt', lines.join('\n'))
const bodyText = after.paraOnScreen.map((p) => p.text).join('\n')
const out = {
  at: new Date().toISOString(),
  hotzoneLeft: hot, clickAt, hit,
  beforeChapter: before.chapterTitle, afterChapter: after.chapterTitle,
  dataPOrder: after.dataPOrder,
  paraOnScreen: after.paraOnScreen,
  visibleTextOnScreen: bodyText,
  domHasTailSentence: after.domHasTailSentence,
  domHasAnyExampleDomain: after.domHasAnyExampleDomain,
  domHasKeepSentence: after.domHasKeepSentence,
  axStaticText: lines.filter((l) => l.startsWith('StaticText')),
}
fs.writeFileSync('_ax-chapter1-state.json', JSON.stringify(out, null, 2))
await c.shot('_ax-chapter1.png')
console.log(JSON.stringify({ hot, hit, before: before.chapterTitle, after: after.chapterTitle, dataPOrder: after.dataPOrder, domHasTail: after.domHasTailSentence, domHasKeep: after.domHasKeepSentence }, null, 2))
c.close()
