// 修复后的键盘复核：每次按键后强制一帧，避免无绘制窗口把平滑滚动/动画冻住。
import { execFileSync, spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(dirname(dirname(here)))
const userData = 'C:/Users/zhanh/AppData/Local/Temp/spbf-audit-user-KCyx21'
const PORT = 38400 + Math.floor(Math.random() * 100)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rec = {}
const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
let appOut = ''
child.stdout.on('data', (c) => { appOut += String(c) })
child.stderr.on('data', (c) => { appOut += String(c) })
const kill = () => { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
let ws, cdp
const ev = async (body) => {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
const waitFor = async (expr, timeout = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { try { if (await ev(`return (${expr});`)) return true } catch { /* t */ } await sleep(100) }
  return false
}
const frame = async (n) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); if (n) await writeFile(join(here, `${n}.png`), Buffer.from(r.data, 'base64')); await sleep(150) }
const key = async (k, code, vk) => {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}
const metrics = () => ev(`const el=document.querySelector('.reader-content'); return {top:+el.scrollTop.toFixed(1),h:el.clientHeight,sh:el.scrollHeight}`)
const spans = () => ev(`const el=document.querySelector('.reader-content'); const top0=el.getBoundingClientRect().top; const out=[];
  for(const n of el.querySelectorAll('.para[data-p]')){const r=n.getBoundingClientRect(); if(r.height<=0)continue; out.push({p:+n.dataset.p,t:+(r.top-top0+el.scrollTop).toFixed(1),b:+(r.top-top0+el.scrollTop+r.height).toFixed(1)});} return out;`)

try {
  let target
  for (let i = 0; i < 100; i += 1) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = l.find((t) => t.type === 'page' && t.url.startsWith('file:')); if (target) break } catch { /* up */ }
    await sleep(300)
  }
  if (!target) throw new Error('no target')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 1
  const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (!m.id) return; const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
  cdp = (method, params = {}) => new Promise((res, rej) => { const i = id += 1; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  await cdp('Page.enable')
  await waitFor(`[...document.querySelectorAll('.nav-label')].some(x=>x.textContent==='书库')`, 25000)
  await ev(`[...document.querySelectorAll('.nav-btn')].find(b=>b.querySelector('.nav-label')?.textContent==='书库')?.click(); return 'ok';`)
  await waitFor(`document.querySelector('.book-open-area')`, 10000)
  await ev(`[...document.querySelectorAll('.book-open-area')].find(x=>x.textContent.includes('长目录测试书'))?.click(); return 'ok'`)
  await waitFor(`document.querySelector('.reader-content .para')`, 12000)
  await sleep(600); await frame('32-keys-entry')
  rec.entry = await metrics()

  // 屏幕翻页：3 次翻页（期望吸附到段首，且被切断的段完整进入视口）
  const flips = []
  for (let i = 0; i < 3; i += 1) {
    const before = await metrics()
    const sp = await spans()
    const edge = before.top + before.h
    const cut = sp.find((s) => s.t < edge && s.b > edge)
    await key('PageDown', 'PageDown', 34); await frame(); await sleep(250); await frame()
    const after = await metrics()
    const sp2 = await spans()
    const cutAfter = cut ? sp2.find((s) => s.p === cut.p) : null
    const firstVisible = sp2.find((s) => s.b > after.top + 2)?.p ?? null
    flips.push({ beforeTop: before.top, afterTop: after.top, delta: +(after.top - before.top).toFixed(1), cutPara: cut?.p ?? null, cutBottomFromTop: cutAfter ? +(cutAfter.b - after.top).toFixed(1) : null, fits: cutAfter ? (cutAfter.b - after.top) <= after.h + 2 : null, firstVisible })
  }
  await frame('33-keys-screen-snap')
  rec.screenFlips = flips

  // Home / End / PageUp
  rec.beforeHome = await metrics()
  await key('Home', 'Home', 36); await frame(); await sleep(300); await frame()
  rec.afterHome = await metrics()
  await key('End', 'End', 35); await frame(); await sleep(500); await frame()
  rec.afterEnd = await metrics()
  await key('PageUp', 'PageUp', 33); await frame(); await sleep(400); await frame()
  rec.afterPageUp = await metrics()

  // 切连续滚动后 PageDown（0.9 屏步进，不吸附）
  await ev(`[...document.querySelectorAll('.bottom-button')].find(x=>x.textContent.trim()==='字体')?.click(); return 'ok'`)
  await waitFor(`document.querySelector('.bottom-panel')`, 4000)
  await ev(`[...document.querySelectorAll('.bottom-panel button')].find(x=>x.textContent.trim()==='连续滚动')?.click(); return 'ok'`)
  await sleep(300); await key('Escape', 'Escape', 27); await frame(); await sleep(300); await frame()
  rec.panelAfterModeSwitch = await ev(`return { panel: !!document.querySelector('.bottom-panel'), op: document.querySelector('.bottom-panel') ? +getComputedStyle(document.querySelector('.bottom-panel')).opacity : null }`)
  const c0 = await metrics()
  await key('PageDown', 'PageDown', 34); await frame(); await sleep(500); await frame()
  const c1 = await metrics()
  await key('PageDown', 'PageDown', 34); await frame(); await sleep(500); await frame()
  const c2 = await metrics()
  rec.scrollMode = { c0, c1, c2, step1: +(c1.top - c0.top).toFixed(1), step2: +(c2.top - c1.top).toFixed(1), expected: +(c0.h * 0.9).toFixed(1) }
  await frame('34-keys-scroll-mode')

  rec.appOutTail = appOut.slice(-300)
  await writeFile(join(here, 'probe-keys-fixed.json'), JSON.stringify(rec, null, 2), 'utf-8')
} catch (error) {
  rec.error = String(error && error.stack || error)
  await writeFile(join(here, 'probe-keys-fixed.json'), JSON.stringify(rec, null, 2), 'utf-8')
} finally {
  try { ws?.close() } catch { /* noop */ }
  kill(); await sleep(1200); console.log('DONE')
}
