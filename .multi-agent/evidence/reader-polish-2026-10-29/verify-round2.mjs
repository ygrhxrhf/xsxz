// 第二轮定向复核：只验证第一轮里「疑似测量伪影 / 疑似真实问题」的 6 项。
// 复用第一轮夹具（library=Temp\spbf-audit-lib-yKtoZP, userData=Temp\spbf-audit-user-KCyx21）。
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(dirname(dirname(here)))
const lib = 'C:/Users/zhanh/AppData/Local/Temp/spbf-audit-lib-yKtoZP'
const userData = 'C:/Users/zhanh/AppData/Local/Temp/spbf-audit-user-KCyx21'
const PORT = 37700 + Math.floor(Math.random() * 200)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = {}
const log = (...a) => console.log(...a)

const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
let appOut = ''
child.stdout.on('data', (c) => { appOut += String(c) })
child.stderr.on('data', (c) => { appOut += String(c) })
const killTree = () => { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }

let ws
let cdp
const ev = async (body) => {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
  return r.result?.value
}
const waitFor = async (expr, timeout = 15000, interval = 120) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { if (await ev(`return (${expr});`)) return true } catch { /* transitioning */ }
    await sleep(interval)
  }
  return false
}
const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(here, `${name}.png`), Buffer.from(r.data, 'base64'))
  return `${name}.png`
}
const KEY = { Space: [' ', 'Space', 32], PageDown: ['PageDown', 'PageDown', 34], PageUp: ['PageUp', 'PageUp', 33], Escape: ['Escape', 'Escape', 27], Tab: ['Tab', 'Tab', 9], ArrowRight: ['ArrowRight', 'ArrowRight', 39], Home: ['Home', 'Home', 36], End: ['End', 'End', 35], Alt: ['Alt', 'AltLeft', 18], KeyI: ['i', 'KeyI', 73], KeyR: ['r', 'KeyR', 82] }
async function press(name, { blur = true } = {}) {
  const [key, code, vk] = KEY[name]
  if (blur) await ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); return 1;`)
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}
const metrics = () => ev(`const el=document.querySelector('.reader-content'); return el?{top:+el.scrollTop.toFixed(1),h:el.clientHeight,sh:el.scrollHeight}:null;`)
const title = () => ev(`return document.querySelector('.ch-title')?.textContent?.trim() || ''`)
const uiState = () => ev(`return { panel:!!document.querySelector('.bottom-panel'), tool:!!document.querySelector('.tool-panel'), drawerVisible:(()=>{const d=[...document.querySelectorAll('.n-drawer')].find(x=>{const r=x.getBoundingClientRect(); return r.width>0&&r.height>0}); return !!d})(), sel:!!document.querySelector('.sel-popup'), activeTag:document.activeElement?.tagName||'' };`)
const keyLog = () => ev(`return (window.__keys||[]).slice(-4);`)
async function closeOverlays() {
  let st = null
  for (let i = 0; i < 6; i += 1) {
    st = await uiState()
    if (!st.panel && !st.tool && !st.drawerVisible && !st.sel) return st
    await press('Escape'); await sleep(280)
  }
  return st
}
async function clickBottom(label) {
  const revealed = await ev(`return !document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden')`)
  if (!revealed) { await press('Alt'); await sleep(300) }
  const r = await ev(`const b=[...document.querySelectorAll('.bottom-button')].find(x=>x.textContent.trim()==='${label}'); if(b){b.click();return 'ok'} return 'none'`)
  await waitFor(`document.querySelector('.bottom-panel')`, 4000)
  return r
}
const clickPanelOption = (label) => ev(`const b=[...document.querySelectorAll('.bottom-panel button')].find(x=>x.textContent.trim()==='${label}'); if(!b)return 'none'; b.click(); return 'ok'`)
async function openCatalog() {
  await clickBottom('目录')
  return waitFor(`document.querySelector('.n-drawer') && document.querySelectorAll('.ch-item').length>0`, 6000)
}
const filterCatalog = (text) => ev(`const i=[...document.querySelectorAll('input')].find(x=>x.placeholder==='过滤目录'); if(!i)return 'none';
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,${JSON.stringify(text)}); i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';`)
const clickChapter = (text) => ev(`const it=[...document.querySelectorAll('.ch-item')].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(!it)return {click:'none',count:document.querySelectorAll('.ch-item').length}; it.click(); return {click:'ok',count:document.querySelectorAll('.ch-item').length};`)
const spansOf = () => ev(`const el=document.querySelector('.reader-content'); if(!el)return [];
  const top0=el.getBoundingClientRect().top; const out=[];
  for (const n of el.querySelectorAll('.para[data-p]')) { const r=n.getBoundingClientRect(); if(r.height<=0)continue; out.push({p:Number(n.dataset.p), top:+(r.top-top0+el.scrollTop).toFixed(1), bottom:+(r.top-top0+el.scrollTop+r.height).toFixed(1)}); }
  return out;`)

