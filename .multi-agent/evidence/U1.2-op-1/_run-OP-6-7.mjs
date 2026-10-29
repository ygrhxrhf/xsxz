// U1.2-op-1：OP-6 / OP-7 真实操作验收采集。
// 只对指定 CDP page target 发 Input.dispatchMouseEvent（mouseMoved / mousePressed / mouseReleased），
// 只读读取 DOM 几何与可见文字；不调用 Vue 方法、不改组件状态、不写 DOM、不改产品代码。
import { connect } from './_cdp-lib.mjs'
import fs from 'node:fs'

const PAGE = process.env.CDP_PAGE
if (!PAGE) throw new Error('缺少 CDP_PAGE')
const DIR = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.2-op-1'
const c = await connect(PAGE)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const READ = `(() => {
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
  const track = document.querySelector('.reader-progress-track')
  const hint = document.querySelector('.reader-progress-scrub-hint')
  const pane = document.querySelector('.reader-pane')
  const pb = pane ? pane.getBoundingClientRect() : null
  const paras = [...document.querySelectorAll('[data-p]')]
  const visible = []
  for (const p of paras) {
    const b = p.getBoundingClientRect()
    if (pb && b.bottom > pb.top && b.top < pb.bottom) visible.push({ p: Number(p.dataset.p), text: (p.textContent || '').trim().slice(0, 70), top: Math.round(b.top) })
    if (visible.length >= 3) break
  }
  const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => (b.textContent || '').trim()).filter(Boolean)
  return {
    capturedAt: new Date().toISOString(),
    url: location.href, docTitle: document.title,
    size: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    readerVisible: !!(pane && pane.offsetParent !== null),
    chapterTitle: (document.querySelector('.ch-title')?.textContent || '').trim() || null,
    chapterError: (document.querySelector('.chapter-error')?.textContent || '').trim() || null,
    chapterHint: (document.querySelector('.chapter-hint')?.textContent || '').trim() || null,
    track: track ? {
      rect: rect(track), cls: String(track.className),
      aria: { min: track.getAttribute('aria-valuemin'), max: track.getAttribute('aria-valuemax'), now: track.getAttribute('aria-valuenow'), valuetext: track.getAttribute('aria-valuetext'), label: track.getAttribute('aria-label') },
      bookFill: document.querySelector('.reader-progress-fill.book')?.style.width || null,
      chapterFill: document.querySelector('.reader-progress-fill.chapter')?.style.width || null,
      scrubPreview: document.querySelector('.reader-progress-fill.scrub-preview')?.style.width || null,
    } : null,
    hint: hint ? {
      text: (hint.textContent || '').trim().replace(/\\s+/g, ' '),
      ordinal: (hint.querySelector('.reader-progress-scrub-ordinal')?.textContent || '').trim(),
      title: (hint.querySelector('.reader-progress-scrub-title')?.textContent || '').trim(),
      rect: rect(hint),
    } : null,
    pane: pane ? { scrollTop: Math.round(pane.scrollTop), clientHeight: pane.clientHeight, scrollHeight: pane.scrollHeight, rect: rect(pane) } : null,
    paraCount: paras.length,
    firstParaTop: paras[0] ? Math.round(paras[0].getBoundingClientRect().top) : null,
    visibleParas: visible,
    buttons: btns,
    bodyText: (document.body.innerText || '').slice(0, 2600),
  }
})()`

const axButtons = async (tag) => {
  const nodes = await c.ax()
  const names = nodes.filter((n) => n.role?.value === 'button' && n.name?.value).map((n) => n.name.value)
  fs.writeFileSync(`${DIR}/${tag}-ax-buttons.txt`, names.slice(0, 60).join('\n'))
  return names
}

const save = async (tag, extra = {}) => {
  const st = await c.evaluate(READ)
  const rec = { ...st, ...extra }
  fs.writeFileSync(`${DIR}/${tag}-state.json`, JSON.stringify(rec, null, 2))
  await c.shot(`${DIR}/${tag}.png`)
  const names = await axButtons(tag)
  return { ...rec, axButtons: names }
}

