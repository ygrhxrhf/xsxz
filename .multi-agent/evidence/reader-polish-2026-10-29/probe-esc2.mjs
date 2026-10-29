// 细粒度探针：面板开/关的 DOM 变化逐帧采样，排除过渡动画与按键投递的干扰。
import { execFileSync, spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(dirname(dirname(here)))
const userData = 'C:/Users/zhanh/AppData/Local/Temp/spbf-audit-user-KCyx21'
const PORT = 38100 + Math.floor(Math.random() * 100)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rec = []
const log = (...a) => console.log(...a)

const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
let appOut = ''
child.stdout.on('data', (c) => { appOut += String(c) })
child.stderr.on('data', (c) => { appOut += String(c) })
const kill = () => { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
let ws
let cdp
const ev = async (body) => {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}
const waitFor = async (expr, timeout = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { if (await ev(`return (${expr});`)) return true } catch { /* transitioning */ }
    await sleep(100)
  }
  return false
}
const key = async (k, code, vk, blur = false, type = 'rawKeyDown') => {
  if (blur) await ev(`document.activeElement?.blur?.(); return 1;`)
  await cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  if (type === 'rawKeyDown') await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}
const snap = () => ev(`const p=document.querySelector('.bottom-panel'); const d=[...document.querySelectorAll('.n-drawer')].find(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0});
  return { panel:!!p, op: p?getComputedStyle(p).opacity:'-', tr: p?getComputedStyle(p).transform:'-', drawer:!!d,
    tool:!!document.querySelector('.tool-panel'), tbHidden:document.querySelector('.reader-toolbar')?.classList.contains('reader-tools-hidden'),
    activeBtn:[...document.querySelectorAll('.bottom-button.active')].map(x=>x.textContent.trim()) }`)

async function timeline(label, act) {
  const t0 = Date.now()
  const frames = []
  await act()
  for (let i = 0; i < 14; i += 1) { frames.push({ ms: Date.now() - t0, ...(await snap()) }); await sleep(100) }
  rec.push({ label, frames })
  log(label, JSON.stringify(frames.map(f => `${f.ms}:p${f.panel ? 1 : 0}/op${f.op}/d${f.drawer ? 1 : 0}/tb${f.tbHidden ? 0 : 1}/${f.activeBtn.join('|')}`)))
}

try {
  let target
  for (let i = 0; i < 100; i += 1) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = l.find((t) => t.type === 'page' && t.url.startsWith('file:')); if (target) break } catch { /* up */ }
    await sleep(300)
  }
  if (!target) throw new Error('no target ' + appOut.slice(-600))
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (!m.id) return; const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
  cdp = (method, params = {}) => new Promise((res, rej) => { const id = nextId += 1; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
  await cdp('Page.enable')
  await waitFor(`[...document.querySelectorAll('.nav-label')].some(x=>x.textContent==='书库')`, 25000)
  await ev(`[...document.querySelectorAll('.nav-btn')].find(b=>b.querySelector('.nav-label')?.textContent==='书库')?.click(); return 'ok';`)
  await waitFor(`document.querySelector('.book-open-area')`, 10000)
  await ev(`[...document.querySelectorAll('.book-open-area')].find(x=>x.textContent.includes('长目录测试书'))?.click(); return 'ok'`)
  await waitFor(`document.querySelector('.reader-content .para')`, 12000)
  await sleep(800)
  await ev(`window.__k=[]; window.addEventListener('keydown',(e)=>window.__k.push({k:e.key,t:e.target.tagName,p:e.defaultPrevented}),true); return 1;`)

  // 键盘 a 打开字体面板（不 blur）
  await timeline('A key-a-open', async () => { await key('a', 'KeyA', 65) })
  log('keys', JSON.stringify(await ev(`return (window.__k||[]).slice(-3)`)))
  // Esc 关闭（不 blur）
  await timeline('B esc-close', async () => { await key('Escape', 'Escape', 27) })
  log('keys', JSON.stringify(await ev(`return (window.__k||[]).slice(-3)`)))
  // 鼠标点字体打开
  await timeline('C click-font-open', async () => { await ev(`[...document.querySelectorAll('.bottom-button')].find(x=>x.textContent.trim()==='字体')?.click(); return 'ok'`) })
  // Esc 关闭
  await timeline('D esc-close-after-mouse', async () => { await key('Escape', 'Escape', 27) })
  // 再点字体（预期重新打开）
  await timeline('E click-font-reopen', async () => { await ev(`[...document.querySelectorAll('.bottom-button')].find(x=>x.textContent.trim()==='字体')?.click(); return 'ok'`) })
  // 点同一按钮关闭（对照）
  await timeline('F click-font-close', async () => { await ev(`[...document.querySelectorAll('.bottom-button')].find(x=>x.textContent.trim()==='字体')?.click(); return 'ok'` ) })
  // i 打开 AI 抽屉
  await timeline('G key-i-open', async () => { await key('i', 'KeyI', 73) })
  // Esc 关 AI 抽屉
  await timeline('H esc-close-ai', async () => { await key('Escape', 'Escape', 27) })
  log('keys', JSON.stringify(await ev(`return (window.__k||[]).slice(-4)`)))

  rec.push({ appOutTail: appOut.slice(-500) })
  await writeFile(join(here, 'probe-esc2.json'), JSON.stringify(rec, null, 2), 'utf-8')
} catch (error) {
  rec.push({ error: String(error && error.stack || error) })
  await writeFile(join(here, 'probe-esc2.json'), JSON.stringify(rec, null, 2), 'utf-8')
} finally {
  try { ws?.close() } catch { /* noop */ }
  kill(); await sleep(1200); log('DONE')
}
