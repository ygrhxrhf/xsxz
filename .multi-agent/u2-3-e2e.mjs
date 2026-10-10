const port = 9222
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let targets
for (let i = 0; i < 50; i += 1) {
  try { targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()); if (targets.length) break } catch {}
  await delay(200)
}
const target = targets?.find((item) => item.type === 'page' && item.url.startsWith('file:'))
if (!target) throw new Error('没有找到 Electron renderer')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let nextId = 1
const pending = new Map()
ws.onmessage = (event) => { const m = JSON.parse(event.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
async function evaluate(expression) { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value }
async function waitFor(expression, timeout = 3000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await evaluate(expression)) return true; await delay(50) } return false }
await cdp('Runtime.enable')
await evaluate(`([...document.querySelectorAll('.nav-btn')].find((el) => el.textContent.includes('书库'))).click()`)
await waitFor(`document.querySelector('.library-empty')`)
const imported = await evaluate(`window.api.library.import('/tmp/U23测试书.txt')`)
if (!imported?.ok) throw new Error(imported?.message || '导入失败')
await evaluate(`(async () => { const navs = [...document.querySelectorAll('.nav-btn')]; navs.find((el) => el.textContent.includes('浏览')).click(); await new Promise((resolve) => setTimeout(resolve, 80)); navs.find((el) => el.textContent.includes('书库')).click() })()`)
if (!await waitFor(`document.querySelector('.card-more')`)) throw new Error('未找到更多按钮')
const evidence = []
async function openMenu() { await evaluate(`document.querySelector('.card-more').click()`); return waitFor(`[...document.querySelectorAll('.n-dropdown-option-body')].some((el) => el.textContent.includes('前情提要'))`) }
const firstOpen = await openMenu()
const menu = await evaluate(`(() => [...document.querySelectorAll('.n-dropdown-option-body')].map((el) => el.textContent.trim()).filter(Boolean))()`)
const menuPass = firstOpen && menu.join('|') === '前情提要|导出 txt|导出 epub|移入回收站'
evidence.push({ item: 'import-menu-order-and-conditions', pass: menuPass, result: { menu } })
await evaluate(`([...document.querySelectorAll('.n-dropdown-option-body')].find((el) => el.textContent.trim() === '前情提要')).click()`)
const recapOpened = await waitFor(`document.querySelector('.n-drawer-container')?.textContent.includes('前情提要')`)
const noDeleteForRecap = !await evaluate(`document.querySelector('.n-modal-container')?.textContent.includes('移入回收站') || false`)
evidence.push({ item: 'non-trash-does-not-confirm-delete', pass: recapOpened && noDeleteForRecap, result: { recapOpened, noDeleteForRecap } })
await evaluate(`document.querySelector('.n-drawer-container .n-base-close').click()`)
await delay(100)
await openMenu()
await evaluate(`([...document.querySelectorAll('.n-dropdown-option-body')].find((el) => el.textContent.trim() === '移入回收站')).click()`)
const dialog = await evaluate(`(() => { const modal = document.querySelector('.n-modal-container'); return { visible: Boolean(modal?.textContent.includes('移入回收站')), text: modal?.textContent.replace(/\s+/g, ' ').trim() } })()`)
const dialogPass = dialog.visible && dialog.text.includes('把《U23测试书》移入回收站？之后可在回收站还原。') && dialog.text.includes('取消')
evidence.push({ item: 'trash-confirm-dialog', pass: dialogPass, result: dialog })
await evaluate(`([...document.querySelectorAll('.n-modal-container button')].find((el) => el.textContent.trim() === '取消')).click()`)
const dialogClosed = await waitFor(`!document.querySelector('.n-modal-container')?.textContent.includes('移入回收站')`)
evidence.push({ item: 'trash-cancel-preserves-book', pass: dialogClosed && await evaluate(`Boolean(document.querySelector('.book-card'))`), result: { dialogClosed } })
for (const size of [{ width: 1280, height: 800 }, { width: 1100, height: 720 }]) {
  await evaluate(`window.resizeTo(${size.width}, ${size.height})`)
  for (const skin of ['sakura', 'minimal']) {
    const result = await evaluate(`(() => { document.body.dataset.skin = '${skin}'; const card = document.querySelector('.book-card'); const more = document.querySelector('.card-more'); more.focus(); return { cardWidth: Math.round(card.getBoundingClientRect().width), moreFocusable: document.activeElement === more, outline: getComputedStyle(more).outlineWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth } })()`)
    evidence.push({ size: `${size.width}x${size.height}`, skin, pass: result.cardWidth >= 230 && result.moreFocusable && Number.parseFloat(result.outline) >= 2 && !result.overflow, result })
  }
}
ws.close()
const failed = evidence.filter((item) => !item.pass)
console.log(JSON.stringify({ passed: evidence.length - failed.length, total: evidence.length, failed, evidence }, null, 2))
if (failed.length) process.exitCode = 1
