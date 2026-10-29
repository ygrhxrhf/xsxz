// 真实鼠标：书库「继续读」→ 回到阅读页，再真实点左侧热区切回第一章，补 AX 证据。
import { connect, READ_U14 } from './_cdp-lib.mjs'
import fs from 'node:fs'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = () => c.evaluate(READ_U14)
const rectOf = (sel) => c.evaluate(`(() => { const b=document.querySelector(${JSON.stringify(sel)}); if(!b) return null; const r=b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2), label: (b.getAttribute('aria-label')||b.textContent||'').trim().slice(0,40) } })()`)
const steps = []
const cont = await rectOf('.shelf-continue-open')
steps.push({ step: 'shelf-continue', rect: cont })
if (cont) { await c.click(cont.cx, cont.cy); await sleep(2200); steps.push('clicked continue') }
else {
  const card = await rectOf('.book-open-area')
  steps.push({ step: 'book-card', rect: card })
  await c.click(card.cx, card.cy); await sleep(2200)
}
let s = await read()
// 若仍不在章 1，用真实鼠标点左侧热区
if (s.chapterTitle !== '第一章 样例尾巴章') {
  const lh = await rectOf('.chapter-hotzone.left')
  steps.push({ step: 'left-hotzone', rect: lh })
  if (lh && lh.w > 0) { await c.click(lh.cx, 400); await sleep(1500) }
  for (let i = 0; i < 30; i++) { await sleep(400); const cur = await read(); if (cur.chapterTitle === '第一章 样例尾巴章') { s = cur; break } }
}
await sleep(1200)
s = await read()
// 工具层收起，保证纯正文画面
const barHidden = () => c.evaluate(`document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden') === true`)
for (let i = 0; i < 3; i++) { if (await barHidden()) break; await c.click(666, 386); await sleep(900) }
s = await read()
const nodes = await c.ax()
const lines = nodes.filter((n) => ['button','switch','StaticText'].includes(n.role?.value) && (n.name?.value || '').trim())
  .map((n) => `${n.role.value}\t${(n.name.value||'').replace(/\s+/g,' ').slice(0,90)}`)
fs.writeFileSync('_ax-chapter1.txt', lines.join('\n'))
const out = { at: new Date().toISOString(), steps, chapter: s.chapterTitle, dataPOrder: s.dataPOrder,
  paraOnScreen: s.paraOnScreen, visibleTextOnScreen: s.visibleTextOnScreen,
  domHasTailSentence: s.domHasTailSentence, domHasAnyExampleDomain: s.domHasAnyExampleDomain, domHasKeepSentence: s.domHasKeepSentence,
  axStaticText: lines.filter((l) => l.startsWith('StaticText')) }
fs.writeFileSync('_ax-chapter1-state.json', JSON.stringify(out, null, 2))
await c.shot('_ax-chapter1.png')
console.log(JSON.stringify({ steps, chapter: s.chapterTitle, dataPOrder: s.dataPOrder, domHasTail: s.domHasTailSentence, domHasKeep: s.domHasKeepSentence }, null, 2))
c.close()
