// 只读 CDP 小工具：连接指定 page target，提供 evaluate / screenshot / 原生鼠标点击。
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
  const wheel = async (x, y, deltaY) => {
    await move(x, y, 0)
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, button: 'none', buttons: 0 })
  }
  const ax = async () => (await send('Accessibility.getFullAXTree')).nodes
  const close = () => ws.close()
  return { send, evaluate, shot, click, move, wheel, ax, close }
}

// 只读读数：章标题、滚动几何、全部段落相对视口的 top/bottom、屏底被切断的段落。
export const READ_STATE = `(() => {
  const pane = document.querySelector('.reader-content')
  if (!pane) return { error: 'no .reader-content', body: (document.body.innerText||'').slice(0,600) }
  const pr = pane.getBoundingClientRect()
  const paras = [...pane.querySelectorAll('.para[data-p]')].map((el) => {
    const r = el.getBoundingClientRect()
    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim()
    return {
      i: Number(el.getAttribute('data-p')),
      top: Math.round(r.top - pr.top), bottom: Math.round(r.bottom - pr.top),
      absTop: Math.round(r.top - pr.top + pane.scrollTop), absBottom: Math.round(r.bottom - pr.top + pane.scrollTop),
      height: Math.round(r.height),
      viewTop: Math.round(r.top), viewBottom: Math.round(r.bottom),
      head: t.slice(0, 36),
      firstSentence: (t.match(/^[^。！？]{1,80}[。！？]/) || [t.slice(0, 40)])[0],
      chars: t.length,
    }
  })
  const cut = paras.filter((p) => p.top < pane.clientHeight && p.bottom > pane.clientHeight)
  const atTop = paras.filter((p) => p.top >= -4 && p.top <= 6)
  const modeBtn = [...document.querySelectorAll('.option-grid button')].find((b) => b.textContent.trim() === '屏幕翻页')
  const scrollBtn = [...document.querySelectorAll('.option-grid button')].find((b) => b.textContent.trim() === '连续滚动')
  const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  return {
    capturedAt: new Date().toISOString(),
    docTitle: document.title,
    url: location.href,
    size: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    chapterTitle: (pane.querySelector('.ch-title')?.textContent || '').trim(),
    pane: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height),
            scrollTop: Math.round(pane.scrollTop), clientHeight: pane.clientHeight, scrollHeight: pane.scrollHeight,
            maxTop: Math.round(pane.scrollHeight - pane.clientHeight) },
    modeActive: { screen: modeBtn ? modeBtn.className.includes('active') : null, scroll: scrollBtn ? scrollBtn.className.includes('active') : null },
    modeBtnRect: rectOf(modeBtn), scrollBtnRect: rectOf(scrollBtn),
    paraCount: paras.length,
    cutAtBottom: cut.map((p) => ({ i: p.i, top: p.top, bottom: p.bottom, absTop: p.absTop, absBottom: p.absBottom, height: p.height, viewTop: p.viewTop, head: p.head, firstSentence: p.firstSentence, chars: p.chars })),
    alignAtTop: atTop.map((p) => ({ i: p.i, top: p.top, viewTop: p.viewTop, head: p.head, firstSentence: p.firstSentence })),
    paras: paras.map((p) => ({ i: p.i, top: p.top, bottom: p.bottom, absTop: p.absTop, absBottom: p.absBottom, viewTop: p.viewTop, viewBottom: p.viewBottom, height: p.height, chars: p.chars, head: p.head, firstSentence: p.firstSentence })),
    pageIndicator: (document.querySelector('.reader-page-indicator')?.textContent || '').trim() || null,
    bottomButtons: [...document.querySelectorAll('.bottom-button')].map((b) => ({ label: b.getAttribute('aria-label'), rect: rectOf(b), active: b.className.includes('active') })),
  }
})()`
