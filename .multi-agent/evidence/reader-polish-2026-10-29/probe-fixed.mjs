// 修复后的真实帧环境复核：每次判定前强制一帧（captureScreenshot），避免无绘制窗口把动画时钟冻住。
import { execFileSync, spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(dirname(dirname(here)))
const userData = 'C:/Users/zhanh/AppData/Local/Temp/spbf-audit-user-KCyx21'
const PORT = 38300 + Math.floor(Math.random() * 100)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rec = []
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
const frame = async (name) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); if (name) await writeFile(join(here, `${name}.png`), Buffer.from(r.data, 'base64')); await sleep(120) }
const key = async (k, code, vk) => {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}
const snap = () => ev(`const p=document.querySelector('.bottom-panel'); const d=[...document.querySelectorAll('.n-drawer')].find(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0});
  return { panel:!!p, op:p?+getComputedStyle(p).opacity:null, drawer:!!d, dw:d?Math.round(d.getBoundingClientRect().width):0 }`)

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
  await sleep(800)
  await frame('26-fixed-reader-entry')

  await ev(`[...document.querySelectorAll('.bottom-button')].find(x=>x.textContent.trim()==='字体')?.click(); return 'ok'`)
  await frame('27-fixed-panel-open')
  await sleep(400); await frame()
  rec.push({ step: 'panel-open-after-frames', ...(await snap()) })
  await key('Escape', 'Escape', 27)
  await frame('28-fixed-panel-closed')
  rec.push({ step: 'panel-esc', ...(await snap()) })
  await ev(`[...document.querySelectorAll('.bottom-button')].find(x=>x.textContent.trim()==='字体')?.click(); return 'ok'`)
  await frame('29-fixed-panel-reopen')
  await sleep(400); await frame()
  rec.push({ step: 'panel-reopen-after-frames', ...(await snap()) })
  await key('Escape', 'Escape', 27); await frame()

  // AI 抽屉：打开 → 点内部按钮 → Esc
  await key('i', 'KeyI', 73)
  await waitFor(`[...document.querySelectorAll('.n-drawer')].some(x=>x.getBoundingClientRect().width>0)`, 8000)
  await frame('30-fixed-ai-open')
  const btn = await ev(`const d=[...document.querySelectorAll('.n-drawer')].find(x=>x.getBoundingClientRect().width>0);
    const b=[...d.querySelectorAll('button')].find(x=>x.textContent.trim().length>0); if(!b)return 'none'; b.focus(); const t=b.textContent.trim().slice(0,12); return t;`)
  rec.push({ step: 'ai-focus-button', button: btn })
  await key('Escape', 'Escape', 27)
  await frame()
  rec.push({ step: 'ai-esc-300ms', ...(await snap()) })
  await sleep(900); await frame('31-fixed-ai-after-esc')
  rec.push({ step: 'ai-esc-1300ms', ...(await snap()) })
  rec.push({ appOutTail: appOut.slice(-300) })
  await writeFile(join(here, 'probe-fixed.json'), JSON.stringify(rec, null, 2), 'utf-8')
} catch (error) {
  rec.push({ error: String(error && error.stack || error) })
  await writeFile(join(here, 'probe-fixed.json'), JSON.stringify(rec, null, 2), 'utf-8')
} finally {
  try { ws?.close() } catch { /* noop */ }
  kill(); await sleep(1200); console.log('DONE')
}
