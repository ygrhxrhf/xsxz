// U1.5-op-1 只读 CDP 小工具：连接指定 page target，evaluate / screenshot / 原生鼠标与键盘。
// 仅用于本轮真实操作验收，不属于产品代码。
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(JSON.stringify(msg.error)))
      else res(msg.result)
    }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  const shot = async (p) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const fs = await import('node:fs')
    fs.writeFileSync(p, Buffer.from(data, 'base64'))
    return p
  }
  const move = (x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: buttons ? 'left' : 'none', buttons, clickCount: 0 })
  const click = async (x, y) => {
    await move(x, y, 0)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  const key = async (k, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  }
  const typeText = (text) => send('Input.insertText', { text })
  const ax = async () => (await send('Accessibility.getFullAXTree')).nodes
  const close = () => ws.close()
  return { send, evaluate, shot, click, move, key, typeText, ax, close }
}

// 顶栏只读读数：类名、computed visibility/opacity/高度、rect、文字；以及「已下 x / y 章」「取消」两个元素。
export const READ_TOOLS = `(() => {
  const tb = document.querySelector('.reader-toolbar')
  if (!tb) return { error: 'no .reader-toolbar', body: (document.body.innerText || '').slice(0, 500) }
  const cs = getComputedStyle(tb)
  const r = tb.getBoundingClientRect()
  const prog = document.querySelector('[data-reader-dl="progress"]')
  const cancel = document.querySelector('[data-reader-dl="cancel"]')
  const el = (node) => {
    if (!node) return null
    const rr = node.getBoundingClientRect()
    const cc = getComputedStyle(node)
    const cx = Math.min(Math.max(rr.left + rr.width / 2, 1), innerWidth - 1)
    const cy = Math.min(Math.max(rr.top + rr.height / 2, 1), innerHeight - 1)
    const hit = document.elementFromPoint(cx, cy)
    return {
      text: (node.textContent || '').replace(/\\\\s+/g, ' ').trim(),
      rect: { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) },
      inViewport: rr.width > 0 && rr.height > 0 && rr.top >= 0 && rr.bottom <= innerHeight,
      visibility: cc.visibility, opacity: cc.opacity, display: cc.display,
      hitIsSelf: !!(hit && (hit === node || node.contains(hit))),
      hitDesc: hit ? (hit.tagName + '.' + (hit.className || '').toString().split(' ')[0]) : null,
    }
  }
  const content = document.querySelector('.reader-content')
  return {
    capturedAt: new Date().toISOString(),
    bookTitle: (document.querySelector('.reader-book-title')?.textContent || '').trim(),
    chapterTitle: (document.querySelector('.ch-title')?.textContent || '').trim(),
    toolbarPresent: true,
    classes: tb.className,
    hiddenClass: tb.classList.contains('reader-tools-hidden'),
    ariaHidden: tb.getAttribute('aria-hidden'),
    inert: tb.getAttribute('inert'),
    computed: { visibility: cs.visibility, opacity: cs.opacity, height: Math.round(r.height), minHeight: cs.minHeight, transform: cs.transform },
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    innerText: (tb.innerText || '').replace(/\\\\s+/g, ' ').trim(),
    progress: el(prog),
    cancel: el(cancel),
    bottombarHidden: document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden') ?? null,
    contentRect: content ? (() => { const cr = content.getBoundingClientRect(); return { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) } })() : null,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  }
})()`

// 当前页面的 tab 与书库列表摘要（只读）。
export const READ_APP = `(() => {
  const active = [...document.querySelectorAll('.app-nav .nav-btn')].map((b) => ({ label: (b.textContent || '').trim(), active: b.className.includes('active') }))
  const cards = [...document.querySelectorAll('.book-card')].map((c) => ({
    title: (c.querySelector('.book-title')?.textContent || '').trim(),
    status: (c.querySelector('.n-tag')?.textContent || '').trim(),
    progress: (c.querySelector('.book-progress')?.textContent || '').trim(),
    task: (c.querySelector('.check-msg')?.textContent || '').trim(),
    cancelButton: !!c.querySelector('.book-cancel-download'),
  }))
  return {
    capturedAt: new Date().toISOString(),
    nav: active,
    hasReaderToolbar: !!document.querySelector('.reader-toolbar'),
    sidebarDl: (() => { const s = document.querySelector('.sidebar-dl'); return s ? (s.innerText || '').replace(/\\\\s+/g, ' ').trim() : null })(),
    cards,
    bodyHead: (document.body.innerText || '').replace(/\\\\s+/g, ' ').slice(0, 300),
  }
})()`