const hit = async (x, y) => c.evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); return el ? { tag: el.tagName, cls: String(el.className), role: el.getAttribute('role') } : null })()`)

async function drag(fromRatio, targetRatio, onHold) {
  const t0 = await c.evaluate(`(() => { const b = document.querySelector('.reader-progress-track').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, bottom: b.bottom } })()`)
  const x0 = Math.round(t0.x + t0.w * fromRatio)
  const y0 = Math.round(t0.bottom - t0.h / 2)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none', buttons: 0, clickCount: 0 })
  await sleep(400)
  const t1 = await c.evaluate(`(() => { const b = document.querySelector('.reader-progress-track').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, bottom: b.bottom } })()`)
  const y1 = Math.round(t1.bottom - t1.h / 2)
  const hitTest = await hit(x0, y1)
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y1, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(200)
  // 按下后先小幅推出去再回到目标比例：保证是「按住→移动→释放」，而不是原地按放。
  const trail = [fromRatio + 0.03, fromRatio + 0.06, targetRatio]
  const stepXs = []
  for (const r of trail) {
    const x = Math.round(t1.x + t1.w * r)
    stepXs.push(x)
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y1, button: 'left', buttons: 1, clickCount: 0 })
    await sleep(180)
  }
  const xEnd = Math.round(t1.x + t1.w * targetRatio)
  await sleep(300)
  const pointer = {
    trackRect: t1,
    press: { x: x0, y: y1, atRatio: fromRatio },
    release: { x: xEnd, y: y1, atRatio: targetRatio },
    stepXs,
    hitTest,
  }
  const held = await onHold(pointer)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xEnd, y: y1, button: 'left', buttons: 0, clickCount: 1 })
  return { pointer, held }
}

const waitFor = async (expr, ms = 8000, step = 200) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await c.evaluate(expr)) return true
    await sleep(step)
  }
  return false
}

await waitFor(`!!document.querySelector('.ch-title') && !!document.querySelector('.reader-progress-track')`, 30000, 300)
await sleep(2000)
const boot = await save('_boot')
console.log('BOOT', JSON.stringify({ title: boot.chapterTitle, track: boot.track?.rect, aria: boot.track?.aria, pane: boot.pane, paras: boot.paraCount, readerVisible: boot.readerVisible }))

// ---- OP-6 ----
const before6 = await save('OP-6-before')
const d6 = await drag(0.5, 0.5, async (pointer) => save('OP-6-drag', { pointer }))
console.log('OP-6 HELD', JSON.stringify({ hint: d6.held.hint, titleHeld: d6.held.chapterTitle, preview: d6.held.track?.scrubPreview, pointer: d6.pointer }))
await waitFor(`(() => { const t = (document.querySelector('.ch-title')?.textContent || '').trim(); return t.length > 0 && t !== ${JSON.stringify(before6.chapterTitle)} && !document.querySelector('.reader-progress-scrub-hint') })()`, 10000, 200)
await sleep(1800)
const after6 = await save('OP-6-after')
console.log('OP-6 AFTER', JSON.stringify({ title: after6.chapterTitle, scroll: after6.pane, firstParaTop: after6.firstParaTop, vis: after6.visibleParas[0], track: after6.track, buttons: after6.buttons }))

// ---- OP-7 ----
const before7 = await save('OP-7-before')
const d7 = await drag(0.5, 0.8, async (pointer) => save('OP-7-drag', { pointer }))
console.log('OP-7 HELD', JSON.stringify({ hint: d7.held.hint, titleHeld: d7.held.chapterTitle, pointer: d7.pointer }))
await waitFor(`(() => { const t = (document.querySelector('.ch-title')?.textContent || '').trim(); return t.length > 0 && t !== ${JSON.stringify(before7.chapterTitle)} && !document.querySelector('.reader-progress-scrub-hint') })()`, 10000, 200)
await sleep(1800)
const after7 = await save('OP-7-after')
console.log('OP-7 AFTER', JSON.stringify({ title: after7.chapterTitle, err: after7.chapterError, hint: after7.chapterHint, scroll: after7.pane, buttons: after7.buttons, track: after7.track }))

fs.writeFileSync(`${DIR}/_run-summary.json`, JSON.stringify({
  page: PAGE,
  boot: { chapterTitle: boot.chapterTitle, track: boot.track, pane: boot.pane, paraCount: boot.paraCount },
  op6: {
    before: { chapterTitle: before6.chapterTitle, pane: before6.pane, firstParaTop: before6.firstParaTop },
    pointer: d6.pointer,
    held: { hint: d6.held.hint, chapterTitleHeld: d6.held.chapterTitle, scrubPreview: d6.held.track?.scrubPreview, aria: d6.held.track?.aria },
    after: { chapterTitle: after6.chapterTitle, pane: after6.pane, firstParaTop: after6.firstParaTop, visibleParas: after6.visibleParas, track: after6.track, axButtons: after6.axButtons },
  },
  op7: {
    before: { chapterTitle: before7.chapterTitle, pane: before7.pane, firstParaTop: before7.firstParaTop },
    pointer: d7.pointer,
    held: { hint: d7.held.hint, chapterTitleHeld: d7.held.chapterTitle, aria: d7.held.track?.aria },
    after: { chapterTitle: after7.chapterTitle, chapterError: after7.chapterError, chapterHint: after7.chapterHint, pane: after7.pane, buttons: after7.buttons, track: after7.track, axButtons: after7.axButtons },
  },
}, null, 2))
c.close()