try {
  let target
  for (let i = 0; i < 100; i += 1) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = list.find((t) => t.type === 'page' && t.url.startsWith('file:')); if (target) break } catch { /* not up */ }
    await sleep(300)
  }
  if (!target) throw new Error('没有 CDP target：' + appOut.slice(-1200))
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (!m.id) return; const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
  cdp = (method, params = {}) => new Promise((res, rej) => { const id = nextId += 1; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
  await cdp('Page.enable')

  // 进书
  await waitFor(`[...document.querySelectorAll('.nav-label')].some(x=>x.textContent==='书库')`, 25000)
  await ev(`[...document.querySelectorAll('.nav-btn')].find(b=>b.querySelector('.nav-label')?.textContent==='书库')?.click(); return 'ok';`)
  await waitFor(`document.querySelector('.book-open-area')`, 10000)
  await ev(`[...document.querySelectorAll('.book-open-area')].find(x=>x.textContent.includes('长目录测试书'))?.click(); return 'ok'`)
  await waitFor(`document.querySelector('.reader-content .para')`, 12000)
  await sleep(800)
  await ev(`window.__keys=[]; window.addEventListener('keydown',(e)=>window.__keys.push({key:e.key,target:e.target.tagName}),true); return 1;`)

  // A. 刚进书、无任何面板时的键盘基线
  const a0 = await metrics()
  await press('PageDown', { blur: false }); await sleep(900)
  const a1 = await metrics()
  const aKeys = await keyLog()
  await press('Home'); await sleep(900)
  const a2 = await metrics()
  await press('End'); await sleep(1100)
  const a3 = await metrics()
  await press('PageUp', { blur: false }); await sleep(900)
  const a4 = await metrics()
  out.keysFresh = { a0, a1, delta1: +(a1.top - a0.top).toFixed(1), a2, a3, a4, keys: aKeys, state: await uiState() }
  log('A fresh keys', JSON.stringify(out.keysFresh))

  // B. 开关字体面板（Esc 关闭）后再按 PageDown
  await ev(`const el=document.querySelector('.reader-content'); el.scrollTop=1000; return 'ok';`)
  await sleep(400)
  await clickBottom('字体')
  const bPanel = await ev(`return { present: !!document.querySelector('.bottom-panel'), mode: [...document.querySelectorAll('.bottom-panel button.active')].map(x=>x.textContent.trim()) };`)
  const bClose = await closeOverlays()
  await sleep(300)
  const b0 = await metrics()
  await press('PageDown', { blur: false }); await sleep(900)
  const b1 = await metrics()
  out.keysAfterPanel = { bPanel, bClose, b0, b1, delta: +(b1.top - b0.top).toFixed(1), state: await uiState(), keys: await keyLog() }
  log('B after panel keys', JSON.stringify(out.keysAfterPanel))

  // C. 屏幕翻页吸附（面板确实关闭、断言）
  await clickBottom('字体'); await clickPanelOption('屏幕翻页'); await sleep(300)
  const cClose = await closeOverlays(); await sleep(300)
  const cMode = await ev(`return { mode: [...document.querySelectorAll('.bottom-panel button.active')].map(x=>x.textContent.trim()), chip: document.querySelector('.reader-mode-chip')?.textContent||'' };`)
  await ev(`const el=document.querySelector('.reader-content'); el.scrollTop=0; return 'ok';`); await sleep(400)
  const flips = []
  for (let i = 0; i < 5; i += 1) {
    const before = await metrics(); const spans = await spansOf()
    const edge = before.top + before.h
    const straddle = spans.find((s) => s.top < edge && s.bottom > edge)
    const expected = straddle ? (straddle.bottom - straddle.top <= before.h ? straddle.top : Math.min(before.top + before.h, before.sh - before.h)) : null
    await press('PageDown', { blur: false }); await sleep(800)
    const after = await metrics(); const spansAfter = await spansOf()
    const cut = straddle ? spansAfter.find((s) => s.p === straddle.p) : null
    flips.push({ beforeTop: before.top, expected, afterTop: after.top, straddle: straddle?.p ?? null, firstVisible: spansAfter.find((s) => s.bottom > after.top + 2)?.p ?? null, cutFully: cut ? +(cut.bottom - after.top).toFixed(1) <= after.h + 2 : null, aligned: expected !== null ? Math.abs(after.top - expected) <= 3 : null })
  }
  const shotC = await shot('22-screen-snap-round2')
  out.screenSnap = { cClose, cMode, flips, bad: flips.filter((f) => f.aligned === false || f.cutFully === false), evidence: shotC }
  log('C screen snap', JSON.stringify(out.screenSnap))

  // D. 目录 第 220 章 / 开篇 + 大章耗时
  const dOpen = await openCatalog()
  await filterCatalog('第 220 章'); await sleep(400)
  const dItems = await ev(`return [...document.querySelectorAll('.ch-item')].map(x=>x.textContent.trim().slice(0,26)).slice(0,5)`)
  const dClick = await clickChapter('第 220 章')
  const dJumped = await waitFor(`(document.querySelector('.ch-title')?.textContent||'').includes('第 220 章')`, 6000)
  await sleep(500)
  const dTitle = await title()
  out.catalog220 = { dOpen, dItems, dClick, dJumped, dTitle }

  // 划线（在真实第 220 章上）并核对落盘 chapterId
  const sel = await ev(`const p=document.querySelectorAll('.reader-content .para')[3]; if(!p)return null;
    const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT); let node=null;
    while(walker.nextNode()){ const t=walker.currentNode; if(t.nodeValue && t.nodeValue.trim().length>=8){ node=t; break } }
    if(!node)return null; const r=document.createRange(); r.setStart(node,2); r.setEnd(node,Math.min(node.length,Math.max(3,node.length-2)));
    const s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
    const rect=p.getBoundingClientRect(); p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:rect.left+30,clientY:rect.top+rect.height/2,button:0})); return { text:s.toString().slice(0,20) };`)
  await sleep(400)
  const hlBefore = await ev(`return document.querySelectorAll('.hl-mark').length`)
  await ev(`[...document.querySelectorAll('.sel-popup button')].find(b=>b.textContent.trim()==='划线')?.click(); return 'ok';`)
  await sleep(1000)
  const hlAfter = await ev(`return { marks: document.querySelectorAll('.hl-mark').length, toast:[...document.querySelectorAll('.n-message__content')].map(x=>x.textContent).join('|') }`)
  const ann = await readFile(join(lib, 'd_aaaaaaaaaaaaaaaa', 'annotations.json'), 'utf-8').then((x) => JSON.parse(x)).catch(() => null)
  const shotD = await shot('23-annotation-220')
  out.annotation220 = { sel, hlBefore, hlAfter, count: ann?.items?.length ?? 'n/a', lastChapter: ann?.items?.at(-1)?.chapterId ?? 'n/a', evidence: shotD }
  log('D annotation', JSON.stringify(out.annotation220))
  await closeOverlays(); await sleep(300)

  // 大章：目录过滤「开篇」→ 第 1 章
  const eOpen = await openCatalog()
  await filterCatalog('开篇'); await sleep(400)
  const eItems = await ev(`return [...document.querySelectorAll('.ch-item')].map(x=>x.textContent.trim().slice(0,26)).slice(0,5)`)
  await ev(`window.__large={t0:performance.now(),first:null,all:null,max:0};
    const obs=new MutationObserver(()=>{ const n=document.querySelectorAll('.reader-content .para').length; window.__large.max=Math.max(window.__large.max,n);
      if(!window.__large.first && n>0) window.__large.first=Math.round(performance.now()-window.__large.t0);
      if(n>=2600 && !window.__large.all) window.__large.all=Math.round(performance.now()-window.__large.t0); });
    obs.observe(document.body,{childList:true,subtree:true}); window.__largeObs=obs; return 1;`)
  const eClick = await clickChapter('第 1 章')
  const eJumped = await waitFor(`(document.querySelector('.ch-title')?.textContent||'').includes('开篇')`, 15000, 100)
  await waitFor(`document.querySelectorAll('.reader-content .para').length>=2600`, 25000, 200)
  const large = await ev(`const el=document.querySelector('.reader-content'); window.__largeObs?.disconnect();
    return { ...window.__large, paras: document.querySelectorAll('.reader-content .para').length, sh: el?.scrollHeight, ch: el?.clientHeight, title: document.querySelector('.ch-title')?.textContent?.trim(), loading: document.querySelector('.loading-hint')?.textContent||'' };`)
  const shotE = await shot('24-large-chapter-round2')
  out.large = { eOpen, eItems, eClick, eJumped, ...large, evidence: shotE }
  log('E large', JSON.stringify(out.large))

  // 大章切屏幕翻页后单次翻页耗时（若大章确实打开）
  if (large.paras >= 2600) {
    await clickBottom('字体'); await clickPanelOption('屏幕翻页'); await sleep(300); await closeOverlays(); await sleep(300)
    await ev(`const el=document.querySelector('.reader-content'); el.scrollTop=0;
      window.__turn={ms:null}; if(!el.__hooked){el.__hooked=true; el.addEventListener('scroll',()=>{ if(!window.__turn.t0)return; clearTimeout(window.__turn.timer); window.__turn.timer=setTimeout(()=>{window.__turn.ms=Math.round(performance.now()-window.__turn.t0)},150)},{passive:true})}
      window.__turn.t0=performance.now(); return 'ok'`)
    await press('PageDown', { blur: false }); await sleep(700)
    const turn = await ev(`return { ms: window.__turn.ms, top: +document.querySelector('.reader-content').scrollTop.toFixed(1) }`)
    out.largeTurn = turn
    log('E2 large turn', JSON.stringify(turn))
  }

  // F. AI 抽屉 Esc 关闭（用可见性判断，而不是 DOM 是否存在）
  await press('KeyI'); await sleep(400)
  const fOpen = await uiState()
  const fOpenText = await ev(`const d=[...document.querySelectorAll('.n-drawer')].find(x=>{const r=x.getBoundingClientRect(); return r.width>0&&r.height>0}); return (d?.innerText||'').slice(0,60)`)
  await press('Escape'); await sleep(700)
  const fAfter = await uiState()
  const fRect = await ev(`const ds=[...document.querySelectorAll('.n-drawer')]; return ds.map(x=>{const r=x.getBoundingClientRect(); return {w:Math.round(r.width),h:Math.round(r.height),display:getComputedStyle(x).display,vis:getComputedStyle(x).visibility}});`)
  const shotF = await shot('25-ai-drawer-after-esc')
  out.aiEsc = { fOpen, fOpenText, fAfter, fRect, evidence: shotF }
  log('F ai esc', JSON.stringify(out.aiEsc))

  out.appOutTail = appOut.slice(-1500)
  await writeFile(join(here, 'verify-round2.json'), JSON.stringify(out, null, 2), 'utf-8')
} catch (error) {
  out.error = String(error && error.stack || error)
  await writeFile(join(here, 'verify-round2.json'), JSON.stringify(out, null, 2), 'utf-8')
} finally {
  try { ws?.close() } catch { /* noop */ }
  killTree()
  await sleep(1500)
  log('DONE')
}
