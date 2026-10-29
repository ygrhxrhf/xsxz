// 复核失败章重试提示：应显示中文原因，不再出现 HttpStatusError。
import { execFileSync, spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(dirname(dirname(here)))
const userData = 'C:/Users/zhanh/AppData/Local/Temp/spbf-audit-user-KCyx21'
const PORT = 38600 + Math.floor(Math.random() * 100)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = {}
const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
const kill = () => { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
let ws, cdp
const ev = async (body) => {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
const waitFor = async (expr, timeout = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { try { if (await ev(`return (${expr});`)) return true } catch { /* t */ } await sleep(120) }
  return false
}
const frame = async (n) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); if (n) await writeFile(join(here, `${n}.png`), Buffer.from(r.data, 'base64')); await sleep(120) }
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
  await waitFor(`document.querySelector('.reader-content .para') || document.querySelector('.chapter-hint')`, 12000)
  await sleep(400); await frame('38-retry-entry')
  // 唤出底栏 → 目录 → 过滤失败章 → 跳过去
  const revealed = await ev(`return !document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden')`)
  if (!revealed) { await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18 }); await sleep(300) }
  await ev(`[...document.querySelectorAll('.bottom-button')].find(x=>x.textContent.trim()==='目录')?.click(); return 'ok'`)
  await waitFor(`document.querySelector('.n-drawer') && document.querySelectorAll('.ch-item').length>0`, 6000)
  await ev(`const i=[...document.querySelectorAll('input')].find(x=>x.placeholder==='过滤目录'); const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(i,'第 211 章'); i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';`)
  await sleep(400)
  await ev(`[...document.querySelectorAll('.ch-item')].find(x=>x.textContent.includes('第 211 章'))?.click(); return 'ok';`)
  await waitFor(`(document.querySelector('.ch-title')?.textContent||'').includes('第 211 章')`, 6000)
  await frame('39-retry-failed-chapter')
  const started = Date.now()
  await waitFor(`document.querySelectorAll('.n-message__content').length===0`, 8000)
  await ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='重试失败章')?.click(); return 'ok';`)
  await waitFor(`[...document.querySelectorAll('.n-message__content')].some(x=>x.textContent.trim().length>0)`, 45000)
  await frame('40-retry-toast')
  out.message = await ev(`return [...document.querySelectorAll('.n-message__content')].map(x=>x.textContent.trim()).join(' | ')`)
  out.title = await ev(`return document.querySelector('.ch-title')?.textContent?.trim()`)
  out.elapsedMs = Date.now() - started
  out.hasEnglish = /HttpStatusError|HTTP 404/.test(out.message)
  await writeFile(join(here, 'probe-retry.json'), JSON.stringify(out, null, 2), 'utf-8')
} catch (error) {
  out.error = String(error && error.stack || error)
  await writeFile(join(here, 'probe-retry.json'), JSON.stringify(out, null, 2), 'utf-8')
} finally {
  try { ws?.close() } catch { /* noop */ }
  kill(); await sleep(1200); console.log('DONE')
}
