// 只读 CDP 小工具：连接指定 page target，提供 evaluate / screenshot / 原生点击。
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
  const shot = async (path) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const buf = Buffer.from(data, 'base64')
    const fs = await import('node:fs')
    fs.writeFileSync(path, buf)
    return buf.length
  }
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  const ax = async () => (await send('Accessibility.getFullAXTree')).nodes
  const close = () => ws.close()
  return { send, evaluate, shot, click, ax, close }
}

// 只读读数：工具层与右侧按钮的可见性，正文可视段落，书库卡片位置。
export const READ_STATE = `(() => {
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const read = (el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      class: String(el.className),
      text: (el.textContent || '').trim().slice(0, 40),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      ariaHidden: el.getAttribute('aria-hidden'),
      inert: el.hasAttribute('inert'),
    }
  }
  const scroller = document.querySelector('.reader-scroll, .reader-pane')
  const visible = []
  for (const p of document.querySelectorAll('[data-p]')) {
    const r = p.getBoundingClientRect()
    if (r.bottom > 0 && r.top < innerHeight) visible.push((p.textContent || '').slice(0, 60))
  }
  return {
    capturedAt: new Date().toISOString(),
    title: document.title,
    url: location.href,
    shellClass: document.querySelector('.app-shell')?.className || null,
    size: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    chapterTitle: (document.querySelector('.chapter-title, .reader-chapter-title')?.textContent || '').trim().slice(0, 60) || null,
    scroll: scroller ? { scrollTop: Math.round(scroller.scrollTop), clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight, cls: String(scroller.className) } : null,
    readerElements: [...q('.reader-toolbar'), ...q('.reader-spine'), ...q('.reader-spine-initial'), ...q('.reader-bottombar'), ...q('.bottom-button')].map(read),
    visibleParagraphs: visible,
    bodyText: (document.body.innerText || '').slice(0, 4000),
    libraryCards: q('.book-open-area, .shelf-continue-open').map((el) => ({ label: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30), rect: read(el).rect })),
  }
})()`
