// 键盘复核补测（连续滚动步进 + Home 精度）：先把位置摆回章内，避免在章末测。
import { execFileSync, spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(dirname(dirname(here)))
const userData = 'C:/Users/zhanh/AppData/Local/Temp/spbf-audit-user-KCyx21'
const PORT = 38500 + Math.floor(Math.random() * 100)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rec = {}
const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
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
  await sleep(600); await frame('35-keys2-entry')

  await ev(`const el=document.querySelector('.reader-content'); el.scrollTop=0; return 'ok';`); await sleep(300); await frame()
  rec.reset = await metrics()
  for (let i = 0; i < 3; i += 1) {
    const b = await metrics()
    await key('PageDown', 'PageDown', 34); await frame(); await sleep(400); await frame()
    const a = await metrics()
    rec[`scrollStep${i + 1}`] = { before: b.top, after: a.top, step: +(a.top - b.top).toFixed(1) }
  }
  await frame('36-keys2-scroll-mode')

  await ev(`const el=document.querySelector('.reader-content'); el.scrollTop=5000; return 'ok';`); await sleep(300); await frame()
  rec.beforeHome = await metrics()
  await key('Home', 'Home', 36); await frame(); await sleep(600); await frame('37-keys2-home')
  rec.afterHome = await metrics()
  await key('End', 'End', 35); await frame(); await sleep(800); await frame()
  rec.afterEnd = await metrics()
  rec.max = (rec.afterEnd.sh ?? 0) - (rec.afterEnd.h ?? 0)
  await writeFile(join(here, 'probe-keys2.json'), JSON.stringify(rec, null, 2), 'utf-8')
} catch (error) {
  rec.error = String(error && error.stack || error)
  await writeFile(join(here, 'probe-keys2.json'), JSON.stringify(rec, null, 2), 'utf-8')
} finally {
  try { ws?.close() } catch { /* noop */ }
  kill(); await sleep(1200); console.log('DONE')
}
