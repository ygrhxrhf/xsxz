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

// ---- U1.4-op-1 追加：裁剪截图 ----
export async function shotClip(c, p, clip) {
  const { data } = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...clip, scale: 1 } })
  const fs = await import('node:fs')
  fs.writeFileSync(p, Buffer.from(data, 'base64'))
  return p
}

// ---- U1.4-op-1 追加：屏幕可见文字与段落可见性只读读数 ----
// 只读 getBoundingClientRect / getComputedStyle / elementFromPoint / innerText，
// 不写 DOM、不读改组件状态。visible 判据 = 有布局盒 + visibility:visible + opacity>0
// + 有落在视口内的像素 + 该段内部采样点 elementFromPoint 落到它自己或其后代。
export const READ_U14 = `(() => {
  const pane = document.querySelector('.reader-content')
  if (!pane) return { error: 'no .reader-content', body: (document.body.innerText || '').slice(0, 400) }
  const pr = pane.getBoundingClientRect()
  const vp = { w: innerWidth, h: innerHeight }
  const inter = (r) => {
    const l = Math.max(r.left, 0), t = Math.max(r.top, 0)
    const rr = Math.min(r.right, vp.w), bb = Math.min(r.bottom, vp.h)
    return rr > l && bb > t ? Math.round((rr - l) * (bb - t)) : 0
  }
  const nodes = [...pane.querySelectorAll('.para[data-p]')]
  const paras = nodes.map((el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const visibleArea = inter(r)
    let covered = null
    if (visibleArea > 0) {
      const cx = Math.min(Math.max(r.left + r.width / 2, 1), vp.w - 1)
      const cy = Math.min(Math.max(r.top + Math.min(r.height / 2, 12), 1), vp.h - 1)
      const hit = document.elementFromPoint(cx, cy)
      covered = !(hit === el || el.contains(hit))
    }
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim()
    return {
      p: Number(el.getAttribute('data-p')),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      visibleArea,
      visiblePx: visibleArea > 0,
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      coveredByOther: covered,
      onScreen: visibleArea > 40 && cs.visibility === 'visible' && Number(cs.opacity) > 0 && covered === false,
      text: text.slice(0, 90),
    }
  })
  const shown = paras.filter((p) => p.onScreen)
  const paneText = (pane.innerText || '')
  // 屏幕上（视口内）实际可见的正文行文字，按 DOM 顺序拼接
  const visibleLines = shown.map((p) => p.text)
  return {
    capturedAt: new Date().toISOString(),
    docTitle: document.title,
    url: location.href,
    viewport: { w: vp.w, h: vp.h, dpr: devicePixelRatio },
    pane: { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height),
            scrollTop: Math.round(pane.scrollTop), clientHeight: pane.clientHeight, scrollHeight: pane.scrollHeight },
    chapterTitle: (pane.querySelector('.ch-title')?.textContent || '').trim(),
    paraCount: paras.length,
    dataPOrder: paras.map((p) => p.p),
    paraOnScreen: shown.map((p) => ({ p: p.p, rect: p.rect, visibleArea: p.visibleArea, text: p.text })),
    paras,
    visibleTextOnScreen: visibleLines.join('\\n'),
    paneInnerText: paneText.slice(0, 1200),
    domHasTailSentence: paneText.includes('请收藏本站'),
    domHasAnyExampleDomain: paneText.includes('www.example.com'),
    domHasKeepSentence: paneText.includes('请收藏这封信'),
  }
})()`

// 开关读数（只读 aria-checked / 文本），用于记录点前点后
export const READ_SWITCHES = `(() => {
  const out = []
  for (const label of document.querySelectorAll('.bottom-panel .control-label')) {
    const sw = label.querySelector('.n-switch')
    if (!sw) continue
    const r = sw.getBoundingClientRect()
    const cs = getComputedStyle(sw)
    out.push({
      label: (label.textContent || '').replace(/\\s+/g, ' ').trim(),
      checked: sw.getAttribute('aria-checked'),
      disabled: sw.getAttribute('aria-disabled'),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: r.top >= 0 && r.bottom <= innerHeight && r.width > 0,
      visibility: cs.visibility, opacity: cs.opacity,
    })
  }
  const p = document.querySelector('.bottom-panel')
  const pr = p ? p.getBoundingClientRect() : null
  return {
    panelPresent: !!p,
    panelRect: pr ? { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height), scrollTop: Math.round(p.scrollTop) } : null,
    switches: out,
    bottombarRect: (() => { const b = document.querySelector('.reader-bottombar'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), hidden: b.classList.contains('reader-tools-hidden') } })(),
    fontBtnRect: (() => { const b = [...document.querySelectorAll('.bottom-button')].find((x) => x.getAttribute('aria-label') === '字体'); if (!b) return null; const r = b.getBoundingClientRect(); return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) } })(),
  }
})()`
